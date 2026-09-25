/**
 * ChatFilesys — 回收站策略层（design.md §3.3，N15 裁定）
 *
 * 职责分工：后端读写由 storage 适配器承担（moveToTrash/listTrash/restoreFromTrash/deleteFromTrash），
 * 本模块是策略层：
 * - snapshotAndMove：先快照后移除的顺序保证（PARDON 安全语义：删除前必有可还原副本）
 * - purgeExpired：按 maxAgeMs 清理过期条目
 * - onPurge：清理后回调（波次2 挂 UI 刷新）
 *
 * 后端契约（适配器必须提供，见 adapter.js）：
 *   moveToTrash({source, content}) -> {ok, trashId}
 *   listTrash() -> [{trashId, source, movedAt}]
 *   restoreFromTrash({trashId}) -> {ok, content, source, movedAt}
 *   deleteFromTrash({trashId}) -> {ok}
 */

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 构造回收站策略层。
 * @param {{backend: object, maxAgeMs?: number}} options
 * @returns {{snapshotAndMove, purgeExpired, onPurge, listAll, restore}}
 */
export function createTrash({ backend, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
    if (!backend) throw new Error('createTrash: backend 缺失');
    const purgeListeners = [];

    /** 先快照（写回收站成功）→ 才允许移除源（顺序保证：回收站持有可还原副本） */
    async function snapshotAndMove({ source, content }) {
        const snap = await backend.moveToTrash({ source, content: String(content ?? '') });
        if (!snap?.ok) throw new Error(`回收站快照失败：${snap?.reason ?? 'unknown'}`);
        return snap;
    }

    /** 过期清理：movedAt + maxAgeMs < now 的条目逐个删除 */
    async function purgeExpired(now = Date.now()) {
        const items = await backend.listTrash();
        const expired = items.filter((x) => Number(x.movedAt ?? 0) + maxAgeMs < now);
        let purged = 0;
        for (const x of expired) {
            const r = await backend.deleteFromTrash({ trashId: x.trashId });
            if (r?.ok) purged++;
        }
        for (const cb of purgeListeners) {
            try { cb(purged); } catch { /* 监听器异常不阻断 */ }
        }
        return purged;
    }

    return {
        snapshotAndMove,
        purgeExpired,
        onPurge(cb) { purgeListeners.push(cb); },
        async listAll() { return backend.listTrash(); },
        async restore({ trashId }) { return backend.restoreFromTrash({ trashId }); },
        /** 单条立刻清理（N15「立刻清理」；策略层的唯一删除入口，不绕过它直接调后端） */
        async purge({ trashId }) { return backend.deleteFromTrash({ trashId }); },
    };
}
