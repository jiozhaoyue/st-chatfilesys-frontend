/**
 * ChatFilesys — 图引擎 · 建图 + 增量失效（B2 / prd R2 R3 R4 R5 R7，design.md §1 §3 §4）
 *
 * 输入 = B1 的 `graphInputs()` 产物（`{ sessions, branches? }`），**本层不自己读数据**（R2）。
 * 输出 = 一张**结构索引图**：节点 + 边 + 每个会话的节点序列。
 *
 * ── 形状（design.md §1，渲染无关、可在 node:test 下无 DOM 跑） ──
 * ```
 * Node  = { id, floor, contentKey, isUser, sessions: string[] }
 * Edge  = { from, to }
 * Graph = { nodes: Node[], edges: Edge[], sessions: [{ ref, nodeIds: string[] }] }
 * ```
 * - `sessions[].nodeIds` = 「按会话取出节点序列」的直接依据（顺序 = 对话顺序）
 * - `nodes[].sessions` 长度 > 1 = 该消息被多个会话共享（公共前缀**零复制**，
 *   靠内容身份而不是靠位置——TL 想要的效果，我们不用它的实现）
 * - 分支点不单独存字段（出边 ≥ 2 的节点就是），查询时算（`query.js#forkPoints`）
 * - **三个数组都按内容排序**（见下），故整张图是「输入内容」的纯函数：
 *   同一份内容随便怎么换会话插入顺序，`graph` 都能 `deepEqual`（钉住 TL 缺陷一）
 *
 * ── 边与多父（design §3，钉住 TL 缺陷二） ──
 * - 会话内：`nodeIds[i] → nodeIds[i+1]`
 * - 跨会话：**不加特殊边**——同 `(层号, 内容指纹)` 自动是同一个节点，共享是身份的推论
 * - `edges` 里同一 `from→to` 只留一条；但**一个节点的入边可以来自多个父节点，全部保留**
 *   （TL 的 `incomingEdgeMap` 只留一条 → 检查点路径回溯不全）
 * - 由此得到一条可证明的性质：**图必然无环**（每条边都从层号 f 到 f+1，层号严格递增）
 *
 * ── 增量失效（design §4，钉住 TL 缺陷三） ──
 * `buildGraph(inputs, { prev }) → { graph, digest, changed, notes }`；
 * `digest === prev.digest` 时**返回 `changed:false` 并复用 `prev.graph`**（同一个对象引用 →
 * 消费方（布局 / 渲染 / 大纲…）可以据此整段跳过重建）。
 *
 * 指纹取什么（design §4 的落地口径，逐条交代）：
 * - 会话**逐条**进指纹：`ref.id` + **该 `ref` 的判定面**（`name` / `kind` / `origin` /
 *   `characterId`，见 `refMetaOf`）+ **行数** + **版本号**（`chat_metadata.integrity`，经
 *   `core/integrity.js#normIntegrity` 归一——库内历史行可能是数字）+ **该会话的节点序列**
 * - **为什么连 `ref` 的元信息一起算**（复检 F1）：图里 `sessions[].ref` 存的是**整份 `ref`**，
 *   指纹就必须覆盖它；否则「同一个键、同一份消息，只有 ref 元信息变了」（`kind` / `origin`
 *   随导入入库变、`name` 随家族改名变）会判成 `changed:false` 却发回**带旧 ref 的图**——
 *   「digest 相同 ⇒ 图相同」这条契约就不成立了。`id` / `key` 的值已由上面那项覆盖（契约上同值）。
 * - 最后一项就是 design §4 里说的「**文件 mtime+size 或内容指纹**」中的后者（父任务 design §1.3
 *   明示二者皆可）。为什么不是 mtime+size：B1 的 `graphInputs()` 契约里**没有文件 stat**
 *   （R8 不许改 `core/source/*`，本层也不许自己读盘）。而内容指纹本就**强于** mtime+size：
 *   `touch` / 原样重写（改 mtime 不改内容）不会误判成「变了」，改内容不改大小也逃不过。
 * - **`inputs.branches` 不进指纹**：它是家族/分支模型，本层的边与节点只由
 *   `(层号, 内容指纹)` 决定（design §3「跨会话不加特殊边」），也即它**不影响图**。
 *   把不影响图的字段算进指纹，只会造成「报变了却什么都没变」的无谓重建。
 * - 指纹与**会话枚举顺序无关**（逐条按 `ref.id` 排序后合并）——与节点 id 同一条纪律：
 *   顺序不参与身份，也不参与「变没变」。
 *
 * ── 两条边界（与 design §4 同文，供 B3/B4 别误用） ──
 * - **`changed` 说的是「图」没变，不是「输入」没变**：不进指纹的输入（`inputs.branches`、`header`
 *   里除 `integrity` 之外的字段）变了，`changed` 仍是 `false`。消费方不要把它当成「数据源没动过」。
 * - **`digest` 省不了 I/O，也省不了哈希**：逐行 `contentKeyOf`（sha256）在判定之前就做完了
 *   （5000 行量级 ≈190ms，真机实测），`prev` 命中的收益只是「不重新装配 / 排序这张图」，
 *   以及让下游（布局 / 渲染）据此整段跳过重建。
 *
 * ── 静默降级（R7 / 铁律 L0-11） ──
 * 单个会话读失败 / 数据不自洽（`ref` 无法识别、`messages` 不是数组、两个会话同 id、消息字段
 * 读爆）→ **该会话不进图 + 记一条 note + `console.warn`**，**不影响其余会话、绝不抛到上层**。
 * **例外：会话里的某一行不是对象** → **不跳过**（跳了会让后面每一条都改层号，也就改了它们的
 * 节点身份），按**空内容**入图 + 记一条 note —— 即「该会话仍进图，但该行内容为空，且
 * **不改变后续层号**」。
 * note 笔记本复用 B1 的 `core/source/notes.js`（只读依赖，不改它）：降级「记账 + 打日志 + 不抛」
 * 这套纪律只此一份，不在图层另立一套。**但日志前缀换成本层自己的**（见 `relabel`）：笔记本打的
 * 是 `[chatfilesys-source]`，在图层里那看起来像「数据源出问题」（复检 F5）。
 */

import { normIntegrity } from '../integrity.js';
import { createSourceNotes } from '../source/notes.js';
import { contentKeyOf, nodeIdOf, textDigest } from './identity.js';

/** 建图自述（`notes[0]`，**不是缺项**；口径同 `core/source/notes.js#hint`） */
const HINT = '建图（B2）：节点身份 = （层号, 内容指纹）——与输入顺序无关；'
    + '文本不驻节点（图是结构索引，正文用 `sessionNodeIds` 回源会话取）';

/** 图层自己的日志前缀（复检 F5） */
const GRAPH_LOG_PREFIX = '[chatfilesys-graph]';

/**
 * 给注入的日志函数**换前缀**（复检 F5）。
 *
 * 降级笔记本是 B1 的（`core/source/notes.js`，只读复用、R8 不改它），它打的是
 * `[chatfilesys-source]`——在图层（建图）里那看起来像「数据源出问题」，会把排障引到错的地方。
 * 只换前缀：「记账 + 打日志 + 不抛」这套纪律仍只此一份，不另立一套。
 *
 * @param {Function} log 调用方注入的日志函数（缺省 `console.warn`）
 * @returns {Function} 换过前缀的日志函数
 */
const relabel = (log) => (msg) => {
    try {
        log(String(msg).replace('[chatfilesys-source]', GRAPH_LOG_PREFIX));
    } catch { /* 日志本身失败与建图无关（L0-11：日志不许带崩数据面） */ }
};

/** 图内一切序列的**唯一**顺序口径：层号升序、同层按 id 升序 → 与输入顺序无关 */
const byFloorThenId = (a, b) => (a.floor - b.floor)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 比较两个字符串（数组排序用；`sort` 的默认比较也够，写出来是为了顺序口径一眼可见） */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 建图。
 *
 * @param {{sessions?: Array<object>, branches?: Array<object>}} inputs B1 `graphInputs()` 的产物
 * @param {{prev?: {graph?: object, digest?: string}|null, log?: Function}} [opts]
 *   `prev` = 上一次的 `{graph, digest}`（`createGraphCache` 替你保管）；缺省 = 每次都算「变了」
 * @returns {Promise<{graph: object, digest: string, changed: boolean, notes: string[]}>}
 *   `notes[0]` 是自述（不是缺项），其后是本次跳过/降级的记录；`changed:false` 时
 *   `graph` **就是** `prev.graph` 那一个对象（引用相等，消费方可据此整段跳过重建）。
 *   **`changed:false` 只说明「图没变」**，不说明「输入没变」（`inputs.branches` 之类不进指纹）；
 *   且 `digest` 判定发生在逐行哈希**之后**，省掉的是装配/排序与下游重建，不是 I/O 与哈希。
 */
export async function buildGraph(inputs, { prev = null, log = console.warn } = {}) {
    const notes = createSourceNotes({ log: relabel(log), hint: HINT });

    const nodeIndex = new Map();     // id → Node（同 id 自然合并 = 共享前缀零复制的全部机制）
    const edgeSeen = new Set();      // `from\u0000to`（同一 from→to 只留一条；多父各留各的）
    const edges = [];
    const built = new Map();         // refId → {ref, nodeIds}（进图的会话，唯一）
    const digestParts = [];          // 逐会话的指纹成分

    const list = Array.isArray(inputs?.sessions) ? inputs.sessions : [];

    for (const session of list) {
        const ref = session?.ref;
        const refId = String(ref?.id ?? ref?.key ?? '');
        try {
            if (!refId) {
                notes.note('有一个会话既没有 `ref.id` 也没有 `ref.key`（认不出是哪个会话），已跳过', { partial: true });
                continue;
            }
            if (built.has(refId)) {
                // 同一个 id 两份会话：合起来会得到一条乱的节点序列，只能保一份 —— 说出来，不静默
                notes.note(`会话「${refId}」出现两次（ref.id 重复，数据不自洽），后一份已跳过`, { partial: true });
                continue;
            }
            if (!Array.isArray(session?.messages)) {
                notes.note(`会话「${refId}」的 messages 不是数组（数据不自洽），已跳过`, { partial: true });
                continue;
            }

            // 先**只算指纹**（这一步可能因坏字段抛），算完再提交 —— 中途抛掉时本会话在图里
            // 不留半截节点（R7「该会话不进图」要的是整份不进，不是残缺地进）
            const rows = [];
            for (let i = 0; i < session.messages.length; i++) {
                // 层号 = 位置（1 起）。**坏行不跳过**——跳了会让后面每一条都改层号，也就改了身份
                const message = session.messages[i];
                rows.push({ floor: i + 1, message, contentKey: await contentKeyOf(message) });
            }

            const nodeIds = [];
            let notObject = 0;
            for (const row of rows) {
                if (!row.message || typeof row.message !== 'object' || Array.isArray(row.message)) notObject += 1;
                const id = nodeIdOf(row.floor, row.contentKey);
                nodeIds.push(id);
                const known = nodeIndex.get(id);
                if (known) {
                    if (!known.sessions.includes(refId)) known.sessions.push(refId);
                } else {
                    nodeIndex.set(id, {
                        id,
                        floor: row.floor,
                        contentKey: row.contentKey,
                        isUser: Boolean(row.message?.is_user),
                        sessions: [refId],
                    });
                }
            }
            if (notObject) {
                notes.note(`会话「${refId}」有 ${notObject} 条行不是对象（按空内容入图，未跳过——`
                    + '跳过会改后续每一条的层号，也就改了它们的节点身份）', { partial: true });
            }

            for (let i = 0; i + 1 < nodeIds.length; i++) {
                const from = nodeIds[i];
                const to = nodeIds[i + 1];
                const stamp = `${from}\u0000${to}`;
                if (edgeSeen.has(stamp)) continue;
                edgeSeen.add(stamp);
                edges.push({ from, to });
            }

            built.set(refId, { ref: ref ? { ...ref } : null, nodeIds });
            digestParts.push({
                ref: refId,
                meta: refMetaOf(ref),
                rows: nodeIds.length,
                integrity: normIntegrity(session?.header?.chat_metadata?.integrity),
                chain: nodeIds.join(','),
            });
        } catch (e) {
            // 单条会话把整次建图带崩是不可接受的（R7 / L0-11）：丢弃这一份，其余照建
            notes.note(`会话「${refId || '（认不出）'}」建图失败，已跳过（不影响其余会话）：`
                + `${e?.message || e}`, { partial: true });
        }
    }

    // 三个数组都按内容排序（见文件头）→ 整张图是输入内容的纯函数：
    // 节点各自的 `sessions` 也排序（它是**先遇到谁就压谁**压出来的，不排就带上了输入顺序；
    // 实测踩到过：只换 [P,Q] → [Q,P]，节点 id / 边 / 会话序列全对，唯独 `sessions` 反了）
    const floorOf = (id) => nodeIndex.get(id)?.floor ?? Number.POSITIVE_INFINITY;
    const graph = {
        nodes: [...nodeIndex.values()]
            .map((node) => ({ ...node, sessions: [...node.sessions].sort() }))
            .sort(byFloorThenId),
        edges: [...edges].sort((a, b) => (floorOf(a.from) - floorOf(b.from))
            || cmp(a.from, b.from) || cmp(a.to, b.to)),
        sessions: [...built.keys()].sort().map((refId) => built.get(refId)),
    };

    const digest = await textDigest(canonicalOf(digestParts));
    const same = Boolean(prev?.graph) && prev.digest === digest;
    return { graph: same ? prev.graph : graph, digest, changed: !same, notes: notes.list() };
}

/**
 * 图缓存 + **宿主事件失效钩子**（design §4 末段）。
 *
 * B2 **不自己挂事件**（宿主事件接线属上层）：聊天变更 / 切换 / 删除到达时，由上层调
 * `invalidate()` 把上一次的 `{graph, digest}` 丢掉，下一次 `build()` 必定 `changed:true`。
 * 缓存只活在内存里——**落地到 IndexedDB 属 B3/B4 的性能范围**（本任务非目标）。
 *
 * @param {{log?: Function}} [opts]
 * @returns {{build: (inputs: object) => Promise<object>, invalidate: () => void, peek: () => object|null}}
 */
export function createGraphCache({ log = console.warn } = {}) {
    let prev = null;
    return {
        /** 建图（带上一次的结果做失效判定）。返回同 `buildGraph`。 */
        async build(inputs) {
            const out = await buildGraph(inputs, { prev, log });
            prev = { graph: out.graph, digest: out.digest };
            return out;
        },
        /** 宿主事件失效入口：清掉上一次的结果（下次 `build` 必 `changed:true`）。 */
        invalidate() {
            prev = null;
        },
        /** 当前缓存（没建过 / 刚失效 → null）。省掉一次「为了看图而重读数据源」。 */
        peek() {
            return prev ? { graph: prev.graph, digest: prev.digest } : null;
        },
    };
}

/* ---------------- 内部 ---------------- */

/**
 * `ref` 的**判定面**（复检 F1）：`ref` 的元信息字段，按固定顺序取成纯量数组。
 *
 * 图里 `sessions[].ref` 存的是**整份 `ref`**，指纹就必须覆盖它，否则「同键、同一份消息、
 * 只有 ref 元信息变了」会判成 `changed:false` 却发回带旧 ref 的图。
 * 取值面 = B1 `SessionRef` 契约的元信息（`name` / `kind` / `origin` / `characterId`）；
 * `id` / `key` 的**值**已由调用方的 `digestParts.ref` 覆盖（契约上二者同值）。
 *
 * @param {object|null|undefined} ref
 * @returns {string[]} 四个字符串（缺项归一成 `''`，故缺字段与空串同判——契约上二者同义）
 */
function refMetaOf(ref) {
    return [
        String(ref?.name ?? ''),
        String(ref?.kind ?? ''),
        String(ref?.origin ?? ''),
        String(ref?.characterId ?? ''),
    ];
}

/**
 * 逐会话指纹成分 → 一个规范串（最后过一次 sha256 = `digest`）。
 *
 * 规范串 = 按 `ref` 排序后的 `[ref, 元信息, 行数, 版本号, 节点序列]` 的 JSON——
 * 会话枚举顺序不进来，「变没变」判的就是内容本身。
 */
function canonicalOf(digestParts) {
    const sorted = [...digestParts].sort((a, b) => cmp(a.ref, b.ref));
    return JSON.stringify(sorted.map((p) => [p.ref, p.meta, p.rows, p.integrity, p.chain]));
}
