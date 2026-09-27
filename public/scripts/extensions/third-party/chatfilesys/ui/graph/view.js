/**
 * ChatFilesys — 图视图（B4）：把 B2 的图 + B3 的坐标画出来
 *
 * ── 它是什么 / 不是什么 ──
 * 是**结构视图**：一个节点 = 一条消息（同层同内容在多条会话里**只有一个节点**——
 * 共享前缀零复制，这正是图引擎存在的理由）。
 * **不是**聊天记录的第二份副本：节点上只有 `层号 + 谁说的 + 几个字`，**没有任何正文**。
 * 这与弹窗铁律一致（`ui/popup.js` 文件头：结构视图只显结构，不显消息内容）；
 * 要看正文是用户**主动点开节点**的动作，走既有的 `ui/versions.js` 展示层，不在这里渲染。
 *
 * ── 与既有分支树的关系（两者都在，不是替代） ──
 * - `ui/tree.js` = **分支级**（节点 = 一条分支）——回答「我有哪几条分支」
 * - 本模块  = **消息级**（节点 = 一条消息）——回答「这几条分支在哪里分、在哪里合」
 * 两者数据同源（都从家族模型来），但**不是同一张图**：分支树是家族模型直出，
 * 图视图走 B1 数据源 → B2 图引擎。分叉点判定应当一致（有单测钉住），
 * 但节点粒度不同，不要把两者混成一个概念。
 *
 * ── 增量 ──
 * `changed:false`（B2 的 `digest` 未变）时**整段跳过重建**：不重新布局、不重绘，
 * 只做一次「视口可能变了」的廉价检查。这是 B2 那句「消费方可据此整段跳过重建」的落地。
 *
 * ── 降级 ──
 * 档位与原因来自 `degrade.js#planDegrade`，**渲染面把 `reasons` 原样带回去**
 * （调用方要能对用户显示「为什么图这么朴素」）。
 */

import {
    IDENTITY, clampScale, toScreen, zoomAt, panBy, hitTest, boundsOf, fitTransform,
    visibleNodes, minimapViewportRect,
} from './viewport.js';
import { createMinimap } from './minimap.js';

const NS = 'http://www.w3.org/2000/svg';

/** 节点配色（按「谁说的」分两类；与宿主主题变量解耦——图是数据可视化，不是宿主 UI） */
const FILL_USER = '#2d4a6b';
const FILL_CHAR = '#3a3350';
const STROKE_DEFAULT = 'rgba(255,255,255,0.22)';
const STROKE_ACTIVE = '#f0c040';

/** 造一个 SVG 元素（`createElement` 不给命名空间，必须用 `createElementNS`） */
function svg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        el.setAttribute(k, String(v));
    }
    return el;
}

/**
 * 节点上显示什么（**纯结构，零正文**）。
 * @param {{id:string, floor:number, isUser:boolean}} node
 * @param {(node: object) => {label?: string, badge?: string, title?: string}} [decorate]
 *   调用方注入的装饰器（B5 开放 API 的接口：第三方可给节点加角标）
 */
function labelOf(node, decorate) {
    const floor = Number(node?.floor) || 0;
    const who = node?.isUser ? '用户' : '角色';
    const primary = `#${floor}`;
    let extra = who;
    let title = `第 ${floor} 层 · ${who}`;
    if (typeof decorate === 'function') {
        try {
            const d = decorate(node) || {};
            if (d.label) extra = String(d.label);
            if (d.title) title = String(d.title);
        } catch { /* 装饰器是第三方的，出错不许带崩渲染（L0-11） */ }
    }
    return { primary, extra, title };
}

/**
 * 创建图视图控制器。
 *
 * @param {{ decorate?: Function, log?: Function, onAction?: (action: string, payload: object) => void,
 *          measure?: () => {width:number,height:number}, environment?: () => object }} [deps]
 *   `measure` = 取视口尺寸（DOM 是调用方的，本模块不假设自己怎么被挂）；
 *   `environment` = 采环境事实喂给 `degrade.js`（这样本模块不直接碰 `navigator`，好测）
 * @returns {{mount, setData, fit, zoom, centerOn, destroy, el, state, describe}}
 */
export function createGraphView(deps = {}) {
    const log = deps.log ?? (() => {});
    const onAction = deps.onAction ?? (() => {});

    const root = document.createElement('div');
    root.className = 'chatfilesys-graph';

    const stage = document.createElement('div');
    stage.className = 'chatfilesys-graph-stage';
    root.appendChild(stage);

    const svgEl = svg('svg', { class: 'chatfilesys-graph-svg' });
    const gEdges = svg('g', { class: 'chatfilesys-graph-edges' });
    const gNodes = svg('g', { class: 'chatfilesys-graph-nodes' });
    svgEl.appendChild(gEdges);
    svgEl.appendChild(gNodes);
    stage.appendChild(svgEl);

    const hud = document.createElement('div');
    hud.className = 'chatfilesys-graph-hud';
    root.appendChild(hud);

    const noteEl = document.createElement('div');
    noteEl.className = 'chatfilesys-graph-note';
    root.appendChild(noteEl);

    const mini = createMinimap({ onJump: (worldPoint) => centerOn(worldPoint) });

    /** 控制器状态（**唯一的可变状态**；其余一律现算） */
    const state = {
        graph: null,
        layout: null,
        positions: {},
        order: [],
        t: { ...IDENTITY },
        activeId: null,
        degrade: null,
        /** 上次渲染用的 digest——`changed:false` 时据此跳过重建 */
        digest: null,
        rendered: 0,
    };

    let disposed = false;
    let dragging = null;
    let rafId = null;

    const viewportSize = () => {
        if (typeof deps.measure === 'function') {
            const m = deps.measure() || {};
            return { width: Number(m.width) || 0, height: Number(m.height) || 0 };
        }
        const r = stage.getBoundingClientRect();
        return { width: r.width, height: r.height };
    };

    /* ---------------- 渲染 ---------------- */

    function applyTransform() {
        const { scale, tx, ty } = state.t;
        gEdges.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
        gNodes.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    }

    /** 画一条边（分叉进来的边用主题色强调——「这里分出去了」是图视图最想说的那句话） */
    function edgeEl(edge, positions) {
        const a = positions[edge.from];
        const b = positions[edge.to];
        if (!a || !b) return null;
        const path = svg('path', {
            class: 'chatfilesys-gedge',
            'data-from': edge.from,
            'data-to': edge.to,
            d: `M${a.x},${a.y} L${b.x},${b.y}`,
        });
        return path;
    }

    function nodeEl(node, positions, decorate, edgeLabels) {
        const p = positions[node.id];
        if (!p) return null;
        const g = svg('g', {
            class: 'chatfilesys-gnode',
            'data-node': node.id,
            transform: `translate(${p.x},${p.y})`,
        });
        const w = Number(p.width) || 180;
        const h = Number(p.height) || 40;
        const { primary, extra, title } = labelOf(node, decorate);
        const rect = svg('rect', {
            x: -w / 2, y: -h / 2, width: w, height: h, rx: 6,
            fill: node.isUser ? FILL_USER : FILL_CHAR,
            stroke: node.id === state.activeId ? STROKE_ACTIVE : STROKE_DEFAULT,
            'stroke-width': node.id === state.activeId ? 2 : 1,
        });
        const t1 = svg('text', { class: 'chatfilesys-gnode-id', x: -w / 2 + 10, y: 4 });
        t1.textContent = primary;
        const t2 = svg('text', { class: 'chatfilesys-gnode-meta', x: -w / 2 + 46, y: 4 });
        t2.textContent = extra;
        const titleEl = svg('title');
        titleEl.textContent = title + (node.sessions?.length > 1 ? ` · 被 ${node.sessions.length} 条会话共享` : '');
        g.appendChild(rect);
        g.appendChild(t1);
        g.appendChild(t2);
        g.appendChild(titleEl);
        if (edgeLabels) g.dataset.hasLabel = '1';
        return g;
    }

    /**
     * 重绘（**全量**；分片只影响「一次画多少」，见 `chunkedRender`）。
     * @param {{graph: object, layout: object, decorate?: Function, degrade?: object, activeId?: string|null}} data
     */
    function draw(data) {
        const { graph, layout } = data;
        state.graph = graph;
        state.layout = layout;
        state.positions = layout?.positions || {};
        state.order = layout?.order?.length ? layout.order : Object.keys(state.positions);
        if (data.activeId !== undefined) state.activeId = data.activeId;
        const degrade = data.degrade || state.degrade || { chunked: false, minimap: false, edgeLabels: true };
        state.degrade = degrade;

        gEdges.replaceChildren();
        gNodes.replaceChildren();
        state.rendered = 0;

        const pos = state.positions;
        const decorate = data.decorate;

        // 边：只画两端都在图里的
        const edges = (graph?.edges || []).map((e) => edgeEl(e, pos)).filter(Boolean);
        if (!degrade.chunked) {
            for (const e of edges) gEdges.appendChild(e);
        }

        const nodeEls = (graph?.nodes || []).map((n) => nodeEl(n, pos, decorate, degrade.edgeLabels)).filter(Boolean);

        if (degrade.chunked) {
            chunkedRender(edges, nodeEls, degrade.chunkSize || 240);
        } else {
            for (const n of nodeEls) gNodes.appendChild(n);
            state.rendered = nodeEls.length;
            afterDraw();
        }
        applyTransform();
    }

    /**
     * 分片渲染：每帧画一批，先画**边**再画**节点**（节点是用户要看的东西）。
     * 用 rAF 而不是同步循环——同步画 5000 个元素会直接卡住弹窗（L1-MR-9 的同族问题）。
     */
    function chunkedRender(edges, nodes, size) {
        const queue = [...edges, ...nodes];
        let i = 0;
        const step = () => {
            if (disposed) return;
            const end = Math.min(queue.length, i + size);
            for (; i < end; i++) {
                const el = queue[i];
                (i < edges.length ? gEdges : gNodes).appendChild(el);
            }
            state.rendered = Math.max(0, i - edges.length);
            afterDraw();
            if (i < queue.length) rafId = requestAnimationFrame(step);
            else rafId = null;
        };
        step();
    }

    /** 每批之后要更新的东西：HUD 数字、小地图、取景框 */
    function afterDraw() {
        updateHud();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
        else mini.hide();
    }

    function updateHud() {
        const total = state.graph?.nodes?.length || 0;
        const shown = state.rendered;
        const via = state.layout?.via ? `布局：${state.layout.via === 'worker' ? 'Worker' : '主线程'}` : '';
        const kind = state.layout?.kind ? `算法：${state.layout.kind === 'dagre' ? 'dagre' : '迭代分层'}` : '';
        const parts = [`${shown}/${total} 节点`, `${state.graph?.edges?.length || 0} 边`];
        if (via) parts.push(via);
        if (kind) parts.push(kind);
        hud.textContent = parts.join(' · ');
    }

    /* ---------------- 交互 ---------------- */

    function localPoint(evt) {
        const r = stage.getBoundingClientRect();
        return { x: evt.clientX - r.left, y: evt.clientY - r.top };
    }

    stage.addEventListener('wheel', (e) => {
        if (!state.layout) return;
        e.preventDefault();
        state.t = zoomAt(state.t, e.deltaY < 0 ? 1.12 : 1 / 1.12, localPoint(e));
        applyTransform();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
    }, { passive: false });

    stage.addEventListener('mousedown', (e) => {
        if (e.target.closest?.('.chatfilesys-gnode')) return;
        dragging = { x: e.clientX, y: e.clientY, t: { ...state.t } };
        stage.classList.add('panning');
    });
    // 监听挂在 window 上：指针划出图区时拖拽不该断（与 ui/tree.js 同一做法）
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        state.t = panBy(dragging.t, e.clientX - dragging.x, e.clientY - dragging.y);
        applyTransform();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = null;
        stage.classList.remove('panning');
    });

    // 命中：用**视口数学**算，不依赖 <rect> 的事件目标——分片渲染中途「元素还没画出来」时
    // 事件目标是 svg 本身，那时点节点会点空。用坐标算，画没画出来都能命中。
    stage.addEventListener('click', (e) => {
        if (!state.layout || dragging) return;
        const id = hitTest(state.order, state.positions, state.t, localPoint(e), 2);
        if (id) {
            setActive(id);
            onAction('graph-node', { nodeId: id, node: state.graph?.nodes?.find((n) => n.id === id) || null,
                screen: localPoint(e), event: e });
            return;
        }
        onAction('graph-blank', { screen: localPoint(e) });
    });

    /* ---------------- 对外 ---------------- */

    function setActive(id) {
        state.activeId = id || null;
        // 只改描边，不整图重绘（重绘会打断用户正在做的拖拽）
        gNodes.querySelectorAll('.chatfilesys-gnode').forEach((g) => {
            const on = g.dataset.node === state.activeId;
            const rect = g.querySelector('rect');
            if (!rect) return;
            rect.setAttribute('stroke', on ? STROKE_ACTIVE : STROKE_DEFAULT);
            rect.setAttribute('stroke-width', on ? '2' : '1');
        });
    }

    /** 整图装进视口 */
    function fit() {
        if (!state.layout) return;
        const b = boundsOf(state.positions);
        state.t = fitTransform(b, viewportSize(), { padding: 20 });
        applyTransform();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
        return state.t;
    }

    /** 缩放（供按钮/快捷键用） */
    function zoom(factor) {
        const v = viewportSize();
        state.t = zoomAt(state.t, factor, { x: v.width / 2, y: v.height / 2 });
        applyTransform();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
        return state.t;
    }

    /** 把某个**世界坐标点**移到视口中心 */
    function centerOn(worldPoint) {
        const v = viewportSize();
        const s = clampScale(state.t.scale);
        state.t = {
            scale: s,
            tx: v.width / 2 - (Number(worldPoint?.x) || 0) * s,
            ty: v.height / 2 - (Number(worldPoint?.y) || 0) * s,
        };
        applyTransform();
        if (state.degrade?.minimap) mini.update(state.graph, state.positions, state.t, viewportSize());
        return state.t;
    }

    /** 挂到容器上（本模块不自建挂载点——挂哪由调用方决定，见 spec/frontend/ui-placement.md） */
    function mount(container) {
        if (!container) return;
        container.replaceChildren(root);
        root.appendChild(stage);
        root.appendChild(hud);
        root.appendChild(noteEl);
        if (state.degrade?.minimap) root.appendChild(mini.el);
    }

    function destroy() {
        disposed = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        mini.destroy?.();
        root.remove();
    }

    const describe = () => ({
        nodes: state.graph?.nodes?.length || 0,
        edges: state.graph?.edges?.length || 0,
        rendered: state.rendered,
        digest: state.digest,
        transform: { ...state.t },
        layoutVia: state.layout?.via ?? null,
        layoutKind: state.layout?.kind ?? null,
        degrade: state.degrade ? { tier: state.degrade.tier, reasons: [...(state.degrade.reasons || [])] } : null,
    });

    return {
        el: root,
        mount,
        setActive,
        fit,
        zoom,
        centerOn,
        destroy,
        describe,
        state,
        /** 渲染入口：数据层（B1/B2/B3 的编排）调它 */
        render(data) {
            state.digest = data.digest ?? state.digest;
            draw(data);
        },
        setNote(text) { noteEl.textContent = text || ''; },
        get stage() { return stage; },
        _log: log,
    };
}
