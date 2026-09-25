/**
 * ChatFilesys — 分支徽章（PRD 决策 #9 / R5 界面分工铁律）
 *
 * 输入框上方的**纯状态指示器**：只显示当前分支名，**不可点击、不承载任何动作**。
 * 打开管理面板只走三个入口：设置页按钮 / 斜杠命令 `/cb` / 快捷键 Alt+B。
 * 未启用/群聊时隐藏。
 */

const BADGE_ID = 'chatfilesys-badge';

/** 注入徽章元素（幂等；宿主 = 输入框上方的 form_sheld） */
export function ensureBadge() {
    if (document.getElementById(BADGE_ID)) return;
    const host = document.getElementById('form_sheld');
    if (!host) return;
    // 纯状态显示：用 div 而非 button——不可聚焦、不可点击（R5：聊天界面只加分支标识/分叉按钮/分叉点标记）
    const badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.title = '当前分支';
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
