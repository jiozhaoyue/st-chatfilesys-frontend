/**
 * ChatFilesys — 存储适配器：接口契约 + 三档选档（design.md §2，N11 裁定）
 *
 * StorageAdapterAPI 契约（三档统一，duck-typed）：
 *   listFamilies({ characterId }) -> [{ familyId, name, updatedAt }]
 *   loadFamily({ familyId? , chatKey? }) -> family | null（未接管返回 null）
 *       family = { familyId, chatKey, characterId, name, integrity,
 *                  hostMetadata, keyBindings,
 *                  branches:[{id,name,is_default,fork_floor,parent_branch_id}],
 *                  branchPaths: { branchId: { floorNo: variantId } },
 *                  model }  // model = store-bridge 桥接出的现有 chatfilesys 模型形态
 *       - keyBindings（T1）：`{ [chatKey]: { branchId, isCheckpoint?, markerFloor? } }`——
 *         原生「创建分支/检查点」键各自代表家族里的一条走法；`loadFamily({chatKey})` 命中
 *         主键之外的**绑定键**时也要返回其所属家族（三档索引容器同步扩展）。
 *   createFamily({ family }) -> { ok, familyId, integrity }（导入旅程建档；familyId 冲突返回 {ok:false}）
 *   bindChatKey({ familyId, chatKey }) -> { ok }（official 档重启后重联：chatKey→familyId 登记进容器 meta）
 *   renameFamily({ familyId, newName }) -> { ok, integrity }
 *   deleteFamily({ familyId }) -> { ok }
 *   loadFloors({ familyId, from, limit }) -> { floors:[{floorNo,variantId,seq,content,contentHash,sendDate}], hasMore }
 *   saveFloors({ familyId, floors, expectedIntegrity }) -> { ok, integrity } | { ok:false, conflict:true }
 *   applyOps({ familyId, ops, model?, branchId?, hostMetadata?, keyBindings?, expectedIntegrity }) -> { ok, integrity, totalMessages }
 *     | { ok:false, conflict:true } | { ok:false, reason, detail }
 *     - 消息补丁（T0b）：ops 是挂在**按活跃走法投影出来的 body 数组**上的 RFC6902（可含 `/N/字段` 深路径），
 *       语义（投影 → 应用 → 按键写回 / 全局删层 / 重投影）统一由 `core/patch-rows.js` 实现，三档只是落库手法不同。
 *     - model：**只有走法切换时**由 seam 传入（目标走法决定重投影结构）；未传表示以库内模型为准。
 *     - branchId（T1）：投影基准走法（ops 的下标是对着它的 body 算的）。未传 = 活跃走法；
 *       原生分支/检查点键必须传该键所在走法，否则在分支聊天里改消息会写错行。
 *     - hostMetadata / keyBindings：undefined = 不动它（同 saveModel）。
 *     - 失败语义：`test-failed`（库内容与宿主假设不符）→ seam 映射 409；其余 reason → 400（宿主自行回退全量保存）。
 *   saveModel({ familyId, model, hostMetadata, keyBindings, expectedIntegrity, keepCurrent }) -> { ok, integrity } | { ok:false, conflict:true }
 *     - hostMetadata（T0/R0）：聊天头保留面——宿主与其他插件写进 chat_metadata 的内容整份留库、读时回显；
 *       传 undefined 表示「本次不动它」，传对象表示覆盖。本插件自己的两项（extensions.chatfilesys 与 integrity）不在其中。
 *     - keyBindings（T1）：键绑定整份覆盖；传 undefined 表示不动它。
 *       model = store-bridge 模型形态（{active_branch, branches:[{...,path}], groups}）；
 *       持久化模型本体（active_branch/groups 不丢失）+ 同步重建 branches/branchPaths 结构表；
 *       keepCurrent=true 时忽略 model、保留现模型仅 bump integrity（chats/meta/patch 防漏写用）。
 *   moveToTrash({ source, content }) -> { ok, trashId }
 *   listTrash() -> [{ trashId, source, movedAt }]
 *   restoreFromTrash({ trashId, restoreTarget }) -> { ok }
 *   deleteFromTrash({ trashId }) -> { ok }
 *
 * integrity 语义（T1/N19）：家族级**字符串**版本号，每次成功写生成一个新值；入向
 * expectedIntegrity 与库内值**字符串相等**才允许写，不等 → { ok:false, conflict:true }（409）。
 * 调用方未带（null）= 不锁；库内为空（家族尚未写过）= 放行首次写。判定统一走 `core/integrity.js`。
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
            const adapter = await createOfficialAdapter(ctx);
            return { tier: 'official', adapter, dispose: adapter.dispose };
        } catch (e) {
            log('[chatfilesys-storage] 官方通道档初始化失败，降级 IndexedDB:', e);
        }
    }

    // 档3：IndexedDB（仅缓存，非事实源）
    const adapter = await createIdbAdapter(ctx);
    return { tier: 'idb', adapter, dispose: adapter.dispose };
}
