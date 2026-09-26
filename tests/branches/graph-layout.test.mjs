/**
 * graph 布局单测（B3 / AC1）：`core/graph/layout.js` + `core/graph/layout-service.js`
 *
 * 覆盖：
 * 1. **确定性**：同一张图两次布局坐标完全相同；**打乱输入顺序**后坐标仍完全相同
 *    （这条直接钉住「喂 dagre 之前必须排序」——去掉 `sortedInputs` 的排序它必红）
 * 2. **真 dagre 参与**：坐标非零、且 TB 方向下后继的 y 大于前驱（不是空壳实现）
 * 3. **边界**：空图 / 没给 dagre（= 静默降级返回 null）/ 边指向不存在的节点 / 多父不炸
 * 4. **服务的「走了哪条路」**：无 worker → `via:'main'`；worker 成功 → `via:'worker'`；
 *    worker 报错 / 超时 → 退回 `via:'main'` 且记为失效；两条都不行 → `null`（**不抛**）
 *
 * 为什么必须能断言 `via`：TL 的 worker 全程没生效却没人知道（它静默退回主线程）。
 * 这里把它变成可断言的事实，真机用例才可能守住「确实在 worker 里算」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { planLayout, clipReason, DEGRADE_REASON_MAX, LAYOUT_DEFAULTS } from '../../public/scripts/extensions/third-party/chatfilesys/core/graph/layout.js';
import { createLayoutService } from '../../public/scripts/extensions/third-party/chatfilesys/core/graph/layout-service.js';

/**
 * 加载 vendor 里的**真 dagre**——走的是「经典脚本」那条路（与浏览器 `<script>` 和 worker 内 `import`
 * 触发的 UMD 分支一致：没有 exports/module/window → `g = self`）。
 * 这样单测用的是真库，不是桩。
 */
function loadRealDagre() {
    const src = fs.readFileSync(new URL(
        '../../public/scripts/extensions/third-party/chatfilesys/vendor/dagre.js', import.meta.url), 'utf8');
    const ctx = {};
    ctx.self = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    assert.ok(ctx.dagre?.graphlib, 'vendor/dagre.js 应能在经典脚本语境下挂到 self.dagre');
    return ctx.dagre;
}

const DAGRE = loadRealDagre();

/** 一张四节点三层的图（含一个分叉：n2 有两个后继） */
const g = () => ({
    nodes: [{ id: '1:a' }, { id: '2:b' }, { id: '2:c' }, { id: '3:d' }],
    edges: [{ from: '1:a', to: '2:b' }, { from: '1:a', to: '2:c' }, { from: '2:b', to: '3:d' }],
});

/* ---------------- 1. 确定性 ---------------- */

test('布局：同一张图两次 → 坐标完全相同（确定性）', () => {
    const a = planLayout(g(), { dagre: DAGRE });
    const b = planLayout(g(), { dagre: DAGRE });
    assert.deepEqual(a.positions, b.positions);
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
});

test('布局：打乱节点与边的输入顺序 → 坐标仍完全相同（顺序归一）', () => {
    const normal = planLayout(g(), { dagre: DAGRE });
    const shuffled = {
        nodes: [...g().nodes].reverse(),
        edges: [...g().edges].reverse(),
    };
    const other = planLayout(shuffled, { dagre: DAGRE });
    assert.deepEqual(other.positions, normal.positions);
    assert.equal(other.width, normal.width);
    assert.equal(other.height, normal.height);
});

/* ---------------- 2. 真 dagre 在起作用 ---------------- */

test('布局：坐标来自真 dagre（非零、TB 下后继 y 更大）；kind 如实标 dagre', () => {
    const r = planLayout(g(), { dagre: DAGRE, direction: 'TB' });
    assert.equal(r.kind, 'dagre');
    assert.equal(r.order.length, 4);
    const p = r.positions;
    assert.ok(p['1:a'].y < p['2:b'].y, 'TB 方向下第 2 层应在第 1 层下方');
    assert.ok(p['2:b'].y < p['3:d'].y, '第 3 层应在第 2 层下方');
    assert.ok(r.width > 0 && r.height > 0);
    assert.equal(p['1:a'].width, LAYOUT_DEFAULTS.nodeWidth);
});

test('布局：换方向（LR）→ 后继 x 更大（参数真传给了 dagre）', () => {
    const r = planLayout(g(), { dagre: DAGRE, direction: 'LR' });
    assert.ok(r.positions['1:a'].x < r.positions['2:b'].x);
});

/* ---------------- 3. 边界与静默降级 ---------------- */

test('布局：空图 → 空坐标 + 尺寸 0（不是 null）', () => {
    assert.deepEqual(planLayout({ nodes: [], edges: [] }, { dagre: DAGRE }),
        { positions: {}, width: 0, height: 0, order: [], kind: 'dagre' });
});

test('布局：没给 dagre → 回落到迭代分层（kind=layered），不是失败', () => {
    const a = planLayout(g(), {});
    const b = planLayout(g());
    assert.equal(a.kind, 'layered');
    assert.equal(Object.keys(a.positions).length, 4);
    assert.deepEqual(a.positions, b.positions);
});

test('布局：边指向不存在的节点 → 跳过该边，不炸', () => {
    const r = planLayout({
        nodes: [{ id: '1:a' }],
        edges: [{ from: '1:a', to: '9:不存在' }, { from: '9:不存在', to: '1:a' }],
    }, { dagre: DAGRE });
    assert.deepEqual(Object.keys(r.positions), ['1:a']);
});

test('布局：多父节点不炸，且重复边只喂一次', () => {
    const r = planLayout({
        nodes: [{ id: '1:a' }, { id: '1:b' }, { id: '2:c' }],
        edges: [
            { from: '1:a', to: '2:c' }, { from: '1:b', to: '2:c' },
            { from: '1:a', to: '2:c' },                     // 重复：应被去重
        ],
    }, { dagre: DAGRE });
    assert.equal(Object.keys(r.positions).length, 3);
    assert.ok(Number.isFinite(r.positions['2:c'].x));
});

test('布局：超长链（1200）不炸、回落 layered、且单调下行（真机长链爆栈的回归钉子）', () => {
    const n = 1200;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const r = planLayout({ nodes, edges }, { dagre: DAGRE, direction: 'TB' });
    assert.ok(r, '长链也必须给出布局');
    assert.equal(Object.keys(r.positions).length, n);
    assert.equal(r.positions.n0.y < r.positions.n1.y, true);
    assert.equal(r.positions.n1198.y < r.positions.n1199.y, true, '链尾也必须有坐标');
    // 长链在 dagre 下会爆栈 → 必须回落；若哪天 dagre 能算了，这条会如实变成 dagre（那时也 OK）
    assert.ok(['dagre', 'layered'].includes(r.kind));
    // 确定性：同一份输入两次一致
    assert.deepEqual(planLayout({ nodes, edges }, { dagre: DAGRE }).positions, r.positions);
});

test('布局：迭代分层（layered）的确定性与层次正确性', () => {
    const a = planLayout(g(), {});                       // 无 dagre → layered
    const shuffled = { nodes: [...g().nodes].reverse(), edges: [...g().edges].reverse() };
    const b = planLayout(shuffled, {});
    assert.deepEqual(b.positions, a.positions, 'layered 也必须与输入顺序无关');
    assert.ok(a.positions['1:a'].y < a.positions['2:b'].y);
    assert.ok(a.positions['2:b'].y < a.positions['3:d'].y);
});

/* ---------------- 3b. 回落不静默（R6） ---------------- */

/**
 * 会抛的 dagre 桩：`dfs` 爆栈在真机上是常态（真实聊天的图就是长链），但依赖真栈深度做单测
 * 就变成"看机器脸色"——这里直接让 `layout` 抛，把「抛了之后必须留下原因」这件事钉死。
 */
const BOOM = 'RangeError: Maximum call stack size exceeded at dfs (dagre.js:2688)';
const throwingDagre = () => ({
    graphlib: DAGRE.graphlib,
    layout: () => { throw new RangeError(BOOM); },
});

test('布局：dagre 抛错 → 回落 layered，且真原因挂在结果上（不许只剩 kind）', () => {
    let seen = null;
    const r = planLayout(g(), { dagre: throwingDagre(), onError: (e) => { seen = e; } });
    assert.equal(r.kind, 'layered');
    assert.equal(Object.keys(r.positions).length, 4, '回落后仍必须给出全部坐标');
    assert.ok(seen instanceof RangeError, 'onError 仍应收到原始异常对象');
    assert.equal(r.degraded?.from, 'dagre');
    assert.equal(r.degraded?.to, 'layered');
    assert.match(r.degraded?.reason ?? '', /Maximum call stack size exceeded/);
});

test('布局：没抛错时**不**出现 degraded（别把正常路径也标成降级）', () => {
    assert.equal(planLayout(g(), { dagre: DAGRE }).degraded, undefined);
});

test('布局：超长栈的原因被截断，但**截断这件事写明白了**（真机爆栈的栈帧重复几百次）', () => {
    const long = `RangeError: Maximum call stack size exceeded\n${'    at dfs (dagre.js:2688:18)\n'.repeat(400)}`;
    const r = planLayout(g(), {
        dagre: { graphlib: DAGRE.graphlib, layout: () => { throw new RangeError(long); } },
    });
    const reason = r.degraded.reason;
    assert.ok(reason.length < 700, `原因必须被截短（实际 ${reason.length}）`);
    assert.match(reason, /Maximum call stack size exceeded/, '可判因的首行必须保住');
    assert.match(reason, /已截断/, '截断本身也要写明，不许悄悄切掉');
    // 申报的原始长度必须**大于**实际返回的长度（否则「已截断」那句话是假的）
    const declared = Number(reason.match(/共 (\d+) 字/)?.[1]);
    assert.ok(Number.isFinite(declared) && declared > reason.length,
        `要说明原始长度（申报=${declared} 实际=${reason.length}）`);
});

test('布局：clipReason 不截断短消息（短原因保持原样）', () => {
    assert.equal(clipReason('boom'), 'boom');
    assert.equal(clipReason('x'.repeat(DEGRADE_REASON_MAX)), 'x'.repeat(DEGRADE_REASON_MAX));
    assert.match(clipReason('x'.repeat(DEGRADE_REASON_MAX + 1)), /已截断）$/);
});

/* ---------------- 4. 服务：走了哪条路（TL 坑的守卫） ---------------- */

/** 假 worker：按 mode 决定「算出来回发」/「撑不住回落」/「超时不回」/「抛 onerror」 */
function makeFakeWorker(mode) {
    return class Fake {
        constructor() { this.mode = mode; this.onmessage = null; this.onerror = null; this.terminated = false; }
        postMessage(msg) {
            if (mode === 'silent') return;                       // 不回 → 触发超时
            if (mode === 'error') {
                setTimeout(() => this.onerror?.({ message: '模拟 worker 脚本加载失败' }), 0);
                return;
            }
            setTimeout(() => {
                // degrade 模式：worker 里那条真路径（dagre 抛 → 回落 layered，原因随结果回去）
                const r = planLayout(msg.graph, { ...(msg.options ?? {}),
                    dagre: mode === 'degrade' ? throwingDagre() : DAGRE });
                this.onmessage?.({ data: r
                    ? { id: msg.id, ok: true, result: r }
                    : { id: msg.id, ok: false, reason: '空图' } });
            }, 0);
        }
        terminate() { this.terminated = true; }
    };
}

test('布局服务：不给 workerUrl → 走主线程，via=main', async () => {
    const s = createLayoutService({ dagre: DAGRE });
    const r = await s.layout(g());
    assert.equal(r.via, 'main');
    assert.equal(s.describe().workerOk, 0);
});

test('布局服务：worker 成功 → via=worker（不是退回主线程）', async () => {
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', workerFactory: () => new (makeFakeWorker('ok'))() });
    const r = await s.layout(g());
    assert.equal(r.via, 'worker');
    assert.equal(s.describe().workerOk, 1);
    assert.equal(s.describe().mainOk, 0, 'worker 成功时不应再走主线程');
});

test('布局服务：worker 报错 → 退回主线程、记为失效、后续不再重试 worker', async () => {
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', workerFactory: () => new (makeFakeWorker('error'))() });
    const r1 = await s.layout(g());
    assert.equal(r1.via, 'main');
    assert.equal(s.describe().workerFail, 1);
    assert.equal(s.describe().workerDead, true);
    const r2 = await s.layout(g());
    assert.equal(r2.via, 'main');
    assert.equal(s.describe().workerFail, 1, 'worker 判死后不应再尝试');
});

test('布局服务：worker 超时 → 退回主线程（不挂死）', async () => {
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', timeoutMs: 30,
        workerFactory: () => new (makeFakeWorker('silent'))() });
    const r = await s.layout(g());
    assert.equal(r.via, 'main');
    assert.equal(s.describe().workerFail, 1);
    assert.match(s.describe().lastReason, /超时/);
});

test('布局服务：worker 不可用且没有主线程 dagre → 仍给出布局（回落迭代分层），via 如实标 main', async () => {
    const s = createLayoutService({ workerUrl: 'fake://w', timeoutMs: 30,
        workerFactory: () => new (makeFakeWorker('silent'))() });
    const r = await s.layout(g());
    assert.ok(r, '两条路都拿不到 dagre 时仍应有布局（迭代分层兜底）');
    assert.equal(r.via, 'main');
    assert.equal(r.kind, 'layered');
});

test('布局服务：dispose 会终止 worker 且可重复调用', async () => {
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', workerFactory: () => new (makeFakeWorker('ok'))() });
    await s.layout(g());
    s.dispose();
    s.dispose();
    const after = await s.layout(g());
    assert.equal(after.via, 'main', 'dispose 后应退回主线程（不再偷偷拉起 worker）');
});

/* ---------------- 5. 回落不静默：worker 里出事，调用方必须知道（R6） ---------------- */

test('布局服务：worker 里 dagre 撑不住 → 原因随回执回到调用方（不是只剩 kind=layered）', async () => {
    const logged = [];
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', log: (...a) => logged.push(a.join(' ')),
        workerFactory: () => new (makeFakeWorker('degrade'))() });
    const r = await s.layout(g());
    assert.equal(r.via, 'worker');
    assert.equal(r.kind, 'layered');
    assert.equal(Object.keys(r.positions).length, 4);
    assert.match(r.degraded?.reason ?? '', /Maximum call stack size exceeded/,
        '真机形态：worker 内没有人能接 onError → 原因必须挂在结果上带回来');
    const d = s.describe();
    assert.equal(d.degraded, 1, '回落要计数（否则它会被当成正常路径）');
    assert.equal(d.workerOk, 1, '回落不是失败：worker 这条路本身是成功的');
    assert.match(d.lastDegrade ?? '', /Maximum call stack size exceeded/);
    assert.ok(logged.some((l) => /回落迭代分层/.test(l)), '回落必须进日志');
});

test('布局服务：主线程那条路同样如实回报回落原因（via=main）', async () => {
    const s = createLayoutService({ dagre: throwingDagre() });
    const r = await s.layout(g());
    assert.equal(r.via, 'main');
    assert.equal(r.kind, 'layered');
    assert.match(r.degraded?.reason ?? '', /Maximum call stack size exceeded/);
    assert.equal(s.describe().degraded, 1);
});

test('布局服务：正常跑通时不记回落（degraded 保持 0，别虚报）', async () => {
    const s = createLayoutService({ dagre: DAGRE, workerUrl: 'fake://w', workerFactory: () => new (makeFakeWorker('ok'))() });
    await s.layout(g());
    const d = s.describe();
    assert.equal(d.degraded, 0);
    assert.equal(d.lastDegrade, null);
});
