/**
 * ChatFilesys — 分支改名后的宿主文件名对齐（W4，design.md §5.6 不变式 3）
 *
 * 判据（用户 2026-09-26 裁定「纯库下不调酒馆接口」）：**磁盘上真有这个聊天文件吗**。
 * 纯库/双写下绑定键在磁盘上**从来没有文件**（T1 接管不落盘；双写只落主键），
 * 对不存在的文件调 `/api/chats/rename` 必然失败；而且文件名没变时也**不该**迁移键绑定（键没变）。
 * 只有「历史上真落过这份文件」（例如切到纯库模式**之前**在增强模式里建过这个分支）才需要同步改名。
 *
 * 依赖注入（无 DOM、无网络、无适配器依赖，可单测）：
 * - `fileExists(fileName)`：磁盘探测（宿主 `/api/chats/search`，走原生通道）
 * - `renameHost({oldFile, newFile, avatarUrl})`：调宿主 `/api/chats/rename`（绕开接缝）
 * - `saveBindings(nextBindings)`：键绑定落库
 */

import { boundKeysOfBranch, migrateBindingKey } from './key-bindings.js';

/**
 * @param {object} args
 * @param {object|null} args.keyBindings 家族键绑定表
 * @param {string} args.branchId 被改名的分支
 * @param {string} args.newName 新分支名（= 期望的新文件名主体）
 * @param {string} args.avatarUrl 角色卡头像（宿主 `/rename` 需要）
 * @param {(fileName: string) => Promise<boolean>} args.fileExists 磁盘上有没有该文件（失败按「没有」处理）
 * @param {(args: {oldFile: string, newFile: string, avatarUrl: string}) => Promise<{ok: boolean, status?: number, file?: string}>} args.renameHost
 * @param {(nextBindings: object) => Promise<{ok: boolean, reason?: string}>} args.saveBindings
 * @param {(fileName: string) => string} args.chatKeyOf 文件名 → 聊天键
 * @param {Function} [args.log]
 * @returns {Promise<{ok: boolean, reason?: string, newKey?: string}>}
 */
export async function alignHostFileName({
    keyBindings, branchId, newName, avatarUrl, fileExists, renameHost, saveBindings, chatKeyOf, log = () => {},
}) {
    const bound = boundKeysOfBranch(keyBindings, branchId);
    if (!bound.length) return { ok: false, reason: 'no-binding' }; // 库内新建的分支没有绑定键 → 无事可做
    if (bound.length > 1) log(`分支 ${branchId} 有 ${bound.length} 个绑定键，只同步第一个`);

    const [[oldKey]] = bound;
    const oldFile = String(oldKey).split('::').pop();
    // 判据：磁盘上没有该文件（含探测失败）→ 只改库内分支名，不调宿主接口、不迁移键绑定
    if (!(await fileExists(oldFile))) return { ok: false, reason: 'no-file' };

    let res;
    try {
        res = await renameHost({ oldFile, newFile: newName, avatarUrl });
    } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
    }
    if (!res?.ok) return { ok: false, reason: `宿主 /api/chats/rename HTTP ${res?.status}` };

    // 宿主可能对文件名做净化 → 用宿主回给的名字建新键
    const newFile = String(res.file || newName);
    const newKey = chatKeyOf(newFile);
    if (newKey === oldKey) return { ok: true, newKey }; // 净化后仍是同一个名字 → 绑定无需迁移
    const next = migrateBindingKey(keyBindings, oldKey, newKey);
    // 新键已被别的绑定占用 → 无法迁移：文件名已改而绑定没跟过去 = 映射断裂，如实报错（不静默 ok）
    if (!next) return { ok: false, reason: 'binding-key-conflict' };
    const r = await saveBindings(next);
    if (!r?.ok) return { ok: false, reason: `键绑定迁移失败（${r?.reason || 'conflict'}）` };
    return { ok: true, newKey };
}
