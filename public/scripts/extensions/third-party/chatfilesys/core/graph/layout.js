/**
 * ChatFilesys — 图的布局计算（B3）
 *
 * 输入 B2 的图（`nodes` / `edges`），输出每个节点的坐标与整图尺寸。
 * 布局交给 **dagre**（引库，用户 2026-09-26 裁定「不要自写、用最好的」）；
 * 本模块**只做**「把图喂给 dagre、把结果整理成纯数据」，不渲染、不碰 DOM、不引 cytoscape。
 *
 * 两条设计要点
 *  1. **确定性**：dagre 的输出会受插入顺序影响，故喂之前把节点按 id、边按 (from,to) **排序**。
 *     同输入必得同坐标（单测钉住），否则「同一张图两次布局不同」会让上层无法判断是否需要重绘。
 *  2. **dagre 依赖注入**：本模块不自己加载 dagre（加载方式三种环境各不相同：页面 `<script>`、
 *     Worker `importScripts`、node 单测 `vm`），由调用方按环境注入 → 本模块可在 node 下用真 dagre 单测。
 *
 * L0-11 静默降级：没拿到 dagre / 图为空 / 布局抛错 → 返回 `null`，由调用方决定退路（**不抛**）。
 */

/** 默认尺寸与间距（节点宽高与既有结构树节点的视觉尺度同源） */
export const LAYOUT_DEFAULTS = Object.freeze({
    direction: 'TB',      // dagre rankdir
    rankSep: 56,          // 层间距
    nodeSep: 28,          // 同层节点间距
    nodeWidth: 180,
    nodeHeight: 40,
    edgeSep: 16,
});

/** 稳定排序：节点按 id、边按 (from,to)。纯函数，不改入参。 */
function sortedInputs(graph) {
    const nodes = [...(graph?.nodes ?? [])]
        .filter((n) => n && typeof n.id === 'string')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const known = new Set(nodes.map((n) => n.id));
    const edges = [...(graph?.edges ?? [])]
        .filter((e) => e && known.has(e.from) && known.has(e.to))
        .map((e) => ({ from: e.from, to: e.to }))
        .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1
            : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    return { nodes, edges };
}

/**
 * 迭代式分层布局（**兜底路径**，零递归）。
 *
 * 为什么必须有它（真机实测）：dagre 的 `dfs` 是**递归**的，链越长栈越深——
 * node 下约 1500 条链尚可、3000 条爆 `RangeError`；**浏览器 worker 栈更小，1000 条就爆**。
 * 而真实聊天的图**恰恰就是长链**（每条消息接上一条）。所以不能只靠"退回主线程"糊过去
 * （主线程栈更大只是把爆点往后推，且会把 UI 卡住——那正是 B3 要消灭的东西）。
 *
 * 做法：Kahn 拓扑分层（迭代，不递归）+ 层内按稳定顺序排布。
 * 长链在这种算法下本来就是一条直线，与 dagre 的结果一致；分叉处不如 dagre 精致，
 * 但**只在 dagre 撑不住时才走这条**（`kind` 会如实标 `'layered'`，可断言）。
 *
 * @returns {{positions: Object, width: number, height: number, order: string[], kind: 'layered'}}
 */
export function planLayoutLayered(graph, opts = {}) {
    const cfg = {
        direction: opts.direction ?? LAYOUT_DEFAULTS.direction,
        rankSep: opts.rankSep ?? LAYOUT_DEFAULTS.rankSep,
        nodeSep: opts.nodeSep ?? LAYOUT_DEFAULTS.nodeSep,
        nodeWidth: opts.nodeWidth ?? LAYOUT_DEFAULTS.nodeWidth,
        nodeHeight: opts.nodeHeight ?? LAYOUT_DEFAULTS.nodeHeight,
    };
    const { nodes, edges } = sortedInputs(graph);
    if (!nodes.length) return { positions: {}, width: 0, height: 0, order: [], kind: 'layered' };

    const ids = nodes.map((n) => n.id);
    const parents = new Map(ids.map((id) => [id, []]));
    const children = new Map(ids.map((id) => [id, []]));
    const indeg = new Map(ids.map((id) => [id, 0]));
    const seenEdge = new Set();
    for (const e of edges) {
        const k = `${e.from}\u0000${e.to}`;
        if (seenEdge.has(k)) continue;          // 重复边只算一次（与 dagre 那条路一致）
        seenEdge.add(k);
        parents.get(e.to).push(e.from);
        children.get(e.from).push(e.to);
        indeg.set(e.to, indeg.get(e.to) + 1);
    }

    // Kahn：迭代分层（rank = 从根算起的最长路径层号）
    const rank = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => indeg.get(id) === 0);
    const left = new Map(indeg);
    for (let qi = 0; qi < queue.length; qi += 1) {
        const id = queue[qi];
        for (const c of children.get(id)) {
            rank.set(c, Math.max(rank.get(c), rank.get(id) + 1));
            left.set(c, left.get(c) - 1);
            if (left.get(c) === 0) queue.push(c);
        }
    }
    // 有环（理论上不该有；B2 已证图无环）→ 未入队的节点按当前 rank 处理，不抛

    // 层内排布：同层按 id 稳定序（确定性），整行居中
    const byRank = new Map();
    for (const id of ids) {
        const r = rank.get(id);
        if (!byRank.has(r)) byRank.set(r, []);
        byRank.get(r).push(id);
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const vertical = cfg.direction === 'TB' || cfg.direction === 'BT';
    const rowWidth = (list) => list.length * cfg.nodeWidth + Math.max(0, list.length - 1) * cfg.nodeSep;
    const maxWidth = Math.max(...ranks.map((r) => rowWidth(byRank.get(r))));

    const positions = {};
    let cursor = 0;
    for (const r of ranks) {
        const list = byRank.get(r);
        const span = rowWidth(list);
        let along = (maxWidth - span) / 2;      // 整行居中
        for (const id of list) {
            const x = vertical ? along + cfg.nodeWidth / 2 : cursor + cfg.nodeHeight / 2;
            const y = vertical ? cursor + cfg.nodeHeight / 2 : along + cfg.nodeWidth / 2;
            positions[id] = { x, y, width: cfg.nodeWidth, height: cfg.nodeHeight };
            along += cfg.nodeWidth + cfg.nodeSep;
        }
        cursor += (vertical ? cfg.nodeHeight : cfg.nodeWidth) + cfg.rankSep;
    }

    const height = vertical ? Math.max(0, cursor - cfg.rankSep) : maxWidth;
    const width = vertical ? maxWidth : Math.max(0, cursor - cfg.rankSep);
    return { positions, width, height, order: ids, kind: 'layered' };
}

/** 回落原因的长度上限：爆栈的栈帧会重复几百次（真机实测数千字），全留着没人看还会灌满日志 */
export const DEGRADE_REASON_MAX = 500;

/** 截断到上限，**并写明截断了**（截断本身也是事实，不许悄悄切掉）；worker 的失败回执也用它 */
export function clipReason(s) {
    const str = String(s);
    return str.length <= DEGRADE_REASON_MAX
        ? str
        : `${str.slice(0, DEGRADE_REASON_MAX)}…（共 ${str.length} 字，已截断）`;
}

/**
 * 计算布局。
 * @param {{nodes?: Array, edges?: Array}} graph B2 的图
 * @param {{dagre?: object, direction?: string, rankSep?: number, nodeSep?: number,
 *          nodeWidth?: number, nodeHeight?: number, edgeSep?: number, onError?: Function}} opts
 * @returns {{positions: Object, width: number, height: number, order: string[],
 *            kind: 'dagre'|'layered', degraded?: {from: string, to: string, reason: string}} | null}
 *          `kind` 说明**这次用的是哪条路**（dagre 撑不住时会回落 `layered`，别把它当失败）；
 *          `degraded` 只在回落时出现，`reason` 是 dagre 真实抛出的原因（**不许吞**）。
 */
export function planLayout(graph, opts = {}) {
    const dagre = opts?.dagre;

    const cfg = {
        direction: opts.direction ?? LAYOUT_DEFAULTS.direction,
        rankSep: opts.rankSep ?? LAYOUT_DEFAULTS.rankSep,
        nodeSep: opts.nodeSep ?? LAYOUT_DEFAULTS.nodeSep,
        nodeWidth: opts.nodeWidth ?? LAYOUT_DEFAULTS.nodeWidth,
        nodeHeight: opts.nodeHeight ?? LAYOUT_DEFAULTS.nodeHeight,
        edgeSep: opts.edgeSep ?? LAYOUT_DEFAULTS.edgeSep,
    };

    // 没有 dagre（或它没给出可用 API）→ 直接走兜底分层（**不返回 null**：能布局就该布局）
    if (!dagre?.graphlib || typeof dagre.layout !== 'function') {
        return planLayoutLayered(graph, cfg);
    }

    try {
        const { nodes, edges } = sortedInputs(graph);
        if (!nodes.length) return { positions: {}, width: 0, height: 0, order: [], kind: 'dagre' };

        const g = new dagre.graphlib.Graph({ multigraph: true });
        g.setGraph({
            rankdir: cfg.direction,
            ranksep: cfg.rankSep,
            nodesep: cfg.nodeSep,
            edgesep: cfg.edgeSep,
        });
        g.setDefaultEdgeLabel(() => ({}));

        // 按**排序后**的顺序喂（确定性，见文件头要点 1）
        for (const n of nodes) g.setNode(n.id, { width: cfg.nodeWidth, height: cfg.nodeHeight });
        // 多父：同一条边只喂一次（dagre 的 multigraph 允许同名边，但重复喂会让权重累积）
        const seen = new Set();
        for (const e of edges) {
            const k = `${e.from}\u0000${e.to}`;
            if (seen.has(k)) continue;
            seen.add(k);
            g.setEdge(e.from, e.to, {}, k);
        }

        dagre.layout(g);

        const positions = {};
        for (const n of nodes) {
            const p = g.node(n.id) ?? {};
            positions[n.id] = {
                x: Number(p.x ?? 0),
                y: Number(p.y ?? 0),
                width: Number(p.width ?? cfg.nodeWidth),
                height: Number(p.height ?? cfg.nodeHeight),
            };
        }
        const meta = g.graph() ?? {};
        return {
            positions,
            width: Number(meta.width ?? 0),
            height: Number(meta.height ?? 0),
            order: nodes.map((n) => n.id),
            kind: 'dagre',
        };
    } catch (e) {
        // dagre 撑不住（真机实测：长链会爆 `Maximum call stack size exceeded`）→ 回落迭代分层。
        // **不静默**（本仓 spec 的 Forbidden）：原因要**同时**交给 `onError` **和结果本身**。
        // 为什么必须挂在结果上：worker 里没有任何人能接 `onError`——只挂 onError，
        // 回落原因就丢在 worker 内（真机实测过：调用方只看到 `kind:'layered'`，不知道为什么）。
        const reason = clipReason((e && (e.stack || e.message)) || e);
        if (typeof opts.onError === 'function') {
            try { opts.onError(e); } catch { /* 上报失败不影响退路 */ }
        }
        try {
            const r = planLayoutLayered(graph, cfg);
            return { ...r, degraded: { from: 'dagre', to: 'layered', reason } };
        } catch {
            return null;      // 连兜底都失败（不该发生）→ 交给调用方
        }
    }
}
