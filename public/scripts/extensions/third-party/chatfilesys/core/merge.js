/**
 * ChatFilesys — 智能合并纯函数（design.md §5，N10 裁定）
 *
 * 内容指纹对齐：
 * - computeHash：{name, is_user, mes} 归一化 → sha256（Web Crypto，node:test 环境同样可用）
 * - prepareRows：jsonl 行数组 → 带 hash 的楼层行序列（非法行跳过计数）
 * - alignMerge：LCP 对齐——完全相同幂等去重；前缀相同分叉挂子分支；hash 冲突二重校验
 *
 * 纯函数：无 DOM、无网络、无适配器依赖（ops 由调用方送 applyOps）。
 */

/** 归一化：去 BOM、统一换行符、去首尾空白 */
function normalizeText(s) {
    return String(s ?? '')
        .replace(/﻿/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * 计算消息行内容指纹。
 * @param {{name?: string, is_user?: boolean, mes?: string}} row ST 消息行
 * @returns {Promise<string>} sha256 hex
 */
export async function computeHash(row) {
    const payload = JSON.stringify({
        name: normalizeText(row?.name),
        is_user: Boolean(row?.is_user),
        mes: normalizeText(row?.mes),
    });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * jsonl 行数组 → 带 hash 的楼层行序列。
 * @param {string[]} lines [header, ...消息行字符串]（或纯消息行数组）
 * @returns {Promise<{rows: Array<{floorNo: number, row: object, hash: string, sendDate, sender}>, stats: {skipped: number}}>}
 */
export async function prepareRows(lines) {
    const rows = [];
    let skipped = 0;
    let floorNo = 0;
    for (const line of lines || []) {
        if (!line || typeof line !== 'string') { skipped++; continue; }
        let obj;
        try { obj = JSON.parse(line); } catch { skipped++; continue; }
        if (!obj || typeof obj !== 'object' || !('mes' in obj)) {
            // header 行（含 chat_metadata）与非法消息行跳过
            if (obj && ('chat_metadata' in obj)) continue;
            skipped++;
            continue;
        }
        floorNo++;
        rows.push({
            floorNo,
            row: obj,
            hash: await computeHash(obj),
            sendDate: obj.send_date ?? null,
            sender: obj.name ?? null,
        });
    }
    return { rows, stats: { skipped } };
}

/**
 * 指纹对齐合并（LCP）。
 * @param {Array<{hash, sendDate?, sender?}>} existingRows 库内既有楼层序列（带 hash）
 * @param {Array<{hash, sendDate?, sender?}>} incomingRows 导入聊天楼层序列（带 hash）
 * @returns {Promise<{ops: Array, stats: {merged: number, deduped: number, forked: number, conflictVariants: number}, forkFloor: number}>}
 *   ops = incoming 剩余段的 add 操作（供 adapter.applyOps 消费）
 */
export async function alignMerge(existingRows, incomingRows) {
    const A = existingRows || [];
    const B = incomingRows || [];

    // 1. LCP：逐层比对 hash（hash 相同但 sendDate/sender 不同 → 视为不同变体，停在前一层）
    let i = 0;
    let conflictVariants = 0;
    while (i < A.length && i < B.length) {
        if (A[i].hash === B[i].hash) {
            const dateA = String(A[i].sendDate ?? '');
            const dateB = String(B[i].sendDate ?? '');
            const senderA = String(A[i].sender ?? '');
            const senderB = String(B[i].sender ?? '');
            if (dateA === dateB && senderA === senderB) { i++; continue; }
            conflictVariants++;
            break; // 二重校验不过 → LCP 停止，进入分叉
        }
        break;
    }

    // 2. 完全相同 → 幂等去重（不产生任何 ops）
    if (i === A.length && i === B.length) {
        return { ops: [], stats: { merged: 0, deduped: B.length, forked: 0, conflictVariants }, forkFloor: i };
    }

    // 3. LCP 后剩余 incoming 段 → add ops（挂为分叉点 i 的子分支，fork_floor = i）
    const ops = B.slice(i).map((r, k) => ({
        op: 'add',
        // 旁挂语义：新分支路径引用，不占线性位置；floorNo 由导入旅程按目标分支路径分配
        floorNo: null,
        variantId: `m${k + 1}`,
        content: r.row ?? r,
        hash: r.hash,
    }));

    return {
        ops,
        stats: {
            merged: B.length - i,
            deduped: i,
            forked: B.length - i > 0 ? 1 : 0,
            conflictVariants,
        },
        forkFloor: i,
    };
}
