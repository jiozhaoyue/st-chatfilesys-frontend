/**
 * graph 单测（B2 / AC1）：图引擎（`core/graph/*`）
 *
 * 覆盖六组（对应 prd.md AC1 的六条）：
 * 1. **顺序无关**：同一份数据换会话插入顺序 → 整张图 `deepEqual`（节点 id ↔ 内容逐一对上）
 * 2. **共享**：同一条消息出现在两个会话 → **一个**节点、`sessions` 两条
 * 3. **多父**：一个节点两条入边**全部保留**（`parentsOf` 2 条、`ancestorsOf` 两条路径都走）
 * 4. **失效真读**：改输入 → `changed:true` 且 digest 变；未改 → `changed:false` 且**复用 `prev.graph`**
 * 5. **LCA**：同节点 / 直接父子 / 多父 / 无公共祖先 / 跨会话（+ 同层并列的确定性）
 * 6. **边界**：空输入 / 单会话单消息 / 同会话内重复台词（不同层不塌成一个节点）/ 坏会话（降级 + note）
 *
 * 另有「结构不变量」一组：图必然无环、出边全留、查询函数返回 id 而不是对象、JSON 往返后仍可查。
 *
 * ── 三组用例**怎么做到可证伪**（本仓出过「恒真断言」事故，故逐条交代） ──
 * - **顺序无关**：① 先断言两次输入的顺序**真的不同**（否则比的是同一份东西）；
 *   ② 再拿「改了一条正文」的第三份数据做对照，断言它的 id 集合**必须不同**——
 *   证明这条断言有能力变红；③ 拿到图后**逐节点**核对 `id === nodeIdOf(floor, contentKey)`
 *   （id 必须是身份算出来的，不能是建图时发的号——这一条永久关掉「发号」这一类变异）。
 *   **能力边界（据实说清，不夸大）**：本组只对**忠实复现 TL 机制**的变异敏感，即
 *   「按本次建图的**首次遇到顺序**给节点发号」（复检 §二 A1 型；实施方裁定：该变异是**忠实**
 *   复现，不是碰巧红）。把下标塞进身份、却让发号表**跨次建图存活**的那种变异，本组 3/3 全绿——
 *   真正变红的是别处的参照比对（`referenceIds`）与上面那条字面断言。故「本组必红」的说法
 *   只对前者成立。
 * - **多父**：不是只数入边条数，而是**两条父路径各自的独占祖先**都要在 `ancestorsOf` 里出现
 *   （`m2` / `m3` 各自只有一条路能到）；只留一条父边的实现必红。
 * - **失效真读**：① `changed:false` 时必须**引用相等**（`graph === prev.graph`）——
 *   重建一遍再返回一个等价对象是红的；② 改**同长度**的正文也必须 `changed:true`
 *   （只比对行数/只写不读的实现必红）；③ 只换会话顺序必须 `changed:false`
 *   （把顺序算进指纹的实现必红）；④ 同键同一份消息、只改 `ref` 元信息也必须 `changed:true`
 *   （指纹漏掉 ref 元信息、却把整份 ref 存进图的实现必红，复检 F1）。
 *
 * 全注入假数据：不碰网络、不碰磁盘、不碰 Dev 实例（`node:test` 下无 DOM 跑）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGraph, createGraphCache, contentKeyOf, nodeIdOf, floorOfNodeId,
    nodeById, parentsOf, childrenOf, ancestorsOf, locateLCA, sessionNodeIds, forkPoints,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/graph/graph.js';

/* ---------------- 夹具 ---------------- */

/** 一条消息（`name` 不进身份，故各处给不同显示名来钉住这一条） */
const msg = (mes, is_user = true, name = '我') => ({ mes, is_user, name });

/** 一条会话（形状 = B1 `readSession` 的产物：`{ ref, header, messages }`） */
const sess = (id, messages, { integrity, fallbackKeyOnly = false } = {}) => ({
    ref: fallbackKeyOnly ? { key: id, name: id } : { id, key: id, name: id, kind: 'chat', origin: 'file' },
    header: integrity === undefined ? {} : { chat_metadata: { integrity } },
    messages,
});

/** 捕获日志（L0-11：降级必须留日志，且不淹没测试输出） */
function captureLog() {
    const lines = [];
    return { lines, log: (m) => lines.push(String(m)) };
}

/** 某会话第 `floor` 层（1 起）的节点 id */
const nodeAt = (graph, refId, floor) => sessionNodeIds(graph, refId)[floor - 1];

/** 节点 id 全集（排序后；比对「图里有哪些节点」用） */
const idsOf = (graph) => graph.nodes.map((n) => n.id).sort();

/**
 * **朴素参照实现**：按 `(层号, 内容指纹)` 直接从原始输入去重出 id 集合。
 * 它复用的是身份原语（`nodeIdOf` / `contentKeyOf`），故验的是**建图**（有没有漏、有没有重、
 * 层号有没有错），不是身份本身——身份由下面钉字段的那几条用例管。
 */
async function referenceIds(sessions) {
    const out = new Set();
    for (const s of sessions) {
        for (let i = 0; i < s.messages.length; i++) {
            out.add(nodeIdOf(i + 1, await contentKeyOf(s.messages[i])));
        }
    }
    return [...out].sort();
}

/**
 * 多父夹具：`X` 在第 3 层，两个会话分别从 `m2` / `m3`（都在第 2 层）走到它。
 * 于是 `X` 的入边是 **2 条**（TL 的 `incomingEdgeMap` 只留一条 → 回溯不全，正是要钉的那条）。
 */
async function multiParentGraph() {
    const p = sess('p', [msg('一'), msg('二', false, 'A'), msg('X', false, 'A')]);
    const q = sess('q', [msg('一'), msg('丙', false, 'A'), msg('X', false, 'A')]);
    const out = await buildGraph({ sessions: [p, q] }, { log: () => {} });
    return { ...out, p, q };
}

/* ---------------- 0. 结构不变量 ---------------- */

test('不变量：每条边都从层号 f 到 f+1（层号严格递增 → 图必然无环）', async () => {
    const { graph } = await multiParentGraph();
    const floors = new Map(graph.nodes.map((n) => [n.id, n.floor]));
    assert.ok(graph.edges.length > 0);
    for (const e of graph.edges) {
        assert.equal(floors.get(e.to), floors.get(e.from) + 1, `边 ${e.from} → ${e.to} 跨了不止一层`);
    }
    // 无环 = 从任一节点沿出边往下走必然终止且不回头（层号单调）
    const walk = (id, seen = new Set()) => {
        for (const kid of childrenOf(graph, id)) {
            assert.equal(seen.has(kid), false, '走回了走过的节点（有环）');
            assert.ok(floors.get(kid) > floors.get(id));
            walk(kid, new Set([...seen, kid]));
        }
    };
    for (const n of graph.nodes) walk(n.id, new Set([n.id]));
});

test('不变量：查询返回的是 id（字符串），不是节点对象——只有 nodeById 给对象', async () => {
    const { graph } = await multiParentGraph();
    const xId = nodeAt(graph, 'p', 3);
    const sample = [
        ...parentsOf(graph, xId), ...childrenOf(graph, xId), ...ancestorsOf(graph, xId),
        nodeAt(graph, 'p', 1), ...forkPoints(graph), ...sessionNodeIds(graph, 'p'),
    ];
    assert.ok(sample.length > 0);
    for (const v of sample) assert.equal(typeof v, 'string', `查询面吐出了非字符串：${JSON.stringify(v)}`);
    assert.equal(nodeById(graph, xId).id, xId);              // 唯一给对象的那一个
    assert.equal(nodeById(graph, xId).floor, 3);
    assert.equal(nodeById(graph, '不存在的 id'), null);
});

test('不变量：图走一遍 JSON 往返后查询照旧（真机 e2e 就是这么把它搬过线的）', async () => {
    const { graph } = await multiParentGraph();
    const revived = JSON.parse(JSON.stringify(graph));
    const xId = nodeAt(revived, 'p', 3);
    assert.deepEqual(parentsOf(revived, xId), parentsOf(graph, xId));
    assert.deepEqual(ancestorsOf(revived, xId), ancestorsOf(graph, xId));
    assert.deepEqual(forkPoints(revived), forkPoints(graph));
    assert.equal(parentsOf(revived, xId).length, 2);
});

test('不变量：节点按（层号升序, id 升序）排、边去重后按（起点层号, from, to）排', async () => {
    const { graph } = await multiParentGraph();
    const key = (n) => [n.floor, n.id];
    const listed = graph.nodes.map(key);
    assert.deepEqual(listed, [...listed].sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    const stamps = graph.edges.map((e) => `${e.from}\u0000${e.to}`);
    assert.equal(new Set(stamps).size, stamps.length, 'edges 里有重复的 from→to');
});

/* ---------------- 1. 顺序无关（钉 TL 缺陷一） ---------------- */

test('顺序无关：同一份数据换会话插入顺序 → 整张图 deepEqual、digest 相同（id ↔ 内容逐一对上）', async () => {
    // 两个会话长度不同、内容不同 —— 交换顺序对这一份数据是真变化
    const forwardInput = [
        sess('p', [msg('一'), msg('二', false, 'A'), msg('三')]),
        sess('q', [msg('一'), msg('丙', false, 'A')]),
    ];
    const reverseInput = [...forwardInput].reverse();
    // **防恒真**：两次输入的顺序**真的**不同（否则下面比的是同一份东西）
    assert.equal(forwardInput[0].ref.id, 'p');
    assert.equal(reverseInput[0].ref.id, 'q');

    const forward = await buildGraph({ sessions: forwardInput }, { log: () => {} });
    const reversed = await buildGraph({ sessions: reverseInput }, { log: () => {} });

    assert.deepEqual(reversed.graph, forward.graph);           // 整张图一模一样（含 nodes/edges/sessions）
    assert.equal(reversed.digest, forward.digest);              // 「变没变」也不因顺序而变
    for (const refId of ['p', 'q']) {
        assert.deepEqual(sessionNodeIds(reversed.graph, refId), sessionNodeIds(forward.graph, refId));
    }
    // 逐一对上「id ↔ 内容」：同一份内容在同一层拿到同一个 id（跨两次建图）
    assert.equal(nodeAt(forward.graph, 'p', 1), nodeAt(reversed.graph, 'p', 1));
    assert.equal(await contentKeyOf(forwardInput[0].messages[2]), (await nodeById(forward.graph, nodeAt(forward.graph, 'p', 3))).contentKey);
    // **永久关掉「按遇到顺序发号」这一类变异**（复检 F2 的补钉）：id 必须是身份
    // `(层号, 内容指纹)` 算出来的。本组的能力边界见文件头「顺序无关」那条——
    // 只有**忠实复现 TL 机制**的变异（建图时按本次首次遇到顺序发号）才会让本组变红。
    for (const n of [...forward.graph.nodes, ...reversed.graph.nodes]) {
        assert.equal(n.id, nodeIdOf(n.floor, n.contentKey), `id 不是由 (层号, 内容) 算出来的：${n.id}`);
    }
});

test('顺序无关（对照组）：只改一条正文 → id 集合必须不同（证明上一条有能力变红）', async () => {
    const base = [sess('p', [msg('一'), msg('二', false, 'A'), msg('三')]), sess('q', [msg('一'), msg('丙', false, 'A')])];
    const edited = [sess('p', [msg('一'), msg('二', false, 'A'), msg('三改')]), sess('q', [msg('一'), msg('丙', false, 'A')])];
    const a = await buildGraph({ sessions: base }, { log: () => {} });
    const b = await buildGraph({ sessions: edited }, { log: () => {} });
    assert.notDeepEqual(idsOf(b.graph), idsOf(a.graph));
    assert.equal(idsOf(a.graph).length, idsOf(b.graph).length);   // 只换了内容，没换数量
});

test('顺序无关：节点 id 只由「层号 + 内容」决定（与位置/序号/会话顺序都无关）', async () => {
    // 同一段正文在第 1 层与第 3 层 → **两个**节点（层号进身份）；两个会话里同层的同内容 → **一个**节点
    const one = sess('s1', [msg('同一句'), msg('别的', false, 'A'), msg('同一句')]);
    const two = sess('s2', [msg('同一句'), msg('别的', false, 'A'), msg('同一句')]);
    const { graph } = await buildGraph({ sessions: [one, two] }, { log: () => {} });
    const [f1, , f3] = sessionNodeIds(graph, 's1');
    assert.notEqual(f1, f3);                                  // 不同层不塌成一个节点
    assert.deepEqual(sessionNodeIds(graph, 's1'), sessionNodeIds(graph, 's2'));   // 同内容同层 = 同一串 id
    assert.equal(graph.nodes.length, 3);                      // 「同一句」@1 + 「别的」@2 + 「同一句」@3
    assert.equal(nodeById(graph, f1).floor, 1);
    assert.equal(nodeById(graph, f3).floor, 3);
    assert.equal(nodeById(graph, f1).contentKey, nodeById(graph, f3).contentKey);   // 内容同，身份仍不同（层号不同）
});

/* ---------------- 2. 共享（公共前缀零复制） ---------------- */

test('共享：同一条消息出现在两个会话 → 一个节点、sessions 两条', async () => {
    const { graph } = await multiParentGraph();
    const shared = graph.nodes.filter((n) => n.sessions.length > 1);
    assert.equal(shared.length, 2);                            // 第 1 层「一」与第 2 层「X」都被共享
    const floor1 = nodeAt(graph, 'p', 1);
    const shared1 = nodeById(graph, floor1);
    assert.deepEqual(shared1.sessions, ['p', 'q']);
    assert.equal(shared1.floor, 1);
    assert.deepEqual(sessionNodeIds(graph, 'q')[0], floor1);   // 两个会话的第一层是**同一个**节点
    assert.equal(shared1.contentKey, await contentKeyOf(msg('一')));
});

test('共享：节点数 = 消息按 (层号, 内容) 去重后的数量（与朴素参照实现逐一相等）', async () => {
    const sessions = [
        sess('p', [msg('一'), msg('二', false, 'A'), msg('三')]),
        sess('q', [msg('一'), msg('丙', false, 'A')]),
        sess('r', [msg('一'), msg('二', false, 'A'), msg('三')]),   // 与 p 一模一样 → 零新增节点
    ];
    const { graph } = await buildGraph({ sessions }, { log: () => {} });
    assert.deepEqual(idsOf(graph), await referenceIds(sessions));
    assert.equal(graph.nodes.length, 4);                       // 一@1、二@2、丙@2、三@3
    assert.equal(sessionNodeIds(graph, 'p').length, 3);         // 会话内一条不丢
    assert.equal(sessionNodeIds(graph, 'q').length, 2);
    assert.deepEqual(sessionNodeIds(graph, 'r'), sessionNodeIds(graph, 'p'));
});

test('共享：显示名不进身份（name 改了不换节点），发言方进身份', async () => {
    const s1 = sess('s1', [{ mes: '同一段正文', is_user: true, name: '我' }]);
    const s2 = sess('s2', [{ mes: '同一段正文', is_user: true, name: '改过的显示名' }]);
    const s3 = sess('s3', [{ mes: '同一段正文', is_user: false, name: '我' }]);
    const { graph } = await buildGraph({ sessions: [s1, s2, s3] }, { log: () => {} });
    assert.equal(sessionNodeIds(graph, 's1')[0], sessionNodeIds(graph, 's2')[0]);   // 显示名可改 → 同一节点
    assert.notEqual(sessionNodeIds(graph, 's1')[0], sessionNodeIds(graph, 's3')[0]); // 用户/角色是两条消息
    assert.equal(graph.nodes.length, 2);
});

test('共享：指纹的文本归一与合并层同源（去首尾空白后同一行 = 同一节点）', async () => {
    assert.equal(await contentKeyOf({ mes: ' 正文 ', is_user: true }), await contentKeyOf({ mes: '正文', is_user: true }));
    const { graph } = await buildGraph({
        sessions: [sess('s1', [msg('正文')]), sess('s2', [msg(' 正文 ')])],
    }, { log: () => {} });
    assert.equal(sessionNodeIds(graph, 's1')[0], sessionNodeIds(graph, 's2')[0]);
});

/* ---------------- 3. 多父（钉 TL 缺陷二） ---------------- */

test('多父：入边 2 条全部保留——parentsOf 两条、edges 里两条都在', async () => {
    const { graph } = await multiParentGraph();
    const xId = nodeAt(graph, 'p', 3);
    const p2 = nodeAt(graph, 'p', 2);
    const q2 = nodeAt(graph, 'q', 2);
    assert.notEqual(p2, q2);
    const parents = parentsOf(graph, xId);
    assert.equal(parents.length, 2);
    assert.deepEqual(parents, [p2, q2].sort());
    // 边数组里两条入边都在（同一 from→to 只留一条，但两个**不同**父各留各的）
    const into = graph.edges.filter((e) => e.to === xId).map((e) => e.from).sort();
    assert.deepEqual(into, [p2, q2].sort());
    assert.equal(new Set(graph.edges.map((e) => `${e.from}->${e.to}`)).size, graph.edges.length);
});

test('多父：ancestorsOf 两条父路径都回溯（各自的独占祖先都在），层号降序去重', async () => {
    const { graph } = await multiParentGraph();
    const xId = nodeAt(graph, 'p', 3);
    const p2 = nodeAt(graph, 'p', 2);
    const q2 = nodeAt(graph, 'q', 2);
    const p1 = nodeAt(graph, 'p', 1);                          // 两条路径的公共祖先
    const ancestors = ancestorsOf(graph, xId);
    assert.deepEqual(ancestors, [p2, q2].sort().concat(p1));    // 层号降序：第 2 层两个（id 升序），第 1 层一个
    assert.equal(ancestors.includes(p2), true, 'm2 那条父路径没回溯到');
    assert.equal(ancestors.includes(q2), true, 'm3 那条父路径没回溯到');
    // 只留一条父边的实现会正好少一个（这就是 TL 的 `incomingEdgeMap` 症状）
    assert.equal(ancestors.length, 3);
    assert.deepEqual(ancestorsOf(graph, p1), []);               // 根没有祖先
});

test('多父：出边同理全留——分叉点有两支，forkPoints 一个不落', async () => {
    const { graph } = await multiParentGraph();
    const p1 = nodeAt(graph, 'p', 1);
    // 第 1 层「一」有两条出边：p → p2、p → q2
    assert.deepEqual(childrenOf(graph, p1), [nodeAt(graph, 'p', 2), nodeAt(graph, 'q', 2)].sort());
    assert.deepEqual(forkPoints(graph), [p1]);
    assert.deepEqual(childrenOf(graph, nodeAt(graph, 'p', 3)), []);   // X 是叶
});

test('多父：一个节点两条入边（两个会话各来一条）时也一条不丢', async () => {
    // C 与 D 同在第 3 层，且都以 p1 / p2（第 2 层）为父
    const sessions = [
        sess('s1', [msg('根'), msg('父甲', false, 'A'), msg('子C')]),
        sess('s2', [msg('根'), msg('父乙', false, 'A'), msg('子C')]),
        sess('s3', [msg('根'), msg('父甲', false, 'A'), msg('子D')]),
        sess('s4', [msg('根'), msg('父乙', false, 'A'), msg('子D')]),
    ];
    const { graph } = await buildGraph({ sessions }, { log: () => {} });
    const cId = sessionNodeIds(graph, 's1')[2];
    const dId = sessionNodeIds(graph, 's3')[2];
    assert.equal(parentsOf(graph, cId).length, 2);
    assert.equal(parentsOf(graph, dId).length, 2);
    assert.equal(graph.edges.filter((e) => e.to === cId).length, 2);
    assert.equal(graph.edges.filter((e) => e.to === dId).length, 2);
    assert.deepEqual(ancestorsOf(graph, cId), [
        sessionNodeIds(graph, 's1')[1], sessionNodeIds(graph, 's2')[1],
    ].sort().concat(sessionNodeIds(graph, 's1')[0]));
});

/* ---------------- 4. 失效真读（钉 TL 缺陷三） ---------------- */

test('失效：未改 → changed:false 且**引用相等**地复用 prev.graph（重建一个等价对象是红的）', async () => {
    const sessions = () => [sess('p', [msg('一'), msg('二', false, 'A')]), sess('q', [msg('一')])];
    const first = await buildGraph({ sessions: sessions() }, { log: () => {} });
    assert.equal(first.changed, true);                          // 没有 prev = 必须算「变了」

    const again = await buildGraph({ sessions: sessions() }, { prev: first, log: () => {} });
    assert.equal(again.changed, false);
    assert.equal(again.digest, first.digest);
    assert.equal(again.graph, first.graph);                     // **同一个对象**，不是「等价的新对象」
    assert.deepEqual(again.graph, first.graph);
});

test('失效：改一条**同长度**正文 → changed:true、digest 变、图也不同（只比行数/只写不读必红）', async () => {
    const before = [sess('p', [msg('一二三'), msg('四五六', false, 'A')]), sess('q', [msg('一二三')])];
    const after = [sess('p', [msg('一二三'), msg('四**六', false, 'A')]), sess('q', [msg('一二三')])];
    const a = await buildGraph({ sessions: before }, { log: () => {} });
    const b = await buildGraph({ sessions: after }, { prev: a, log: () => {} });
    assert.equal(b.changed, true);
    assert.notEqual(b.digest, a.digest);
    assert.notEqual(b.graph, a.graph);                          // 变了就不能把旧图发回来
    assert.notDeepEqual(idsOf(b.graph), idsOf(a.graph));
    // 行数完全没变（钉住「不能只看行数/尺寸」）——TL 的四元组只写不读就是这一类
    assert.equal(a.graph.nodes.length, b.graph.nodes.length);
});

test('失效：只换会话顺序 → changed:false（顺序不进指纹，与节点 id 同一条纪律）', async () => {
    const forward = [sess('p', [msg('一'), msg('二', false, 'A')]), sess('q', [msg('一')])];
    const reversed = [...forward].reverse();
    const a = await buildGraph({ sessions: forward }, { log: () => {} });
    const b = await buildGraph({ sessions: reversed }, { prev: a, log: () => {} });
    assert.equal(b.changed, false);
    assert.equal(b.graph, a.graph);
});

test('失效：行数变 / 会话增删 / 版本号变 → 都算「变了」', async () => {
    const base = [sess('p', [msg('一'), msg('二', false, 'A')], { integrity: 'c-1' })];
    const a = await buildGraph({ sessions: base }, { log: () => {} });

    const cases = [
        ['追加一条', [sess('p', [msg('一'), msg('二', false, 'A'), msg('三')], { integrity: 'c-1' })]],
        ['删掉一条', [sess('p', [msg('一')], { integrity: 'c-1' })]],
        ['多一个会话', [sess('p', [msg('一'), msg('二', false, 'A')], { integrity: 'c-1' }), sess('q', [msg('一')])]],
        ['会话被清空', [sess('p', [], { integrity: 'c-1' })]],
        // 库源版本号变了（宿主写了一次）：图一样，但**输入**确实变了 —— design §4 把 integrity 列为信号
        ['版本号变（图结构不变）', [sess('p', [msg('一'), msg('二', false, 'A')], { integrity: 'c-2' })]],
    ];
    for (const [label, sessions] of cases) {
        const b = await buildGraph({ sessions }, { prev: a, log: () => {} });
        assert.equal(b.changed, true, `${label}：应当判为变了`);
        assert.notEqual(b.digest, a.digest, `${label}：digest 应当变`);
        assert.notEqual(b.graph, a.graph, `${label}：不应复用旧图`);
    }
});

test('失效：版本号数字形态与字符串形态同值（跟着 core/integrity.js 的归一走）', async () => {
    const a = await buildGraph({ sessions: [sess('p', [msg('一')], { integrity: 1 })] }, { log: () => {} });
    const b = await buildGraph({ sessions: [sess('p', [msg('一')], { integrity: '1' })] }, { prev: a, log: () => {} });
    assert.equal(b.changed, false, '1 与 "1" 是同一个版本号（normIntegrity 单点）');
});

test('失效：同键同一份消息、只改 ref 元信息 → changed:true（指纹必须覆盖整份 ref，复检 F1）', async () => {
    // 图里 `sessions[].ref` 存的是**整份 ref**，指纹就必须覆盖它；否则「同键同消息、只有
    // ref 元信息变了」会判成 changed:false 却发回带旧 ref 的图 ——「digest 相同 ⇒ 图相同」不成立
    const messages = [msg('一'), msg('二', false, 'A')];
    const base = sess('p', messages);
    const a = await buildGraph({ sessions: [base] }, { log: () => {} });
    const cases = [
        ['name', '改过的家族名', '家族改名'],
        ['kind', 'family-member', '随导入入库变（chat → 家族键）'],
        ['origin', 'library', '换来源（file ↔ library）'],
        ['characterId', 42, '绑定角色变'],
    ];
    for (const [field, value, label] of cases) {
        const b = await buildGraph({ sessions: [{ ...base, ref: { ...base.ref, [field]: value } }] }, { prev: a, log: () => {} });
        assert.equal(b.changed, true, `${field} 变（${label}）：应当判为「变了」`);
        assert.notEqual(b.digest, a.digest, `${field} 变（${label}）：digest 应当变`);
        assert.notEqual(b.graph, a.graph, `${field} 变（${label}）：不许复用旧图（旧图里带的是旧 ref）`);
        assert.equal(b.graph.sessions[0].ref[field], value, `${field} 变（${label}）：发回的图里是新 ref`);
        // 消息面一个都没变（差异只来自 ref 元信息，不是消息也动了）
        assert.deepEqual(sessionNodeIds(b.graph, 'p'), sessionNodeIds(a.graph, 'p'));
    }
});

test('失效：inputs.branches 不影响图，也不进指纹（不许造成无谓重建）', async () => {
    const sessions = [sess('p', [msg('一')])];
    const a = await buildGraph({ sessions }, { log: () => {} });
    const b = await buildGraph({
        sessions, branches: [{ familyId: 'f1', chatKey: 'p', name: 'p', model: { active_branch: 'b1', branches: [], groups: {} } }],
    }, { prev: a, log: () => {} });
    assert.equal(b.changed, false);
    assert.equal(b.graph, a.graph);
});

test('失效：createGraphCache —— 未改复用、invalidate() 后必变、peek() 跟着走', async () => {
    const cache = createGraphCache({ log: () => {} });
    const sessions = () => [sess('p', [msg('一'), msg('二', false, 'A')])];
    assert.equal(cache.peek(), null);                            // 还没建过

    const a = await cache.build({ sessions: sessions() });
    assert.equal(a.changed, true);
    const peeked = cache.peek();
    assert.equal(peeked.digest, a.digest);
    assert.equal(peeked.graph, a.graph);                         // peek 不重读数据源

    const b = await cache.build({ sessions: sessions() });
    assert.equal(b.changed, false);
    assert.equal(b.graph, a.graph);

    cache.invalidate();                                          // 宿主事件到达（聊天变更/切换/删除）
    assert.equal(cache.peek(), null);
    const c = await cache.build({ sessions: sessions() });
    assert.equal(c.changed, true, '失效之后必须先报「变了」');
    assert.notEqual(c.graph, a.graph);
});

/* ---------------- 5. LCA ---------------- */

test('LCA：同节点 / 直接父子（两个方向）/ 自己与祖先', async () => {
    const { graph } = await multiParentGraph();
    const xId = nodeAt(graph, 'p', 3);
    const p2 = nodeAt(graph, 'p', 2);
    const p1 = nodeAt(graph, 'p', 1);
    assert.equal(locateLCA(graph, xId, xId), xId);               // 同节点
    assert.equal(locateLCA(graph, p2, xId), p2);                 // 直接父子（父在前）
    assert.equal(locateLCA(graph, xId, p2), p2);                 // 同一对（子在前，对称）
    assert.equal(locateLCA(graph, p1, xId), p1);                 // 隔代的祖先也是它的公共祖先
});

test('LCA：多父 —— 两条路径合一到公共祖先（不是「只沿一条父边」的那条路）', async () => {
    const { graph } = await multiParentGraph();
    const p2 = nodeAt(graph, 'p', 2);
    const q2 = nodeAt(graph, 'q', 2);
    const p1 = nodeAt(graph, 'p', 1);
    assert.equal(locateLCA(graph, p2, q2), p1);                  // 两个父的 LCA = 它们共享的根
    assert.equal(locateLCA(graph, p2, nodeAt(graph, 'p', 3)), p2);
});

test('LCA：无公共祖先 → null；不在图里的 id → null', async () => {
    const far = sess('far', [msg('另一条链', false, 'B'), msg('再接一句', false, 'B')]);
    const { graph } = await multiParentGraph();
    const { graph: mixed } = await buildGraph({
        sessions: [sess('p', [msg('一'), msg('二', false, 'A')]), far], log: () => {},
    });
    assert.equal(locateLCA(mixed, nodeAt(mixed, 'p', 1), nodeAt(mixed, 'far', 1)), null);
    assert.equal(locateLCA(graph, '不存在的 id', nodeAt(graph, 'p', 1)), null);
    assert.equal(locateLCA(graph, nodeAt(graph, 'p', 1), '不存在的 id'), null);
    assert.equal(locateLCA(null, 'a', 'b'), null);
});

test('LCA：跨会话 —— 两个会话共享前缀后各自分叉，LCA = 共享前缀的最后一个节点', async () => {
    // 分叉点在共享前缀的第 2 层之后：s1 走「左」，s2 走「右」
    const { graph } = await buildGraph({
        sessions: [
            sess('s1', [msg('一'), msg('二', false, 'A'), msg('左')]),
            sess('s2', [msg('一'), msg('二', false, 'A'), msg('右')]),
        ],
    }, { log: () => {} });
    const left = nodeAt(graph, 's1', 3);
    const right = nodeAt(graph, 's2', 3);
    assert.equal(locateLCA(graph, left, right), nodeAt(graph, 's1', 2));   // 两档的共用分叉点
    assert.equal(locateLCA(graph, left, nodeAt(graph, 's1', 1)), nodeAt(graph, 's1', 1));
    assert.deepEqual(forkPoints(graph), [nodeAt(graph, 's1', 2)]);          // 分叉点正是这个共享节点
});

test('LCA：同层并列时给一个确定的答案（层号最大优先，同层取 id 升序最小）', async () => {
    const sessions = [
        sess('s1', [msg('根'), msg('父甲', false, 'A'), msg('子C')]),
        sess('s2', [msg('根'), msg('父乙', false, 'B'), msg('子C')]),
        sess('s3', [msg('根'), msg('父甲', false, 'A'), msg('子D')]),
        sess('s4', [msg('根'), msg('父乙', false, 'B'), msg('子D')]),
    ];
    const { graph } = await buildGraph({ sessions }, { log: () => {} });
    const cId = sessionNodeIds(graph, 's1')[2];
    const dId = sessionNodeIds(graph, 's3')[2];
    const tied = [sessionNodeIds(graph, 's1')[1], sessionNodeIds(graph, 's2')[1]].sort();
    assert.equal(locateLCA(graph, cId, dId), tied[0]);                   // 稳定可复现
    assert.equal(locateLCA(graph, dId, cId), tied[0]);                   // 参数顺序不改变答案
});

/* ---------------- 6. 边界 ---------------- */

test('边界：空输入 / 非输入 → 空图 + 只有自述，不抛', async () => {
    // 五种「没有会话」的形态：全都要安静地给一张空图
    for (const inputs of [undefined, null, {}, { sessions: [] }, { sessions: '不是数组' }]) {
        const out = await buildGraph(inputs, { log: () => {} });
        assert.deepEqual(out.graph.nodes, []);
        assert.deepEqual(out.graph.edges, []);
        assert.deepEqual(out.graph.sessions, []);
        assert.equal(typeof out.digest, 'string');
        assert.ok(out.digest.length > 0);
        assert.equal(out.notes.length, 1, `notes 只该有自述：${JSON.stringify(out.notes)}`);
        assert.match(out.notes[0], /^建图（B2）/);
    }
    // 会话数组里有 null 不算「空输入」：认不出它 → 记一条（见下一条降级用例）
    const withNull = await buildGraph({ sessions: [null] }, { log: () => {} });
    assert.deepEqual(withNull.graph.nodes, []);
    assert.equal(withNull.notes.length, 2);
    // 空输入也有指纹（同一个空 → 同一个 digest；不同输入 → 不同 digest）
    const empty1 = await buildGraph({ sessions: [] }, { log: () => {} });
    const empty2 = await buildGraph({}, { log: () => {} });
    assert.equal(empty1.digest, empty2.digest);
    assert.notEqual(empty1.digest, (await buildGraph({ sessions: [sess('p', [msg('一')])] }, { log: () => {} })).digest);
});

test('边界：单会话单消息 → 1 节点 0 边 0 分叉点', async () => {
    const out = await buildGraph({ sessions: [sess('solo', [msg('只有一句')])] }, { log: () => {} });
    assert.equal(out.graph.nodes.length, 1);
    assert.deepEqual(out.graph.edges, []);
    assert.deepEqual(out.graph.sessions.map((s) => s.ref.id), ['solo']);
    assert.equal(sessionNodeIds(out.graph, 'solo').length, 1);
    assert.deepEqual(forkPoints(out.graph), []);
    assert.deepEqual(parentsOf(out.graph, out.graph.nodes[0].id), []);
    assert.deepEqual(childrenOf(out.graph, out.graph.nodes[0].id), []);
    assert.deepEqual(ancestorsOf(out.graph, out.graph.nodes[0].id), []);
    assert.equal(out.notes.length, 1);                            // 干净数据不该报缺项
});

test('边界：会话内的空消息列表 → 进图（会话在列表里）但 0 节点', async () => {
    const out = await buildGraph({ sessions: [sess('empty', [])] }, { log: () => {} });
    assert.deepEqual(out.graph.nodes, []);
    assert.deepEqual(out.graph.sessions.map((s) => s.ref.id), ['empty']);
    assert.deepEqual(sessionNodeIds(out.graph, 'empty'), []);
    assert.equal(out.notes.length, 1);
});

test('边界：降级 —— messages 不是数组 / 认不出 ref / 同 id 两份 / 字段读爆 → 该会话不进图 + note + 日志，其余照建', async () => {
    const good = sess('good', [msg('一'), msg('二', false, 'A')]);
    const notArray = { ref: { id: 'notArray', key: 'notArray' }, messages: 'oops' };
    const noRef = { header: {}, messages: [msg('没人认领')] };
    const duplicate = sess('good', [msg('重复的一份')]);            // 与 good 同 id
    // **防御分支：B1 契约保证不会出现的形状**（复检 F4）—— `messages` 是 `core/source/normalize.js`
    // 从 `JSON.parse` 的普通对象 `structuredClone` 出来的，**不会有**会抛异常的取值器（这里手工造）
    const boomMsg = { is_user: false };
    Object.defineProperty(boomMsg, 'mes', { get() { throw new Error('坏字段'); } });
    const boom = sess('boom', [boomMsg, msg('后面还有')]);
    const lg = captureLog();

    const out = await buildGraph({ sessions: [good, notArray, noRef, duplicate, boom] }, { log: lg.log });

    assert.deepEqual(out.graph.sessions.map((s) => s.ref.id), ['good']);   // 只有好的那份进了图
    assert.equal(out.graph.nodes.length, 2);
    // 「其余会话照建」：好的那份与单独建它时**逐一对上**（降级不污染留下的那份）
    const alone = await buildGraph({ sessions: [good] }, { log: () => {} });
    assert.deepEqual(sessionNodeIds(out.graph, 'good'), sessionNodeIds(alone.graph, 'good'));
    assert.deepEqual(out.graph.nodes, alone.graph.nodes);
    const joined = out.notes.join('|');
    assert.match(joined, /messages 不是数组/);
    assert.match(joined, /既没有 `ref\.id`/);
    assert.match(joined, /出现两次/);
    assert.match(joined, /建图失败.*坏字段/);
    assert.equal(out.notes.length, 5);                              // 自述 + 4 条降级记录
    assert.ok(lg.lines.some((m) => /坏字段/.test(m)), '降级必须留日志（L0-11）');
    // 日志前缀是**图层自己**的（复检 F5）：复用 B1 的笔记本（不改它）但换掉 `[chatfilesys-source]`，
    // 否则控制台里看起来像「数据源出问题」，把排障引到错的地方
    assert.ok(lg.lines.length > 0 && lg.lines.every((m) => m.startsWith('[chatfilesys-graph]')),
        `图层日志必须带图层自己的前缀：${JSON.stringify(lg.lines)}`);
    // 降级记录不计入「图内容」的判定之外的东西：good 之外一份都不算
    assert.equal(out.graph.nodes.some((n) => n.sessions.includes('boom')), false);
    assert.equal(out.graph.nodes.some((n) => n.sessions.includes('notArray')), false);
});

/**
 * **防御分支：B1 契约保证不会出现的形状**（复检 F4）—— `core/source/normalize.js#splitSessionRows` 已把
 * **非对象行过滤掉**（`messageFromLine` 返回 null 即跳过并计数），故真实 `inputs` 的 `messages`
 * 里不会有 null。这里手工造一行 null，只为钉住图层自己那条降级纪律：**不跳过**
 * （跳了会让后面每一条都改层号，也就改了它们的节点身份），按**空内容**入图 + 记一条 note。
 */
test('边界：坏行不是对象 → 不跳过（保住层号），按空内容入图 + 记一条', async () => {
    const lg = captureLog();
    const out = await buildGraph({ sessions: [sess('s', [msg('一'), null, msg('三')])] }, { log: lg.log });
    assert.equal(out.graph.nodes.length, 3);                        // 跳掉坏行会让「三」的层号从 3 变成 2
    assert.deepEqual(sessionNodeIds(out.graph, 's').length, 3);
    assert.equal(nodeById(out.graph, nodeAt(out.graph, 's', 3)).floor, 3);
    assert.equal(nodeById(out.graph, nodeAt(out.graph, 's', 2)).contentKey, await contentKeyOf(null));
    assert.match(out.notes.join('|'), /1 条行不是对象/);
});

/**
 * **防御分支：B1 契约保证不会出现的形状**（复检 F4）—— 两档 `refOf` 恒给 `id`（契约上 `id === key`），
 * 故「只有 key 没有 id」不会出现在真实输入里。这条只钉取键口径（`id ?? key`）本身不抛、不回退错。
 */
test('边界：会话没有 id 只有 key → 用 key 当会话 id（两档同源同值）', async () => {
    const out = await buildGraph({ sessions: [sess('只有键', [msg('一')], { fallbackKeyOnly: true })] }, { log: () => {} });
    assert.deepEqual(out.graph.sessions.map((s) => s.ref.id ?? s.ref.key), ['只有键']);
    assert.equal(sessionNodeIds(out.graph, '只有键').length, 1);
});

test('边界：查不存在的会话 / 空图查询 → 空数组，不抛', async () => {
    const { graph } = await multiParentGraph();
    assert.deepEqual(sessionNodeIds(graph, '不存在的会话'), []);
    assert.deepEqual(sessionNodeIds(graph, null), []);
    assert.deepEqual(sessionNodeIds({ nodes: [], edges: [], sessions: [] }, 'x'), []);
    assert.deepEqual(forkPoints({ nodes: [], edges: [], sessions: [] }), []);
    assert.deepEqual(ancestorsOf(undefined, 'x'), []);
    assert.deepEqual(parentsOf(null, 'x'), []);
    assert.deepEqual(childrenOf({}, 'x'), []);
});

test('边界：id 的拼装与拆解（层号可反查；非法 id → null）', async () => {
    assert.equal(nodeIdOf(3, 'abc'), '3:abc');
    assert.equal(floorOfNodeId('12:abc'), 12);
    assert.equal(floorOfNodeId('abc'), null);
    assert.equal(floorOfNodeId(''), null);
    assert.equal(floorOfNodeId(undefined), null);
    assert.equal(floorOfNodeId('x:y'), null);
    // 手上图的 id 全部可反查层号，且与节点自带 floor 一致
    const { graph } = await multiParentGraph();
    for (const n of graph.nodes) assert.equal(floorOfNodeId(n.id), n.floor);
});
