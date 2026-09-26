/**
 * ChatFilesys — 管理弹窗内容（R5 2026-09-25 重裁定：**弹窗即唯一界面**）
 *
 * 宿主 = 官方 Popup（DISPLAY+wide+large，index.js 负责生命周期）；本模块只负责内容：
 * Tabs 用官方 renderLukerTabs（tab 选择持久化到 extension_settings），ST 无此 API 时
 * 降级为内置轻量 Tab（能力检测+优雅降级）。
 * Tab 内容体带 data-tabbody 标记，刷新时只重填内容、不重建外壳（保留 tab 选择态）。
 *
 * 四个页签（旧「分支树 / 楼层 / 批量操作 / 导出」四页签已废除——不留兼容包袱）：
 *   当前聊天 / 角色卡的聊天 / 设置 / 回收站
 *
 * 铁律：
 *   · **绝不逐层列举楼层**——弹窗内任何位置都不得逐层列出楼层（旧「楼层」页签不得重新引入）
 *   · **结构树只显结构**（节点 = 序号 / 分支名 + 层数），不含任何消息内容
 */

import { esc, nodeLabel, getActiveBranch, branchMaxFloor, renderInactiveContent } from './common.js';
import { renderTree } from './tree.js';

const TABS = [
    { key: 'chat', label: '当前聊天' },
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
                <div class="chatfilesys-export-row">
                    <label><input type="checkbox" data-role="auto-export"> 保存后自动导出</label>
                </div>
                <div class="chatfilesys-note">
                    界面入口：输入框上方工具图标排里的插件按钮，或快捷键 Alt+B。
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
            branchId = null,
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

        /* ---------- 设置 ---------- */
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
            const cb = setBody.querySelector('[data-role="auto-export"]');
            if (cb) cb.checked = Boolean(autoExport);
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
        scope.querySelectorAll('[data-action="rename"], [data-action="delete-branch"], [data-action="ai-summary"], [data-action="set-main-branch"]')
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
