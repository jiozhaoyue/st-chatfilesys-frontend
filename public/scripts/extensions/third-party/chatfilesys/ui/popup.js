/**
 * ChatFilesys — 管理弹窗内容（R5 2026-09-25 重裁定：**弹窗即唯一界面**）
 *
 * 宿主 = 官方 Popup（DISPLAY+wide+large，index.js 负责生命周期）；本模块只负责内容：
 * Tabs 用官方 renderLukerTabs（tab 选择持久化到 extension_settings），ST 无此 API 时
 * 降级为内置轻量 Tab（能力检测+优雅降级）。
 * Tab 内容体带 data-tabbody 标记，刷新时只重填内容、不重建外壳（保留 tab 选择态）。
 *
 * 五个页签（旧「分支树 / 楼层 / 批量操作 / 导出」四页签已废除——不留兼容包袱）：
 *   当前聊天 / 结构图 / 角色卡的聊天 / 设置 / 回收站
 *
 * **「结构树」与「结构图」是两种粒度，不要混**：
 *   · 结构树 = 分支级（节点 = 一条分支）——「我有哪几条分支」
 *   · 结构图 = 消息级（节点 = 一条消息）——「这几条分支在哪里分、在哪里合」
 *
 * 铁律：
 *   · **绝不逐层列举楼层**——弹窗内任何位置都不得逐层列出楼层（旧「楼层」页签不得重新引入）
 *   · **结构视图只显结构**（节点 = 序号 / 分支名 + 层数 / 谁说的），不含任何消息内容
 *     （结构图的节点只写 `#N · 用户/角色`，正文要用户主动点开才走 ui/versions.js 展示层）
 */

import { esc, nodeLabel, getActiveBranch, branchMaxFloor, renderInactiveContent } from './common.js';
import { renderTree } from './tree.js';

const TABS = [
    { key: 'chat', label: '当前聊天' },
    { key: 'graph', label: '结构图' },   // B4：消息级图视图（与「结构树」不同粒度，见 ui/graph/view.js 文件头）
    { key: 'character', label: '角色卡的聊天' },
    { key: 'settings', label: '设置' },
    { key: 'trash', label: '回收站' }, // N15：列出 / 还原 / 立刻清理
];

function fallbackTabShell() {
    const headers = TABS.map((t, i) => `
        <button class="chatfilesys-tab-btn menu_button ${i === 0 ? 'active' : ''}" data-tabbtn="${t.key}">${t.label}</button>`).join('');
    const bodies = TABS.map((t, i) => `
        <div class="chatfilesys-tabbody" data-tabbody="${t.key}" ${i === 0 ? '' : 'hidden'}></div>`).join('');
    return { html: `<div class="chatfilesys-tabs">${headers}</div>${bodies}`, manual: true };
}

/**
 * 回收站页签内容：异步拉列表 → 行内「还原 / 立刻清理」。
 * 每次打开面板拉一次（列表可能被导入旅程改动），失败只提示不抛。
 */
async function loadTrashInto(container, listTrash) {
    try {
        const items = (await listTrash()) || [];
        if (!items.length) {
            container.innerHTML = '<div class="chatfilesys-note">回收站为空。删除聊天源文件时会把副本先放这里（保留 7 天）。</div>';
            return;
        }
        container.innerHTML = items.map((x) => `
            <div class="chatfilesys-trash-row" data-trash="${esc(x.trashId)}">
                <span class="src" title="${esc(x.source)}">${esc(String(x.source || '').split('::').pop())}</span>
                <span class="meta">${x.movedAt ? new Date(Number(x.movedAt)).toLocaleString() : ''}</span>
                <span class="actions">
                    <button class="menu_button" data-action="trash-restore" data-trash="${esc(x.trashId)}" title="还原为聊天文件">还原</button>
                    <button class="menu_button" data-action="trash-purge" data-trash="${esc(x.trashId)}" title="立刻从回收站永久删除">立刻清理</button>
                </span>
            </div>`).join('');
    } catch (e) {
        container.innerHTML = `<div class="chatfilesys-note">回收站读取失败：${esc(String(e?.message || e))}</div>`;
    }
}

/**
 * 「角色卡的聊天」页签内容：列出当前角色卡下的聊天（磁盘文件 ∪ 库内家族）。
 * 每行：转数据库（仅磁盘文件）/ 导出 / 查看结构树（仅已入库）。
 */
async function loadChatsInto(container, listChats, note) {
    const reloadBtn = container.querySelector('[data-role="chat-list-reload"]');
    const host = container.querySelector('.chatfilesys-chatlist');
    if (!host) return;
    if (typeof listChats !== 'function') {
        host.innerHTML = `<div class="chatfilesys-note">${esc(note || '当前无法枚举聊天。')}</div>`;
        return;
    }
    if (reloadBtn) reloadBtn.disabled = true;
    host.innerHTML = '<div class="chatfilesys-note">正在读取聊天列表…</div>';
    try {
        const items = (await listChats()) || [];
        host.innerHTML = items.map((x) => `
            <div class="chatfilesys-chat-row" data-file="${esc(x.fileName)}">
                <span class="src" title="${esc(x.fileName)}">${esc(x.fileName)}</span>
                <span class="meta">${x.messageCount ?? '?'} 条 · 最后 ${x.lastMes ? new Date(String(x.lastMes)).toLocaleString() : '—'}</span>
                <span class="state">${x.inLibrary ? '已入库' : '仅磁盘文件'}</span>
                <span class="actions">
                    ${x.hasFile ? `<button class="menu_button" data-action="chat-import" data-file="${esc(x.fileName)}" title="把这份存量 jsonl 录入数据库（源文件进回收站）">转数据库</button>` : ''}
                    <button class="menu_button" data-action="chat-export" data-file="${esc(x.fileName)}" title="导出为纯标准 JSONL">导出</button>
                    ${x.inLibrary ? `<button class="menu_button" data-action="chat-tree" data-file="${esc(x.fileName)}" title="查看该聊天的结构树（只显结构）">结构树</button>` : ''}
                </span>
            </div>`).join('') || '<div class="chatfilesys-note">本角色卡下没有聊天。</div>';
    } catch (e) {
        host.innerHTML = `<div class="chatfilesys-note">聊天列表读取失败：${esc(String(e?.message || e))}</div>`;
    } finally {
        if (reloadBtn) reloadBtn.disabled = false;
    }
}

/**
 * 创建弹窗内容。
 * @returns {{el: HTMLElement, refresh: (view: object) => void}}
 */
export function createPopupContent(ctx, view) {
    const root = document.createElement('div');
    root.className = 'chatfilesys-popup';

    const header = document.createElement('div');
    header.className = 'chatfilesys-popup-header';
    root.appendChild(header);

    const shellHost = document.createElement('div');
    shellHost.className = 'chatfilesys-tabs-host';
    root.appendChild(shellHost);

    let manualTabs = null;

    if (typeof ctx.renderLukerTabs === 'function') {
        try {
            shellHost.innerHTML = ctx.renderLukerTabs({
                id: 'chatfilesys-tabs',
                scope: 'management',
                moduleName: 'chatfilesys',
                defaultTab: 'chat',   // 打开即「当前聊天」（tab 选择由 renderLukerTabs 自己持久化）
                tabs: TABS.map((t) => ({
                    key: t.key,
                    label: t.label,
                    contentHtml: `<div class="chatfilesys-tabbody" data-tabbody="${t.key}"></div>`,
                })),
            });
        } catch (e) {
            console.warn('[chatfilesys] renderLukerTabs 失败，降级内置 Tab:', e);
            const fb = fallbackTabShell();
            shellHost.innerHTML = fb.html;
            manualTabs = fb.manual;
        }
    } else {
        const fb = fallbackTabShell();
        shellHost.innerHTML = fb.html;
        manualTabs = fb.manual;
    }

    if (manualTabs) {
        shellHost.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tabbtn]');
            if (!btn) return;
            const key = btn.dataset.tabbtn;
            shellHost.querySelectorAll('[data-tabbtn]').forEach((b) => b.classList.toggle('active', b === btn));
            shellHost.querySelectorAll('[data-tabbody]').forEach((b) => { b.hidden = b.dataset.tabbody !== key; });
        });
    }

    const bodyOf = (key) => shellHost.querySelector(`[data-tabbody="${key}"]`);

    /** 最近一次渲染的视图（picker 的 change 监听在 refresh 之外，需要它来算「主分支」） */
    let lastModel = null;

    /* ---------- 页签静态骨架（建一次，动态部分每次 refresh 重填） ---------- */

    function ensureChatTab(body) {
        if (!body || body.querySelector('.chatfilesys-tab-inner')) return;
        body.innerHTML = `
            <div class="chatfilesys-tab-inner">
                <div class="chatfilesys-section">
                    <h4>结构树</h4>
                    <div class="chatfilesys-tree-host" data-role="tree-host"></div>
                </div>
                <div class="chatfilesys-section">
                    <h4>分支管理</h4>
                    <div class="chatfilesys-btnrow">
                        <select class="text_pole chatfilesys-branch-picker" data-role="branch-picker"></select>
                        <button class="menu_button" data-action="set-main-branch" data-branch="" title="把选中的分支设为主分支（主分支 = 打开这个聊天看到的内容）"><i class="fa-solid fa-star"></i> 设为主分支</button>
                        <button class="menu_button" data-action="rename" data-branch="" title="改分支名（磁盘上真有该文件时同步改宿主文件名）"><i class="fa-solid fa-pencil"></i> 改名</button>
                        <button class="menu_button" data-action="delete-branch" data-branch="" title="删除该分支（其私有组一并回收）"><i class="fa-solid fa-trash"></i> 删除分支</button>
                        <button class="menu_button" data-action="ai-summary" data-branch="" title="用 AI 总结这条分支（手动触发）"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 总结</button>
                        <button class="menu_button" data-action="merge-branches" data-branch="" title="把这条分支与另一条合成一条新分支（原分支不动）"><i class="fa-solid fa-code-merge"></i> 合并…</button>
                    </div>
                </div>
                <div class="chatfilesys-section">
                    <h4>本聊天的库操作</h4>
                    <div class="chatfilesys-btnrow">
                        <button class="menu_button" data-action="run-import" title="检测本角色存量 jsonl → 指纹合并入库 → 源文件移入回收站（需库模式）">
                            <i class="fa-solid fa-box-archive"></i> 转库（导入存量聊天）
                        </button>
                        <button class="menu_button" data-action="export" title="导出当前分支为纯标准 JSONL"><i class="fa-solid fa-download"></i> 导出当前分支</button>
                        <button class="menu_button" data-action="sync-mirror" title="把库内容立刻落成标准聊天文件（仅双写模式可用）"><i class="fa-solid fa-rotate"></i> 与库同步一次</button>
                    </div>
                </div>
            </div>`;
    }

    function ensureCharacterTab(body) {
        if (!body || body.querySelector('.chatfilesys-tab-inner')) return;
        body.innerHTML = `
            <div class="chatfilesys-tab-inner">
                <div class="chatfilesys-section">
                    <h4>本角色卡下的聊天</h4>
                    <div class="chatfilesys-btnrow">
                        <button class="menu_button" data-action="chat-list-reload"><i class="fa-solid fa-rotate"></i> 刷新列表</button>
                    </div>
                    <div class="chatfilesys-chatlist"></div>
                </div>
                <div class="chatfilesys-section">
                    <h4>结构树（所选聊天，只显结构）</h4>
                    <div class="chatfilesys-tree-host" data-role="chat-tree-host">
                        <div class="chatfilesys-note">点某行的「结构树」查看。</div>
                    </div>
                </div>
            </div>`;
    }

    function ensureSettingsTab(body) {
        if (!body || body.querySelector('.chatfilesys-tab-inner')) return;
        // 静态骨架建一次；**控件由设置表生成**（见 renderSettingsInto），
        // 于是「加一项设置」只改 `core/settings-registry.js` 一处，不动这里
        body.innerHTML = `
            <div class="chatfilesys-tab-inner">
                <div class="chatfilesys-storage-status" data-role="storage-status"></div>
                <div class="chatfilesys-export-row">
                    <label title="JSONL 增强：内容存聊天文件（原生形态）｜纯数据库：内容只存库｜双写：库为事实源，同时保留一份标准聊天文件">
                        存储模式
                        <select class="text_pole" data-role="storage-mode"></select>
                    </label>
                    <span class="chatfilesys-entry-hint">切到库模式后，用「当前聊天 → 转库」把旧聊天录进库</span>
                </div>
                <div class="chatfilesys-settings-groups" data-role="settings-groups"></div>
                <div class="chatfilesys-btnrow">
                    <button class="menu_button" data-action="settings-reset-all"
                            title="把下面全部设置恢复为出厂默认">恢复全部默认</button>
                    <button class="menu_button" data-action="settings-export"
                            title="把全部可调项（含类型、默认值、取值范围、为什么）导成 JSON 复制走——排障与自动化脚本用">导出设置清单 JSON</button>
                </div>
                <div class="chatfilesys-note">
                    界面入口：输入框上方工具图标排里的插件按钮，或快捷键 Alt+B。
                </div>
            </div>`;
    }

    /**
     * 由设置表生成控件（**每次 refresh 重填**：值是活的，控件要为最新值）。
     * @param {HTMLElement} host
     * @param {object} v currentView 的产物
     */
    function renderSettingsInto(host, v) {
        if (!host) return;
        const groups = v.settingsGroups || [];
        if (!groups.length) {
            host.innerHTML = '<div class="chatfilesys-note">设置表未加载。</div>';
            return;
        }
        const values = v.settingsValues || {};
        // 保留用户正在编辑的焦点：重填会让输入框失焦（数字框尤其明显）。
        // 记下 key+光标位置，重填后恢复——不这么做，调一个数字就要重新点一次。
        const ae = document.activeElement;
        const focusKey = ae?.dataset?.key || null;
        const selStart = typeof ae?.selectionStart === 'number' ? ae.selectionStart : null;

        host.innerHTML = groups.map((g) => `
            <div class="chatfilesys-set-group">
                <h5>${esc(g.name)}</h5>
                ${g.items.map((it) => itemHtml(it, values[it.key])).join('')}
            </div>`).join('');

        if (focusKey) {
            const back = host.querySelector(`[data-key="${focusKey}"]`);
            if (back) {
                back.focus();
                if (selStart !== null && typeof back.setSelectionRange === 'function') {
                    try { back.setSelectionRange(selStart, selStart); } catch { /* 非文本控件忽略 */ }
                }
            }
        }
    }

    /** 一项设置 → 一行（标签 + 控件 + 「为什么」） */
    function itemHtml(it, value) {
        const key = esc(it.key);
        const title = esc(it.describe || '');
        let control = '';
        if (it.type === 'boolean') {
            control = `<input type="checkbox" data-role="setting" data-key="${key}"
                data-type="boolean" ${value ? 'checked' : ''}>`;
        } else if (it.type === 'enum') {
            control = `<select class="text_pole" data-role="setting" data-key="${key}" data-type="enum">
                ${(it.values || []).map((v) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${
                    esc((it.valueLabels || {})[v] || v)}</option>`).join('')}</select>`;
        } else if (it.type === 'number') {
            control = `<input type="number" class="text_pole chatfilesys-set-num" data-role="setting"
                data-key="${key}" data-type="number" value="${esc(String(value))}"
                min="${esc(String(it.min))}" max="${esc(String(it.max))}" step="${esc(String(it.step))}"
                title="范围 ${esc(String(it.min))} – ${esc(String(it.max))}">`;
        } else {
            control = `<input type="text" class="text_pole" data-role="setting" data-key="${key}"
                data-type="text" value="${esc(String(value ?? ''))}">`;
        }
        return `
            <div class="chatfilesys-set-row">
                <label class="chatfilesys-set-label" title="${title}">${esc(it.label)}</label>
                <span class="chatfilesys-set-ctl">${control}</span>
                <span class="chatfilesys-set-why" title="${title}">${esc(it.why || it.describe || '')}</span>
            </div>`;
    }

    function ensureGraphTab(body) {
        if (!body || body.querySelector('.chatfilesys-tab-inner')) return;
        body.innerHTML = `
            <div class="chatfilesys-tab-inner">
                <div class="chatfilesys-section">
                    <h4>结构图 <span class="chatfilesys-badge chatfilesys-badge-dim">消息级</span></h4>
                    <div class="chatfilesys-btnrow">
                        <button class="menu_button" data-action="graph-reload" title="重新读数据源并重建图（忽略缓存）"><i class="fa-solid fa-rotate"></i> 重算</button>
                        <button class="menu_button" data-action="graph-fit" title="把整张图装进视口"><i class="fa-solid fa-expand"></i> 适应窗口</button>
                        <button class="menu_button" data-action="graph-zoom-in" title="放大"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
                        <button class="menu_button" data-action="graph-zoom-out" title="缩小"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
                    </div>
                    <div class="chatfilesys-graph-host" data-role="graph-host"></div>
                    <div class="chatfilesys-note" data-role="graph-status"></div>
                </div>
                <div class="chatfilesys-section">
                    <h4>节点</h4>
                    <div class="chatfilesys-graph-selection" data-role="graph-selection">
                        <div class="chatfilesys-note">点图上的节点看它的来龙去脉。</div>
                    </div>
                </div>
            </div>`;
    }

    function ensureTrashTab(body) {
        if (!body || body.querySelector('.chatfilesys-tab-inner')) return;
        body.innerHTML = '<div class="chatfilesys-tab-inner"><div class="chatfilesys-trash-host"></div></div>';
    }

    const refresh = (v) => {
        const {
            model, chat, familyName, warning = '', isGroupChat = false, autoExport = false,
            treeDirection = 'down', canSummarize = false, listTrash = null, trashNote = '',
            listChats = null, chatsNote = '', storage = {}, pureLike = false, chatsToken = 0,
            branchId = null, graphToken = 0, renderGraph = null, graphSelection = null,
            graphEnabled = true, settingsGroups = [], settingsValues = {},
        } = v;
        // W3：本聊天键绑定的分支优先，无绑定才回落家族活跃分支（绑定键上的 body 是它自己的投影）
        const active = model ? getActiveBranch(model, branchId) : null;
        const maxF = active ? branchMaxFloor(active) : 0;
        lastModel = model;

        header.innerHTML = model
            ? `<span class="chatfilesys-badge">家族：${esc(familyName)}</span>
               <span class="chatfilesys-badge">${model.branches.length} 分支</span>
               <span class="chatfilesys-badge">${maxF} 层</span>`
            : `<span class="chatfilesys-badge">家族：${esc(familyName)}</span><span class="chatfilesys-badge">未启用</span>`;

        let warnEl = root.querySelector('.chatfilesys-error');
        if (warning) {
            if (!warnEl) {
                warnEl = document.createElement('div');
                warnEl.className = 'chatfilesys-error';
                root.insertBefore(warnEl, shellHost);
            }
            warnEl.textContent = warning;
        } else if (warnEl) {
            warnEl.remove();
        }

        for (const t of TABS) {
            const body = bodyOf(t.key);
            if (!body) continue;
            if (t.key === 'chat') ensureChatTab(body);
            else if (t.key === 'graph') ensureGraphTab(body);
            else if (t.key === 'character') ensureCharacterTab(body);
            else if (t.key === 'settings') ensureSettingsTab(body);
            else ensureTrashTab(body);
        }

        /* ---------- 当前聊天：结构树 + 分支管理（未启用时该页签只放启用引导） ---------- */
        const chatBody = bodyOf('chat');
        if (chatBody && !model) {
            // 页签外壳不能整块隐藏——否则「设置」页签（换存储模式）在未启用聊天里不可达
            chatBody.innerHTML = '<div class="chatfilesys-inactive"></div>';
            renderInactiveContent(chatBody.querySelector('.chatfilesys-inactive'), { isGroupChat, pureLike });
        }
        if (chatBody && model) {
            const treeHost = chatBody.querySelector('[data-role="tree-host"]');
            if (treeHost) renderTree(treeHost, { model, direction: treeDirection, currentBranchId: branchId });
            const picker = chatBody.querySelector('[data-role="branch-picker"]');
            if (picker) {
                const prev = picker.value;
                picker.innerHTML = model.branches
                    .map((b, i) => `<option value="${esc(b.id)}">${esc(nodeLabel(b, i))}${b.is_default ? '（主分支）' : ''}</option>`).join('');
                const keep = model.branches.some((b) => b.id === prev) ? prev : (branchId || model.active_branch);
                if (keep) picker.value = keep;
                syncBranchRefs(chatBody, picker.value, model);
            }
            const syncBtn = chatBody.querySelector('[data-action="sync-mirror"]');
            if (syncBtn) syncBtn.disabled = !storage.mirror;
            const sumBtn = chatBody.querySelector('[data-action="ai-summary"]');
            if (sumBtn) sumBtn.hidden = !canSummarize;
            // 只有一条分支时「合并」无从下手 → 置灰（不是藏起来：藏了用户不知道有这个功能）
            const mergeBtn = chatBody.querySelector('[data-action="merge-branches"]');
            if (mergeBtn) {
                const can = model.branches.length >= 2;
                mergeBtn.disabled = !can;
                mergeBtn.title = can ? '把这条分支与另一条合成一条新分支（原分支不动）'
                    : '只有一条分支，没有可合并的对象';
            }
        }

        /* ---------- 角色卡的聊天：列表（token 变了才重拉；「刷新列表」与导入后由 index.js 递增） ---------- */
        const charBody = bodyOf('character');
        if (charBody) {
            const host = charBody.querySelector('.chatfilesys-chatlist');
            const token = String(chatsToken ?? 0);
            if (host && charBody.dataset.chatsToken !== token) {
                charBody.dataset.chatsToken = token;
                loadChatsInto(charBody, listChats, chatsNote);
            }
        }

        /* ---------- 设置（控件由设置表生成；值每次都重填） ---------- */
        const setBody = bodyOf('settings');
        if (setBody) {
            const status = setBody.querySelector('[data-role="storage-status"]');
            if (status) status.innerHTML = storageBadgeHtml(storage);
            const sel = setBody.querySelector('[data-role="storage-mode"]');
            if (sel) {
                if (!sel.options.length) {
                    sel.innerHTML = (storage.modes || [])
                        .map((m) => `<option value="${esc(m)}">${esc((storage.labels || {})[m] || m)}</option>`).join('');
                }
                if (sel.value !== storage.mode) sel.value = storage.mode;
            }
            renderSettingsInto(setBody.querySelector('[data-role="settings-groups"]'), v);
        }

        /* ---------- 结构图（B4）：宿主元素在这里，数据编排在 index.js ----------
           用 token 控制：token 没变就不重算（图数据没动时，重算纯属浪费——控制器那层虽有缓存，
           但每次 refresh 都可能带一次 `measure()` 与 DOM 写入）。 */
        const graphBody = bodyOf('graph');
        if (graphBody) {
            const gtoken = String(graphToken ?? 0);
            const host = graphBody.querySelector('[data-role="graph-host"]');
            if (graphEnabled === false) {
                // 关掉了就说清楚「为什么这儿是空的」并给一键开启——空着比说清楚更糟
                const sel = graphBody.querySelector('[data-role="graph-selection"]');
                if (host) host.innerHTML = '';
                if (sel) {
                    sel.innerHTML = `<div class="chatfilesys-note">结构图已在设置里关闭（它会给长聊天带来额外开销）。</div>
                        <div class="chatfilesys-btnrow"><button class="menu_button" data-action="settings-enable-graph">
                        <i class="fa-solid fa-toggle-on"></i> 开启结构图</button></div>`;
                }
            } else if (graphBody.dataset.graphToken !== gtoken) {
                graphBody.dataset.graphToken = gtoken;
                if (host && typeof renderGraph === 'function') renderGraph(host, graphBody);
                const sel = graphBody.querySelector('[data-role="graph-selection"]');
                if (sel) sel.innerHTML = graphSelectionHtml(graphSelection);
            } else {
                // 图没变，但选中项可能变了（点节点会 bumpGraph，所以一般也走上面那支）
                const sel = graphBody.querySelector('[data-role="graph-selection"]');
                if (sel) sel.innerHTML = graphSelectionHtml(graphSelection);
            }
        }

        /* ---------- 回收站（每次打开拉一次；档位不支持时明说） ---------- */
        const trashBody = bodyOf('trash');
        if (trashBody) {
            const host = trashBody.querySelector('.chatfilesys-trash-host');
            if (host) {
                if (typeof listTrash !== 'function') {
                    host.innerHTML = `<div class="chatfilesys-note">${esc(trashNote || '回收站当前不可用。')}</div>`;
                } else if (!trashBody.dataset.trashLoaded) {
                    trashBody.dataset.trashLoaded = '1';
                    loadTrashInto(host, listTrash);
                }
            }
        }
    };

    /**
     * 分支管理按钮的 data-branch 跟随 picker 选中项（保持 index.js 委托契约不变）。
     *
     * T9（R8.3）：主分支是删除的护城河——选中的是主分支时，**删除按钮置灰不可点**
     * （悬停说明原因：主分支是起点，要删先换主分支），「设为主分支」也一并置灰（已是主分支）。
     * 置灰判据与 `core/branches.js#deleteBranch` 的拒绝判据**同一条**（`is_default`），
     * 所以「按钮看起来能点、点下去却报错」不会出现。
     */
    function syncBranchRefs(scope, branchId, model = null) {
        scope.querySelectorAll('[data-action="rename"], [data-action="delete-branch"], [data-action="ai-summary"], [data-action="set-main-branch"], [data-action="merge-branches"]')
            .forEach((b) => { b.dataset.branch = branchId || ''; });
        const cur = model?.branches?.find((b) => b.id === branchId) || null;
        const isMain = Boolean(cur?.is_default);
        const del = scope.querySelector('[data-action="delete-branch"]');
        if (del) {
            del.disabled = isMain;
            del.title = isMain
                ? '主分支是起点，不能直接删——先用「设为主分支」换一条，再删这条'
                : '删除该分支（其私有组一并回收）';
        }
        const setMain = scope.querySelector('[data-action="set-main-branch"]');
        if (setMain) {
            setMain.disabled = isMain;
            setMain.title = isMain
                ? '已经是主分支'
                : '把选中的分支设为主分支（主分支 = 打开这个聊天看到的内容）';
        }
    }

    /**
     * 结构图的「节点详情」（**只显结构，正文一个字都不放**——弹窗铁律）。
     * 邻接节点做成可点的小块（`data-action="graph-goto"`），点一下把视口挪过去。
     * @param {object|null} s 见 index.js 的 `graphSelection()` 产物；缺省/空 → 占位文案
     */
    function graphSelectionHtml(s) {
        if (!s) return '<div class="chatfilesys-note">点图上的节点看它的来龙去脉。</div>';
        const chip = (n) => `<button class="menu_button chatfilesys-gchip" data-action="graph-goto"
            data-node="${esc(n.id)}" title="把视口移到这个节点">#${esc(String(n.floor))}</button>`;
        const row = (label, list, empty) => `
            <div class="chatfilesys-gsel-row">
                <span class="k">${label}</span>
                <span class="v">${list.length ? list.map(chip).join('') : `<span class="chatfilesys-note">${empty}</span>`}</span>
            </div>`;
        return `
            <div class="chatfilesys-gsel">
                <div class="chatfilesys-gsel-head">
                    <span class="chatfilesys-badge">#${esc(String(s.floor))}</span>
                    <span class="chatfilesys-badge chatfilesys-badge-dim">${s.isUser ? '用户' : '角色'}</span>
                    ${s.sessionCount > 1 ? `<span class="chatfilesys-badge chatfilesys-badge-dim">被 ${s.sessionCount} 条会话共享</span>` : ''}
                    ${s.isFork ? `<span class="chatfilesys-badge">分叉点：这里分出去 ${s.children.length} 条</span>` : ''}
                </div>
                ${row('上一节点', s.parents, '这是起点')}
                ${row('下一节点', s.children, '这是末端')}
            </div>`;
    }

    /** 存储档位与模式徽章（原扩展设置页那份内容，R5 起搬进弹窗「设置」页签） */
    function storageBadgeHtml(storage) {
        if (!storage.pureLike) {
            return '<span class="chatfilesys-badge">存储：JSONL 增强模式</span>';
        }
        const mirrorNote = storage.mirror ? (storage.mirrorPending ? ' · 文件落后' : ' · 文件已同步') : '';
        const name = storage.mirror ? '双写' : '纯库';
        return `<span class="chatfilesys-badge">存储：${esc(name)} · ${esc(storage.tierLabel || '未就绪')}${esc(mirrorNote)}</span>`;
    }

    /* picker 变更 → 同步按钮上的 data-branch 与「主分支置灰」状态 */
    shellHost.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-role="branch-picker"]');
        if (!sel) return;
        syncBranchRefs(sel.closest('[data-tabbody]') || shellHost, sel.value, lastModel);
    });

    refresh(view);
    return { el: root, refresh };
}
