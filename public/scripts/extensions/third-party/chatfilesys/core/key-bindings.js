/**
 * ChatFilesys — 键绑定纯函数（T4r.9 分支改名双向对齐 / T9 设为主分支）
 *
 * 术语（全仓统一）：「分支（branch）」= swipe 组的归属；「swipe」= 滑动；
 * 「swipe 组 / 组」= 某楼层的一份内容，该层有多个组 = 该层就是分叉点。
 *
 * 背景（design.md §5.6 不变式 3）：原生「创建分支 / 创建检查点」键各自绑定家族里的一条分支；
 * 库内改分支名时**必须**同步改绑定键的文件名，否则映射断裂（用户 2026-09-25 裁定「双向对齐」）。
 * 迁移 = `keyBindings` 里把旧键搬到新键，绑定值原样带走（branchId / mainChat / 检查点标记）。
 *
 * T9 追加：`setBindingBranch` —— 把某个键（主分支场景 = 家族主键）的绑定改指到目标分支。
 *
 * N1 追加：`pinActiveForBoundKey` —— 某次写入里的模型改动归谁（键绑定 vs 家族级），
 * 含「主键上的切换要迁 `is_default`」这条不变式的落地点（原先住在 `core/seam.js`，
 * 因为它是按**键的性质**分流的判断，与绑定表同源）。
 *
 * 纯函数：无 DOM、无网络；宿主 `/api/chats/rename` 的调用留在 index.js（I/O 与降级都在那里）。
 */

import { setDefaultBranch } from './branches.js';

/**
 * 某条走法的全部绑定键（T1 接管下通常 0 或 1 个）。
 * @param {object|null} keyBindings `{ [chatKey]: { branchId, mainChat?, isCheckpoint?, markerFloor? } }`
 * @param {string} branchId
 * @returns {Array<[string, object]>} [chatKey, binding] 列表（保持原键序）
 */
export function boundKeysOfBranch(keyBindings, branchId) {
    if (!keyBindings || !branchId) return [];
    return Object.entries(keyBindings).filter(([, v]) => v?.branchId === branchId);
}

/**
 * 键迁移：`oldKey` → `newKey`，绑定值原样带走。
 *
 * 保守语义（返回 `null` = 本次不迁移，调用方保持原状）：
 * - 任一侧为空、或新旧键相同 → null（无事可做）
 * - `oldKey` 不在表里 → null（没有可迁的绑定）
 * - `newKey` 已被占用 → null（**不覆盖**别人的绑定；改名与文件重名同性质，宁可不迁）
 *
 * @param {object|null} keyBindings
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {object|null} 新的 keyBindings（调用方落库）
 */
export function migrateBindingKey(keyBindings, oldKey, newKey) {
    if (!keyBindings || !oldKey || !newKey || oldKey === newKey) return null;
    if (!Object.hasOwn(keyBindings, oldKey)) return null;
    if (Object.hasOwn(keyBindings, newKey)) return null;
    const next = { ...keyBindings };
    const binding = next[oldKey];
    delete next[oldKey];
    next[newKey] = { ...binding };
    return next;
}

/**
 * 把某个聊天键的绑定改指到目标分支（T9 / R8.3「设为主分支」用）。
 *
 * 语义：**主键（家族主聊天键）绑在哪条分支上，打开这个聊天就看到哪条分支的内容**。
 * 换主分支 = 把主键的绑定改到目标分支 + 目标分支 `is_default = true`（模型侧由
 * `core/branches.js#setMainBranch` 负责），两者同一次写入落库，保证不变量
 * 「家族恰有一条 `is_default`，且它 = 主键绑定所在分支」。
 *
 * 保守语义（返回 `null` = 本次不动 keyBindings）：
 * - 缺 key / 缺 branchId → null
 * - 该键已指向目标分支 → null（不做无谓写入，也就不会白增版本号）
 *
 * 已有的键上字段（`mainChat` / `isCheckpoint` / `markerFloor`）原样保留——
 * 换主分支只改「看哪条分支」，不改这个键的父聊天线与检查点标记。
 *
 * @param {object|null} keyBindings
 * @param {string} chatKey 目标键（主分支场景 = 家族主键）
 * @param {string} branchId 目标分支
 * @returns {object|null} 新的 keyBindings（调用方落库）
 */
export function setBindingBranch(keyBindings, chatKey, branchId) {
    if (!chatKey || !branchId) return null;
    const kb = keyBindings && typeof keyBindings === 'object' ? keyBindings : {};
    const cur = kb[chatKey];
    if (cur?.branchId === branchId) return null;
    return { ...kb, [chatKey]: { ...(cur || {}), branchId: String(branchId) } };
}

/**
 * 入向模型的 `active_branch` **归属**（T1 起；N1 于 2026-09-26 按用户裁定收紧）。
 *
 * 家族只有**一个** `active_branch`，而根键没有绑定、靠它解析投影。若绑定键（原生分支/检查点键）
 * 上的切换把它带跑，用户点「返回父聊天」回到根键时会看到**截断内容**。故按**键的性质**分流：
 *   · 非绑定键（根键）→ 原样返回：那里的切换就是家族级切换，语义正确
 *   · 绑定键 + **非主键** → pin 回家族活跃分支（该键只改自己的绑定，见 `core/seam.js#followKeyBinding`）
 *   · 绑定键 + **主键** → 不 pin（家族活跃分支跟走），并让**主分支标记**跟着迁到目标分支
 *
 * 主键那条是 N1（用户 2026-09-26 复现）：把 B 设为主分支后（主键因此有了指向 B 的绑定），
 * 在结构树上普通切到 C → 绑定改到 C、`is_default` 还留在 B → 面板把 B 标成「（主分支）」，
 * 而删除按钮对**正在看的 C** 可点（删掉 C，内容无声跳回 B）。不变式（R8.3）：
 * 「恰有一条 `is_default`，且它 = 主键绑定所在分支」。
 *
 * 只有「入向确实在换分支」（`active_branch` 与库内不同）才动手：宿主内存里的模型副本可能是旧版，
 * 那不算切换（`core/seam.js#modelSwitchesBranch` 同一前提）。
 *
 * @param {{chatKey?: string, keyBindings?: object, model?: object}|null} family 库内家族
 * @param {string|null} chatKey 本次请求的聊天键
 * @param {object|null} incomingModel 入向模型（chat_metadata.extensions.chatfilesys）
 * @returns {object|null} 落库用的模型（未改动时 = 入向那份）
 */
export function pinActiveForBoundKey(family, chatKey, incomingModel) {
    if (!incomingModel || chatKey == null) return incomingModel ?? null;
    if (!family?.keyBindings?.[chatKey]) return incomingModel;
    const stored = family?.model?.active_branch;
    if (!stored || stored === incomingModel.active_branch) return incomingModel;
    if (family?.chatKey === chatKey) {
        const next = structuredClone(incomingModel);
        try {
            setDefaultBranch(next, incomingModel.active_branch);
        } catch {
            return incomingModel; // 目标分支不存在等异常：切换照常落库，标记不动
        }
        return next;
    }
    return { ...incomingModel, active_branch: stored };
}

/**
 * 删除某条分支时清掉它的全部绑定键（design.md §5.6 不变式 2：`keyBindings[chatKey].branchId`
 * 必须在 `branches` 里存在——分支已删、绑定还在就是悬挂绑定，宿主打开该键会读到错的分支）。
 *
 * 保守语义（返回 `null` = 本次不动 keyBindings）：
 * - 无表 / 无 branchId → null
 * - 该分支没有绑定键 → null（库内新建的分支就是这种，不做无谓写入）
 *
 * @param {object|null} keyBindings
 * @param {string} branchId
 * @returns {object|null} 新的 keyBindings（调用方落库）
 */
export function dropBindingsOfBranch(keyBindings, branchId) {
    if (!keyBindings || !branchId) return null;
    const bound = boundKeysOfBranch(keyBindings, branchId);
    if (!bound.length) return null;
    const next = { ...keyBindings };
    for (const [k] of bound) delete next[k];
    return next;
}
