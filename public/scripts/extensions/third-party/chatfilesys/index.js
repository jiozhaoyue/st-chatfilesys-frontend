/**
 * ChatFilesys — 前端扩展入口（二期 UI 形态：弹窗为主 + 轻量注入）
 *
 * 数据流（零核心修改、零拦截，2.4 起写路径全走官方消息 API）：
 * - 模型 = chat_metadata.extensions.chatfilesys（随聊天文件走）
 * - body = ctx.chat（活跃分支的楼层线性序列）
 * - 结构操作（分叉/改名/删分支）→ 纯 metadata → ctx.saveMetadata()
 * - 切换/删层 → planSwitch/planDeleteFloor 生成 RFC6902 ops → chat-writer 映射为
 *   deleteMessages（批量自动偏移）/ addMessages（尾段追加）批量调用（官方持久化自动
 *   携带 chat_metadata = ops+metadata 同车；失败回退 ctx.saveChat() 全量）
 * - 追加楼层（原生 append 流）→ MESSAGE_SENT/RECEIVED → registerAppendedGroup → saveMetadataDebounced
 * - 重绘：clearChat + printMessages（失败回退 reloadCurrentChat）
 *
 * UI 宿主分工（spec/frontend/ui-placement.md，2026-09-05 用户裁定）：
 * - 设置页：仅设置项 + 「打开管理面板」按钮
 * - 复杂 UI：管理弹窗（官方 Popup DISPLAY+wide+large + renderLukerTabs，ST 降级内置 Tab）
 * - 消息旁：RENDERED 事件注入 ⎇ 一键分叉按钮 + 分叉点标记
 * - 全局入口：设置页按钮 / 斜杠命令 /cb / 快捷键 Alt+B
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { event_types, eventSource, clearChat, printMessages } from '../../../../script.js';
import { registerSlashCommand } from '../../../slash-commands.js';
import { Popup, callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';

import { enableForChat, registerAppendedGroup, createBranch, renameBranch, deleteBranch, getBranch, getActive, maxFloor, adoptNativeCopy } from './core/branches.js';
import { planSwitch, planDeleteFloor } from './core/projection.js';
import { createChatWriter } from './core/chat-writer.js';
import { installSeam } from './core/seam.js';
import { createStorageAdapter } from './core/storage/adapter.js';
import { modelFromStore } from './core/store-bridge.js';
import { createTrash } from './core/trash.js';
import { runImport } from './core/importer.js';
import { getActiveBranch, branchMaxFloor } from './ui/common.js';
import { createPopupContent } from './ui/popup.js';
import { injectMessageTools, injectAllMessages } from './ui/marker.js';
import { ensureBadge, updateBadge } from './ui/badge.js';

const MODULE_NAME = 'chatfilesys';
const extensionFolderPath = `/scripts/extensions/third-party/${MODULE_NAME}`;

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
    popupClass: false,       // Popup 类（弹窗宿主）
    renderedEvents: false,   // 消息旁注入钩子
    slashCommand: false,     // 斜杠命令
};

function detectCapabilities() {
    CAP.popupClass = typeof ctx().Popup === 'function';
    CAP.renderedEvents = Boolean(event_types.USER_MESSAGE_RENDERED && event_types.CHARACTER_MESSAGE_RENDERED);
    CAP.slashCommand = true; // registerSlashCommand 为静态导入，缺失会在 import 阶段暴露
    console.log(`[${MODULE_NAME}] 能力检测:`, CAP);
}

/* ---------------- 设置（自动导出：关/开，默认关 = 仅手动，PRD 决策 #9） ---------------- */

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || { auto_export: false };
    if (typeof extension_settings[MODULE_NAME].auto_export !== 'boolean') {
        extension_settings[MODULE_NAME].auto_export = false;
    }
    // 纯库模式开关（design.md §8.3：'off'|'pure'，默认 off，安装旅程引导开启）
    if (extension_settings[MODULE_NAME].storage_mode !== 'pure') {
        extension_settings[MODULE_NAME].storage_mode = 'off';
    }
}

function autoExportEnabled() {
    return Boolean(extension_settings[MODULE_NAME]?.auto_export);
}

function pureDbMode() {
    return extension_settings[MODULE_NAME]?.storage_mode === 'pure';
}

/* ---------------- 纯库模式：存储适配器 + seam 接缝（design.md §8.3） ---------------- */

let storageState = null; // { tier, adapter, dispose, seam, trash }

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
            log: console.warn,
        });
        const seam = installSeam(adapter, { log: console.warn });
        storageState = { tier, adapter, dispose, seam };
        console.log(`[chatfilesys] 纯库模式已启用（存储档位：${tier}）`);
        renderStorageBadge();
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
        storageState.seam?.dispose();
        storageState.dispose?.();
    } catch (e) {
        console.warn('[chatfilesys] 纯库模式卸载异常:', e);
    }
    storageState = null;
    renderStorageBadge();
}

/** 设置页存储档位徽章 */
function renderStorageBadge() {
    const el = document.querySelector('#chatfilesys-storage-badge');
    if (!el) return;
    if (!pureDbMode()) {
        el.innerHTML = '<span class="chatfilesys-badge">存储：JSONL 增强模式</span>';
        return;
    }
    const tierName = { authority: 'Authority SQL', official: '官方通道', idb: 'IndexedDB 缓存' }[storageState?.tier] || '未就绪';
    el.innerHTML = `<span class="chatfilesys-badge">存储：纯库 · ${tierName}</span>`;
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
        const active = getActive(model);
        if (ctx().chat.length !== maxFloor(active)) {
            errors.push(`分支树（${maxFloor(active)} 层）与聊天体（${ctx().chat.length} 行）不一致——可能在原生环境改动过消息。`);
        }
    } catch (e) {
        errors.push(`模型异常: ${e.message}`);
    }
    return errors.join(' ');
}

function currentView() {
    const c = ctx();
    const model = getModel();
    const active = model ? getActiveBranch(model) : null;
    return {
        model,
        chat: c.chat || [],
        familyName: familyName(),
        warning: currentWarning(),
        isGroupChat: Boolean(c.groupId),
        autoExport: autoExportEnabled(),
        activeName: active?.name || '',
    };
}

let settingsStatusEl = null;

function renderSettingsStatus() {
    const el = settingsStatusEl?.[0] || settingsStatusEl;  // jQuery 对象或原生元素均可
    if (!el) return;
    renderStorageBadge();
    const v = currentView();
    if (v.isGroupChat) {
        el.innerHTML = '<span class="chatfilesys-badge">群聊：分支功能不适用</span>';
        return;
    }
    el.innerHTML = v.model
        ? `<span class="chatfilesys-badge">家族：${v.familyName}</span>
           <span class="chatfilesys-badge">${v.model.branches.length} 分支</span>
           <span class="chatfilesys-badge">${branchMaxFloor(getActiveBranch(v.model))} 层</span>`
        : '<span class="chatfilesys-badge">未启用——在管理面板中可启用</span>';
}

let popupHandle = null; // { popup, content:{el, refresh} }

let uiRefreshTimer = null;

function injectAllNow() {
    const v = currentView();
    injectAllMessages({ model: v.model, isGroupChat: v.isGroupChat, onQuickFork: quickFork });
}

/**
 * UI 刷新防抖（150ms）：弹窗重建、徽章、消息旁注入补注统一走这里。
 * 实测依据：printMessages 批量重绘不触发 RENDERED 事件（append 路径才触发），
 * 切换/删层后的注入恢复必须由我们自己的重绘尾部显式补做或走本防抖。
 */
function scheduleUiRefresh() {
    clearTimeout(uiRefreshTimer);
    uiRefreshTimer = setTimeout(() => {
        renderSettingsStatus();
        if (popupHandle) popupHandle.content.refresh(currentView());
        updateBadge(currentView());
        injectAllNow();
    }, 150);
}

function renderAll() {
    renderSettingsStatus();
    scheduleUiRefresh();
}

/** 分支切换/删层后的聊天区重绘；失败回退官方整载 */
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

/* ---------------- 管理弹窗（唯一复杂 UI 宿主） ---------------- */

async function openManagementPopup() {
    if (popupHandle) return;
    if (typeof Popup !== 'function') {
        toastr.error('当前环境缺少 Popup API，管理面板不可用。');
        return;
    }
    const content = createPopupContent(ctx(), currentView());
    bindActions(content.el);  // 弹窗内容的数据操作委托（switch/fork/rename/delete/export/enable）
    const popup = new Popup(content.el, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
    });
    popupHandle = { popup, content };
    // 宿主实测（2026-09-06，design.md「二期实测事实」#6）：DISPLAY 弹窗关闭时宿主不回调
    // onClose/onClosing、show() 的 Promise 也不 resolve——popupHandle 只能靠 dialog 标准
    // close 事件清引用，否则弹窗关闭后无法二次打开。show() 调用后 content.el 已挂入 dialog。
    popup.show();
    content.el.closest('dialog')?.addEventListener('close', () => { popupHandle = null; }, { once: true }); // 不 await：弹窗保持打开，事件驱动 refresh
}

/* ---------------- 业务操作 ---------------- */

async function enableBranches() {
    const c = ctx();
    if (getModel()) return;
    const ok = await popupConfirm(
        '启用分支？此聊天将成为一个聊天家族：当前消息序列成为「主分支」，之后可零复制分叉。' +
        '数据仍存于本聊天文件内（chat_metadata.extensions），vanilla ST 完全兼容。',
    );
    if (!ok) return;
    setModel(enableForChat(c.chat || []));
    await c.saveMetadata();
    renderAll();
    toastr.success('分支已启用');
}

/**
 * 切换分支：共享前缀不动，尾部折叠/展开；ops 经 chat-writer 映射为官方消息 API
 * 批量调用（deleteMessages/addMessages，官方持久化自动携带 metadata）。
 */
async function switchBranch(branchId) {
    const c = ctx();
    const model = getModel();
    if (!model || model.active_branch === branchId) return;
    const target = getBranch(model, branchId);
    if (!target) return;

    let operations;
    try {
        ({ operations } = planSwitch(model, branchId, c.chat || []));
    } catch (e) {
        toastr.error(`切换失败: ${e.message}`);
        return;
    }
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

    await renderChat();
    renderAll();
    maybeAutoExport();
    toastr.success(`已切换到「${target.name}」`);
}

/**
 * 一键直分叉（消息旁 ⎇，R14）：立即创建 + 自动切换 + 自动命名（分支N），改名去弹窗。
 */
async function quickFork(floor) {
    const model = getModel();
    if (!model) return;
    const name = `分支${model.branches.length + 1}`;
    try {
        const b = createBranch(model, { name, forkFloor: floor, activate: false });
        await switchBranch(b.id);
    } catch (e) {
        toastr.error(`分叉失败: ${e.message}`);
    }
}

/**
 * 分叉（面板内，带命名）：建分支（零复制）→ 统一走切换路径（尾 fork 无 body 变化；中段 fork 折叠原分支尾部）。
 */
async function forkBranch(floor) {
    const model = getModel();
    if (!model) return;
    const name = await popupInput(`在第 ${floor} 层之后分叉——新分支名称：`, `分叉·F${floor}`);
    if (!name) return;
    try {
        const b = createBranch(model, { name, forkFloor: floor, activate: false });
        await switchBranch(b.id);
    } catch (e) {
        toastr.error(`分叉失败: ${e.message}`);
    }
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
        toastr.success('分支已重命名');
    } catch (e) {
        toastr.error(`重命名失败: ${e.message}`);
    }
}

async function deleteBranchFlow(branchId) {
    const model = getModel();
    const b = getBranch(model, branchId);
    if (!b) return;
    if (!(await popupConfirm(`删除分支「${b.name}」？其私有楼层将一并移除（共享楼层不受影响）。`))) return;
    try {
        deleteBranch(model, branchId);
        setModel(model);
        await ctx().saveMetadata();
        renderAll();
        toastr.success(`分支「${b.name}」已删除`);
    } catch (e) {
        toastr.error(`删除失败: ${e.message}`);
    }
}

/**
 * 删除楼层（全局）：模型重编号 + ops 经 chat-writer 走官方 deleteMessages
 * （批量自动索引偏移，与删层重编号契合；官方持久化携带新 metadata）。
 */
async function deleteFloorFlow(floor) {
    const c = ctx();
    const model = getModel();
    if (!model) return;
    if (!(await popupConfirm(`删除第 ${floor} 层？全局生效：所有分支失去该层，后续楼层前移。`))) return;
    let operations;
    try {
        ({ operations } = planDeleteFloor(model, floor, c.chat || []));
    } catch (e) {
        toastr.error(e.message);
        return;
    }
    setModel(model);
    if (operations.length > 0) {
        try {
            await messageWriter.applyOperations(operations);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] 消息 API 删除失败，回退全量保存:`, e);
            await c.saveChat();
        }
    } else {
        await c.saveMetadata();
    }
    maybeAutoExport();
    renderAll();
}

/**
 * 楼层同步：原生 append（用户/AI 继续聊天）后，把新楼层登记进模型。
 * 仅 metadata 变化，防抖持久化；chat 缩短（删除）时自动跳过。
 */
function syncAppendedFloors() {
    const c = ctx();
    const model = getModel();
    if (!model) return 0;
    let registered = 0;
    let guard = 0;
    while (c.chat.length > maxFloor(getActive(model)) && guard++ < 500) {
        registerAppendedGroup(model, maxFloor(getActive(model)) + 1);
        registered++;
    }
    if (registered > 0) {
        setModel(model);
        c.saveMetadataDebounced();
    }
    return registered;
}

/* ---------------- 原生书签收编（PRD 决策 #8） ---------------- */

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
 */
async function adoptNativeBranchFlow(payload) {
    const c = ctx();
    const model = getModel();
    if (!model || c.groupId) return; // 未接管聊天/群聊：原生行为原样，不询问
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

/* ---------------- 增量导出（PRD 决策 #9） ---------------- */

/**
 * 导出当前分支为纯标准 JSONL（服务端落盘视图 = 活跃分支投影；剥离分支元数据）。
 * @returns {Promise<boolean>}
 */
async function exportCurrentBranch(quiet = false) {
    const c = ctx();
    const model = getModel();
    if (!model) return false;
    const file = await fetchChatFile(c.getCurrentChatId?.() || c.chatId);
    if (!file || !file.header) {
        if (!quiet) toastr.error('导出失败：聊天文件读取失败。', '聊天文件系统');
        return false;
    }
    if (file.header.chat_metadata?.extensions) {
        delete file.header.chat_metadata.extensions.chatfilesys;
    }
    const active = model.branches.find((b) => b.id === model.active_branch);
    const jsonl = [JSON.stringify(file.header), ...file.lines.map((l) => JSON.stringify(l))].join('\n') + '\n';
    const blob = new Blob([jsonl], { type: 'application/x-jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.chatId} - 分支「${active?.name || 'main'}」.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (!quiet) toastr.success('当前分支已导出为纯标准 JSONL。', '聊天文件系统');
    return true;
}

let autoExportTimer = null;

function maybeAutoExport() {
    if (!autoExportEnabled()) return;
    clearTimeout(autoExportTimer);
    autoExportTimer = setTimeout(() => { exportCurrentBranch(true); }, 1500);
}

/* ---------------- 消息旁注入（RENDERED 事件驱动） ---------------- */

function onMessageRendered(messageId) {
    const c = ctx();
    injectMessageTools(Number(messageId), {
        model: getModel(),
        isGroupChat: Boolean(c.groupId),
        onQuickFork: quickFork,
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

function onChatChanged() {
    syncAppendedFloors();
    renderAll();
}

/** 新聊天自动建家族（PRD 决策 #6）；已有聊天保持原生，启用由用户显式触发 */
function onChatCreated() {
    const c = ctx();
    if (c.groupId) { renderAll(); return; }
    if (!getModel()) {
        setModel(enableForChat(c.chat || []));
        c.saveMetadataDebounced();
    }
    renderAll();
}

function onMessageChanged() {
    syncAppendedFloors();
    renderAll();
    maybeAutoExport();
}

function registerEventListeners() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_CREATED, onChatCreated);
    eventSource.on(event_types.MESSAGE_SENT, onMessageChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageChanged);
    eventSource.on(event_types.MESSAGE_EDITED, () => renderAll());
    eventSource.on(event_types.MESSAGE_SWIPED, () => renderAll());
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
        /** 读源 jsonl 全文（raw 供回收站快照；lines 供指纹合并） */
        async readChatFile(fileName) {
            const res = await nativeFetch('/api/chats/get', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ ch_name: char.name, file_name: fileName, avatar_url: char.avatar }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (!Array.isArray(data)) return null;
            return { header: data[0], lines: data.slice(1), raw: data.map(JSON.stringify).join('\n') };
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
 * 导入旅程入口（管理面板/设置页按钮触发）。
 * 全程依赖注入；确认弹窗 = PARDON 门禁（默认勾选删除，取消保留 jsonl）。
 */
async function importJsonlFlow() {
    if (!storageState) {
        toastr.warning('请先开启纯库模式，再导入存量聊天。', '聊天文件系统');
        return;
    }
    const c = ctx();
    const api = importApi();
    const trash = getTrash();
    if (!trash) { toastr.error('回收站未就绪，导入中止。', '聊天文件系统'); return; }

    // 删除源文件确认（N2 用户旅程：默认删 → 回收站 7 天）
    const deleteSources = await popupConfirm(
        `将检测本角色的存量聊天（不含当前打开的聊天与库隐容器），智能合并入库。\n\n` +
        '完成后删除源 jsonl 文件？\n（推荐：删除——副本先进回收站保留 7 天，可随时还原）',
    );

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
        deleteSources,
        characterId: api.characterId,
        avatarUrl: api.avatarUrl,
    });

    const parts = [`已合并 ${result.totalMerged} 条`];
    if (result.families.length) parts.push(`新建家族 ${result.families.length} 个`);
    if (result.failed.length) parts.push(`失败 ${result.failed.length} 个（${result.failed.map((x) => x.fileName).slice(0, 3).join('、')}${result.failed.length > 3 ? '…' : ''}）`);
    if (result.totalFiles === 0) {
        toastr.info('未检测到可导入的存量聊天。', '聊天文件系统');
    } else {
        toastr.success(`${parts.join('，')}。`, '聊天文件系统', { timeOut: 6000 });
        console.log(`[${MODULE_NAME}] 导入结果:`, result);
    }
    renderAll();
}

/* ---------------- 交互委托（设置页 + 弹窗内容共用同一套 data-action） ---------------- */

async function handleAction(action, el) {
    const branchId = el.dataset.branch;
    const floor = Number(el.dataset.floor);
    switch (action) {
        case 'open-popup': return await openManagementPopup();
        case 'enable': return await enableBranches();
        case 'switch': return await switchBranch(branchId);
        case 'fork': return await forkBranch(floor);
        case 'rename': return await renameBranchFlow(branchId);
        case 'delete-branch': return await deleteBranchFlow(branchId);
        case 'delete-floor': return await deleteFloorFlow(floor);
        case 'export': return await exportCurrentBranch();
        case 'run-import': return await importJsonlFlow();
        default: return undefined;
    }
}

function bindActions(rootEl) {
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
}

function bindSettingsEvents(settingsRoot) {
    // settingsRoot 是 jQuery 对象（抽屉内容容器），事件委托用 jQuery .on
    settingsRoot.on('change', '#chatfilesys-auto-export', function () {
        extension_settings[MODULE_NAME].auto_export = Boolean(this.checked);
        toastr.info(`保存后自动导出已${this.checked ? '开启' : '关闭'}`, '聊天文件系统');
    });
    // 纯库模式开关（N2：安装旅程引导开启；此处为手动开关入口）
    settingsRoot.on('change', '#chatfilesys-pure-db', async function () {
        const on = Boolean(this.checked);
        extension_settings[MODULE_NAME].storage_mode = on ? 'pure' : 'off';
        if (on) {
            await enablePureDb();
            toastr.info('纯库模式已开启——新聊天将存入数据库；存量聊天经管理面板导入。', '聊天文件系统');
        } else {
            disablePureDb();
            toastr.info('已切回 JSONL 增强模式。', '聊天文件系统');
        }
        renderAll();
    });
}

/* ---------------- 全局入口（PRD 决策 #7：设置页按钮 / /cb / Alt+B） ---------------- */

function registerGlobalEntries() {
    // 斜杠命令 /cb
    if (CAP.slashCommand) {
        registerSlashCommand('cb', async () => {
            if (popupHandle) { toastr.info('管理面板已打开。'); return ''; }
            await openManagementPopup();
            return '';
        }, [], '打开聊天文件系统管理面板');
    }
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

    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(html);
        const settingsRoot = $('#chatfilesys-settings .chatfilesys-settings-content');
        settingsStatusEl = $('#chatfilesys-settings .chatfilesys-settings-status');
        $('#chatfilesys-auto-export').prop('checked', autoExportEnabled());
        $('#chatfilesys-pure-db').prop('checked', pureDbMode());
        bindActions(settingsRoot[0]);
        bindSettingsEvents(settingsRoot);
    } catch (e) {
        console.error(`[${MODULE_NAME}] 设置页注入失败:`, e);
        return;
    }

    ensureBadge(() => openManagementPopup());
    registerGlobalEntries();
    registerEventListeners();
    registerMarkerListeners();
    renderAll();
    console.log(`[${MODULE_NAME}] 扩展初始化完成`);
}
