/**
 * ChatFilesys — 原生「创建分支 / 创建检查点」接管判定（design.md §2，裁定 N22：拦在建键之前）
 *
 * 问题：宿主点原生按钮时会**先落一个复制文件**（`chats/save` 到一个新键），走法只存在于
 * 那个文件里。纯库模式下不要文件、要库内走法，所以必须在写路径的「未命中家族」分支里
 * 认出「这次写的是某个已是家族聊天的新分支/检查点」，并把落点改成库内一条新走法。
 *
 * 识别依据（真机事实，`.history/.../01-branch-creation-flow`、`02-checkpoint-creation-flow`）：
 *  1. 宿主写新键时正文首行 header 的 `chat_metadata.main_chat` = 当前聊天键（父线索，权威）
 *  2. 正文（去 header 后的行序列）必须是**父走法当前投影的逐行前缀**（保守闸门：宁可透传不误吞）
 *  3. 类型：分支名由宿主 `buildBranchName` 自动生成，**用户不可改** → 形如 `X - Branch #<n>`；
 *     检查点名**用户可改**（弹窗留空才是 `X - Checkpoint #<n>`）→ 命中分支样式即分支，其余即检查点。
 *     （`main_chat` 只由分支/检查点两条路径写入，故「非分支样式 ⇒ 检查点」不会误判别的功能。）
 *
 * 纯函数：无 DOM、无网络、无适配器依赖，可单测。
 */

import { createBranch } from './branches.js';

/** 宿主自动生成的分支名（bookmarks.js buildBranchName） */
export const BRANCH_NAME_RE = / - Branch #\d+$/i;
/** 宿主自动生成的检查点名（bookmarks.js buildCheckpointName，仅留空时使用） */
export const CHECKPOINT_NAME_RE = / - Checkpoint #\d+$/i;

/**
 * 新键的类型判定。
 * @param {string} fileName 宿主写请求里的文件名（键）
 * @returns {'branch'|'checkpoint'}
 */
export function classifyNewChat(fileName) {
    return BRANCH_NAME_RE.test(String(fileName || '').replace(/\.jsonl$/i, '')) ? 'branch' : 'checkpoint';
}

/** 走法 path 的楼层数（path 的键是 1..N 连续楼层号） */
function floorsOf(path) {
    return Object.keys(path || {}).length;
}

/**
 * 逐行前缀校验：入向行序列必须是父走法投影的**逐行相同前缀**。
 * 用 JSON 序列化比对（键序由两侧解析顺序决定，宿主克隆出的行与我们存的同源）。
 * @param {Array<object>} rows 入向正文行（已去 header）
 * @param {Array<string>} parentContents 父走法投影行的 content 字符串（楼层 1..N 顺序）
 * @returns {{ok: true} | {ok: false, reason: string, firstDiff?: number}}
 */
export function checkPrefix(rows, parentContents) {
    if (!rows.length) return { ok: false, reason: '正文为空' };
    if (rows.length > parentContents.length) {
        return { ok: false, reason: `正文 ${rows.length} 行超过父走法 ${parentContents.length} 层` };
    }
    for (let i = 0; i < rows.length; i++) {
        if (JSON.stringify(rows[i]) !== parentContents[i]) {
            return { ok: false, reason: `第 ${i + 1} 层内容不是父走法前缀`, firstDiff: i };
        }
    }
    return { ok: true };
}

/**
 * 接管计划（纯函数）：判定通过时给出「库内该怎么改」。
 *
 * 关键取舍（**偏离 design.md §2.2 的写法，理由见下**）：
 * 接管**不改 `model.active_branch`**，只登记 `keyBindings`。原因：父键在改之前是靠
 * `active_branch` 解析的，若把它切到新走法，用户点「返回父聊天」回到父键时会被投影到
 * 新走法（只剩截断前缀）——内容就错了。改为「键 → 走法」显式绑定后：
 *   父键仍按 `active_branch` 解析（接管不动它 → 内容 = 完整历史）；
 *   新键按自己的绑定解析（内容 = 到分叉点为止）。
 * 父键**不**建绑定：`active_branch` 是 UI「切换走法」的作用面，父键跟随它才是用户预期；
 * 给父键建死绑定反而会让 UI 的切换看起来没生效。
 * 检查点与分支在这条规则下天然同构，唯一差别是检查点额外带 `is_checkpoint` / `marker_floor`
 * 标记与键绑定上的 `mainChat`（见下）。
 *
 * `mainChat`（AC11 的关键）：宿主靠 `chat_metadata.main_chat` 驱动「返回父聊天」。每个
 * 分支/检查点文件在原生形态下**各自**带一个 main_chat（指向它的父），而家族级的
 * `hostMetadata` 是所有键共用的——把 main_chat 混进家族级会让「根聊天」也冒出一个
 * 返回父聊天按钮。故 main_chat **按键**存进绑定，读该键时覆盖回显。
 *
 * @param {object} args
 * @param {'branch'|'checkpoint'} args.kind
 * @param {Array<object>} args.rows 入向正文行（已去 header）
 * @param {Array<string>} args.parentContents 父走法投影行的 content 字符串
 * @param {object} args.parentModel 父家族模型（store-bridge 形态）
 * @param {string} args.parentBranchId 分叉来源走法（父键当前所在的走法）
 * @param {string} args.parentKey 父键（仅用于日志/诊断）
 * @param {string} args.newKey 新键
 * @param {string} args.fileName 新键文件名（走法名用）
 * @param {string} args.mainChat 宿主给的父聊天名（原样存，读回时原样回显）
 * @param {object} [args.parentBindings] 父家族已有键绑定
 * @returns {{ok: true, kind: string, model: object, keyBindings: object, branchId: string, forkFloor: number}
 *          | {ok: false, reason: string, firstDiff?: number}}
 */
export function planTakeover({
    kind, rows, parentContents, parentModel, parentBranchId, parentKey, newKey, fileName, mainChat, parentBindings,
}) {
    const pre = checkPrefix(rows, parentContents);
    if (!pre.ok) return pre;

    const model = structuredClone(parentModel);
    const prevActive = model.active_branch;
    // 分叉来源 = 父键当前所在的走法（父键可能只是家族里的一个分支键，不一定是 active_branch）
    model.active_branch = parentBranchId;
    const forkFloor = rows.length;
    let branch;
    try {
        branch = createBranch(model, {
            name: String(fileName || '').replace(/\.jsonl$/i, ''),
            forkFloor,
            // 分支/检查点都不在此处切换：切换与否由「宿主随后打开哪个键」体现，
            // 而库内解析按键绑定走（改 active_branch 会污染父键的投影，见函数头注释）
            activate: false,
        });
    } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
    }
    model.active_branch = prevActive;

    if (kind === 'checkpoint') {
        branch.is_checkpoint = true;
        branch.marker_floor = forkFloor;
    }
    const keyBindings = { ...(parentBindings || {}) };
    keyBindings[newKey] = {
        branchId: branch.id,
        mainChat: mainChat != null ? String(mainChat) : null,
        ...(kind === 'checkpoint' ? { isCheckpoint: true, markerFloor: forkFloor } : {}),
    };
    return { ok: true, kind, model, keyBindings, branchId: branch.id, forkFloor };
}

/**
 * 按聊天键解析「这次读写作用于哪条走法」。
 * 键绑定优先（原生分支/检查点键各自代表一条走法），无绑定回落到家族活跃走法
 * （导入建档的主键、以及 UI 在某个键上切换走法后由该键绑定跟随的情形）。
 * @param {{model?: object, keyBindings?: object}} family
 * @param {string} chatKey
 * @returns {string|null} branchId
 */
export function branchIdForKey(family, chatKey) {
    const bound = chatKey != null ? family?.keyBindings?.[chatKey]?.branchId : null;
    return bound ?? family?.model?.active_branch ?? null;
}
