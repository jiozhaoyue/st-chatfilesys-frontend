/**
 * ChatFilesys — 投影层（纯函数）
 *
 * 负责「分支树 ⇄ body 线性数组」的双向投影：
 * - body 行 ⇄ Swipe 组（变体/折叠/展开，含 ST 原生 swipes/swipe_info/swipe_id 映射）
 * - 切换分支 → diff 出 patch operations（共享前缀永远不动）
 * - 删除楼层 → 配对 remove 操作（RFC6902 数组 remove 自带移位语义，与重编号天然一致）
 *
 * operations 路径方案 "/<index>"（已按实例源码定案，见 chat-writer.bodyPath）。
 */

import { bodyPath } from './chat-writer.js';
import {
    getActive,
    getBranch,
    maxFloor,
    deriveOwner,
    deleteFloorEverywhere,
} from './branches.js';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/* ---------------- body 行 ⇄ Swipe 组 ---------------- */

/**
 * body 行 → 组记录（折叠态形态）。
 * 行含多 swipe（swipes.length>1）→ 每个 swipe 一个变体，active=swipe_id；
 * 否则 → 单变体。变体为完整消息对象（剥离 swipes/swipe_info/swipe_id 三个组级字段）。
 */
export function groupFromLine(gid, floor, line) {
    const l = clone(line);
    const base = { ...l };
    delete base.swipes;
    delete base.swipe_info;
    delete base.swipe_id;

    if (Array.isArray(l.swipes) && l.swipes.length > 1) {
        const info = Array.isArray(l.swipe_info) ? l.swipe_info : [];
        const variants = l.swipes.map((mes, k) => ({
            ...clone(base),
            mes,
            send_date: info[k]?.send_date !== undefined ? info[k].send_date : l.send_date,
            extra: info[k]?.extra !== undefined ? info[k].extra : l.extra,
        }));
        return { id: gid, floor, owner: undefined, active: l.swipe_id ?? 0, variants };
    }
    return { id: gid, floor, owner: undefined, active: 0, variants: [base] };
}

/**
 * 组记录 → body 行（展开态形态）。
 * 多变体 → 主体 = variants[active]，swipes/swipe_info/swipe_id 按 ST 原生字段生成。
 */
export function lineFromGroup(group) {
    const v = group.variants;
    if (v.length === 1) return clone(v[0]);
    const line = { ...clone(v[group.active]) };
    line.swipes = v.map((x) => x.mes);
    line.swipe_info = v.map((x) => ({ send_date: x.send_date, extra: x.extra }));
    line.swipe_id = group.active;
    return line;
}

/**
 * 活跃分支投影：path 楼层号 ↔ body 行位置对齐。
 * @returns [{floor, gid, line}]
 */
export function activeProjection(model, body) {
    const cur = getActive(model);
    const out = [];
    for (let f = 1; f <= maxFloor(cur); f++) {
        const line = body[f - 1];
        if (line === undefined) throw new Error(`projection: body 缺少第 ${f} 层（行数 ${body.length}）`);
        out.push({ floor: f, gid: cur.path[f], line });
    }
    return out;
}

/* ---------------- 切换分支 ---------------- */

/**
 * 计算并应用「切换分支」：折叠/展开差集 + 生成 patch operations。
 * 共享前缀（两分支 path 相同 gid 的最长公共前缀）之后的区段才产生操作。
 *
 * W6（2026-09-26）：**切换的起点可显式给出**。body 是**本聊天键所在分支**的投影
 * （原生分支/检查点键各自的 body；`core/takeover.js#branchIdForKey`），而家族活跃分支是
 * 另一条——按 `getActive` 算起点会拿错分支的 path 做最长公共前缀与尾部差集，生成的
 * ops 与宿主真实的 body 对不上（接缝只能拒绝，宿主再回退全量保存）。
 * 缺省仍是家族活跃分支（增强模式与家族级路径的既有行为）。
 *
 * @param {object} model
 * @param {string} targetId 目标分支
 * @param {Array<object>} body 当前 body（本键所在分支的投影）
 * @param {string|null} [curId] 起点分支（缺省 = 家族活跃分支）
 * @returns {{operations: Array, model, switchedTo: string}}
 *   operations 顺序执行后，body 即目标分支投影；model 已就地更新（active_branch、groups 折叠/展开）。
 */
export function planSwitch(model, targetId, body, curId = null) {
    const cur = curId ? getBranch(model, curId) : getActive(model);
    if (!cur) throw new Error(`planSwitch: 起点分支 "${curId}" 不存在`);
    const tgt = getBranch(model, targetId);
    if (!tgt) throw new Error(`planSwitch: 目标分支 "${targetId}" 不存在`);
    if (tgt.id === cur.id) return { operations: [], model, switchedTo: cur.id };

    const curMax = maxFloor(cur);
    const tgtMax = maxFloor(tgt);

    // 最长公共前缀（gid 相同）
    let k = 0;
    while (cur.path[k + 1] !== undefined && cur.path[k + 1] === tgt.path[k + 1]) k++;

    const tgtGids = new Set(Object.values(tgt.path));
    const curLineByGid = {};
    for (let f = k + 1; f <= curMax; f++) curLineByGid[cur.path[f]] = body[f - 1];

    // 目标尾部：优先展开折叠组，其次复用 body 中现存的行（防御性：假想的重汇聚）
    const targetTail = [];
    for (let f = k + 1; f <= tgtMax; f++) {
        const gid = tgt.path[f];
        const folded = model.groups[gid];
        if (folded) {
            targetTail.push({ gid, line: lineFromGroup(folded), from: 'folded' });
        } else if (curLineByGid[gid]) {
            targetTail.push({ gid, line: curLineByGid[gid], from: 'body' });
        } else {
            throw new Error(`invariant: 目标分支楼层 ${f} 的组 "${gid}" 既不在 groups 也不在当前 body`);
        }
    }

    // 折叠：当前尾部中目标不需要的组 → groups（owner 为派生语义）
    for (let f = k + 1; f <= curMax; f++) {
        const gid = cur.path[f];
        if (!tgtGids.has(gid)) {
            const g = groupFromLine(gid, f, curLineByGid[gid]);
            g.owner = deriveOwner(model, gid);
            model.groups[gid] = g;
        }
    }
    // 展开：目标尾部中来自 groups 的组离开折叠态
    for (const t of targetTail) {
        if (t.from === 'folded') delete model.groups[t.gid];
    }

    // operations：尾部区段 remove（降序保索引）+ add（顺序插入）
    const operations = [];
    for (let i = curMax - 1; i >= k; i--) operations.push({ op: 'remove', path: bodyPath(i) });
    targetTail.forEach((t, j) => operations.push({ op: 'add', path: bodyPath(k + j), value: t.line }));

    model.active_branch = tgt.id;
    return { operations, model, switchedTo: tgt.id };
}

/* ---------------- 删除楼层 ---------------- */

/**
 * 全局删除楼层 F：模型重编号（deleteFloorEverywhere）+ 配对 body remove 操作。
 * RFC6902 对数组的 remove 自带「后续元素前移」语义，与楼层重编号一一对应。
 *
 * @returns {{operations: Array, model}}
 */
export function planDeleteFloor(model, floor, body) {
    if (!Number.isInteger(floor) || floor < 1) {
        throw new Error(`planDeleteFloor: 楼层 ${floor} 超出范围`);
    }
    const cur = getActive(model);
    const curMax = maxFloor(cur);
    const operations = [];
    if (floor <= curMax) {
        if (body[floor - 1] === undefined) {
            throw new Error(`planDeleteFloor: body 缺少第 ${floor} 层（行数 ${body.length}）`);
        }
        operations.push({ op: 'remove', path: bodyPath(floor - 1) });
    }
    deleteFloorEverywhere(model, floor);
    return { operations, model };
}
