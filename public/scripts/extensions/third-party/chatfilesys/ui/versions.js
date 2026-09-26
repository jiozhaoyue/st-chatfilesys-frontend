/**
 * ChatFilesys — 「该层版本」弹窗（T7 / R5 末段：每层版本管理）
 *
 * 宿主 = **官方 Popup**（`new Popup` + `POPUP_TYPE.DISPLAY`）。硬边界（`ui-placement.md`）：
 * **不得**自造窗口、**不得**挂 `document.body`、**不得**用 `MutationObserver`。
 *
 * 打开条件由消息旁**版本按钮**决定：该层 swipe 组数 > 1（= 该层是分叉点）。
 *
 * 四项能力（R5 末段 / AC17，全部落地在本模块）：
 *   ① 版本预览（只读，当前项高亮）——列表 + 预览面板，**只读不写**
 *   ② 跳转 / 切换——组内版本 = 宿主原生 swipe 语义（后续楼层不动）；别的组的版本 = 切分支
 *   ③ 多选删除（**至少保留一个**）——勾选 + 降序逐条删除（每步一次删除事件，保第三方下标一致）
 *   ④ 重排 / 编辑——上移 / 下移（当前版本跟着它所属的那一份走）+ 就地编辑正文
 *
 * 数据与下标规则全部在 `core/versions.js`（纯函数，可单测）；本模块只做 DOM 与编排，
 * 所有**写**都经 index.js 传进来的回调（写路径在 index.js：官方消息 API + 接缝）。
 * 交互设计**参考** `qianzhuowo/SillyTavernSwipePreviewer`（design.md §5.5），
 * **未引入其任何代码**（无第三方声明义务）。
 *
 * 铁律（`ui-placement.md` §一·A）：**绝不逐层列举楼层**——本弹窗只列**一个楼层**的版本，
 * 不出现按楼层号逐行枚举的列表（旧「楼层」页签不得复活）。
 */

import { Popup, POPUP_TYPE } from '../../../../popup.js';   // 子目录多一级：ui/ 比 index.js 深一层
import { esc, nodeLabel, branchMaxFloor, getActiveBranch } from './common.js';
import { versionsAt } from '../core/versions.js';

const ROOT_CLASS = 'chatfilesys-versions';
/** 列表里每行正文的截断长度（完整正文在预览面板里看） */
const ROW_TEXT_MAX = 90;
/** 预览面板的正文上限（防超大楼层把弹窗撑爆；超出只提示，不改数据） */
const PREVIEW_MAX = 4000;

function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 版本清单（内部包装 `core/versions.js#versionsAt`，附带分支显示标签）。
 * @param {{model, chat, currentBranchId}} view
 */
function listOf(view, floor) {
    const { model, chat = [], currentBranchId = null } = view;
    const data = versionsAt(model, floor, chat, currentBranchId);
    const order = new Map((model?.branches || []).map((b, i) => [b.id, i]));
    const labelOf = (id) => {
        const b = model?.branches?.find((x) => x.id === id);
        return b ? nodeLabel(b, order.get(b.id) ?? 0) : id;
    };
    return { data, labelOf, active: model ? getActiveBranch(model, currentBranchId) : null, order };
}

/**
 * 打开「该层版本」弹窗。
 *
 * @param {object} opts
 * @param {number} opts.floor 楼层号（从 1 起）
 * @param {object} opts.model 家族模型
 * @param {Array<object>} [opts.chat] 当前 body
 * @param {string|null} [opts.currentBranchId] 本聊天键绑定的分支（W3）
 * @param {() => {model: object, chat: Array, currentBranchId: string|null}} [opts.getView]
 *        每次操作后重取视图（弹窗不关、就地刷新）
 * @param {(k: number) => Promise<void>} [opts.onSwitchVariant] 组内版本切换（纯 swipe 语义）
 * @param {(gid: string, k: number) => Promise<void>} [opts.onSwitchGroup] 别的组的某版本（切分支）
 * @param {(indices: number[]) => Promise<void>} [opts.onDeleteVariants] 多选删除（至少留一个）
 * @param {(from: number, to: number) => Promise<void>} [opts.onMoveVariant] 重排
 * @param {(k: number, text: string) => Promise<void>} [opts.onEditVariant] 编辑正文
 * @returns {object|null} popup 实例（环境缺 Popup API 时 null）
 */
export function openVersionsPopup(opts) {
    const { floor } = opts;
    const view0 = opts.getView ? opts.getView() : opts;
    if (!view0?.model) return null;

    const state = {
        view: view0,
        selected: null,      // 预览中的版本 key
        selection: new Set(), // 多选删除（只收当前组的 key）
        editing: null,       // 正在编辑的版本 key
        draft: '',
        error: '',
    };
    state.selected = listOf(view0, floor).data.currentKey;

    const root = document.createElement('div');
    root.className = ROOT_CLASS;

    /** 重取视图（操作成功后状态变了）+ 清掉已消失的选中项 */
    function resync() {
        if (opts.getView) state.view = opts.getView();
        const { data } = listOf(state.view, floor);
        const keys = new Set(data.items.map((x) => x.key));
        if (state.selected && !keys.has(state.selected)) state.selected = data.currentKey;
        if (data.currentKey && !state.selected) state.selected = data.currentKey;
        state.selection = new Set([...state.selection].filter((k) => keys.has(k)));
        if (state.editing && !keys.has(state.editing)) { state.editing = null; state.draft = ''; }
    }

    /** 统一的操作执行：失败 → 弹窗内提示（不关窗、不崩），最后一律重绘 */
    async function run(fn) {
        state.error = '';
        try {
            await fn();
        } catch (e) {
            state.error = String(e?.message || e);
        }
        resync();
        render();
    }

    function itemRow(item, g) {
        const deletable = item.isCurrentGroup && g.variantCount > 1;
        const checked = state.selection.has(item.key);
        const buttons = [];
        if (!item.isCurrent) {
            buttons.push(`<button class="menu_button" data-act="switch" data-key="${esc(item.key)}" `
                + `title="${item.isCurrentGroup ? '切到这一版（该层后续楼层不变）' : '切到这一版的所在分支'}"
                    >切换</button>`);
        }
        if (item.isCurrentGroup && g.variantCount > 1) {
            buttons.push(`<button class="menu_button" data-act="up" data-key="${esc(item.key)}" data-k="${item.variantIndex}" `
                + `title="上移一位" ${item.variantIndex === 0 ? 'disabled' : ''}>↑</button>`);
            buttons.push(`<button class="menu_button" data-act="down" data-key="${esc(item.key)}" data-k="${item.variantIndex}" `
                + `title="下移一位" ${item.variantIndex === g.variantCount - 1 ? 'disabled' : ''}>↓</button>`);
        }
        buttons.push(`<button class="menu_button" data-act="edit" data-key="${esc(item.key)}" data-k="${item.variantIndex}" `
            + `title="${item.isCurrentGroup ? '编辑这一版的正文' : '这一版属于别的组，先在分支管理里改那条分支'}"
                ${item.isCurrentGroup ? '' : 'disabled'}>编辑</button>`);
        const text = truncate(item.text, ROW_TEXT_MAX);
        // 别的组的正文可能取不到：家族模型是**家族级**的（相对家族活跃分支折叠），而本聊天读到的
        // body 是**本键所在分支**的投影（W3）——绑定键上两者不同时，那一组的正文既不在 body、
        // 也不在 `model.groups` 里。如实说明，不假装是空正文（index.js 会尽力从库内行补齐）。
        const empty = item.isCurrentGroup ? '（空正文）' : '（正文不在本聊天的投影里，切换过去即可看到）';
        return `<div class="chatfilesys-ver-item${item.isCurrent ? ' current' : ''}${state.selected === item.key ? ' selected' : ''}"
                     data-key="${esc(item.key)}">
            ${deletable
        ? `<input type="checkbox" data-act="check" data-key="${esc(item.key)}" ${checked ? 'checked' : ''}
                 title="选中以删除这一版（至少保留一个）">`
        : '<span class="chatfilesys-ver-nocheck"></span>'}
            <span class="chatfilesys-ver-k">版本 ${item.variantIndex + 1}/${item.variantCount}</span>
            <span class="chatfilesys-ver-txt" title="点这一行预览全文（只读）">${esc(text) || `<span class="chatfilesys-note">${empty}</span>`}</span>
            ${item.isCurrent ? '<span class="chatfilesys-ver-tag">当前</span>' : ''}
            <span class="chatfilesys-ver-ops">${buttons.join('')}</span>
        </div>`;
    }

    function groupBlock(g, gi, { labelOf, active }) {
        const owners = g.branchIds
            .map((id) => `<span class="chatfilesys-ver-owner${id === active?.id ? ' current' : ''}">${esc(labelOf(id))}</span>`)
            .join('');
        return `<div class="chatfilesys-ver-group${g.isCurrent ? ' active' : ''}" data-gid="${esc(g.gid)}">
            <div class="chatfilesys-ver-ghead">
                <span class="chatfilesys-ver-idx">${g.isCurrent ? '当前组' : `组 ${gi + 1}`}</span>
                <span class="chatfilesys-ver-meta">${g.variantCount} 个版本${g.variantCount > 1 ? `（当前第 ${g.active + 1} 个）` : ''}</span>
                <span class="chatfilesys-ver-owners">${owners || '<span class="chatfilesys-ver-owner">—</span>'}</span>
                ${g.isCurrent || !g.targetBranchId ? '' : `<span class="chatfilesys-note">切换会到分支 ${esc(labelOf(g.targetBranchId))}</span>`}
            </div>
            <div class="chatfilesys-ver-items">${g.items.map((it) => itemRow(it, g)).join('')}</div>
        </div>`;
    }

    function render() {
        const { data, active, order, labelOf } = listOf(state.view, floor);
        const cur = data.groups.find((g) => g.isCurrent) || null;
        const deletableCount = cur ? cur.variantCount : 0;
        const selCount = state.selection.size;
        const selItem = data.items.find((x) => x.key === state.selected) || null;
        const editingItem = state.editing ? data.items.find((x) => x.key === state.editing) : null;
        const selText = selItem ? truncate(selItem.text, PREVIEW_MAX) : '';
        const selEmpty = selItem && !selItem.isCurrentGroup
            ? '（正文不在本聊天的投影里，切换过去即可看到）'
            : '（空正文）';

        root.innerHTML = `
            <div class="chatfilesys-ver-head">第 ${data.floor} 层 · ${data.items.length} 个版本（${data.groups.length} 个 swipe 组）`
                + `<span class="chatfilesys-note">当前分支 ${esc(nodeLabel(active, order.get(active?.id) ?? 0))} · 共 ${branchMaxFloor(active)} 层</span></div>
            <div class="chatfilesys-note">组内版本 = 宿主原生左右箭头所切的那一份内容（切它，后续楼层不变）；
                别的组的版本 = 切到它所在的分支。删除 / 重排 / 编辑只对**当前组**的版本开放（别的组的内容属另一条分支）。</div>
            ${state.error ? `<div class="chatfilesys-ver-err">${esc(state.error)}</div>` : ''}
            <div class="chatfilesys-ver-list">${data.groups.map((g, gi) => groupBlock(g, gi, { labelOf, active })).join('') || '<div class="chatfilesys-note">这一层没有可展示的版本。</div>'}</div>
            <div class="chatfilesys-ver-preview">
                <div class="chatfilesys-ver-preview-head">版本预览（只读）${selItem ? ` · 版本 ${selItem.variantIndex + 1}/${selItem.variantCount}${selItem.isCurrent ? ' · 当前' : ''}` : ''}</div>
                <div class="chatfilesys-ver-preview-body">${selItem ? (esc(selText) || `<span class="chatfilesys-note">${selEmpty}</span>`) : '<span class="chatfilesys-note">点上面某一行看它的全文。</span>'}</div>
            </div>
            ${state.editing
        ? `<div class="chatfilesys-ver-editrow">
                   <textarea class="text_pole chatfilesys-ver-edit" data-role="ver-edit" rows="6"
                       title="编辑这一版的正文">${esc(state.draft)}</textarea>
                   <div class="chatfilesys-btnrow">
                       <button class="menu_button" data-act="save-edit">保存</button>
                       <button class="menu_button" data-act="cancel-edit">取消</button>
                   </div>
               </div>`
        : `<div class="chatfilesys-btnrow">
                   <button class="menu_button" data-act="switch" data-key="${esc(selItem?.key || '')}"
                       ${!selItem || selItem.isCurrent ? 'disabled' : ''}>切换到此版本</button>
                   <button class="menu_button" data-act="edit" data-key="${esc(selItem?.key || '')}"
                       data-k="${selItem?.variantIndex ?? 0}" ${!selItem || !selItem.isCurrentGroup ? 'disabled' : ''}>编辑此版本</button>
                   ${deletableCount > 1 ? `<button class="menu_button" data-act="select-all">全选</button>
                   <button class="menu_button" data-act="select-invert">反选</button>
                   <button class="menu_button" data-act="select-none">取消选择</button>
                   <button class="menu_button" data-act="delete" ${selCount === 0 || selCount >= deletableCount ? 'disabled' : ''}
                       title="删除选中的版本（至少保留一个）">删除选中（${selCount}）</button>` : ''}
               </div>`}
            ${editingItem ? `<div class="chatfilesys-note">正在编辑「版本 ${editingItem.variantIndex + 1}/${editingItem.variantCount}」的正文。</div>` : ''}`;
    }

    /** 当前组里「可勾选删除」的全部 key（全选 / 反选的作用域） */
    function deletableKeys() {
        const { data } = listOf(state.view, floor);
        const cur = data.groups.find((g) => g.isCurrent);
        return cur && cur.variantCount > 1 ? cur.items.map((x) => x.key) : [];
    }

    async function act(key) {
        const { data } = listOf(state.view, floor);
        const item = data.items.find((x) => x.key === key);
        if (!item) return undefined;
        if (item.isCurrentGroup) return await opts.onSwitchVariant?.(item.variantIndex);
        return await opts.onSwitchGroup?.(item.gid, item.variantIndex);
    }

    root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        const row = e.target.closest('.chatfilesys-ver-item');
        const action = btn?.dataset.act;
        const { data } = listOf(state.view, floor);   // 每次点击都取当前视图（上一次操作可能已改动它）
        if (!action) {                       // 点行 = 选中预览（只读）
            if (row) { state.selected = row.dataset.key; state.error = ''; render(); }
            return;
        }
        e.stopPropagation();
        if (action === 'switch') return await run(async () => act(btn.dataset.key || state.selected));
        if (action === 'up' || action === 'down') {
            const k = Number(btn.dataset.k);
            return await run(async () => opts.onMoveVariant?.(k, action === 'up' ? k - 1 : k + 1));
        }
        if (action === 'edit') {
            state.selected = btn.dataset.key || state.selected;
            state.editing = state.selected;
            state.draft = data.items.find((x) => x.key === state.editing)?.text ?? '';
            state.error = '';
            render();
            return;
        }
        if (action === 'cancel-edit') { state.editing = null; state.draft = ''; render(); return; }
        if (action === 'save-edit') {
            const ta = root.querySelector('[data-role="ver-edit"]');
            const text = ta ? ta.value : state.draft;
            const k = data.items.find((x) => x.key === state.editing)?.variantIndex ?? 0;
            return await run(async () => {
                state.editing = null;
                await opts.onEditVariant?.(k, text);
            });
        }
        if (action === 'select-all') { state.selection = new Set(deletableKeys()); render(); return; }
        if (action === 'select-invert') {
            const all = deletableKeys();
            state.selection = new Set(all.filter((x) => !state.selection.has(x)));
            render();
            return;
        }
        if (action === 'select-none') { state.selection = new Set(); render(); return; }
        if (action === 'delete') {
            const indices = data.items
                .filter((x) => state.selection.has(x.key))
                .map((x) => x.variantIndex)
                .sort((a, b) => a - b);
            return await run(async () => {
                await opts.onDeleteVariants?.(indices);
                state.selection = new Set();
            });
        }
        return undefined;   // 'check' 等由 change 事件处理
    });

    root.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-act="check"]');
        if (!cb) return;
        if (cb.checked) state.selection.add(cb.dataset.key);
        else state.selection.delete(cb.dataset.key);
        render();
    });

    // 宿主 = 官方 Popup（DISPLAY + wide + large，见 spec/frontend/component-guidelines.md）
    const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
    render();
    popup.show();
    // 关闭时连带清 DOM：宿主 `Popup#hide` 在自己的关闭路径里会 `dlg.remove()`，但若 dialog 是被
    // 直接 `close()`（自动化脚本 / 别处绕开 complete()），那份清理不会执行 → 残留节点叠在 body 里。
    // 与 `openManagementPopup` 同一处置（2026-09-26 真机取证，tests/e2e/probe_popup_residue.py）。
    const dialog = root.closest('dialog');
    dialog?.addEventListener('close', () => {
        if (dialog.open) return;   // 被宿主拦下的关闭（立刻 showModal 复原）不能拆节点
        dialog.remove();
    });
    return popup;
}
