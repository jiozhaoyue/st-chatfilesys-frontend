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
 *         原生「创建分支/检查点」键各自代表家族里的一条分支；`loadFamily({chatKey})` 命中
 *         主键之外的**绑定键**时也要返回其所属家族（三档索引容器同步扩展）。
 *   createFamily({ family }) -> { ok, familyId, integrity }（导入旅程建档；familyId 冲突返回 {ok:false}）
 *   bindChatKey({ familyId, chatKey }) -> { ok }（official 档重启后重联：chatKey→familyId 登记进容器 meta）
 *   renameFamily({ familyId, newName }) -> { ok, integrity }
 *   deleteFamily({ familyId }) -> { ok }
 *   loadFloors({ familyId, from, limit }) -> { floors:[{floorNo,variantId,seq,content,contentHash,sendDate}], hasMore }
 *   saveFloors({ familyId, floors, expectedIntegrity }) -> { ok, integrity } | { ok:false, conflict:true }
 *   applyOps({ familyId, ops, model?, branchId?, targetBranchId?, hostMetadata?, keyBindings?, expectedIntegrity }) -> { ok, integrity, totalMessages }
 *     | { ok:false, conflict:true } | { ok:false, reason, detail }
 *     - 消息补丁（T0b）：ops 是挂在**按投影基准分支投影出来的 body 数组**上的 RFC6902（可含 `/N/字段` 深路径），
 *       语义（投影 → 应用 → 按键写回 / 全局删层 / 重投影）统一由 `core/patch-rows.js` 实现，三档只是落库手法不同。
 *     - model：**只有切分支时**由 seam 传入（目标分支决定重投影结构）；未传表示以库内模型为准。
 *     - branchId（T1）：**投影基准分支**（ops 的下标是对着它的 body 算的）。未传 = 活跃分支；
 *       原生分支/检查点键必须传该键所在分支，否则在分支聊天里改消息会写错行。
 *     - targetBranchId（W6）：**结构收敛目标分支**（补丁之后 body 应等于它的投影，被改写的 path 也是它）。
 *       切分支时 = 目标分支，而 branchId 仍是**切换前**那条（ops 是对着旧 body 算的）；不切换时两者相同。
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
 *
 * **降级归因（quality-guidelines「降级归因」节）**：每一档的尝试结果都随返回值给出
 * （`attempts`），**真原因必须落在返回值上**，不能只交给 `log` 回调——调用方要能
 * 报出「为什么没落到更高一档」，否则故障看起来像一切正常。
 * 档1 的失败原因由调用方（编排层）传入 `authorityReason`：只有它知道 probe / init 的实情，
 * 本模块不替它编一个泛化标记。
 *
 * @param {{fetch?: Function, log?: Function, authorityClient?: object, authorityReason?: string,
 *          getSettings?: Function}} ctx
 * @returns {Promise<{tier: 'authority'|'official'|'idb', adapter: object, dispose: Function,
 *                    attempts: Array<{tier: string, ok: boolean, reason?: string}>}>}
 *   `attempts` 按尝试顺序排列（含选中那一档，其 `ok:true`）；未尝试的档不出现在其中。
 *   例：SDK 缺失 → `[{tier:'authority', ok:false, reason:'sdk-missing'}, {tier:'official', ok:true}]`
 */
export async function createStorageAdapter(ctx = {}) {
    const log = ctx.log ?? console.warn;
    const attempts = [];

    // 档1：Authority SQL（真分片库，性能最佳）
    if (!ctx.authorityClient) {
        attempts.push({ tier: 'authority', ok: false, reason: ctx.authorityReason || 'no-client' });
    } else {
        try {
            const adapter = await createAuthorityAdapter(ctx);
            attempts.push({ tier: 'authority', ok: true });
            return { tier: 'authority', adapter, dispose: adapter.dispose, attempts };
        } catch (e) {
            attempts.push({ tier: 'authority', ok: false, reason: `init-failed: ${e?.message || e}` });
            log('[chatfilesys-storage] Authority 档初始化失败，降级官方通道:', e);
        }
    }

    // 档2：官方 /api/chats/* 通道（隐藏聊天容器）
    if (typeof ctx.fetch !== 'function') {
        attempts.push({ tier: 'official', ok: false, reason: 'no-fetch' });
    } else {
        try {
            const adapter = await createOfficialAdapter(ctx);
            attempts.push({ tier: 'official', ok: true });
            return { tier: 'official', adapter, dispose: adapter.dispose, attempts };
        } catch (e) {
            attempts.push({ tier: 'official', ok: false, reason: `init-failed: ${e?.message || e}` });
            log('[chatfilesys-storage] 官方通道档初始化失败，降级 IndexedDB:', e);
        }
    }

    // 档3：IndexedDB（仅缓存，非事实源）—— 最后一档，构造失败即向上抛（由调用方接住退回增强模式）
    const adapter = await createIdbAdapter(ctx);
    attempts.push({ tier: 'idb', ok: true });
    return { tier: 'idb', adapter, dispose: adapter.dispose, attempts };
}
