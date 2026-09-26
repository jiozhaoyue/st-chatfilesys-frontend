/**
 * ChatFilesys — 图引擎 · 查询面（B2 / prd R6，design.md §5）
 *
 * 全部是**纯函数**（吃一张建好的图 + id，吐 id / id 序列），无 DOM、无网络、无宿主依赖，
 * 供 D2（分支深度 Diff）、D1（大纲）、C1（看板）等消费层直接用。
 *
 * ── 多父是这里的头等语义（design §3 / §5，钉住 TL 缺陷二） ──
 * `parentsOf` / `childrenOf` 返回**全部**父/子（TL 的 `incomingEdgeMap` 只留一条父边 →
 * 检查点着色只沿一条父边回溯，回溯不全）。`ancestorsOf` 因此在多父下会同时走上两条父路径。
 *
 * ── 顺序口径（写死在这里，消费方可依赖） ──
 * - `parentsOf` / `childrenOf`：id 升序（集合语义，顺序只为确定性）
 * - `ancestorsOf`：**层号降序**（由近及远，像一条往上走的祖先链），同层按 id 升序
 * - `forkPoints`：层号升序，同层按 id 升序
 * - `sessionNodeIds`：**对话顺序**（这是它的语义本身）
 * 一律与输入顺序无关——同一个 id 在同一张图上的查询结果恒定。
 *
 * ── 无环（可证明，不是假设） ──
 * 每条边都从层号 f 到 f+1（`build.js`），层号严格递增 → 图必为 DAG。故祖先回溯必然终止；
 * 遍历里仍带 `seen` 集合：多父下同一个祖先会被多条路径重复走到，去重是语义要求
 * （design §5「按层序**去重**」），不只是防环。
 *
 * ── 索引 ──
 * 查询是逐节点被调的（渲染一个节点要问它的父/子），故用一张**按图对象缓存的索引**
 * （`WeakMap`：不挂在图上、不进 JSON、不改变 `Graph` 的既定形状）。图建成后**视为不可变**
 * ——这是建图层的契约（`buildGraph` 每次返回新对象，不原地改旧的）。
 */

/** 图对象 → 索引（纯 memo；同一张图重复查询不再重建） */
const INDEXES = new WeakMap();

/** 「不是图」时的空索引（`WeakMap` 只吃对象键，故非对象输入得先拦住；L0-11：查询不抛） */
const NO_INDEX = { byId: new Map(), parents: new Map(), children: new Map(), sessions: new Map() };

/** 排序：层号降序、同层按 id 升序（祖先链的顺序口径） */
const byFloorDesc = (a, b) => (b.floor - a.floor) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 排序：层号升序、同层按 id 升序 */
const byFloorAsc = (a, b) => (a.floor - b.floor) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 反查层号（索引里存的是 id，排序要层号） */
const floorOf = (byId, id) => byId.get(id)?.floor ?? -1;

/** 建索引（首次查询某张图时做一次；不是对象/是 null → 空索引，不抛） */
function indexOf(graph) {
    if (!graph || typeof graph !== 'object') return NO_INDEX;
    const cached = INDEXES.get(graph);
    if (cached) return cached;

    const byId = new Map();
    const parents = new Map();      // id → Set(父 id)（**全部**父边，不去重父）
    const children = new Map();     // id → Set(子 id)
    const sessions = new Map();     // 会话 id → nodeIds 副本

    for (const node of graph?.nodes || []) byId.set(node.id, node);
    for (const edge of graph?.edges || []) {
        const from = edge?.from;
        const to = edge?.to;
        // 悬空边（指向不存在的节点）不该有；真有也不让它把查询带崩（L0-11 的姿态）
        if (!byId.has(from) || !byId.has(to)) continue;
        if (!parents.has(to)) parents.set(to, new Set());
        if (!children.has(from)) children.set(from, new Set());
        parents.get(to).add(from);
        children.get(from).add(to);
    }
    for (const session of graph?.sessions || []) {
        const refId = String(session?.ref?.id ?? session?.ref?.key ?? '');
        if (refId) sessions.set(refId, [...(session?.nodeIds || [])]);
    }

    const index = { byId, parents, children, sessions };
    INDEXES.set(graph, index);
    return index;
}

/** 取节点（找不到 → null）。省掉各处再写一遍 `graph.nodes.find(...)` 的 O(N) 线性扫。 */
export function nodeById(graph, id) {
    return indexOf(graph).byId.get(id) ?? null;
}

/**
 * 一个节点的**全部**父节点（design §3：多父必须留全）。
 * @returns {string[]} 父节点 id（升序）；无父（根）或节点不存在 → `[]`
 */
export function parentsOf(graph, id) {
    const index = indexOf(graph);
    if (!index.byId.has(id)) return [];
    return [...(index.parents.get(id) ?? [])].sort();
}

/**
 * 一个节点的**全部**子节点（同一 from→to 只留一条，但不同子各留各的）。
 * @returns {string[]} 子节点 id（升序）；无子（叶）或节点不存在 → `[]`
 */
export function childrenOf(graph, id) {
    const index = indexOf(graph);
    if (!index.byId.has(id)) return [];
    return [...(index.children.get(id) ?? [])].sort();
}

/**
 * 一个节点的**全部**祖先（**不含自己**；多父下所有父路径都走，按层号去重）。
 * @returns {string[]} 祖先 id，**层号降序（由近及远）**，同层按 id 升序；节点不存在 → `[]`
 */
export function ancestorsOf(graph, id) {
    const index = indexOf(graph);
    if (!index.byId.has(id)) return [];

    const seen = new Set();
    const stack = [...(index.parents.get(id) ?? [])];
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const parent of index.parents.get(cur) ?? []) {
            if (!seen.has(parent)) stack.push(parent);
        }
    }
    return [...seen]
        .map((nodeId) => ({ id: nodeId, floor: floorOf(index.byId, nodeId) }))
        .sort(byFloorDesc)
        .map((n) => n.id);
}

/**
 * 最近公共祖先（design §5）：`({自己} ∪ 全部祖先)` 求交，取**层号最大者**。
 *
 * 取「祖先或自己」而不是「严格祖先」是为了三条语义都自洽：同一个节点 → 它自己；
 * 一个是另一个的直接父 → 那个父；互不为祖先 → 它们最深的共同祖先。
 * 层号在本图里就是拓扑深度（每条边 +1），故「层号最大」= 最近的公共祖先。
 * 同层并列（多父下可能有两个同层共同祖先）取 **id 升序最小**——只为一个确定的答案。
 *
 * @returns {string|null} 公共祖先 id；无公共祖先（或节点不在图里）→ `null`
 */
export function locateLCA(graph, idA, idB) {
    const index = indexOf(graph);
    if (!index.byId.has(idA) || !index.byId.has(idB)) return null;

    const sideA = new Set([idA, ...ancestorsOf(graph, idA)]);
    const common = [idB, ...ancestorsOf(graph, idB)]
        .filter((candidate) => sideA.has(candidate))
        .map((nodeId) => ({ id: nodeId, floor: floorOf(index.byId, nodeId) }))
        .sort(byFloorDesc);
    return common.length ? common[0].id : null;
}

/**
 * 某会话的节点序列（**对话顺序**）。
 * @param {object} graph
 * @param {string} refId 会话 id（`ref.id`；库源与文件源同源同值）
 * @returns {string[]} 节点 id 序列（副本，改它不会污染图）；认不出这个会话 → `[]`
 */
export function sessionNodeIds(graph, refId) {
    const found = indexOf(graph).sessions.get(String(refId ?? ''));
    return found ? [...found] : [];
}

/**
 * 分叉点 = **出边 ≥ 2** 的节点（design §1 末段：「不单独存字段，查询时算」）。
 * @returns {string[]} 节点 id，层号升序、同层按 id 升序
 */
export function forkPoints(graph) {
    const index = indexOf(graph);
    const out = [];
    for (const [id, kids] of index.children) {
        if (kids.size >= 2) out.push({ id, floor: floorOf(index.byId, id) });
    }
    return out.sort(byFloorAsc).map((n) => n.id);
}
