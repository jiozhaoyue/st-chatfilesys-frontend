/**
 * ChatFilesys — 消息旁轻量注入（PRD 决策 #7/#8/#9，R14/R15）
 *
 * 宿主 = 官方渲染钩子 USER_MESSAGE_RENDERED / CHARACTER_MESSAGE_RENDERED（messageId）：
 * 核心重渲染后事件重新触发 → 天然自愈；禁止 MutationObserver（ui-placement.md）。
 * 注入物：每层 ⎇ 一键直分叉按钮（自动命名+自动切换，R14）+ 分叉点 ⎇ 标记（R15）。
 */

function mesEl(messageId) {
    return document.querySelector(`#chat .mes[mesid="${messageId}"]`);
}

/**
 * 向一条消息注入/刷新工具元素（幂等：已存在则原位更新标记态）。
 * @param {number} messageId
 * @param {{model: object|null, isGroupChat: boolean, onQuickFork: (floor: number) => void}} opts
 */
export function injectMessageTools(messageId, { model, isGroupChat, onQuickFork }) {
    const el = mesEl(messageId);
    if (!el || isGroupChat) return;
    const floor = Number(messageId) + 1;

    // 分叉点标记：该层挂了 >1 个组
    let forkHere = false;
    if (model) {
        const groups = new Set();
        for (const b of model.branches) {
            const gid = b.path[floor];
            if (gid) groups.add(gid);
        }
        forkHere = groups.size > 1;
    }

    let tools = el.querySelector(':scope > .chatfilesys-mes-tools');
    if (!tools) {
        tools = document.createElement('div');
        tools.className = 'chatfilesys-mes-tools';
        const btn = document.createElement('button');
        btn.className = 'menu_button chatfilesys-mes-fork';
        btn.title = `在第 ${floor} 层之后分叉（一键，自动命名）`;
        btn.innerHTML = '<i class="fa-solid fa-code-fork"></i>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onQuickFork(floor);
        });
        tools.appendChild(btn);
        el.appendChild(tools);
    }

    let mark = tools.querySelector('.chatfilesys-mes-forkmark');
    if (forkHere && !mark) {
        mark = document.createElement('span');
        mark.className = 'chatfilesys-mes-forkmark';
        mark.title = '分叉点：此层挂有多个 Swipe 组';
        mark.textContent = '⎇';
        tools.prepend(mark);
    } else if (!forkHere && mark) {
        mark.remove();
    }
}

/** 聊天整体重绘后批量注入由 RENDERED 事件驱动，这里只做批量兜底（如事件缺失的降级） */
export function injectAllMessages(opts) {
    if (!opts.model) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
        const id = Number(el.getAttribute('mesid'));
        if (Number.isInteger(id)) injectMessageTools(id, opts);
    });
}
