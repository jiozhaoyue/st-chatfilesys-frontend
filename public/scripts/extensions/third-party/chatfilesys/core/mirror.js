/**
 * ChatFilesys — 双写落盘器（design.md §4，裁定 Q3：防抖批量）
 *
 * 语义：**库是事实源**，磁盘上同时维持一份**标准聊天文件**（原生酒馆可直接打开）。
 * - 只写不读：读取与写入一律走库；不做「文件 → 库」的反向采纳（那是导入旅程的职责）。
 * - 落盘一律经 `seam.native`（绕开接缝）→ 不会自触发（design §9 的回环风险）。
 * - 写**纯标准 jsonl**：header 只带宿主字段（hostMetadata），**不带**本插件模型
 *   （带模型会让这份副本被误认成「增强模式」的文件）。
 * - 失败只 warn + 记状态，**不阻断聊天**（L0-11 静默降级）。
 *
 * 依赖注入（可单测）：`adapter` / `native` / `timers` 全部由调用方给，本模块不碰全局。
 */

import { projectionOf } from './patch-rows.js';
import { branchIdForKey } from './takeover.js';

/** 双写文件的主键拆分：`avatar::fileName` → { avatarUrl, fileName } */
export function splitChatKey(chatKey) {
    const [avatarUrl, ...rest] = String(chatKey || '').split('::');
    return { avatarUrl: avatarUrl || '', fileName: rest.join('::') || '' };
}

/**
 * 组装一份**标准聊天文件**的写入体（纯函数，可单测）。
 *
 * header 里的 chat_metadata = 家族保留的宿主内容（其他插件的命名空间照旧）+ 库内版本号；
 * **不含** `extensions.chatfilesys`——这份文件是给原生酒馆打开的副本，不是事实源。
 * `main_chat`（若有）来自家族级内容，键级的 main_chat 属于分支/检查点键，不落到主文件。
 *
 * @param {object} family 适配器 loadFamily 产物
 * @param {Array} floors 家族全部行
 * @returns {{ch_name: string, file_name: string, avatar_url: string, chat: Array, force: boolean}}
 */
export function buildMirrorSave(family, floors) {
    const { avatarUrl, fileName } = splitChatKey(family?.chatKey);
    const meta = { ...(family?.hostMetadata && typeof family.hostMetadata === 'object' ? family.hostMetadata : {}) };
    if (family?.integrity != null) meta.integrity = family.integrity;
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: meta };
    // 主文件 = 主键所在分支的投影（根聊天）；原生分支/检查点键各有各的绑定，不落文件
    const branchId = branchIdForKey(family, family.chatKey);
    const branch = family?.model?.branches?.find((b) => b.id === branchId);
    const rows = projectionOf(branch?.path, floors);
    return {
        ch_name: fileName,
        file_name: fileName,
        avatar_url: avatarUrl,
        chat: [header, ...rows],
        force: true, // 副本重建：允许覆盖既有文件（T2.4 真机实测点）
    };
}

/**
 * 创建双写落盘器。
 * @param {object} deps
 * @param {object} deps.adapter 存储适配器（读家族 + 读行）
 * @param {Function} deps.native 原生 fetch（绕开接缝；通常 = seam.native）
 * @param {Function} [deps.headers] 返回鉴权头（CSRF）
 * @param {Function} [deps.log]
 * @param {number} [deps.debounceMs] 防抖窗口（design §4：1.5 秒，与既有自动导出同节奏）
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] 定时器（测试注入假定时器）
 * @returns {{markDirty: Function, flushNow: Function, exportFamily: Function, state: object, dispose: Function}}
 */
export function createMirror(deps) {
    const adapter = deps.adapter;
    const native = deps.native;
    const log = deps.log ?? console.warn;
    const headers = typeof deps.headers === 'function' ? deps.headers : () => ({ 'Content-Type': 'application/json' });
    const debounceMs = deps.debounceMs ?? 1500;
    const timers = deps.timers ?? { setTimeout, clearTimeout };

    const dirty = new Map(); // familyId → chatKey（提示用；实际以家族记录为准）
    const state = {
        pending: false, // 有未落盘的改动（「文件落后」提示的数据源）
        writing: false,
        lastWrittenAt: null,
        lastWrittenFamily: null,
        lastError: null,
        writeCount: 0,
    };
    let timer = null;

    /** 写成功后标脏（seam 的成功写回调）→ 防抖批量落盘 */
    function markDirty(evt) {
        if (!evt?.familyId) return;
        dirty.set(evt.familyId, evt.chatKey || null);
        state.pending = true;
        if (timer) timers.clearTimeout(timer);
        timer = timers.setTimeout(() => { timer = null; flushNow(); }, debounceMs);
    }

    /** 立刻落盘所有脏家族（设置页「与库同步一次」/ 模式切换动作也走这里） */
    async function flushNow() {
        if (timer) { timers.clearTimeout(timer); timer = null; }
        const entries = [...dirty.entries()];
        dirty.clear();
        const results = [];
        for (const [familyId] of entries) {
            results.push(await exportFamily(familyId));
        }
        state.pending = dirty.size > 0;
        return results;
    }

    /**
     * 把某个家族当前分支落成标准聊天文件（单家族；失败只记状态不抛）。
     * @returns {{ok: boolean, reason?: string}}
     */
    async function exportFamily(familyId) {
        state.writing = true;
        try {
            const family = await adapter.loadFamily({ familyId });
            if (!family) return { ok: false, reason: 'family-not-found' };
            const { floors } = await adapter.loadFloors({ familyId, from: 0, limit: 100000 });
            const body = buildMirrorSave(family, floors);
            const res = await native('/api/chats/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers() },
                body: JSON.stringify(body),
            });
            if (!res?.ok) throw new Error(`/api/chats/save HTTP ${res?.status}`);
            state.lastWrittenAt = Date.now();
            state.lastWrittenFamily = family.chatKey || familyId;
            state.lastError = null;
            state.writeCount += 1;
            return { ok: true };
        } catch (e) {
            state.lastError = String(e?.message || e);
            log('[chatfilesys-mirror] 落文件失败（不阻断，库仍是事实源）:', e);
            return { ok: false, reason: state.lastError };
        } finally {
            state.writing = false;
        }
    }

    /** 按聊天键落盘（模式切换动作：切过去/切回来之前先把当前聊天写一份） */
    async function exportByChatKey(chatKey) {
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return { ok: false, reason: 'not-in-library' };
        return exportFamily(family.familyId);
    }

    return {
        markDirty,
        flushNow,
        exportFamily,
        exportByChatKey,
        state,
        dispose() {
            if (timer) { timers.clearTimeout(timer); timer = null; }
            dirty.clear();
        },
    };
}
