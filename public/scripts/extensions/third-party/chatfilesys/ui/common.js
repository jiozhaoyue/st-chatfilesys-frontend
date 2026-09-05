/**
 * ChatFilesys — UI 公共渲染（纯 DOM 组装，不含业务编排）
 *
 * 从一期 panel.js 拆分：分支行/楼层行/分叉点检测在弹窗与消息旁注入之间共用。
 * 交互通过 data-action / data-branch / data-floor 事件委托抛给 index.js。
 */

const BR_COLORS = ['#58a6ff', '#f0883e', '#a371f7', '#db61a2', '#d29922', '#39c5cf'];

export function esc(s) {
    const d = document.createElement('div');
    d.textContent = s === undefined || s === null ? '' : String(s);
    return d.innerHTML;
}

export function branchColor(model, branchId) {
    const idx = model.branches.findIndex((b) => b.id === branchId);
    return BR_COLORS[(idx < 0 ? 0 : idx) % BR_COLORS.length];
}

/** 分叉点：同层位置上存在 >1 个不同组的楼层 */
export function detectForkFloors(model) {
    const byFloor = new Map();
    for (const b of model.branches) {
        for (const [f, gid] of Object.entries(b.path)) {
            const set = byFloor.get(Number(f)) || new Set();
            set.add(gid);
            byFloor.set(Number(f), set);
        }
    }
    const forks = new Set();
    for (const [f, set] of byFloor) if (set.size > 1) forks.add(f);
    return forks;
}

export function branchFloors(b) {
    return Object.keys(b.path).length;
}

export function branchMaxFloor(b) {
    return Math.max(0, ...Object.keys(b.path).map(Number));
}

export function getActiveBranch(model) {
    return model.branches.find((b) => b.id === model.active_branch) || model.branches[0];
}

/** 分支行（弹窗「分支树」Tab 的列表视图） */
export function branchRow(model, b, activeId) {
    const floors = branchFloors(b);
    const isForked = b.fork_base > 0;
    return `
        <div class="chatfilesys-branch ${b.id === activeId ? 'active' : ''}" data-action="switch" data-branch="${esc(b.id)}"
             title="${isForked ? `第 ${b.fork_base} 层后分叉` : '主分支'} · 点击切换">
            <span class="dot" style="background:${branchColor(model, b.id)}"></span>
            <span class="name">${esc(b.name)}${b.is_default ? ' <span style="opacity:.5;font-size:10px">默认</span>' : ''}</span>
            <span class="actions">
                <button class="menu_button" data-action="rename" data-branch="${esc(b.id)}" title="重命名"><i class="fa-solid fa-pencil"></i></button>
                ${!b.is_default ? `<button class="menu_button" data-action="delete-branch" data-branch="${esc(b.id)}" title="删除分支"><i class="fa-solid fa-trash"></i></button>` : ''}
            </span>
            <span class="meta">${isForked ? `⎇F${b.fork_base} · ` : ''}${floors} 层</span>
        </div>`;
}

/** 楼层行 */
export function floorRow(model, chat, floor, isFork) {
    const active = getActiveBranch(model);
    const gid = active?.path[floor];
    if (!gid) return '';
    const line = chat[floor - 1];
    if (!line) return '';
    const who = esc(line.name || (line.is_user ? '用户' : 'AI'));
    const mes = esc(line.mes || '');
    const sw = Array.isArray(line.swipes) && line.swipes.length > 1
        ? `<span class="swipes">swipe ${Number(line.swipe_id ?? 0) + 1}/${line.swipes.length}</span>`
        : '';
    return `
        <div class="chatfilesys-floor ${isFork ? 'fork' : ''}">
            <span class="fno">${isFork ? '<span class="fk">⎇</span>' : ''}F${floor}</span>
            <span class="prev"><b>${who}</b> · ${mes}</span>
            ${sw}
            <button class="menu_button" data-action="fork" data-floor="${floor}" title="在第 ${floor} 层之后分叉（零复制）">
                <i class="fa-solid fa-code-fork"></i>
            </button>
            <button class="menu_button" data-action="delete-floor" data-floor="${floor}" title="删除该楼层（全局，后续楼层前移）">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>`;
}

/** 楼层视图（弹窗「楼层」Tab） */
export function renderFloorsList(container, { model, chat }) {
    if (!container) return;
    if (!model) {
        container.innerHTML = '<div class="chatfilesys-note">尚未启用。</div>';
        return;
    }
    const active = getActiveBranch(model);
    const forkFloors = detectForkFloors(model);
    const maxF = active ? branchMaxFloor(active) : 0;
    let html = '';
    for (let f = 1; f <= maxF; f++) html += floorRow(model, chat, f, forkFloors.has(f));
    container.innerHTML = html || '<div class="chatfilesys-note">空聊天——发一条消息开始。</div>';
}

/** 未启用/群聊状态的弹窗内容（无 Tabs） */
export function renderInactiveContent(container, { isGroupChat = false }) {
    if (!container) return;
    if (isGroupChat) {
        container.innerHTML = '<div class="chatfilesys-note">群聊暂不支持分支（第一期仅单人聊天）。</div>';
        return;
    }
    container.innerHTML = `
        <div class="chatfilesys-note">
            此聊天尚未启用分支。启用后：<b>分支住在这个聊天文件体内</b>——共享前缀只存一份、
            切换分支零网络、vanilla ST 打开看到当前分支且数据无损。
        </div>
        <div class="chatfilesys-btnrow">
            <button class="menu_button" data-action="enable"><i class="fa-solid fa-layer-group"></i> 启用分支</button>
        </div>`;
}
