/**
 * ChatFilesys — 分支徽章（PRD 决策 #9，R15）
 *
 * 输入框上方的轻量常驻指示器：显示当前分支名，点击打开管理弹窗。
 * 未启用/群聊时隐藏。
 */

const BADGE_ID = 'chatfilesys-badge';

export function ensureBadge(onOpen) {
    if (document.getElementById(BADGE_ID)) return;
    const host = document.getElementById('form_sheld');
    if (!host) return;
    const badge = document.createElement('button');
    badge.id = BADGE_ID;
    badge.type = 'button';
    badge.title = '当前分支 · 点击打开管理面板';
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
    });
    badge.hidden = true;
    host.appendChild(badge);
}

/** @param {{model: object|null, isGroupChat: boolean, activeName: string}} view */
export function updateBadge(view) {
    const badge = document.getElementById(BADGE_ID);
    if (!badge) return;
    const { model, isGroupChat, activeName } = view;
    const visible = Boolean(model) && !isGroupChat;
    badge.hidden = !visible;
    badge.textContent = visible ? `⎇ ${activeName}` : '';
    badge.classList.toggle('active-self', false);
}
