/**
 * ChatFilesys — 入库提醒的判定与压制（T8 / R8.1 / AC21）
 *
 * 打开一个**尚未录入数据库**的聊天时提醒用户走入库流程（用户 2026-09-26 裁定：
 * 「默认是增强，但是强制弹出弹窗，提醒装库流程，选择是否转换到数据库，然后继续走」）。
 *
 * 弹窗控件（用户 2026-09-26 重裁定按钮摆法）：
 *   · 两个**模式短按钮**「纯库」/「双写」—— 点哪个就按那种模式把这个聊天转入库；
 *   · 小字次按钮「不入库」（本次不转；关闭 X/Esc 等同它）；
 *   · 两个**小勾选**「这个聊天不再提醒」「全部不再提醒」——落点是压制记录，与按钮可以同时生效。
 *
 * 纯函数：无 DOM、无网络、无适配器依赖，可单测。弹窗本体在 `ui/import-prompt.js`，
 * 压制记录的读写留在 `index.js`（它才是 extension_settings 的持有者）。
 *
 * 压制记录放 `extension_settings.chatfilesys.import_prompt`，**不写进聊天记录**——
 * 它是「本机的提醒偏好」，不属于聊天内容（写进聊天头会被别的插件/宿主来回搬运）。
 */

/** 弹窗按钮的三种取向（→ index.js 分流） */
export const IMPORT_PROMPT_MODE = {
    PURE: 'pure',       // 「纯库」：按纯库模式转入库
    MIRROR: 'mirror',   // 「双写」：按双写模式转入库（库为事实源 + 磁盘留标准聊天文件）
    SKIP: 'skip',       // 「不入库」/ 关闭窗口：本次不转
};

/**
 * 归一压制记录（缺字段/旧形态/脏数据都收敛成固定形状）。
 * @param {{never?: unknown, mutedKeys?: unknown}|null|undefined} raw
 * @returns {{never: boolean, mutedKeys: string[]}} 去重、去空、恒为新对象
 */
export function normImportPrompt(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const muted = Array.isArray(r.mutedKeys)
        ? [...new Set(r.mutedKeys.map((x) => String(x ?? '')).filter(Boolean))]
        : [];
    return { never: Boolean(r.never), mutedKeys: muted };
}

/**
 * 该聊天键是否已被压制。
 * @param {object|null} prompt 压制记录（未归一也行）
 * @param {string} chatKey
 * @returns {boolean} `never` 一律压制；否则看该键是否在 `mutedKeys` 里
 */
export function isImportPromptMuted(prompt, chatKey) {
    const p = normImportPrompt(prompt);
    if (p.never) return true;
    return Boolean(chatKey) && p.mutedKeys.includes(String(chatKey));
}

/**
 * 是否要弹入库提醒。
 *
 * 判定顺序（任一不满足即不弹）：
 *   ① 有聊天键（拿不到键就无从判断「这个聊天」是谁）
 *   ② 不是群聊（群聊端点不在接缝路由内，保持原生，R0）
 *   ③ 当前没有别的弹窗在场（不叠窗、不打断用户正在做的事）
 *   ④ 该键在库里**没有**家族（已入库的聊天无需提醒）
 *   ⑤ 未被压制（`never` 或该键在 `mutedKeys` 里）
 *
 * @param {object} args
 * @param {object|null} args.prompt 压制记录
 * @param {string} args.chatKey 当前聊天键（`角色::文件名`）
 * @param {boolean} args.inLibrary 该键在库里已有家族？（库模式未启用时一律 false）
 * @param {boolean} [args.isGroupChat]
 * @param {boolean} [args.hasDialogOpen] 页面上已有打开的 dialog
 * @returns {boolean}
 */
export function shouldPromptImport({
    prompt, chatKey, inLibrary, isGroupChat = false, hasDialogOpen = false,
} = {}) {
    if (!chatKey) return false;
    if (isGroupChat) return false;
    if (hasDialogOpen) return false;
    if (inLibrary) return false;
    return !isImportPromptMuted(prompt, chatKey);
}

/**
 * ③「这个聊天不再提醒」：把该键记进 `mutedKeys`。
 * @returns {{never: boolean, mutedKeys: string[]}} 新的压制记录（调用方落盘）
 */
export function muteImportPromptKey(prompt, chatKey) {
    const p = normImportPrompt(prompt);
    if (!chatKey) return p;
    const key = String(chatKey);
    if (p.mutedKeys.includes(key)) return p;
    return { never: p.never, mutedKeys: [...p.mutedKeys, key] };
}

/**
 * ④「完全不再提醒」：一律不弹（连同已记的键一起保留，便于将来取消压制时逐键恢复）。
 * @returns {{never: boolean, mutedKeys: string[]}}
 */
export function muteImportPromptAll(prompt) {
    const p = normImportPrompt(prompt);
    return { never: true, mutedKeys: p.mutedKeys };
}

/**
 * 把弹窗上的两个勾选落到压制记录（两个勾选**与按钮取向无关**，可同时生效）。
 *
 * 勾选语义（R8.1 用户裁定）：
 *   · 「这个聊天不再提醒」→ 该键进 `mutedKeys`（别的聊天照弹）
 *   · 「全部不再提醒」    → `never = true`（任何聊天都不再弹）
 * 两者同时勾 → 都要落（`never` 已经覆盖一切，`mutedKeys` 仍记下来，将来取消全局压制时可逐键恢复）。
 * 都没勾 → 原样返回（**不写记录**，也就不会留下空改动）。
 *
 * @param {object|null} prompt 现有压制记录
 * @param {string} chatKey 当前聊天键
 * @param {{muteKey?: boolean, muteAll?: boolean}} flags 两个勾选的现场值
 * @returns {{never: boolean, mutedKeys: string[]}} 新的压制记录（调用方落盘）
 */
export function withImportPromptMutes(prompt, chatKey, { muteKey = false, muteAll = false } = {}) {
    let p = normImportPrompt(prompt);
    if (muteKey) p = muteImportPromptKey(p, chatKey);
    if (muteAll) p = muteImportPromptAll(p);
    return p;
}
