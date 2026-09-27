/**
 * ChatFilesys — 图视图 · 小地图（B4）
 *
 * 一张「整图缩略 + 当前取景框」的小 SVG；点一下把视口挪过去。
 *
 * ── 为什么小地图值得单独一个文件 ──
 * 它要独立回答两个问题：① 整图长什么样（用户在图里迷路时的唯一参照）；
 * ② 我现在看的是哪一块（取景框）。两者都是**纯几何**，全部算术在 `viewport.js` 里
 * （`boundsOf` / `minimapViewportRect`），本文件只贴 SVG —— 于是小地图的正确性
 * 可以在 node 里对着数学单测，不必开浏览器。
 *
 * ── 降级不是这里决定的 ──
 * 「要不要小地图」由 `degrade.js#planDegrade` 判定（节点太多时它自己就成了负担）。
 * 本模块提供 `hide()`，让调用方按档位开关；**不自己猜**。
 */

import { boundsOf, minimapViewportRect } from './viewport.js';

const NS = 'http://www.w3.org/2000/svg';
const MINI_W = 148;
const MINI_H = 96;

function svg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        el.setAttribute(k, String(v));
    }
    return el;
}

/**
 * @param {{onJump?: (worldPoint: {x:number,y:number}) => void, size?: {width:number,height:number}}} [deps]
 * @returns {{el: HTMLElement, update: Function, hide: Function, show: Function, destroy: Function}}
 */
export function createMinimap(deps = {}) {
    const w = Number(deps.size?.width) || MINI_W;
    const h = Number(deps.size?.height) || MINI_H;
    const onJump = deps.onJump ?? (() => {});

    const el = document.createElement('div');
    el.className = 'chatfilesys-graph-minimap';

    const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    const gDots = svg('g', { class: 'chatfilesys-mini-dots' });
    const box = svg('rect', { class: 'chatfilesys-mini-box', x: 0, y: 0, width: 0, height: 0, rx: 2 });
    s.appendChild(gDots);
    s.appendChild(box);
    el.appendChild(s);

    /** 最近一次用到的「世界 → 小地图」投影参数（点击反算要用） */
    let projection = null;

    function update(graph, positions, t, viewport) {
        const b = boundsOf(positions);
        if (!b) { hide(); return; }
        const k = Math.min(w / Math.max(1, b.width), h / Math.max(1, b.height));
        const ox = (w - b.width * k) / 2;
        const oy = (h - b.height * k) / 2;
        projection = { b, k, ox, oy };
        const project = (p) => ({
            x: (p.x - b.minX) * k + ox,
            y: (p.y - b.minY) * k + oy,
        });

        // 点：一个节点一个点。**不画边**——小地图上边只会糊成一片，点才是「哪里有东西」
        const frag = document.createDocumentFragment();
        const ids = Object.keys(positions);
        // 点数上限：小地图是全局参照，不需要每个节点都在（超出时按步长抽样）
        const step = Math.max(1, Math.ceil(ids.length / 600));
        for (let i = 0; i < ids.length; i += step) {
            const p = positions[ids[i]];
            const q = project(p);
            const dot = svg('circle', {
                cx: q.x, cy: q.y, r: 1.2,
                fill: p.isUser ? '#6f9fd8' : '#9b8fd0',
            });
            frag.appendChild(dot);
        }
        gDots.replaceChildren(frag);

        const r = minimapViewportRect(b, t, viewport, { width: w, height: h });
        box.setAttribute('x', r.x);
        box.setAttribute('y', r.y);
        box.setAttribute('width', Math.max(2, r.width));
        box.setAttribute('height', Math.max(2, r.height));
        show();
    }

    // 点小地图 → 把那个世界坐标挪到主视口中心
    s.addEventListener('click', (e) => {
        if (!projection) return;
        const rect = s.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const { b, k, ox, oy } = projection;
        if (!k) return;
        onJump({ x: (mx - ox) / k + b.minX, y: (my - oy) / k + b.minY });
    });

    function show() { el.hidden = false; }
    function hide() { el.hidden = true; }
    function destroy() { el.remove(); }

    return { el, update, hide, show, destroy };
}
