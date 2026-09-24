/**
 * ChatFilesys — 存储适配器：接口契约 + 三档选档（design.md §2，N11 裁定）
 *
 * StorageAdapterAPI 契约（三档统一，duck-typed）：
 *   listFamilies({ characterId }) -> [{ familyId, name, updatedAt }]
 *   loadFamily({ familyId? , chatKey? }) -> family | null（未接管返回 null）
 *       family = { familyId, chatKey, characterId, name, integrity,
 *                  branches:[{id,name,is_default,fork_floor,parent_branch_id}],
 *                  branchPaths: { branchId: { floorNo: variantId } },
 *                  model }  // model = store-bridge 桥接出的现有 chatfilesys 模型形态
 *   renameFamily({ familyId, newName }) -> { ok, integrity }
 *   deleteFamily({ familyId }) -> { ok }
 *   loadFloors({ familyId, from, limit }) -> { floors:[{floorNo,variantId,seq,content,contentHash,sendDate}], hasMore }
 *   saveFloors({ familyId, floors, expectedIntegrity }) -> { ok, integrity } | { ok:false, conflict:true }
 *   applyOps({ familyId, ops, expectedIntegrity })   -> { ok, integrity } | { ok:false, conflict:true }
 *   moveToTrash({ source, content }) -> { ok, trashId }
 *   listTrash() -> [{ trashId, source, movedAt }]
 *   restoreFromTrash({ trashId, restoreTarget }) -> { ok }
 *   deleteFromTrash({ trashId }) -> { ok }
 *
 * integrity 语义：家族级递增计数；expectedIntegrity 非空且不匹配 → { ok:false, conflict:true }。
 * 选档（特性检测）：Authority SQL → 官方通道 → IndexedDB（L0-11 降级链）。
 */

import { createAuthorityAdapter } from './authority.js';
import { createOfficialAdapter } from './official.js';
import { createIdbAdapter } from './idb.js';

/**
 * 特性检测选档并构造适配器。
 * @param {{fetch?: Function, log?: Function, authorityClient?: object, getSettings?: Function}} ctx
 * @returns {Promise<{tier: 'authority'|'official'|'idb', adapter: object, dispose: Function}>}
 */
export async function createStorageAdapter(ctx = {}) {
    const log = ctx.log ?? console.warn;

    // 档1：Authority SQL（真分片库，性能最佳）
    if (ctx.authorityClient) {
        try {
            const adapter = await createAuthorityAdapter(ctx);
            return { tier: 'authority', adapter, dispose: adapter.dispose };
        } catch (e) {
            log('[chatfilesys-storage] Authority 档初始化失败，降级官方通道:', e);
        }
    }

    // 档2：官方 /api/chats/* 通道（隐藏聊天容器）
    if (typeof ctx.fetch === 'function') {
        try {
            const adapter = createOfficialAdapter(ctx);
            return { tier: 'official', adapter, dispose: adapter.dispose };
        } catch (e) {
            log('[chatfilesys-storage] 官方通道档初始化失败，降级 IndexedDB:', e);
        }
    }

    // 档3：IndexedDB（仅缓存，非事实源）
    const adapter = await createIdbAdapter(ctx);
    return { tier: 'idb', adapter, dispose: adapter.dispose };
}
