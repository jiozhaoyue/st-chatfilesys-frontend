/**
 * ChatFilesys — 图引擎入口（B2）：图这一层的**单一 import 点**
 *
 * 消费层（B3 布局 / B4 渲染 / D1 大纲 / C1 看板 / D2 Diff…）只 import 本文件即可，
 * 不必知道内部拆了几个模块：
 *
 * ```
 * import { buildGraph, createGraphCache, ancestorsOf, locateLCA } from '…/core/graph/graph.js';
 * ```
 *
 * 落点（prd R1）：纯逻辑、**可在 `node:test` 下无 DOM 跑**；**不引渲染库**
 * （cytoscape / dagre 是 B3/B4 的事，本层不把它们拖进来）。
 * 第三方库检索结论（2026-09-26，`api.github.com/search/repositories`）：
 * 现成方案里最贴的是 `graphology`（1749★，MIT）——但它的 LCA / 祖先要另配
 * `graphology-dag` 等包，且 `Graph` 对象**不是**本层 design §1 定死的
 * `{nodes, edges, sessions}` 纯数据形状（要额外写一层双向适配），**入边全保留**这条语义
 * 也得自己走。本层真正要写的只是「按层号排序的集合运算」（见 `query.js`），
 * 引库反而多一层适配，故**不引库**（R1 的「确有最佳现成库」不成立）。
 *
 * 各模块职责：
 * - `identity.js` — 节点身份（`层号:内容指纹`，与输入顺序无关）
 * - `build.js`    — 建图 + 增量失效（`buildGraph` / `createGraphCache`）
 * - `query.js`    — 查询面（父/子/祖先/LCA/会话序列/分叉点）
 */

export { ID_SEP, contentKeyOf, nodeIdOf, floorOfNodeId, textDigest } from './identity.js';
export { buildGraph, createGraphCache } from './build.js';
export {
    nodeById, parentsOf, childrenOf, ancestorsOf, locateLCA, sessionNodeIds, forkPoints,
} from './query.js';
