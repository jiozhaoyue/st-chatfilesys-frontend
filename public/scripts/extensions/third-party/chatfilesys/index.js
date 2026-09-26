/**
 * ChatFilesys — 前端扩展入口（R5 2026-09-25 重裁定：**弹窗即唯一界面**）
 *
 * 数据流（零核心修改、零拦截，2.4 起写路径全走官方消息 API）：
 * - 模型 = chat_metadata.extensions.chatfilesys（随聊天文件走）
 * - body = ctx.chat（活跃分支的楼层线性序列）
 * - 结构操作（改名/删除分支）→ 纯 metadata → ctx.saveMetadata()
 * - 切换/分支投影 → planSwitch 生成 RFC6902 ops → chat-writer 映射为官方消息 API 批量调用
 * - 追加楼层（原生 append 流）→ MESSAGE_SENT/RECEIVED → registerAppendedGroup → saveMetadataDebounced
 * - 重绘：clearChat + printMessages（失败回退 reloadCurrentChat）
 *
 * UI 宿主分工（spec/frontend/ui-placement.md §一·A，2026-09-25 重裁定）：
 * - 扩展设置抽屉：**零注入**（settings.html 已删除）；设置项搬进弹窗「设置」页签
 * - 复杂 UI：管理弹窗（官方 Popup DISPLAY+wide+large + renderLukerTabs，ST 降级内置 Tab）
 * - 聊天界面只剩两样：① 输入框上方工具图标排里的插件入口按钮 ② 消息旁的**版本按钮**
 *   （仅该层 swipe 组数 > 1 时出现；形状 = 分叉图标 + 计数，不用左右箭头）
 * - 全局入口：输入框上方工具图标排里的插件按钮 + 快捷键 Alt+B（`/cb` 已删除）
 * - T8 入库提醒：打开未入库聊天时弹**官方 Popup**（正文 + 两个模式短按钮「纯库」「双写」+
 *   小字次按钮「不入库」+ 两个小勾选，`.chatfilesys-import-prompt`；关窗 = 不入库），
 *   与上面两样不冲突（它不在 `#chat` / `#form_sheld` 里，也不是常驻元素）；压制记录住 extension_settings
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { event_types, eventSource, clearChat, printMessages, saveSettingsDebounced } from '../../../../script.js';
import { Popup, callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';

import { enableForChat, registerAppendedGroup, renameBranch, deleteBranch, deleteFloorEverywhere, getBranch, getActive, maxFloor, adoptNativeCopy, setMainBranch, setDefaultBranch } from './core/branches.js';
import { planSwitch } from './core/projection.js';
import { createChatWriter } from './core/chat-writer.js';
import { detectRemovedFloors } from './core/floor-diff.js';
import { installSeam, normalizeChatKey } from './core/seam.js';
import { branchIdForKey } from './core/takeover.js';
import { dropBindingsOfBranch, setBindingBranch } from './core/key-bindings.js';
import { alignHostFileName } from './core/rename-align.js';
import { createMirror } from './core/mirror.js';
import { normMode, isPureLike, isMirror, STORAGE_MODES, STORAGE_MODE_LABELS } from './core/mode.js';
import { createStorageAdapter } from './core/storage/adapter.js';
import { modelFromStore, storeFromModel } from './core/store-bridge.js';
import { createTrash } from './core/trash.js';
import { runImport } from './core/importer.js';
import {
    IMPORT_PROMPT_MODE, normImportPrompt, shouldPromptImport, withImportPromptMutes,
} from './core/import-prompt.js';
import { esc, getActiveBranch, assembleBranchLines } from './ui/common.js';
import { createPopupContent } from './ui/popup.js';
import { renderTree } from './ui/tree.js';
import { injectMessageTools, injectAllMessages } from './ui/marker.js';
import { openVersionsPopup } from './ui/versions.js';
import { openImportPrompt } from './ui/import-prompt.js';

const MODULE_NAME = 'chatfilesys';

/** 库内隐容器前缀（不能当聊天列出来） */
const HIDDEN_PREFIX = '__cfsys__';

const ctx = () => getContext();

/**
 * 结构操作写入口（官方消息 API 封装，闭包内动态取 ctx；silent 抑制事件、照常持久化，
 * UI 刷新由操作尾部 renderAll/renderChat 显式调度）。
 */
const messageWriter = createChatWriter({
    deleteMessages: (idx, opts) => ctx().deleteMessages(idx, opts),
    addMessages: (msgs, opts) => ctx().addMessages(msgs, opts),
    updateMessages: (upd, opts) => ctx().updateMessages(upd, opts),
});

/* ---------------- 能力检测（PRD 决策 #12：缺什么降什么） ---------------- */

const CAP = {
    renderedEvents: false,   // 消息旁注入钩子
};

function detectCapabilities() {
    CAP.renderedEvents = Boolean(event_types.USER_MESSAGE_RENDERED && event_types.CHARACTER_MESSAGE_RENDERED);
    console.log(`[${MODULE_NAME}] 能力检测:`, CAP);
}

/* ---------------- 设置 ---------------- */

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || { auto_export: false };
    if (typeof extension_settings[MODULE_NAME].auto_export !== 'boolean') {
        extension_settings[MODULE_NAME].auto_export = false;
    }
    // 存储模式（T2/R1：'off' JSONL 增强 | 'pure' 纯数据库 | 'mirror' 双写；默认 off）
    extension_settings[MODULE_NAME].storage_mode = normMode(extension_settings[MODULE_NAME].storage_mode);
    // 双写：与库同步一次的开关（T2.5 的「文件落后」提示数据源在 mirror.state）
    if (typeof extension_settings[MODULE_NAME].mirror_sync_on_write !== 'boolean') {
        extension_settings[MODULE_NAME].mirror_sync_on_write = true;
    }
    // 入库提醒的压制记录（T8/R8.1：{ never, mutedKeys }）——本机偏好，不写进聊天记录
    extension_settings[MODULE_NAME].import_prompt = normImportPrompt(extension_settings[MODULE_NAME].import_prompt);
}

/** 回收站不可用时的说明（N15：不假装有空列表） */
function trashUnavailableNote() {
    if (!storageState) return '回收站只在库模式下可用（当前是 JSONL 增强模式）。';
    return '当前存储档位不支持枚举回收站条目（只有档1 Authority 能列目录）；已经快照的条目不会被自动删除。';
}

/** 分支树展开方向（N13：可切「向下 / 向右」；持久化到设置） */
function treeDirection() {
    return extension_settings[MODULE_NAME]?.tree_direction === 'right' ? 'right' : 'down';
}

/** AI 总结能力检测（N13：生成链路不可用时按钮隐藏并降级） */
function canSummarize() {
    const c = ctx();
    return typeof c.generateQuietPrompt === 'function' || typeof c.generateRaw === 'function';
}

async function generateSummary(text) {
    const c = ctx();
    const prompt = `请用不超过 20 个字概括下面这段对话的走向，只输出概括本身，不要引号、不要解释：\n\n${text}`;
    if (typeof c.generateQuietPrompt === 'function') return String(await c.generateQuietPrompt({ quietPrompt: prompt }) ?? '');
    if (typeof c.generateRaw === 'function') return String(await c.generateRaw({ prompt }) ?? '');
    throw new Error('宿主无可用生成链路');
}

function autoExportEnabled() {
    return Boolean(extension_settings[MODULE_NAME]?.auto_export);
}

/** 当前存储模式（单点判定走 core/mode.js） */
function storageMode() {
    return normMode(extension_settings[MODULE_NAME]?.storage_mode);
}

/** 是否走库的模式（pure / mirror 都装接缝） */
function pureDbMode() {
    return isPureLike(storageMode());
}

/** 是否双写（额外落标准聊天文件） */
function mirrorMode() {
    return isMirror(storageMode());
}

/* ---------------- 纯库模式：存储适配器 + seam 接缝（design.md §8.3） ---------------- */

let storageState = null; // { tier, adapter, dispose, seam, trash, mirror }

/** 回收站实例（纯库模式启用后可用；backend = adapter 本身即契约实现者） */
function getTrash() {
    if (!storageState) return null;
    if (!storageState.trash) storageState.trash = createTrash({ backend: storageState.adapter });
    return storageState.trash;
}

/**
 * 启用纯库模式：选档 → 装 seam（拦截先于聊天 get 就绪）。
 * 全程 try/catch 静默降级（L0-11）：失败仅 console.warn，插件其余功能照常。
 */
async function enablePureDb() {
    if (storageState) return storageState;
    try {
        const { tier, adapter, dispose } = await createStorageAdapter({
            fetch: (...args) => globalThis.fetch(...args),
            headers: () => (typeof ctx().getRequestHeaders === 'function' ? ctx().getRequestHeaders() : {}),
            log: console.warn,
        });
        // 双写模式：成功写标脏 → 1.5s 防抖落标准聊天文件（§4；失败只 warn 不阻断）
        const seam = installSeam(adapter, {
            log: console.warn,
            // 只在双写模式下标脏（切回纯库模式后即时停写，磁盘文件保留为快照）
            onWrote: (evt) => { if (mirrorMode()) storageState?.mirror?.markDirty(evt); },
        });
        const mirror = createMirror({
            adapter,
            native: (...args) => seam.native(...args),
            headers: () => (typeof ctx().getRequestHeaders === 'function' ? ctx().getRequestHeaders() : {}),
            log: console.warn,
        });
        storageState = { tier, adapter, dispose, seam, mirror };
        console.log(`[chatfilesys] 库模式已启用（存储档位：${tier}；模式：${storageMode()}）`);
        return storageState;
    } catch (e) {
        console.warn('[chatfilesys] 纯库模式启用失败，保持 JSONL 增强模式:', e);
        return null;
    }
}

/** 关闭纯库模式：卸 seam + 释放适配器 */
function disablePureDb() {
    if (!storageState) return;
    try {
        storageState.mirror?.dispose?.();
        storageState.seam?.dispose();
        storageState.dispose?.();
    } catch (e) {
        console.warn('[chatfilesys] 库模式卸载异常:', e);
    }
    storageState = null;
}

/* ---------------- 模型读写 ---------------- */

function getModel() {
    return ctx().chatMetadata?.extensions?.chatfilesys || null;
}

/** 把模型写回 chat_metadata（setter 内部走 updateChatMetadata 替换模块级变量） */
function setModel(model) {
    const c = ctx();
    const md = { ...(c.chatMetadata || {}) };
    md.extensions = { ...(md.extensions || {}), chatfilesys: model };
    c.chatMetadata = md;
    c.chatMetadata.tainted = true;
    return md;
}

/* ---------------- 弹窗（规范：callGenericPopup；INPUT 第三参是预填值） ---------------- */

async function popupInput(text, prefill = '') {
    const v = await callGenericPopup(text, POPUP_TYPE.INPUT, prefill, { rows: 1 });
    return typeof v === 'string' ? v.trim() : '';
}

async function popupConfirm(text) {
    const r = await callGenericPopup(text, POPUP_TYPE.CONFIRM, '', { okButton: '确定', cancelButton: '取消' });
    return r === POPUP_RESULT.AFFIRMATIVE;
}

/* ---------------- 视图状态与全局刷新 ---------------- */

function familyName() {
    const id = String(ctx().chatId || '未命名聊天');
    return id.replace(/\.jsonl$/i, '');
}

function currentWarning() {
    const model = getModel();
    if (!model) return '';
    const errors = [];
    try {
        // W3：比的是**本聊天键所在分支**的层数，不是家族活跃分支（绑定键上后者本就不同）
        const active = getActiveBranch(model, currentBranchId);
        if (ctx().chat.length !== maxFloor(active)) {
            errors.push(`分支结构（${maxFloor(active)} 层）与聊天体（${ctx().chat.length} 行）不一致——可能在原生环境改动过消息。`);
        }
    } catch (e) {
        errors.push(`模型异常: ${e.message}`);
    }
    return errors.join(' ');
}

/** 角色卡的聊天列表刷新令牌（递增 → 弹窗「角色卡的聊天」页签重拉列表） */
let chatListToken = 0;
function bumpChatList() { chatListToken += 1; }

function currentView() {
    const c = ctx();
    const model = getModel();
    // W3：当前分支 = 本聊天键的绑定分支（无绑定才回落家族活跃分支）
    const active = model ? getActiveBranch(model, currentBranchId) : null;
    const tierLabel = { authority: 'Authority SQL', official: '官方通道', idb: 'IndexedDB 缓存' }[storageState?.tier] || '未就绪';
    return {
        model,
        chat: c.chat || [],
        branchId: currentBranchId,
        familyName: familyName(),
        warning: currentWarning(),
        isGroupChat: Boolean(c.groupId),
        autoExport: autoExportEnabled(),
        activeName: active?.name || '',
        treeDirection: treeDirection(),
        canSummarize: canSummarize(),
        pureLike: pureDbMode(),
        storage: {
            mode: storageMode(),
            modes: STORAGE_MODES,
            labels: STORAGE_MODE_LABELS,
            pureLike: pureDbMode(),
            mirror: mirrorMode(),
            tierLabel,
            mirrorPending: Boolean(storageState?.mirror?.state?.pending),
        },
        // N15：档1 有目录枚举；档2/档3 无枚举端点 → 明说不可用，不给假「空列表」
        listTrash: storageState?.tier === 'authority' ? async () => (getTrash()?.listAll?.() ?? []) : null,
        trashNote: trashUnavailableNote(),
        listChats: () => listChatsForCharacter(),
        chatsNote: storageState ? '' : '库模式未启用——下面只列磁盘上的聊天文件。',
        chatsToken: chatListToken,
    };
}

let popupHandle = null; // { popup, content:{el, refresh} }

let uiRefreshTimer = null;

function injectAllNow() {
    const v = currentView();
    injectAllMessages({
        model: v.model,
        chat: v.chat,
        branchId: v.branchId,
        isGroupChat: v.isGroupChat,
        onOpenVersions: openVersionsForFloor,
    });
}

/**
 * UI 刷新防抖（150ms）：弹窗重建、消息旁注入补注统一走这里。
 * 实测依据：printMessages 批量重绘不触发 RENDERED 事件（append 路径才触发），
 * 切换后的注入恢复必须由我们自己的重绘尾部显式补做或走本防抖。
 */
function scheduleUiRefresh() {
    clearTimeout(uiRefreshTimer);
    uiRefreshTimer = setTimeout(() => {
        if (popupHandle) popupHandle.content.refresh(currentView());
        injectAllNow();
    }, 150);
}

function renderAll() {
    ensureEntryButton();   // 宿主 DOM 就绪晚于本插件时自愈
    captureBodyBaseline(); // 每次刷新都是一次「模型 ↔ body 已对齐」的确认点（W1 删层判定的基线）
    scheduleUiRefresh();
}

/** 分支切换后的聊天区重绘；失败回退官方整载 */
async function renderChat() {
    try {
        await clearChat();
        await printMessages();
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 本地重绘失败，回退 reloadCurrentChat:`, e);
        await ctx().reloadCurrentChat();
    }
    injectAllNow();  // 批量重绘不触发 RENDERED，重绘尾部显式补注入（幂等）
}

/* ---------------- 管理弹窗（唯一界面） ---------------- */

async function openManagementPopup() {
    if (popupHandle) return;
    if (typeof Popup !== 'function') {
        toastr.error('当前环境缺少 Popup API，管理面板不可用。');
        return;
    }
    const content = createPopupContent(ctx(), currentView());
    bindPopupEvents(content.el);  // 弹窗内容的数据操作委托（switch/rename/export/enable/…）
    const popup = new Popup(content.el, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
    });
    popupHandle = { popup, content };
    // 宿主实测（2026-09-06，design.md「二期实测事实」#6）：DISPLAY 弹窗关闭时宿主不回调
    // onClose/onClosing、show() 的 Promise 也不 resolve——popupHandle 只能靠 dialog 标准
    // close 事件清引用，否则弹窗关闭后无法二次打开。show() 调用后 content.el 已挂入 dialog。
    popup.show();
    // 关闭时连带清 DOM：宿主 Popup#hide 在它自己的关闭路径里会 `dlg.remove()`，但若 dialog 是被
    // 直接 `close()`（自动化脚本 / 别处绕过 complete()），那份清理不会执行——我们的
    // `.chatfilesys-popup` 就会永远留在 body 里，每开一次叠一份（2026-09-26 真机取证，见
    // tests/e2e/probe_popup_residue.py）。故这里补一次移除，保证「关闭后页面里零本插件弹窗节点」。
    const dialog = content.el.closest('dialog');
    dialog?.addEventListener('close', () => {
        // 宿主 closeListener 会在「本次关闭被拦下」时立刻 showModal() 复原——那时弹窗仍在屏幕上，
        // 不能拆节点、也不能清引用（清了会让下一次打开叠出第二份内容）。
        if (dialog.open) return;
        popupHandle = null;
        dialog.remove();
    }); // 不 await：弹窗保持打开，事件驱动 refresh
}

/* ---------------- 业务操作 ---------------- */

async function enableBranches() {
    const c = ctx();
    if (getModel()) return;
    const where = pureDbMode()
        ? '此聊天将成为一个聊天家族，内容存进数据库（磁盘上不再有该聊天的 jsonl）。'
        : '此聊天将成为一个聊天家族：当前消息序列成为「主分支」，之后可零复制分叉。'
            + '数据仍存于本聊天文件内（chat_metadata.extensions），原生环境完全兼容。';
    const ok = await popupConfirm(`启用？${where}`);
    if (!ok) return;
    setModel(enableForChat(c.chat || []));
    await c.saveMetadata();
    renderAll();
    toastr.success('已启用');
}

/**
 * 切换分支：共享前缀不动，尾部折叠/展开；ops 经 chat-writer 映射为官方消息 API
 * 批量调用（deleteMessages/addMessages，官方持久化自动携带 metadata）。
 *
 * W6（2026-09-26）：`planSwitch` 的**起点**必须显式给「本聊天键所在分支」——body 是它的投影，
 * 而家族活跃分支可能是另一条（原生分支/检查点键）。按家族活跃分支算最长公共前缀与尾部差集，
 * 生成的 ops 与真实 body 对不上，接缝只能拒绝（宿主再回退全量保存）。
 */
async function switchBranch(branchId) {
    const c = ctx();
    const model = getModel();
    // W3：判断「已经在这条分支上」用**本聊天键所在的分支**，不是家族活跃分支——
    // 原生分支/检查点键上两者不同，按家族级判断会把真实的切换当成空操作。
    const currentId = currentBranchId || model?.active_branch;
    if (!model || currentId === branchId) return;
    const target = getBranch(model, branchId);
    if (!target) return;

    let operations;
    try {
        ({ operations } = planSwitch(model, branchId, c.chat || [], currentId));
    } catch (e) {
        toastr.error(`切换失败: ${e.message}`);
        return;
    }
    // N1：主键上的普通切换 = 家族级切换 → 主分支标记（is_default）跟着迁（用户 2026-09-26 裁定）
    await alignMainBranchOnSwitch(model, branchId);
    setModel(model);

    if (operations.length > 0) {
        try {
            await messageWriter.applyOperations(operations);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 消息 API 写入失败，回退全量保存:`, e);
            await c.saveChat();
        }
    } else {
        await c.saveMetadata();
    }

    // 该键的绑定已随这次切换跟到新分支（接缝 followKeyBinding）→ 重取，UI 与读路径保持一致
    await syncCurrentBranchId();
    await renderChat();
    renderAll();
    maybeAutoExport();
    toastr.success(`已切换到「${target.name}」`);
}

/**
 * 主键上的普通切换后，把**主分支标记**（`is_default`）迁到目标分支（N1 / R8.3）。
 *
 * 用户 2026-09-26 复现的顺序失效：把 B 设为主分支（主键因此有了指向 B 的绑定）后，
 * 在结构树上普通切到 C → 屏幕显示 C，面板却仍把 B 标成「（主分支）」，而删除按钮对
 * **正在看的 C** 可点（删掉 C，内容无声跳回 B）。根因是 `is_default` 与「主键绑定所在分支」
 * 分了叉——不变式（R8.3）要求「恰有一条 `is_default`，且它 = 主键绑定所在分支」。
 *
 * 判据 = 「**当前聊天键就是家族主键**」：只有主键上的切换才是家族级切换。绑定键
 * （原生分支/检查点键）上的切换不迁（那里家族主分支不动）——与接缝同一判据，
 * 见 `core/key-bindings.js#pinActiveForBoundKey`。
 *
 * 逐层失败不阻断：标记迁移失败（读不到家族等）只记日志，切换本身照常进行。
 *
 * @param {object} model 已按目标分支改好的内存模型（就地迁移 is_default）
 * @param {string} branchId 目标分支 id
 */
async function alignMainBranchOnSwitch(model, branchId) {
    if (!storageState) {
        // 增强模式：模型住聊天头里，**这个聊天就是它自己的家族** → 普通切换就是换主分支，直接迁。
        // 否则「is_default」会停在旧那条上，而删除护城河看的是 is_default → 症状与库模式一模一样。
        setDefaultBranch(model, branchId);
        return;
    }
    try {
        const family = await loadCurrentFamily();
        if (!family || family.chatKey !== normalizeChatKeyOf(ctx())) return;
        setDefaultBranch(model, branchId);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 主分支标记跟随失败（切换本身不受影响）:`, e);
    }
}

/* ---------------- 分支改名（不变式 3：磁盘上有文件时才双向对齐） ---------------- */

/**
 * 分支改名后同步宿主文件名（design.md §5.6 不变式 3）。
 *
 * 只对**有绑定键**的分支生效（原生「创建分支 / 创建检查点」键各自绑一条分支）；
 * 库内新建的分支没有绑定键 → 直接跳过。
 *
 * **W4（2026-09-26）判据修正**：是否要动宿主文件名，取决于「**磁盘上真有这份文件吗**」——
 * 纯库/双写下绑定键在磁盘上从来没有文件（接管不落盘；双写只落主键），对不存在的文件调
 * `/api/chats/rename` 只可能失败；文件名没变时更不该迁移键绑定。故：
 *   · 磁盘**有**该文件 → 调 `/api/chats/rename` + 把键绑定迁到宿主回给的新键名
 *   · 磁盘**没有**（或探测失败）→ 只改库内分支名，不调接口、不迁键绑定（键没变）
 *
 * 实现要点：
 * - 调宿主端点必须走 `seam.native` **绕开接缝**——`chats/rename` 在接缝路由内，而绑定键
 *   会命中**父家族**，走接缝会把父家族改名（错误目标）。
 * - 宿主端点参数照 Dev Luker `src/endpoints/chats.js` 的 `/rename`：`original_file` /
 *   `renamed_file` **带 .jsonl**，返回 `{ ok, sanitizedFileName }`。
 * - 键绑定随新键迁移（旧键删除、新键写上同一 binding）。
 *
 * @param {string} branchId
 * @param {string} newName 新分支名（= 新的文件名主体）
 * @returns {Promise<{ok: boolean, reason?: string, newKey?: string}>}
 */
async function alignBoundKeyRename(branchId, newName) {
    const c = ctx();
    // 键绑定只存在于库里（增强模式没有库）→ 等价于「没有绑定键」，直接跳过并对齐静默
    if (!storageState) return { ok: false, reason: 'no-binding' };
    const family = await storageState.adapter.loadFamily({ chatKey: normalizeChatKeyOf(c) }).catch(() => null);
    if (!family) return { ok: false, reason: 'no-binding' };
    const char = c.characters?.[c.characterId] || {};
    const doFetch = (...a) => (storageState.seam?.native ? storageState.seam.native(...a) : globalThis.fetch(...a));
    const headers = typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : {};

    return await alignHostFileName({
        keyBindings: family.keyBindings,
        branchId,
        newName,
        avatarUrl: char.avatar,
        log: (m) => console.warn(`[${MODULE_NAME}] ${m}`),
        // 磁盘探测走原生通道（`/api/chats/search` 不在接缝路由内）；失败按「没有文件」处理
        fileExists: (fileName) => chatFileExistsOnDisk(fileName, false),
        chatKeyOf: (fileName) => normalizeChatKeyOf(c, fileName),
        renameHost: async ({ oldFile, newFile, avatarUrl }) => {
            const res = await doFetch('/api/chats/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({
                    original_file: `${oldFile}.jsonl`,
                    renamed_file: `${newFile}.jsonl`,
                    avatar_url: avatarUrl,
                    is_group: false,
                }),
            });
            const data = await res?.json?.().catch(() => null);
            return { ok: Boolean(res?.ok) && !data?.error, status: res?.status, file: data?.sanitizedFileName };
        },
        saveBindings: async (next) => {
            const r = await storageState.adapter.saveModel({
                familyId: family.familyId,
                keyBindings: next,
                expectedIntegrity: family.integrity, // 刚读出的版本号，避免自造冲突
            });
            return { ok: Boolean(r?.ok), reason: r?.reason };
        },
    });
}

async function renameBranchFlow(branchId) {
    const model = getModel();
    const b = getBranch(model, branchId);
    if (!b) return;
    const name = await popupInput('新分支名称：', b.name);
    if (!name || name === b.name) return;
    try {
        renameBranch(model, branchId, name);
        setModel(model);
        await ctx().saveMetadata();
        renderAll();
        toastr.success('分支已改名');
    } catch (e) {
        toastr.error(`改名失败: ${e.message}`);
        return;
    }
    // 对齐宿主侧文件名——**仅当磁盘上真有该文件**（W4；L0-11：失败只提示，不阻断、不回退库内名）
    try {
        const r = await alignBoundKeyRename(branchId, name);
        if (r.ok) {
            toastr.info('宿主聊天文件名已同步。', '聊天文件系统');
        } else if (r.reason === 'no-file') {
            toastr.info('已改库内分支名：该分支在宿主侧没有聊天文件，无需改文件名。', '聊天文件系统');
        } else if (r.reason !== 'no-binding') {
            toastr.info(`宿主聊天文件未同步（${r.reason}）。`, '聊天文件系统');
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 分支改名对齐失败（不阻断）:`, e);
        toastr.info(`宿主聊天文件未同步（${e?.message || e}）。`, '聊天文件系统');
    }
}

/* ---------------- 分支删除：清掉该分支的绑定键（不变式 2） ---------------- */

/**
 * 删除分支后清掉它的绑定键（design.md §5.6 不变式 2：`keyBindings[chatKey].branchId` 必须存在）。
 *
 * 纯库/双写下原生创建的分支各自带一个键；分支删了而键还在就是**悬挂绑定**——宿主打开那个键时
 * 会按失效的 branchId 解析（落到别的分支上），映射断裂。故删除分支必须同步解绑。
 *
 * 只动库、不碰宿主文件：纯库/双写下该键在宿主侧**本就没有文件**（T1 接管不落盘；双写只落主键），
 * 所以没有文件可删——也**不能**把删除请求打到接缝上（接缝的 `chats/delete` 删的是整个家族）。
 * 失败一律静默降级（L0-11）：只记日志，不阻断已完成的删除。
 *
 * @param {string} branchId
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function unbindKeysOfBranch(branchId) {
    if (!storageState) return { ok: false, reason: 'no-binding' }; // 增强模式没有库 → 等价于没有绑定键
    try {
        // 读在模型写入（saveMetadata）之后：拿到的就是最新版本号，避免自造冲突
        const family = await storageState.adapter.loadFamily({ chatKey: normalizeChatKeyOf(ctx()) });
        const next = dropBindingsOfBranch(family?.keyBindings, branchId);
        if (!next) return { ok: false, reason: 'no-binding' };
        const r = await storageState.adapter.saveModel({
            familyId: family.familyId,
            keyBindings: next,
            expectedIntegrity: family.integrity,
        });
        if (!r?.ok) return { ok: false, reason: r?.reason || 'conflict' };
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
    }
}

async function deleteBranchFlow(branchId) {
    const model = getModel();
    const b = getBranch(model, branchId);
    if (!b) return;
    if (!(await popupConfirm(`删除分支「${b.name}」？其私有组（仅它引用的楼层）将一并回收，共享楼层不受影响。`))) return;
    try {
        deleteBranch(model, branchId);
        setModel(model);
        await ctx().saveMetadata();
        // 不变式 2：绑定键随分支一起消失（失败只记日志，删除已生效不回退）
        const un = await unbindKeysOfBranch(branchId);
        if (un.ok) console.log(`[${MODULE_NAME}] 分支 ${branchId} 的绑定键已清掉`);
        else if (un.reason !== 'no-binding') console.warn(`[${MODULE_NAME}] 分支 ${branchId} 解绑失败（可能留下悬挂绑定）:`, un.reason);
        renderAll();
        toastr.success(`分支「${b.name}」已删除`);
    } catch (e) {
        toastr.error(`删除失败: ${e.message}`);
    }
}

/**
 * 楼层同步：原生 append（用户/AI 继续聊天）后，把新楼层登记进模型。
 * 仅 metadata 变化，防抖持久化；chat 缩短（删除）时自动跳过（那条路走 `onMessageDeleted`）。
 */
function syncAppendedFloors() {
    const c = ctx();
    const model = getModel();
    if (!model) return 0;
    let registered = 0;
    let guard = 0;
    // W3：新楼层登记进**本聊天键所在的分支**（原生分支/检查点键各有各的投影与层数）。
    // 度量与登记必须取自同一条分支：只改度量会让登记落到家族活跃分支上并抛
    // 「新楼层 ≠ maxFloor+1」（该键的新楼层进不了模型 → 后续 metadata 写把库内 path 抹回旧版）。
    while (c.chat.length > maxFloor(getActiveBranch(model, currentBranchId)) && guard++ < 500) {
        registerAppendedGroup(model, maxFloor(getActiveBranch(model, currentBranchId)) + 1, currentBranchId);
        registered++;
    }
    if (registered > 0) {
        setModel(model);
        c.saveMetadataDebounced();
    }
    return registered;
}

/* ---------------- 删消息后的楼层重排（W1：三模式行为一致，R4） ---------------- */

/**
 * body 引用快照（删层判定的基线）。见 `core/floor-diff.js` 的模块头：宿主删消息的
 * `MESSAGE_DELETED` 载荷**不带被删下标**，唯一精确的信息源是「改动前后 body 的引用差」。
 * 因此在每个「已确认一致」的时刻重取基线：聊天重载、我们自己的结构性写之后、每次事件处理末尾。
 */
let bodyBaseline = null;

function captureBodyBaseline() {
    bodyBaseline = (ctx().chat || []).slice();
}

/* ---------------- 当前分支解析（W3：本聊天键 → 分支） ---------------- */

/**
 * 本聊天键在库内绑定到哪条分支（`null` = 无绑定 → 由 `model.active_branch` 决定投影）。
 *
 * 为什么需要：读路径是按 **`keyBindings[chatKey].branchId`** 投影的（design.md §2.3），
 * 而模型里的 `active_branch` 是**家族级**的——原生分支/检查点聊天打开时两者并不相同，
 * UI 若一律按 `active_branch` 判断就会误报「结构与聊天体不一致」、把别的组标成「当前组」。
 * 解析只走一处（`core/takeover.js#branchIdForKey`），渲染函数收参数（ui/common.js 文件头）。
 */
let currentBranchId = null;

/** 重取本聊天键的分支绑定（聊天切换 / 分支切换 / 导入 / 换模式后调用） */
async function syncCurrentBranchId() {
    if (!storageState) { currentBranchId = null; return null; } // 增强模式无绑定面（模型住在聊天头里）
    try {
        const chatKey = normalizeChatKeyOf(ctx());
        const family = await storageState.adapter.loadFamily({ chatKey });
        currentBranchId = family ? branchIdForKey(family, chatKey) : null;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 当前分支解析失败（回落到家族活跃分支）:`, e);
        currentBranchId = null;
    }
    return currentBranchId;
}

/**
 * 纯库/双写：把内存里的模型按库内事实重取一遍（W1 删消息路径专用）。
 *
 * 接缝在处理宿主的 `chats/patch`（`remove /N`）时已在**库里**做了全局删层重排
 * （`core/patch-rows.js`），而宿主内存那份 `chat_metadata` 还是旧编号——
 * 内存副本必须**从库重取**而不是再排一次（再排一次 = 重复删层），
 * 否则它会在下一次 `saveMetadata` 把旧编号写回库（静默改坏库内结构）。
 */
async function refreshModelFromLibrary() {
    if (!storageState) return false;
    try {
        const chatKey = normalizeChatKeyOf(ctx());
        const family = await storageState.adapter.loadFamily({ chatKey });
        if (!family) return false;
        currentBranchId = branchIdForKey(family, chatKey);
        if (family.model) setModel(family.model);
        return true;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 库内结构重取失败（内存副本可能落后）:`, e);
        return false;
    }
}

/**
 * 把被删楼层从模型里去掉（**全局删层**：所有分支前移，与纯库/双写的 `remove /N` 同语义）。
 * @returns {number} 实际处理的楼层数
 */
function renumberAfterDelete(model, floors) {
    // 从高到低删（与宿主 splice 的降序同序），避免前移影响后续楼层号
    let done = 0;
    for (const f of [...floors].sort((a, b) => b - a)) {
        try {
            deleteFloorEverywhere(model, f);
            done++;
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 删层重排：第 ${f} 层不在模型范围内，跳过（模型可能与聊天体不一致）:`, e?.message || e);
        }
    }
    if (done) {
        setModel(model);
        ctx().saveMetadataDebounced();
    }
    return done;
}

/**
 * 宿主原生「删除消息」→ 层号重排（W1，2026-09-26）。
 *
 * 为什么这么修（事实，非推测）：`MESSAGE_DELETED` 只给 `chat.length`，被删下标推不出来；
 * 而 JSONL 增强模式下模型住在聊天头里、宿主不会替我们重排 → 只能靠 `core/floor-diff.js`
 * 的引用差反推。判定不通过（对象被换过等）时**不动模型**，只记日志。
 *
 * 纯库/双写不做内存重排（接缝已在库里排过），改为从库重取，两边都不重复。
 */
async function onMessageDeleted() {
    const c = ctx();
    const model = getModel();
    const before = bodyBaseline;
    captureBodyBaseline(); // 基线先重取：后面的分支无论走哪条路，下一次判定都从当前状态起算
    if (model && before) {
        const removed = detectRemovedFloors(before, c.chat || []);
        if (removed) {
            if (pureDbMode()) {
                // 接缝已在库里按 remove /N 排过 → 内存副本只能从库重取（再排一次就重复删层了）
                await refreshModelFromLibrary();
            } else {
                const active = getActiveBranch(model, currentBranchId);
                // 基线必须与分支结构本来一致，否则「差了多少层」无从谈起（保守：宁可不改）
                if (before.length !== maxFloor(active)) {
                    console.warn(`[${MODULE_NAME}] 删层重排跳过：基线（${before.length} 行）与分支结构（${maxFloor(active)} 层）本就不一致。`);
                } else {
                    const n = renumberAfterDelete(model, removed);
                    if (n) console.log(`[${MODULE_NAME}] 删消息后已重排 ${n} 层（第 ${removed.join('、')} 层）`);
                }
            }
        } else if (before.length > (c.chat || []).length) {
            console.warn(`[${MODULE_NAME}] 消息数变少但无法定位被删楼层（对象被替换过？），分支结构未改动——可能在原生环境改动过消息。`);
        }
    }
    syncAppendedFloors();
    renderAll();
    maybeAutoExport();
}

/* ---------------- 原生书签收编（PRD 决策 #8） ---------------- */

/**
 * 收编前提检查：这份「原生分支/检查点」在**磁盘上真的有文件**吗？
 *
 * 纯库/双写模式下原生保存被接缝拦下（T1 接管），磁盘不产生复制文件——此时没有任何东西可收编，
 * 而收编成功路径里的 `/api/chats/delete` 会被接缝按 chatKey 解析到**该键所属家族**并删除整个家族
 * （`core/seam.js#handleDelete`），故必须先把这种情况挡在门外。
 *
 * 判据用宿主自己的文件枚举（`/api/chats/search` **不在接缝路由内** → 走原生通道，结果即磁盘事实）。
 * 枚举失败时按「存在」处理（保持改造前的行为，不因一次网络抖动改变功能）。
 */
/** 收编前提检查（枚举失败按「存在」处理，保持改造前的行为） */
async function branchFileExistsOnDisk(branchName) {
    return await chatFileExistsOnDisk(branchName, true);
}

/**
 * 宿主磁盘上有没有这个聊天文件（文件名不带 .jsonl）。
 *
 * `/api/chats/search` **不在接缝 ROUTES 内** → `importApi()` 走 `seam.native` **原生通道**，
 * 返回的就是磁盘事实（纯库模式下库内家族对它不可见）。
 *
 * @param {string} fileName
 * @param {boolean} fallback 枚举失败（网络/后端抖动）时的返回值——各调用点的「最可能事实」不同：
 *        收编流程按「有文件」处理（保持改造前行为），分支改名按「没有文件」处理（绑定键本就不落盘）。
 * @returns {Promise<boolean>}
 */
async function chatFileExistsOnDisk(fileName, fallback) {
    const want = String(fileName || '').replace(/\.jsonl$/i, '');
    if (!want) return false;
    try {
        const listing = await importApi().searchChats();
        return (listing || []).some((x) => {
            const n = String(x?.file_name ?? x ?? '').replace(/\.jsonl$/i, '');
            return n === want;
        });
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 磁盘聊天枚举失败（按 ${fallback ? '有' : '没有'}该文件处理）:`, e);
        return fallback;
    }
}

/** 服务端拉取聊天文件（header + 行数组）；失败返回 null */
async function fetchChatFile(fileName) {
    const c = ctx();
    const char = c.characters?.[c.characterId] || {};
    try {
        const res = await fetch('/api/chats/get', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ ch_name: char.name, file_name: fileName, avatar_url: char.avatar }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data) ? { header: data[0], lines: data.slice(1) } : null;
    } catch {
        return null;
    }
}

/**
 * 收编原生书签复制文件：校验 = 活跃分支前缀（分叉截断）→ 转楼层分支（零复制）
 * → 清理原生 extra.branches 引用 → 删复制文件。默认不收编（取消 = 原样保留）。
 *
 * **纯库/双写模式下一律不进入本流程**（两道闸，见下）：原生分支/检查点由接缝接管（T1），
 * 磁盘没有复制文件；放行则该流程会把 `/api/chats/delete` 打到接缝上，
 * 而 `core/seam.js#handleDelete` 是按 chatKey 找家族 → **删掉整个聊天家族**（用户点一下「收编」即全量数据丢失）。
 */
async function adoptNativeBranchFlow(payload) {
    const c = ctx();
    const model = getModel();
    if (!model || c.groupId) return; // 未接管聊天/群聊：原生行为原样，不询问
    // 闸①：接缝已装（纯库/双写）→ 原生保存被接管，磁盘不落文件 → 无物可收编。
    if (storageState) {
        console.log(`[${MODULE_NAME}] 收编跳过：「${payload?.branchName || ''}」由接缝接管（磁盘无复制文件）`);
        return;
    }
    const branchName0 = String(payload?.branchName || '');
    // 闸②：磁盘上真有这份文件才谈收编（覆盖「接缝由外部安装 / 历史遗留文件」等闸①挡不住的情形）。
    if (branchName0 && !(await branchFileExistsOnDisk(branchName0))) {
        console.log(`[${MODULE_NAME}] 收编跳过：磁盘上没有「${branchName0}」这个文件`);
        return;
    }
    const branchName = String(payload?.branchName || '');
    const mesId = Number(payload?.mesId);
    if (!branchName || !Number.isInteger(mesId) || mesId < 0) return;

    const copy = await fetchChatFile(branchName);
    if (!copy) {
        console.warn(`[${MODULE_NAME}] 收编检测：复制文件读取失败，原样保留`, branchName);
        return;
    }
    const copiedLines = copy.lines;
    const body = c.chat || [];
    const active = getActive(model);
    const preOk = copiedLines.length <= maxFloor(active)
        && copiedLines.every((l, i) => JSON.stringify(l) === JSON.stringify(body[i]));
    if (!preOk) {
        // 决策 #8：仅收编「= 分叉截断前缀」的复制文件；swipe 变体等不一致场景原样保留
        toastr.info(`原生书签「${branchName}」与当前分支前缀不一致，已原样保留。`, '聊天文件系统');
        return;
    }

    const r = await callGenericPopup(
        `检测到原生书签「${branchName}」（截断于第 ${mesId + 1} 层）。\n\n`
        + '收编：转为楼层分支（共享前缀零复制）并删除复制文件。\n'
        + '保留：不收编，复制文件独立存在。',
        POPUP_TYPE.CONFIRM, '', { okButton: '收编', cancelButton: '保留' },
    );
    if (r !== POPUP_RESULT.AFFIRMATIVE) {
        toastr.info('已保留原生书签文件。', '聊天文件系统');
        return;
    }

    const result = adoptNativeCopy(model, { name: branchName, copiedLines, body });
    if (!result.ok) {
        toastr.error(`收编失败: ${result.reason}`, '聊天文件系统');
        return;
    }

    // 原生在截断楼层 extra.branches 上留下的引用指向将被删除的文件，同步移除后全量落盘
    const line = body[mesId];
    if (Array.isArray(line?.extra?.branches) && line.extra.branches.includes(branchName)) {
        line.extra.branches = line.extra.branches.filter((x) => x !== branchName);
    }
    setModel(model);
    await c.saveChat();

    const char = c.characters?.[c.characterId] || {};
    try {
        const del = await fetch('/api/chats/delete', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ chatfile: `${branchName}.jsonl`, avatar_url: char.avatar }),
        });
        if (!del.ok) toastr.warning(`复制文件删除失败（HTTP ${del.status}），可手动清理。`, '聊天文件系统');
    } catch {
        toastr.warning('复制文件删除失败，可手动清理。', '聊天文件系统');
    }

    renderAll();
    toastr.success(`已收编「${branchName}」为楼层分支（共享前缀，零复制）。`, '聊天文件系统');

    // 原生 createBranch 在 emit(CHAT_BRANCH_CREATED) 之后同步 push 引用（bookmarks.js），
    // 实测 push 晚于本监听器的 setTimeout(0)——轮询等它出现后再清一次并落盘，
    // 避免指向已删除文件的死引用被后续保存持久化。
    let cleanupTries = 0;
    const cleanupNativeRef = () => {
        try {
            const line2 = ctx().chat?.[mesId];
            const refs = line2?.extra?.branches;
            if (Array.isArray(refs) && refs.includes(branchName)) {
                line2.extra.branches = refs.filter((x) => x !== branchName);
                ctx().saveChat();
                return;
            }
            if (++cleanupTries < 30) setTimeout(cleanupNativeRef, 100);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 收编后引用清理失败:`, e);
        }
    };
    setTimeout(cleanupNativeRef, 100);
}

/* ---------------- 导出（PRD 决策 #9 / R5：弹窗内触发） ---------------- */

/**
 * 导出某个聊天为纯标准 JSONL（剥离分支元数据）。
 * 纯库模式下 `/api/chats/get` 经接缝读库（当前分支投影）；增强模式下读原生文件。
 * @param {string} fileName 聊天文件名（不带 .jsonl）；缺省 = 当前聊天
 * @param {{quiet?: boolean, downloadName?: string}} [opts]
 * @returns {Promise<boolean>}
 */
async function exportChatFile(fileName = null, { quiet = false, downloadName = null } = {}) {
    const c = ctx();
    const name = String(fileName || c.getCurrentChatId?.() || c.chatId || '');
    if (!name) { if (!quiet) toastr.error('导出失败：拿不到聊天文件名。', '聊天文件系统'); return false; }
    const file = await fetchChatFile(name);
    if (!file || !file.header) {
        if (!quiet) toastr.error('导出失败：聊天内容读取失败。', '聊天文件系统');
        return false;
    }
    if (file.header.chat_metadata?.extensions) {
        delete file.header.chat_metadata.extensions.chatfilesys;
    }
    const model = getModel();
    // W3：导出的是**本聊天键所在分支**（绑定键上不等于家族活跃分支）
    const active = model ? getActiveBranch(model, currentBranchId) : null;
    const jsonl = [JSON.stringify(file.header), ...file.lines.map((l) => JSON.stringify(l))].join('\n') + '\n';
    const blob = new Blob([jsonl], { type: 'application/x-jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName || `${name}${active ? ` - 分支「${active.name}」` : ''}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (!quiet) toastr.success('已导出为纯标准 JSONL。', '聊天文件系统');
    return true;
}

let autoExportTimer = null;

function maybeAutoExport() {
    if (pureDbMode()) return; // §8.3.5：纯库模式下 jsonl 只经显式导出产生，自动导出走文件下载语义不适用
    if (!autoExportEnabled()) return;
    clearTimeout(autoExportTimer);
    autoExportTimer = setTimeout(() => { exportChatFile(null, { quiet: true }); }, 1500);
}

/* ---------------- 消息旁注入（RENDERED 事件驱动） ---------------- */

function onMessageRendered(messageId) {
    const c = ctx();
    injectMessageTools(Number(messageId), {
        model: getModel(),
        chat: c.chat || [],
        branchId: currentBranchId,
        isGroupChat: Boolean(c.groupId),
        onOpenVersions: openVersionsForFloor,
    });
}

/** 该层版本弹窗（版本按钮点击入口；完整四项能力由 T7 接管 ui/versions.js） */
function openVersionsForFloor(floor) {
    const model = getModel();
    if (!model) return;
    openVersionsPopup({
        floor,
        model,
        chat: ctx().chat || [],
        currentBranchId,
        onSwitchBranch: (branchId) => switchBranch(branchId),
    });
}

function registerMarkerListeners() {
    if (!CAP.renderedEvents) {
        console.warn(`[${MODULE_NAME}] 缺少 RENDERED 事件，消息旁注入已降级关闭`);
        return;
    }
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
}

/* ---------------- 事件 ---------------- */

async function onChatChanged() {
    captureBodyBaseline();          // 聊天刚整载：模型与 body 同源，是「一致」的时刻
    await syncCurrentBranchId();    // W3：本键在库内绑到哪条分支（按绑定键解析）
    syncAppendedFloors();
    bumpChatList();
    renderAll();
    // T8：打开一个尚未入库的聊天 → 提醒装库流程
    schedulePromptImport();
}

/**
 * 排一次入库提醒（不 await：提醒绝不能拖慢/阻断聊天载入）。
 *
 * 为什么要**晚一拍**：宿主的「新聊天」会连发 `CHAT_CHANGED` → `CHAT_CREATED`，而纯库/双写
 * 模式下 `onChatCreated` 会**即时把新聊天建成库内家族**——若在 CHAT_CHANGED 那一刻就判
 * 「库里没有」并弹窗，用户会看到一个多余的选择，点「纯库」还会把同一份内容再导一次。
 * 故：CHAT_CHANGED 排一个短延时，`onChatCreated`（它必然在这一拍之内落地）把计时器**换掉**
 * 并按当时的库内事实重判。净效果 = 只有「确实还没入库」的聊天才弹。
 *
 * @param {number} [delay] 毫秒
 */
let promptTimer = null;
function schedulePromptImport(delay = 600) {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
        promptTimer = null;
        void maybePromptImport();
    }, delay);
}

/**
 * 新聊天自动建家族（PRD 决策 #6）；已有聊天保持原生，启用由用户显式触发。
 *
 * T1 守卫（AC3）：原生「创建分支 / 创建检查点」产生的键**不得**建成独立家族——
 *  - 该键已在库内绑定（接缝接管已登记）→ 跳过建档（它属于父家族的一条分支）
 *  - 键名形如分支/检查点 → 跳过建档，交给接缝写路径的接管判定
 *    （接管判定不通过时该键就是一个原生 jsonl 文件，由导入旅程收编，不在这里建档）
 */
/**
 * body（宿主那一份消息数组）→ 库内楼层行（floorNo = 行序 +1，变体身份取自主分支的 path）。
 *
 * 用于「建档时首批楼层与模型同批落库」：模型声明了 1..N 层却不写行，库里就是
 * 「有路径没有行」，早到的 `chats/patch` 会被接缝以 `projection-incomplete` 拒绝。
 * @param {object} model 刚启用的模型（`enableForChat` 产物：主分支每层一个 `g<序号>`）
 * @param {Array<object>} body
 * @param {string|null} [branchId] 目标分支（缺省 = 主分支）
 */
function floorsFromBody(model, body, branchId = null) {
    const branch = (branchId ? getBranch(model, branchId) : null)
        || model.branches.find((b) => b.is_default) || model.branches[0];
    return (body || []).map((row, i) => ({
        floorNo: i + 1,
        variantId: branch?.path?.[i + 1] || `g${i + 1}`,
        seq: 0,
        content: JSON.stringify(row),
        contentHash: null,
        sendDate: row?.send_date ?? null,
    }));
}

async function onChatCreated() {
    const c = ctx();
    if (c.groupId) { renderAll(); return; }
    if (!getModel()) {
        // 纯库模式（§8.3.6）：新聊天直接库内建档（首条消息随 seam 拦截的 save/append 入库）
        if (storageState) {
            try {
                const chatKey = normalizeChatKeyOf(c);
                const existing = await storageState.adapter.loadFamily({ chatKey }).catch(() => null);
                if (existing) {
                    console.log(`[chatfilesys] "${chatKey}" 已是库内家族 ${existing.familyId} 的键（原生分支/检查点），跳过建档`);
                    renderAll();
                    return;
                }
                if (looksLikeNativeBranchOrCheckpoint(c.chatId)) {
                    console.log(`[chatfilesys] "${chatKey}" 形如原生分支/检查点键，跳过建档（由接缝接管判定处理）`);
                    renderAll();
                    return;
                }
                const model = enableForChat(c.chat || []);
                const family = storeFromModel(
                    model,
                    { familyId: `f_${newId36()}`, chatKey, characterId: String(c.characterId ?? ''), name: familyName() },
                );
                const r = await storageState.adapter.createFamily({ family });
                if (r?.ok) {
                    console.log(`[chatfilesys] 新聊天已库内建档 ${family.familyId}`);
                    // **首批楼层与模型同批落库**（2026-09-26 真机实录修）：模型声明了 1..N 层
                    // 却不写行，库里就是「有路径没有行」——之后任何一条早到的 `chats/patch`
                    // （宿主新建聊天后第一条就是 `add /0` 问候语）都会被接缝以
                    // `projection-incomplete`（楼层 1 的变体 g1 在库中无行）拒绝，宿主只能回退
                    // 全量保存才收敛。模型与行本就该同时存在，这里补上。
                    const floors = floorsFromBody(model, c.chat || []);
                    if (floors.length) {
                        const rf = await storageState.adapter.saveFloors({
                            familyId: family.familyId, floors, expectedIntegrity: null,
                        });
                        if (rf && rf.ok === false) console.warn('[chatfilesys] 新聊天首批楼层落库失败（后续写会补上）:', rf.reason);
                    }
                } else {
                    console.warn('[chatfilesys] 新聊天建档失败（聊天仍走原生路径）:', r?.reason);
                }
            } catch (e) {
                console.warn('[chatfilesys] 新聊天库内建档异常（不阻断）:', e);
            }
        } else {
            setModel(enableForChat(c.chat || []));
            c.saveMetadataDebounced();
        }
    }
    renderAll();
    // 建档落地之后再判要不要提醒（纯库/双写下这时库里已经有这个聊天 → 不该弹；
    // 增强模式没建档 → 该弹。见 schedulePromptImport 的说明）
    schedulePromptImport(0);
}

/** 文件名是否形如宿主自动生成的「分支 / 检查点」键（bookmarks.js 命名规则） */
function looksLikeNativeBranchOrCheckpoint(fileName) {
    const n = String(fileName || '').replace(/\.jsonl$/i, '');
    return / - (?:Branch|Checkpoint) #\d+$/i.test(n);
}

/**
 * 某聊天文件名的库 chatKey（规则单点 = `core/seam.js#normalizeChatKey`，此处只补「取当前聊天」）。
 * @param {object} c ST context
 * @param {string} [fileName] 缺省 = 当前聊天
 */
function normalizeChatKeyOf(c, fileName = null) {
    const char = c.characters?.[c.characterId] || {};
    return normalizeChatKey(char.avatar, fileName || c.chatId);
}

/** 短随机 id（36 进制时间戳+序） */
function newId36() {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function onMessageChanged() {
    captureBodyBaseline(); // 追加/编辑/换 swipe：数组结构在这些路径上不受影响，重取基线即可
    syncAppendedFloors();
    renderAll();
    maybeAutoExport();
}

function registerEventListeners() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_CREATED, onChatCreated);
    eventSource.on(event_types.MESSAGE_SENT, onMessageChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageChanged);
    // 删消息单列一条：要按「改动前后的 body 引用差」反推被删楼层（W1），不能与追加共用一条
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_EDITED, () => { captureBodyBaseline(); renderAll(); });
    eventSource.on(event_types.MESSAGE_SWIPED, () => { captureBodyBaseline(); renderAll(); });
    if (event_types.MORE_MESSAGES_LOADED) {
        // 前置加载更早的消息（chat.unshift 新对象）→ 只重取基线，不当作删层
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => { captureBodyBaseline(); renderAll(); });
    }
    eventSource.on(event_types.CHAT_BRANCH_CREATED, adoptNativeBranchFlow);
}

/* ---------------- 导入旅程（R3/AC4：存量 jsonl → 库） ---------------- */

/** 官方端点封装（native fetch 直连，绕开 seam 拦截——读源/删源必须原生路径） */
function importApi() {
    const c = ctx();
    const nativeFetch = (...args) => storageState?.seam?.native?.(...args) ?? globalThis.fetch(...args);
    const headers = () => (typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : { 'Content-Type': 'application/json' });
    const char = c.characters?.[c.characterId] || {};
    return {
        /** 枚举当前角色全部聊天（displayPastChats 先例：空 query） */
        async searchChats() {
            const res = await nativeFetch('/api/chats/search', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ query: '', avatar_url: char.avatar }),
            });
            if (!res.ok) throw new Error(`/api/chats/search HTTP ${res.status}`);
            return res.json();
        },
        /**
         * 读源 jsonl 全文（raw 供回收站快照；header/lines 供建档与指纹合并）。
         *
         * **行归一（2026-09-26 真机取事实）**：宿主 `/api/chats/get` 返回的 body 条目是
         * **对象**——FS/SQLite 两个引擎都会把每一行 `JSON.parse` 成对象再回
         * （`src/storage/engines/*-engine-transaction.js` 的 chat handler）。
         * 而建档/合并的纯函数（`core/merge.js#prepareRows`）的契约是**jsonl 行字符串**，
         * 拿到对象会把它们当非法行**全部跳过** → 导入进库的是空家族（0 楼层）；
         * 之所以过去没被发现：测的正是**当前打开的**聊天，导入后宿主自己那次全量保存
         * 又把楼层回填进库、把缺口盖住了（冷路径一试就露，见 tests/e2e/test_cold_import_header.py）。
         * 故在**边界处**统一成字符串（`raw` 也顺带成为真正的 jsonl 文本，回收站快照才是原样）。
         */
        async readChatFile(fileName) {
            const res = await nativeFetch('/api/chats/get', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ ch_name: char.name, file_name: fileName, avatar_url: char.avatar }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (!Array.isArray(data)) return null;
            const asLine = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
            return { header: data[0], lines: data.slice(1).map(asLine), raw: data.map(asLine).join('\n') };
        },
        /** 删源 jsonl（PARDON：仅回收站快照成功后调用） */
        async deleteChatFile(fileName) {
            const res = await nativeFetch('/api/chats/delete', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ chatfile: `${fileName}.jsonl`, avatar_url: char.avatar }),
            });
            return { ok: res.ok };
        },
        avatarUrl: char.avatar,
        characterId: c.characterId,
    };
}

/**
 * 导入旅程入口（弹窗「当前聊天 → 转库」/「角色卡的聊天 → 转数据库」/ 入库提醒的模式按钮触发）。
 * 全程依赖注入；确认弹窗 = PARDON 门禁（默认勾选删除，取消保留 jsonl）。
 * @param {{only?: string|null, includeCurrent?: boolean, keepBinding?: boolean|null}} [opts]
 *        `only` = 只导入这一个文件名（角色卡的聊天页签按行触发）；
 *        `includeCurrent` = 连**当前打开的**聊天一起导入（T8 提醒弹窗：
 *        用户要转的就是眼前这个聊天，而全量导入默认把它排除在外）；
 *        `keepBinding` = **模式已由调用方定好**（入库提醒的「纯库」/「双写」按钮）：
 *           `true`（双写）→ 源文件保留、不问两问；`false`（纯库）→ 只留 PARDON 删除确认、不问双写；
 *           缺省（`null`）= 保留 N2 旅程原有的两问（弹窗「转库」按钮走这条）。
 */
async function importJsonlFlow({ only = null, includeCurrent = false, keepBinding = null } = {}) {
    if (!storageState) {
        toastr.warning('请先切到库模式（弹窗「设置」页签），再导入存量聊天。', '聊天文件系统');
        return;
    }
    const c = ctx();
    const api = importApi();
    const trash = getTrash();
    if (!trash) { toastr.error('回收站未就绪，导入中止。', '聊天文件系统'); return; }

    let wantMirror = keepBinding === true;
    let deleteSources = false;
    if (wantMirror) {
        // 双写：源文件正是要保留并投影的那一份 → 没有删除动作，无需 PARDON 确认
    } else {
        // N2 用户旅程第一问：删除源文件（默认删 → 回收站 7 天）
        deleteSources = await popupConfirm(
            `将${only ? `把「${only}」录入数据库` : '检测本角色的存量聊天（不含当前打开的聊天与库隐容器），智能合并入库'}。\n\n` +
            '完成后删除源 jsonl 文件？\n（推荐：删除——副本先进回收站保留 7 天，可随时还原）',
        );
        // N2 第二问：是否保持 jsonl 双写绑定（**默认否**）——只在模式未指明时问
        if (keepBinding == null) wantMirror = await popupConfirm(
            '是否保持 jsonl 双写绑定？\n\n' +
            '是：库为事实源，同时把每个家族落一份标准聊天文件（原生酒馆可直接打开），源文件不删除。\n' +
            '否：源文件按上一问的选择处理。',
        );
        if (wantMirror) deleteSources = false;
    }

    const result = await runImport({
        adapter: storageState.adapter,
        trash,
        api,
        confirm: async () => true, // 上面的确认已覆盖 PARDON 门禁
        progress: (p) => {
            if (p.phase === 'importing') toastr.info(`正在导入 ${p.index + 1}/${p.total}：${p.fileName}`, '聊天文件系统', { timeOut: 1200 });
        },
    }, {
        currentFileName: String(c.chatId || ''),
        only,
        includeCurrent,
        deleteSources,
        characterId: api.characterId,
        avatarUrl: api.avatarUrl,
    });

    const parts = [`已合并 ${result.totalMerged} 条`];
    if (result.families.length) parts.push(`新建家族 ${result.families.length} 个`);
    if (result.failed.length) parts.push(`失败 ${result.failed.length} 个（${result.failed.map((x) => x.fileName).slice(0, 3).join('、')}${result.failed.length > 3 ? '…' : ''}）`);
    if (result.totalFiles === 0) {
        toastr.info(only ? `「${only}」没有可导入的内容（可能已入库）。` : '未检测到可导入的存量聊天。', '聊天文件系统');
    } else {
        toastr.success(`${parts.join('，')}。`, '聊天文件系统', { timeOut: 6000 });
        console.log(`[${MODULE_NAME}] 导入结果:`, result);
    }
    if (wantMirror && result.totalFiles > 0) {
        extension_settings[MODULE_NAME].storage_mode = 'mirror';
        toastr.info('已进入双写模式：之后每次改动都会把库内容同步落成标准聊天文件。', '聊天文件系统', { timeOut: 6000 });
    }
    await syncCurrentBranchId(); // 导入可能给当前聊天建档 → 本键的分支解析跟着更新
    bumpChatList();
    renderAll();
}

/* ---------------- 入库提醒弹窗（T8 / R8.1 / AC21） ---------------- */

/** 压制记录落盘（本机偏好：`extension_settings`，**不写进聊天记录**） */
function saveImportPrompt(next) {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    extension_settings[MODULE_NAME].import_prompt = normImportPrompt(next);
    try {
        saveSettingsDebounced();
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 压制记录落盘调度失败（本会话内仍生效）:`, e);
    }
}

/**
 * 当前聊天在库里有没有家族。
 * 库模式未启用（`storageState` 为空）时库里不可能有这个聊天 → false。
 * 查询异常按「已入库」处理：**宁可不弹**，也不因为一次后端抖动打扰用户（L0-11）。
 */
async function isCurrentChatInLibrary(chatKey) {
    if (!storageState) return false;
    try {
        return Boolean(await storageState.adapter.loadFamily({ chatKey }));
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 入库判定失败（按已入库处理，本次不弹提醒）:`, e);
        return true;
    }
}

/**
 * 打开一个尚未入库的聊天时提醒入库（R8.1/R8.2）。
 *
 * 判定与压制都是纯函数（`core/import-prompt.js`），这里只做「查库 → 弹窗 → 分流」。
 * 全程 try/catch 静默降级（L0-11）：提醒失败绝不能影响聊天本身。
 *
 * 两个调用点：`CHAT_CHANGED`（换聊天）与 `init()`（**冷启动**：页面刚加载就停在一个聊天上，
 * 那次 CHAT_CHANGED 已经过去了）。`importPromptPending` 保证两者不会叠窗。
 */
let importPromptPending = false;

async function maybePromptImport() {
    const c = ctx();
    if (importPromptPending) return;
    try {
        // 冷启动早期可能还没打开任何聊天（扩展先于聊天载入激活）→ 什么都不做，
        // 交给随后的 CHAT_CHANGED（那条路一定会来）。
        const fileName = String(c.getCurrentChatId?.() || c.chatId || '').replace(/\.jsonl$/i, '');
        if (!fileName) return;
        const prompt = normImportPrompt(extension_settings[MODULE_NAME]?.import_prompt);
        const chatKey = normalizeChatKeyOf(c, fileName);
        const inLibrary = await isCurrentChatInLibrary(chatKey);
        const show = shouldPromptImport({
            prompt,
            chatKey,
            inLibrary,
            isGroupChat: Boolean(c.groupId),
            hasDialogOpen: Boolean(document.querySelector('dialog[open]')),
        });
        if (!show) return;
        importPromptPending = true;
        const choice = await openImportPrompt({ fileName });
        // 两个勾选与按钮取向无关，**任何关闭路径**（含 X / Esc）都要落压制记录；没勾就不写
        const next = withImportPromptMutes(prompt, chatKey, choice);
        if (JSON.stringify(next) !== JSON.stringify(prompt)) {
            saveImportPrompt(next);
            if (choice.muteAll) toastr.info('以后不再提醒入库。', '聊天文件系统');
            else if (choice.muteKey) toastr.info('这个聊天不再提醒入库。', '聊天文件系统');
        }
        if (choice.mode === IMPORT_PROMPT_MODE.SKIP) return; // 「不入库」/ 关窗：本次不转
        await importCurrentChatFlow(fileName, choice.mode);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 入库提醒弹窗失败（不阻断聊天）:`, e);
    } finally {
        importPromptPending = false;
    }
}

/**
 * 「纯库」/「双写」按钮：按用户选的那种模式把**眼前这个聊天**转入库。
 *
 * 事实（2026-09-26 核实）：既有 `importJsonlFlow` 的第一道门就是「库模式已启用」
 * （`storageState` 为空直接提示先去设置页切模式）——所以先按 `setStorageMode` 的**既有安全动作**
 * 切到目标模式（`off → 库` 的安全动作只是提示，不会丢数据；`pure → mirror` 会立即落一次文件）。
 * 模式确定后再走导入旅程：`keepBinding` 明确给出 → 不再追问模式相关的两问
 * （双写不删源文件、无需 PARDON 确认；纯库只留删除确认）。
 *
 * @param {string} fileName 当前聊天文件名
 * @param {'pure'|'mirror'} mode
 */
async function importCurrentChatFlow(fileName, mode = 'pure') {
    const name = String(fileName || '').replace(/\.jsonl$/i, '');
    if (!name) {
        toastr.error('拿不到当前聊天的文件名，没有导入。', '聊天文件系统');
        return;
    }
    if (!storageState || storageMode() !== mode) {
        const ok = await setStorageMode(mode);
        if (!ok || !storageState) {
            toastr.error(`切到${STORAGE_MODE_LABELS[mode] || mode}模式失败，没有导入。`, '聊天文件系统');
            return;
        }
    }
    await importJsonlFlow({ only: name, includeCurrent: true, keepBinding: mode === 'mirror' });
}

/* ---------------- 主分支（T9 / R8.3 / AC22） ---------------- */

/** 当前聊天所在的库内家族（库模式未启用 / 未入库 → null） */
async function loadCurrentFamily() {
    if (!storageState) return null;
    try {
        return await storageState.adapter.loadFamily({ chatKey: normalizeChatKeyOf(ctx()) });
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 家族读取失败（设为主分支不可用）:`, e);
        return null;
    }
}

/**
 * 「设为主分支」（R8.3）：主分支 = **打开这个聊天时看到的那条分支**。
 *
 * 用户裁定（2026-09-26）：「可换默认分支，想要删除，只能换，或者删除家族」+「显式『设为主分支』按钮」。
 * 因此删除的护城河是 `deleteBranch` 的既有校验（默认分支不可删）——面板上对主分支把删除按钮置灰，
 * 想删主分支就先换一条。
 *
 * 两步走（顺序不能颠倒）：
 *   ① **先按既有切换路径把内容切到目标分支**（`switchBranch` → `planSwitch` + 官方消息 API）。
 *      为什么不直接改 `active_branch`：模型里 body/groups 的分区（不变式 3）由 `planSwitch` 维护，
 *      手改标记会让「折叠组」与「投影」错位（读回时组数算错、结构校验不通过）。
 *   ② 再迁移主分支标记：`is_default` 换人 + 家族活跃分支跟到同一条（`setMainBranch`），
 *      库模式下**同一次 `saveModel`** 把**主键的键绑定**也改到目标分支（不变量：
 *      「家族恰有一条 `is_default`，且它 = 主键绑定所在分支」）。
 *
 * 旧主分支换完就同时失去 `is_default` 与「家族活跃分支」两重身份 → 可以删（否则 `deleteBranch`
 * 的两条校验会拒掉，用户会看到「换了主分支还是删不掉」）。
 *
 * 写库走适配器直连，不经过接缝（这是结构操作，不是宿主发起的写）；失败时内存副本不领先于库。
 *
 * @param {string} branchId
 * @returns {Promise<boolean>} 是否完成
 */
async function setMainBranchFlow(branchId) {
    const c = ctx();
    const model = getModel();
    if (!model) return false;
    const target = getBranch(model, branchId);
    if (!target) return false;
    if (target.is_default) {
        toastr.info(`「${target.name}」已经是主分支。`, '聊天文件系统');
        return false;
    }
    const prev = model.branches.find((b) => b.is_default);
    const ok = await popupConfirm(
        `把「${target.name}」设为主分支？\n\n`
        + '主分支 = 打开这个聊天时看到的那条分支。\n'
        + `换过之后「${prev?.name || '旧主分支'}」成为普通分支，可以删除。`,
    );
    if (!ok) return false;

    // ① 切到目标分支（既有切换机制；同时把 body/groups 分区摆正）
    const curId = currentBranchId || model.active_branch;
    if (curId !== branchId) await switchBranch(branchId);

    // ② 迁移主分支标记（+ 库模式下同时把主键的绑定改到目标分支）
    const m2 = getModel();
    if (!m2) return false;
    const work = structuredClone(m2);
    setMainBranch(work, branchId);

    if (!storageState) {
        // 增强模式：模型住聊天头，没有键绑定面
        setModel(work);
        await c.saveMetadata();
    } else {
        const family = await loadCurrentFamily();
        if (!family) {
            toastr.error('这个聊天还没入库，先在「当前聊天 → 转库」里录入。', '聊天文件系统');
            return false;
        }
        const nextBindings = setBindingBranch(family.keyBindings, family.chatKey, branchId) ?? family.keyBindings;
        const r = await storageState.adapter.saveModel({
            familyId: family.familyId,
            model: work,
            keyBindings: nextBindings,
            expectedIntegrity: family.integrity,
        });
        if (!r?.ok) {
            toastr.error(`设为主分支失败：${r?.reason || '未知原因'}`, '聊天文件系统');
            return false;
        }
        setModel(work);
    }
    await syncCurrentBranchId();
    renderAll();
    toastr.success(`「${target.name}」已设为主分支`, '聊天文件系统');
    return true;
}

/* ---------------- 角色卡的聊天（T4r.5 页签数据源） ---------------- */

/**
 * 列出当前角色卡下的聊天：**磁盘文件 ∪ 库内家族**。
 * 只列磁盘会漏掉已入库（源文件已进回收站）的聊天，故两边取并集。
 * @returns {Promise<Array<{fileName, messageCount, lastMes, hasFile, inLibrary, familyId?}>>}
 */
async function listChatsForCharacter() {
    const c = ctx();
    const rows = [];
    const byName = new Map();
    try {
        const listing = await importApi().searchChats();
        for (const x of listing || []) {
            const name = String(x?.file_name || '').replace(/\.jsonl$/i, '');
            if (!name || name.includes(HIDDEN_PREFIX)) continue;
            const row = {
                fileName: name,
                messageCount: x.message_count ?? null,
                lastMes: x.last_mes ?? null,
                hasFile: true,
                inLibrary: false,
            };
            byName.set(name, row);
            rows.push(row);
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 磁盘聊天列表读取失败:`, e);
    }
    if (storageState) {
        try {
            const fams = await storageState.adapter.listFamilies({ characterId: c.characterId });
            for (const f of fams || []) {
                const name = String(f?.name || String(f?.chatKey || '').split('::').pop() || '').replace(/\.jsonl$/i, '');
                if (!name || name.includes(HIDDEN_PREFIX)) continue;
                const row = byName.get(name);
                if (row) {
                    row.inLibrary = true;
                    row.familyId = f.familyId;
                } else {
                    const fresh = { fileName: name, messageCount: null, lastMes: null, hasFile: false, inLibrary: true, familyId: f.familyId };
                    byName.set(name, fresh);
                    rows.push(fresh);
                }
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 库内家族列表读取失败:`, e);
        }
    }
    return rows;
}

/** 把某个聊天的结构树渲染进弹窗容器（只显结构；未入库则明说） */
async function renderChatTreeInto(container, fileName) {
    if (!container) return;
    if (!storageState) {
        container.innerHTML = '<div class="chatfilesys-note">库模式未启用，没有结构树可看。</div>';
        return;
    }
    container.innerHTML = '<div class="chatfilesys-note">正在读取结构…</div>';
    const c = ctx();
    try {
        const family = await storageState.adapter.loadFamily({ chatKey: normalizeChatKeyOf(c, fileName) });
        if (!family) {
            container.innerHTML = `<div class="chatfilesys-note">「${esc(fileName)}」尚未入库（先在列表里点「转数据库」）。</div>`;
            return;
        }
        const { floors } = await storageState.adapter.loadFloors({ familyId: family.familyId, from: 0, limit: 1e9 });
        renderTree(container, { model: modelFromStore(family, floors), direction: treeDirection() });
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 结构树读取失败:`, e);
        container.innerHTML = `<div class="chatfilesys-note">结构读取失败：${esc(String(e?.message || e))}</div>`;
    }
}

/* ---------------- T4：树方向 / AI 总结 / 回收站 ---------------- */

/** 切换分支树展开方向（N13；持久化 + 重绘） */
function toggleTreeDirection() {
    const next = treeDirection() === 'right' ? 'down' : 'right';
    extension_settings[MODULE_NAME].tree_direction = next;
    renderAll();
    toastr.info(`结构树：${next === 'right' ? '向右展开' : '向下展开'}`, '聊天文件系统');
}

/**
 * AI 总结某条分支（N13：**手动触发**；生成链路不可用即报错降级，按钮本就不渲染）。
 * 摘要写进 model.branches[i].summary（随模型持久化），不是分支名。
 */
async function summarizeBranch(branchId) {
    const model = getModel();
    const b = model ? getBranch(model, branchId) : null;
    if (!b) return;
    if (!canSummarize()) { toastr.warning('当前宿主没有可用的生成链路，AI 总结不可用。', '聊天文件系统'); return; }
    const lines = assembleBranchLines(model, ctx().chat || [], b, currentBranchId);
    if (!lines.length) { toastr.warning('这条分支没有可总结的内容。', '聊天文件系统'); return; }
    const text = lines.map((l) => `${l.name || (l.is_user ? '用户' : 'AI')}: ${String(l.mes || '').slice(0, 200)}`).join('\n').slice(0, 4000);
    toastr.info('正在生成摘要…', '聊天文件系统', { timeOut: 1500 });
    try {
        const summary = (await generateSummary(text)).trim().replace(/^[「"']|[」"']$/g, '').slice(0, 60);
        if (!summary) { toastr.warning('生成结果为空，未写入摘要。', '聊天文件系统'); return; }
        b.summary = summary;
        setModel(model);
        await ctx().saveMetadata();
        renderAll();
        toastr.success(`「${b.name}」摘要：${summary}`, '聊天文件系统');
    } catch (e) {
        console.warn(`[${MODULE_NAME}] AI 总结失败（降级不阻断）:`, e);
        toastr.error(`AI 总结失败：${e?.message || e}`, '聊天文件系统');
    }
}

/** 回收站：还原为聊天文件（还原到它原来的聊天键） */
async function restoreTrashEntry(trashId) {
    const trash = getTrash();
    if (!trash || !trashId) return;
    if (!(await popupConfirm('把这条回收站条目还原成聊天文件？同名聊天已存在时会被覆盖。'))) return;
    try {
        const r = await trash.restore({ trashId });
        if (!r?.ok) { toastr.error(`还原失败：${r?.reason || '未知原因'}`, '聊天文件系统'); return; }
        const fileName = String(r.source || '').split('::').pop();
        if (!fileName) { toastr.error('还原失败：条目缺少源文件名。', '聊天文件系统'); return; }
        const seam = storageState?.seam;
        const doFetch = (...a) => (seam?.native ? seam.native(...a) : globalThis.fetch(...a));
        const headers = typeof ctx().getRequestHeaders === 'function' ? ctx().getRequestHeaders() : {};
        const lines = String(r.content || '').split('\n').filter(Boolean);
        const res = await doFetch('/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ ch_name: fileName, file_name: fileName, avatar_url: String(r.source || '').split('::')[0], chat: lines, force: true }),
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
        toastr.success(`已还原为「${fileName}」。`, '聊天文件系统');
        bumpChatList();
        renderAll();
    } catch (e) {
        toastr.error(`还原失败：${e?.message || e}`, '聊天文件系统');
    }
}

/** 回收站：立刻清理（永久删除该条目） */
async function purgeTrashEntry(trashId) {
    const trash = getTrash();
    if (!trash || !trashId) return;
    if (!(await popupConfirm('从回收站永久删除这一条？此操作不可撤销。'))) return;
    const r = await trash.purge({ trashId });
    if (r?.ok) toastr.success('已从回收站永久删除。', '聊天文件系统');
    else toastr.error(`清理失败：${r?.reason || '未知原因'}`, '聊天文件系统');
    renderAll();
}

/* ---------------- 交互委托（弹窗内容；click = data-action，change = data-role） ---------------- */

async function handleAction(action, el) {
    const branchId = el.dataset.branch;
    switch (action) {
        case 'enable': return await enableBranches();
        case 'switch': return await switchBranch(branchId);
        case 'rename': return await renameBranchFlow(branchId);
        case 'delete-branch': return await deleteBranchFlow(branchId);
        case 'set-main-branch': return await setMainBranchFlow(branchId);
        case 'export': return await exportChatFile();
        case 'run-import': return await importJsonlFlow();
        case 'sync-mirror': return await syncMirrorNow();
        case 'tree-direction': return toggleTreeDirection();
        case 'ai-summary': return await summarizeBranch(branchId);
        case 'trash-restore': return await restoreTrashEntry(el.dataset.trash);
        case 'trash-purge': return await purgeTrashEntry(el.dataset.trash);
        case 'chat-list-reload': {
            bumpChatList();
            if (popupHandle) popupHandle.content.refresh(currentView());
            return undefined;
        }
        // N3（2026-09-26）：`only` 已把候选限死在这一个文件名上，而当前打开的聊天正是
        // 用户点的那一行 → 必须显式放行（否则 `planImport` 先按 only 过滤、再判当前聊天，
        // 点当前聊天那一行会走到「没有可导入的内容」）。放行只影响这一种情况，不会带上别的聊天。
        case 'chat-import': return await importJsonlFlow({ only: el.dataset.file, includeCurrent: true });
        case 'chat-export': return await exportChatFile(el.dataset.file, { downloadName: `${el.dataset.file}.jsonl` });
        case 'chat-tree': {
            const host = el.closest('.chatfilesys-popup')?.querySelector('[data-role="chat-tree-host"]');
            return await renderChatTreeInto(host, el.dataset.file);
        }
        default: return undefined;
    }
}

function bindPopupEvents(rootEl) {
    if (!rootEl) return;
    rootEl.addEventListener('click', async (evt) => {
        const el = evt.target.closest('[data-action]');
        if (!el || !rootEl.contains(el)) return;
        evt.stopPropagation();
        try {
            await handleAction(el.dataset.action, el);
        } catch (e) {
            console.error(`[${MODULE_NAME}] 操作 ${el.dataset.action} 失败:`, e);
            toastr.error(`操作失败: ${e.message}`);
        }
    });
    // 设置项（原设置页控件搬进弹窗「设置」页签；分支选择器的 data-branch 同步在 popup.js 内）
    rootEl.addEventListener('change', async (evt) => {
        const el = evt.target;
        if (el?.dataset?.role === 'auto-export') {
            extension_settings[MODULE_NAME].auto_export = Boolean(el.checked);
            toastr.info(`保存后自动导出已${el.checked ? '开启' : '关闭'}`, '聊天文件系统');
            return;
        }
        if (el?.dataset?.role === 'storage-mode') {
            const ok = await setStorageMode(String(el.value || 'off'));
            if (!ok) el.value = storageMode(); // 切换被安全动作中止 → 控件回位
        }
    });
}

/**
 * 模式切换（design.md §1 的安全动作表）：
 * - off → 库：提示先走导入旅程（未导入的聊天保持原生、不被接管）
 * - 库 → off：**先把当前分支落成标准聊天文件**，成功才切；失败中止（否则切完内容就没有来源了）
 * - pure → mirror：立即落一次文件；mirror → pure：停止落文件、磁盘文件保留为快照
 * @returns {Promise<boolean>} 是否完成切换
 */
async function setStorageMode(next) {
    const target = normMode(next);
    const cur = storageMode();
    if (target === cur) return true;
    if (target !== 'off' && cur === 'off') {
        toastr.info('已切到库模式——存量聊天请点「转库」录入；未导入的聊天仍走原生文件。', '聊天文件系统');
    }
    if (target === 'off' && cur !== 'off') {
        const r = await exportCurrentChatFile();
        if (!r.ok && r.reason !== 'not-in-library') {
            toastr.error(`导出当前聊天文件失败（${r.reason}），已保持原模式以免内容失去来源。`, '聊天文件系统');
            return false;
        }
    }
    extension_settings[MODULE_NAME].storage_mode = target;
    if (target === 'off') {
        if (cur === 'mirror') toastr.info('磁盘上的聊天文件保留为快照，不再同步。', '聊天文件系统');
        disablePureDb();
    } else {
        await enablePureDb();
        if (isMirror(target)) {
            const r = await exportCurrentChatFile();
            if (!r.ok && r.reason !== 'not-in-library') {
                toastr.warning(`首次落文件失败：${r.reason}（库仍是事实源，可点「与库同步一次」重试）`, '聊天文件系统');
            }
        }
    }
    await syncCurrentBranchId(); // W3：换模式后绑定面变了（进库才有绑定键）
    renderAll();
    toastr.success(`存储模式：${STORAGE_MODE_LABELS[target]}`, '聊天文件系统');
    return true;
}

/** 把当前聊天所在家族落成标准聊天文件（切模式 / pure→mirror / 同步按钮共用） */
async function exportCurrentChatFile() {
    if (!storageState?.mirror) return { ok: false, reason: '库模式未启用' };
    try {
        return await storageState.mirror.exportByChatKey(normalizeChatKeyOf(ctx()));
    } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
    }
}

/** T2.5：「与库同步一次」——把所有脏家族立刻落盘（失败只 warn 不阻断） */
async function syncMirrorNow() {
    if (!mirrorMode()) { toastr.warning('当前不是双写模式。', '聊天文件系统'); return; }
    const results = await storageState.mirror.flushNow();
    const failed = (results || []).filter((r) => !r?.ok);
    if (failed.length) {
        toastr.error(`同步完成，但有 ${failed.length} 个家族落文件失败（${failed.map((f) => f.reason).slice(0, 2).join('；')}）`, '聊天文件系统');
    } else {
        toastr.success('已把库内容落成标准聊天文件。', '聊天文件系统');
    }
    renderAll();
}

/* ---------------- 全局入口（R5：输入框上方工具图标排里的插件按钮 + Alt+B） ---------------- */

const ENTRY_ID = 'chatfilesys-entry';

/**
 * 入口按钮落点 = 宿主 `#leftSendForm`（输入框那一排工具图标）。
 *
 * 依据（Dev Luker 源码核实）：`public/scripts/extensions.js#addExtensionsButtonAndMenu`
 * 用 `$('#leftSendForm').append(buttonHTML)` 挂官方扩展菜单按钮（`#extensionsMenuButton`）；
 * `public/style.css` 的 `#leftSendForm>div` 规则统一给这排图标块尺寸/悬停样式——
 * 我们的按钮同挂这里即获得原生观感，且是官方自己用的落点。
 */
function ensureEntryButton() {
    if (document.getElementById(ENTRY_ID)) return;
    const host = document.getElementById('leftSendForm');
    if (!host) return;
    const btn = document.createElement('div');
    btn.id = ENTRY_ID;
    btn.className = 'fa-solid fa-folder-tree interactable';
    btn.title = '聊天文件系统（Alt+B）';
    btn.addEventListener('click', () => {
        if (popupHandle) return;
        openManagementPopup();
    });
    host.appendChild(btn);
}

function registerGlobalEntries() {
    // 快捷键 Alt+B
    document.addEventListener('keydown', (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyB' || String(e.key).toLowerCase() === 'b')) {
            e.preventDefault();
            if (popupHandle) return;
            openManagementPopup();
        }
    });
}

/* ---------------- 入口 ---------------- */

/**
 * Luker 扩展激活 hook（manifest.hooks.activate 引用）
 * 命名导出 + 顶层不带 jQuery 自执行，由 ST 的 callExtensionHook 动态 import 后调用。
 */
export async function init() {
    loadSettings();
    detectCapabilities();

    // 纯库模式：storage_mode='pure' 时先装 seam（拦截须先于任何聊天 get 就绪，design.md §8.3）
    if (pureDbMode()) {
        await enablePureDb();
    }

    registerGlobalEntries();
    registerEventListeners();
    registerMarkerListeners();
    // 扩展设置抽屉零注入（settings.html 已删除）：唯一界面 = 弹窗，入口 = 工具图标排按钮 + Alt+B
    renderAll();
    // 扩展可能在聊天载入**之后**才激活（没有 CHAT_CHANGED 了）：补取一次本键的分支绑定（W3），
    // 否则首开原生分支/检查点聊天会先按家族活跃分支显示。失败只 warn（L0-11），最后再刷一次 UI。
    syncCurrentBranchId().then(() => scheduleUiRefresh()).catch((e) => console.warn(`[${MODULE_NAME}] 启动时分支解析失败:`, e));
    // 冷启动也弹一次入库提醒（W7，用户 2026-09-26 明令「补，冷启动也弹」）：页面刚加载就停在
    // 一个聊天上时，那次 CHAT_CHANGED 已经过去，只靠事件就永远不弹。不 await（提醒绝不阻断启动），
    // 且与 CHAT_CHANGED 那条路共用 in-flight 去重 → 不会叠窗；扩展先于聊天激活时这里拿不到键，
    // 由随后的 CHAT_CHANGED 负责（`maybePromptImport` 内部判空返回）。
    void maybePromptImport();
    console.log(`[${MODULE_NAME}] 扩展初始化完成`);
}
