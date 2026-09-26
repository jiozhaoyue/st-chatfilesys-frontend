/**
 * ChatFilesys — 「该层版本」弹窗（T4 最小接缝；完整四项能力由 T7 补齐）
 *
 * 依赖纪律：T7 的版本管理**只参考外部插件的交互设计，不引入其任何代码**
 * （用户 2026-09-25 澄清：「我只是让你参考那个插件，不是全盘要那个插件的做法」；
 * 参考来源记在 tasks 的 design.md §5.5，代码侧不产生任何第三方依赖/文件）。
 * 存法仍用库内组记录自带的版本清单（`model.groups[gid].variants` + `active`，design.md §5.5A）。
 *
 * 打开条件由消息旁**版本按钮**决定：该层 swipe 组数 > 1（= 该层是分叉点）。
 *
 * 本轮提供（T4r.4）：
 *   - 列出该层**全部 swipe 组** + 每个组的所属分支与组内 swipe 数
 *   - 「切到该组」：非当前组 → 切成分支（design.md §5.4 的组间语义）
 *
 * 明确留给 T7（接口接缝已按此留好：`openVersionsPopup` 收 floor/model/chat + 两个回调）：
 *   ① 版本预览（只读，当前项高亮；展平 = 组 × 组内 swipe）② 组内 swipe 跳转/切换
 *   ③ 多选删除（至少保留一个）④ 重排 / 编辑
 */

import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';   // 子目录多一级：ui/ 比 index.js 深一层
import { esc, nodeLabel, swipeGroupsAt, branchMaxFloor, getActiveBranch } from './common.js';

const ROOT_CLASS = 'chatfilesys-versions';

/** 组所属分支的显示标签（未引用该组的分支不列） */
function groupOwnersHtml(model, g, currentBranchId) {
    const order = new Map(model.branches.map((b, i) => [b.id, i]));
    const activeId = getActiveBranch(model, currentBranchId)?.id;
    const names = g.branchIds
        .map((id) => model.branches.find((b) => b.id === id))
        .filter(Boolean)
        .map((b) => `<span class="chatfilesys-ver-owner${b.id === activeId ? ' current' : ''}">`
            + `${esc(nodeLabel(b, order.get(b.id) ?? 0))}</span>`)
        .join('');
    return names || '<span class="chatfilesys-ver-owner">—</span>';
}

/** 非当前组 → 可切换到的分支（该组必须被某条非当前分支引用；当前组不需要切） */
function targetBranchOf(g) {
    return g.isActive ? null : (g.branchIds[0] || null);
}

/**
 * 打开「该层版本」弹窗。
 * @param {{floor: number, model: object, chat?: Array, currentBranchId?: string,
 *          onSwitchBranch?: (branchId: string) => Promise<void>|void}} opts
 *        `currentBranchId` = 本聊天键绑定的分支（W3：决定哪个组是「当前组」）
 */
export function openVersionsPopup({ floor, model, chat = [], currentBranchId = null, onSwitchBranch }) {
    const groups = swipeGroupsAt(model, floor, chat, currentBranchId);
    const root = document.createElement('div');
    root.className = ROOT_CLASS;

    const active = getActiveBranch(model, currentBranchId);
    const activeIdx = model.branches.indexOf(active);
    root.innerHTML = `<div class="chatfilesys-ver-head">第 ${floor} 层 · ${groups.length} 个 swipe 组（该层是分叉点）`
        + `<span class="chatfilesys-note">当前分支 ${esc(nodeLabel(active, activeIdx))} · 共 ${branchMaxFloor(active)} 层</span></div>`;

    const rowsHost = document.createElement('div');
    rowsHost.innerHTML = groups.map((g, i) => {
        const target = targetBranchOf(g);
        return `<div class="chatfilesys-ver-group${g.isActive ? ' active' : ''}" data-gid="${esc(g.gid)}">`
            + `<span class="chatfilesys-ver-idx">${g.isActive ? '当前组' : `第 ${i + 1} 组`}</span>`
            + `<span class="chatfilesys-ver-meta">组内 ${g.variantCount} 个版本`
            + `${g.variantCount > 1 ? `（第 ${g.activeVariant + 1} 个）` : ''}</span>`
            + `<span class="chatfilesys-ver-owners">${groupOwnersHtml(model, g, currentBranchId)}</span>`
            + `${target ? `<button class="menu_button" data-switch-branch="${esc(target)}">切到该组</button>` : ''}`
            + `</div>`;
    }).join('') || '<div class="chatfilesys-note">该层没有可展示的组。</div>';
    root.appendChild(rowsHost);

    const note = document.createElement('div');
    note.className = 'chatfilesys-note';
    note.textContent = '版本预览 / 组内 swipe 切换 / 多选删除 / 重排编辑将在「版本管理」里提供。';
    root.appendChild(note);

    const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide: false, large: false });
    root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-switch-branch]');
        if (!btn) return;
        e.stopPropagation();
        const branchId = btn.dataset.switchBranch;
        try {
            await popup.complete(POPUP_RESULT.CANCELLED);
        } catch { /* 关闭失败不阻断切换 */ }
        await onSwitchBranch?.(branchId);
    });
    popup.show();
    return popup;
}
