/**
 * ChatFilesys — 管理弹窗内容（PRD 决策 #7/#10）
 *
 * 宿主 = 官方 Popup（DISPLAY+wide+large，index.js 负责生命周期）；本模块只负责内容：
 * Tabs 用官方 renderLukerTabs（tab 选择持久化到 extension_settings），ST 无此 API 时
 * 降级为内置轻量 Tab（能力检测+优雅降级，PRD 决策 #12）。
 * Tab 内容体带 data-tabbody 标记，刷新时只重填内容、不重建外壳（保留 tab 选择态）。
 */

import { esc, branchRow, renderFloorsList, renderInactiveContent, getActiveBranch, branchMaxFloor } from './common.js';
import { renderTree } from './tree.js';

const TABS = [
    { key: 'tree', label: '分支树' },
    { key: 'floors', label: '楼层' },
    { key: 'batch', label: '批量操作' },
    { key: 'export', label: '导出' },
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
 * 创建弹窗内容。
 * @returns {{el: HTMLElement, refresh: (view: object) => void}|null}
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
                defaultTab: 'tree',
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

    const refresh = (v) => {
        const {
            model, chat, familyName, warning = '', isGroupChat = false, autoExport = false,
            treeDirection = 'down', canSummarize = false, listTrash = null, trashNote = '',
        } = v;
        const active = model ? getActiveBranch(model) : null;
        const maxF = active ? branchMaxFloor(active) : 0;

        header.innerHTML = model
            ? `<span class="chatfilesys-badge">家族：${esc(familyName)}</span>
               <span class="chatfilesys-badge">${model.branches.length} 分支</span>
               <span class="chatfilesys-badge">${maxF} 层</span>
               ${autoExport ? '<span class="chatfilesys-badge chatfilesys-badge-dim">自动导出开</span>' : ''}`
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

        if (!model) {
            shellHost.hidden = true;
            let inactive = root.querySelector('.chatfilesys-inactive');
            if (!inactive) {
                inactive = document.createElement('div');
                inactive.className = 'chatfilesys-inactive';
                root.appendChild(inactive);
            }
            renderInactiveContent(inactive, { isGroupChat });
            return;
        }
        shellHost.hidden = false;
        root.querySelector('.chatfilesys-inactive')?.remove();

        // Tab「分支树」：SVG 图形树 + 层级列表
        const treeBody = bodyOf('tree');
        if (treeBody) {
            let svgHost = treeBody.querySelector('.chatfilesys-tree-host');
            if (!svgHost) {
                treeBody.innerHTML = `
                    <div class="chatfilesys-tree-host"></div>
                    <div class="chatfilesys-section">
                        <h4>分支列表</h4>
                        <div class="chatfilesys-branchlist"></div>
                        <div class="chatfilesys-btnrow">
                            <button class="menu_button" data-action="fork" data-floor="${maxF}"><i class="fa-solid fa-code-fork"></i> 在最后一层（F${maxF}）之后分叉</button>
                        </div>
                    </div>`;
                svgHost = treeBody.querySelector('.chatfilesys-tree-host');
            }
            // 尾层分叉按钮的楼层号随数据刷新（初始烙死的 maxF 会陈旧）
            const forkLast = treeBody.querySelector('.chatfilesys-btnrow [data-action="fork"]');
            if (forkLast) {
                forkLast.dataset.floor = String(maxF);
                forkLast.innerHTML = `<i class="fa-solid fa-code-fork"></i> 在最后一层（F${maxF}）之后分叉`;
            }
            renderTree(svgHost, { model, direction: treeDirection });
            const list = treeBody.querySelector('.chatfilesys-branchlist');
            if (list) list.innerHTML = model.branches
                .map((b) => branchRow(model, b, model.active_branch, { canSummarize })).join('');
        }

        // Tab「楼层」
        const floorsBody = bodyOf('floors');
        if (floorsBody) renderFloorsList(floorsBody, { model, chat });

        // Tab「批量操作」：四期占位（PRD 决策 #13）
        const batchBody = bodyOf('batch');
        if (batchBody && !batchBody.dataset.placeholder) {
            batchBody.dataset.placeholder = '1';
            batchBody.innerHTML = '<div class="chatfilesys-note">批量编辑/搜索/过滤将在四期提供（增强 JSONL 操作）。</div>';
        }

        // Tab「回收站」（N15：列出 / 还原 / 立刻清理；档位不支持枚举时明说）
        const trashBody = bodyOf('trash');
        if (trashBody) {
            if (typeof listTrash !== 'function') {
                trashBody.innerHTML = `<div class="chatfilesys-note">${esc(trashNote || '回收站当前不可用。')}</div>`;
            } else if (!trashBody.dataset.hooked) {
                trashBody.dataset.hooked = '1';
                trashBody.innerHTML = '<div class="chatfilesys-note chatfilesys-trash-loading">正在读取回收站…</div>';
                loadTrashInto(trashBody, listTrash);
            }
        }

        // Tab「导出」
        const exportBody = bodyOf('export');
        if (exportBody && !exportBody.querySelector('[data-action="export"]')) {
            exportBody.innerHTML = `
                <div class="chatfilesys-btnrow">
                    <button class="menu_button" data-action="export"><i class="fa-solid fa-download"></i> 导出当前分支</button>
                </div>
                <div class="chatfilesys-note">
                    导出物 = 服务端落盘视图（当前分支投影）剥离分支元数据后的<b>纯标准 JSONL</b>，可导入任何原生环境。
                    「保存后自动导出」开关在扩展设置页。
                </div>
                <div class="chatfilesys-note chatfilesys-badge-dim">自动导出当前状态：${autoExport ? '开启' : '关闭'}</div>`;
        }
    };

    refresh(view);
    return { el: root, refresh };
}
