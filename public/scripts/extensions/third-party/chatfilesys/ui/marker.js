/**
 * ChatFilesys — 消息旁**版本按钮**（R5 2026-09-25 重裁定）
 *
 * 宿主 = 官方渲染钩子 USER_MESSAGE_RENDERED / CHARACTER_MESSAGE_RENDERED（messageId）：
 * 核心重渲染后事件重新触发 → 天然自愈；禁止 MutationObserver（ui-placement.md）。
 *
 * 注入物 = **一个版本按钮**，且**仅当该层 swipe 组数 > 1 时出现**
 * （只有 1 个组时该消息上零插件元素）。形状 = **分叉图标 + 计数**（如 `⎇ 2/3`），
 * **不得用左右箭头**——箭头这个形状归宿主原生 swipe。
 *
 * 已废除（不得重新引入）：每条消息旁的 ⎇ 一键分叉按钮、分叉点 ⎇ 记号、徽章、工具条。
 */

import { versionButtonLabel, swipeGroupsAt } from './common.js';

function mesEl(messageId) {
    return document.querySelector(`#chat .mes[mesid="${messageId}"]`);
}

/**
 * 向一条消息注入/刷新版本按钮（幂等）。
 * 组数 ≤ 1 → 不注入并清掉已有元素（保证单组消息上零插件元素）。
 *
 * @param {number} messageId
 * @param {{model: object|null, chat?: Array, branchId?: string, isGroupChat: boolean,
 *          onOpenVersions: (floor: number) => void}} opts
 *        `branchId` = 本聊天键绑定的分支（W3：绑定键上的 body 不一定是家族活跃分支的投影）
 */
export function injectMessageTools(messageId, { model, chat = [], branchId = null, isGroupChat, onOpenVersions }) {
    const el = mesEl(messageId);
    if (!el || isGroupChat) return;
    const floor = Number(messageId) + 1;
    const label = model ? versionButtonLabel(model, floor, chat, branchId) : '';

    let tools = el.querySelector(':scope > .chatfilesys-mes-tools');
    if (!label) {
        tools?.remove();
        return;
    }
    if (!tools) {
        tools = document.createElement('div');
        tools.className = 'chatfilesys-mes-tools';
        const btn = document.createElement('button');
        btn.className = 'menu_button chatfilesys-ver-btn';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onOpenVersions(Number(btn.dataset.floor));
        });
        tools.appendChild(btn);
        el.appendChild(tools);
    }
    const btn = tools.querySelector('.chatfilesys-ver-btn');
    const groups = swipeGroupsAt(model, floor, chat, branchId);
    btn.dataset.floor = String(floor);
    btn.textContent = label;
    btn.title = `第 ${floor} 层有 ${groups.length} 个 swipe 组（分叉点）——点开查看该层全部版本`;
}

/** 聊天整体重绘后批量注入由 RENDERED 事件驱动，这里只做批量兜底（如事件缺失的降级） */
export function injectAllMessages(opts) {
    if (!opts.model) {
        document.querySelectorAll('#chat .mes > .chatfilesys-mes-tools').forEach((t) => t.remove());
        return;
    }
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
        const id = Number(el.getAttribute('mesid'));
        if (Number.isInteger(id)) injectMessageTools(id, opts);
    });
}
