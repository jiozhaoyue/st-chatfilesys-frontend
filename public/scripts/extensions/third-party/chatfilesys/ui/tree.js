/**
 * ChatFilesys — SVG 图形化分支树（PRD 决策 #10，二期）
 *
 * 节点=分支、边=分叉关系（标注分叉楼层号）、可缩放拖拽、点击节点=切换。
 * 数据源：branches（path/fork_base）直出，纯前端渲染，无新数据依赖。
 */

import { esc, branchColor, branchFloors, branchMaxFloor, getActiveBranch, nodeLabel, branchSummaryOf } from './common.js';

const NODE_W = 150;
const NODE_H = 46;
const GAP_X = 26;
const GAP_Y = 64;

/**
 * 推断分支父节点：path 在 1..fork_base 上与 b 完全一致的已放置分支；
 * 多候选时优先默认分支，其次楼层数最接近 fork_base 的（分叉来源的直观祖先）。
 */
function inferParent(model, b, placed) {
    if (b.is_default || !b.fork_base) return null;
    const k = b.fork_base;
    const candidates = placed.filter((p) => p.id !== b.id
        && branchMaxFloor(p) >= k
        && Array.from({ length: k }, (_, i) => i + 1).every((f) => p.path[f] === b.path[f]));
    if (!candidates.length) return null;
    candidates.sort((x, y) => {
        if (x.is_default !== y.is_default) return x.is_default ? -1 : 1;
        return Math.abs(branchMaxFloor(x) - k) - Math.abs(branchMaxFloor(y) - k);
    });
    return candidates[0];
}

/**
 * 树布局：DFS 先序 = 兄弟轴，depth = 深度轴。
 * @param {object} model
 * @param {{direction?: 'down'|'right'}} [opts] down = 深度向下（兄弟横排，默认）；right = 深度向右（兄弟竖排，N13）
 */
export function layoutTree(model, opts = {}) {
    const placed = [];
    const parentOf = new Map();
    const childrenOf = new Map();
    // fork_base 升序放置：保证推断父节点时候选已就位（默认分支 fork_base=0 最先）
    const ordered = [...model.branches].sort((a, b) => (a.fork_base || 0) - (b.fork_base || 0));
    for (const b of ordered) {
        const parent = inferParent(model, b, placed);
        parentOf.set(b.id, parent?.id || null);
        if (parent) {
            const arr = childrenOf.get(parent.id) || [];
            arr.push(b.id);
            childrenOf.set(parent.id, arr);
        }
        placed.push(b);
    }

    const pos = new Map();
    const depth = new Map();
    const roots = model.branches.filter((b) => !parentOf.get(b.id));
    let cursor = 0;
    const walk = (id, d) => {
        depth.set(id, d);
        const kids = childrenOf.get(id) || [];
        if (!kids.length) {
            pos.set(id, cursor++);
            return;
        }
        const first = cursor;
        for (const kid of kids) walk(kid, d + 1);
        pos.set(id, first + (cursor - 1 - first) / 2);  // 父节点居中于子节点上方
    };
    for (const r of roots) walk(r.id, 0);

    const horizontal = opts.direction === 'right';
    return model.branches.map((b) => {
        const along = (pos.get(b.id) ?? 0);       // 兄弟轴
        const deep = (depth.get(b.id) ?? 0);      // 深度轴
        return {
            branch: b,
            x: (horizontal ? deep : along) * (NODE_W + GAP_X),
            y: (horizontal ? along : deep) * (NODE_H + GAP_Y),
            parent: parentOf.get(b.id),
        };
    });
}

/**
 * 渲染 SVG 树到容器（含缩放/拖拽；点击节点 = data-action="switch" 委托）。
 * @param {HTMLElement} container
 * @param {{model: object, selectedId?: string}} view
 */
export function renderTree(container, { model, direction = 'down' }) {
    if (!container || !model) return;
    const layout = layoutTree(model, { direction });
    const active = getActiveBranch(model);
    const width = Math.max(...layout.map((n) => n.x)) + NODE_W + 20;
    const height = Math.max(...layout.map((n) => n.y)) + NODE_H + 20;

    const nodeById = new Map(layout.map((n) => [n.branch.id, n]));
    const edges = layout.filter((n) => n.parent).map((n) => {
        const p = nodeById.get(n.parent);
        const x1 = p.x + NODE_W / 2, y1 = p.y + NODE_H;
        const x2 = n.x + NODE_W / 2, y2 = n.y;
        const my = (y1 + y2) / 2;
        return `<path class="chatfilesys-edge" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"></path>
            <text class="chatfilesys-edge-label" x="${(x1 + x2) / 2}" y="${my - 4}">⎇F${n.branch.fork_base}</text>`;
    }).join('');

    const order = new Map(model.branches.map((b, i) => [b.id, i]));
    const nodes = layout.map((n) => {
        const b = n.branch;
        const isActive = b.id === active?.id;
        // N5/N13：节点标签默认自动序号（#N），有自定义名时附在序号后
        const name = nodeLabel(b, order.get(b.id) ?? 0);
        const summary = branchSummaryOf(b);
        return `<g class="chatfilesys-tnode ${isActive ? 'active' : ''}" data-action="switch" data-branch="${esc(b.id)}"
                transform="translate(${n.x},${n.y})">
            <rect width="${NODE_W}" height="${NODE_H}" rx="8" style="stroke:${branchColor(model, b.id)}"></rect>
            <circle cx="14" cy="${NODE_H / 2}" r="5" fill="${branchColor(model, b.id)}"></circle>
            <text class="chatfilesys-tnode-name" x="26" y="19">${esc(name)}${b.is_default ? '（默认）' : ''}</text>
            <text class="chatfilesys-tnode-meta" x="26" y="35">${esc(summary || `${branchFloors(b)} 层`)}${isActive ? ' · 当前' : ''}</text>
        </g>`;
    }).join('');

    container.innerHTML = `
        <div class="chatfilesys-tree-vp">
            <svg class="chatfilesys-tree" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                ${edges}${nodes}
            </svg>
        </div>
        <div class="chatfilesys-tree-hint">
            <button class="menu_button" data-action="tree-direction" title="切换树的方向">${direction === 'right' ? '向右展开 ↓ 切回向下' : '向下展开 ↓ 切到向右'}</button>
            <span>节点编号 = 走法顺序（自定义名附在编号后）· 滚轮缩放 · 拖拽平移 · 点击节点切换</span>
        </div>`;

    bindPanZoom(container.querySelector('.chatfilesys-tree-vp'), container.querySelector('.chatfilesys-tree'));
}

/** 视口内缩放/拖拽（transform 于 svg 元素；指针事件不冒泡避免触发节点） */
function bindPanZoom(vp, svg) {
    if (!vp || !svg) return;
    let scale = 1, tx = 0, ty = 0, dragging = null;
    const apply = () => { svg.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    vp.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const next = Math.min(3, Math.max(0.3, scale * factor));
        const rect = vp.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        tx = mx - (mx - tx) * (next / scale);
        ty = my - (my - ty) * (next / scale);
        scale = next;
        apply();
    }, { passive: false });
    vp.addEventListener('mousedown', (e) => {
        if (e.target.closest('.chatfilesys-tnode')) return;
        dragging = { x: e.clientX, y: e.clientY, tx, ty };
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        tx = dragging.tx + (e.clientX - dragging.x);
        ty = dragging.ty + (e.clientY - dragging.y);
        apply();
    });
    window.addEventListener('mouseup', () => { dragging = null; });
}
