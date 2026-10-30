/**
 * C1.3 长聊天对齐单测：整数代价 0/2/3 + 线性空间分治 + 歧义标注 + 预算/取消 + Worker 协议
 *
 * 契约（design-v2.md「对齐机制与复杂度」+ implement-v2 C1.3）：
 * · 新 DP（线性空间）与旧 DP（oracle）在固定种子的小数组上**总 cost 与 n0 一致**；
 * · 多条同分路径 → **标歧义**，不伪造唯一对应；歧义的同位 MATCH 不硬并（降级 two-groups）；
 * · 10000 层稀疏插删：所有可证实未修改的消息错位后**仍共享身份**（不再被 2000 护栏拒收）；
 * · 预算耗尽 → budget-exceeded，不截断、不假装合并（floors 为空）；
 * · 取消有界（abortFlag 逐行检查）；Worker 协议 start/cancel/progress/result/error；
 *   无 Worker 时主线程分片降级，结果与同步一致；dispose 后 terminate + 置 null（L1-MR-8）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    align, alignFull, alignEx, classify, planFamilyMerge, formatPlan,
    buildDescriptors, LIMITS, COST,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/family-align.js';
import { createAlignRunner, ALIGN_MSG } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-align-worker.js';

/* ---------------- 夹具 ---------------- */

/** 合成描述符（不走去 hash 的 buildDescriptors —— oracle 只要 classify 的判据面） */
const desc = (id, extra = {}) => ({
    idx: extra.idx ?? 0,
    isUser: false,
    name: '角色',
    hash: `h#${id}`,
    len: 20,
    swipeHashes: new Set(),
    swipeId: null,
});

/** 固定种子 RNG（mulberry32）—— 结果可复现，失败能重放 */
function rng(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const totalCostOf = (path) => path.reduce((s, p) => s + p.cost, 0);
const n0Of = (path) => path.filter((p) => p.cost === COST.MATCH).length;

/* ---------------- oracle：线性空间 vs 旧全矩阵（固定种子穷举+随机） ---------------- */

test('oracle：线性空间 DP 与旧全矩阵 DP 总 cost / n0 / gaps 一致（固定种子随机 200 组）', () => {
    const rand = rng(20261031);
    for (let trial = 0; trial < 200; trial += 1) {
        const n = Math.floor(rand() * 9); // 0..8
        const m = Math.floor(rand() * 9);
        const pool = 4; // 小哈希池 → 必然出现重复模板与同分多解
        const a = Array.from({ length: n }, (_, i) => desc(Math.floor(rand() * pool), { idx: i }));
        const b = Array.from({ length: m }, (_, j) => desc(Math.floor(rand() * pool), { idx: j }));
        const full = alignFull(a, b);
        const lin = align(a, b);
        assert.equal(
            totalCostOf(lin.path), totalCostOf(full.path),
            `trial ${trial}: 总 cost 不一致 a=${JSON.stringify(a.map((d) => d.hash))} b=${JSON.stringify(b.map((d) => d.hash))}`,
        );
        assert.equal(n0Of(lin.path), n0Of(full.path), `trial ${trial}: n0 不一致`);
        assert.equal(lin.gaps, full.gaps, `trial ${trial}: gaps 不一致`);
    }
});

test('oracle：确定性 —— 同输入两次跑结果逐字节一致（L16 幂等在单元级成立）', () => {
    const a = [desc(1), desc(2), desc(3)];
    const b = [desc(2), desc(3), desc(1)];
    assert.deepEqual(align(a, b), align(a, b));
});

/* ---------------- 歧义：同分多解必须标注，不伪造唯一对应 ---------------- */

test('歧义：A/B 互为反转且各含唯一值 → 存在并列最优路径，alignEx 标注歧义楼层', () => {
    // a = [x, y]、b = [y, x]：两条 cost 相等的 optimal（头配或尾配），对应关系不唯一
    const a = [desc('x', { idx: 0 }), desc('y', { idx: 1 })];
    const b = [desc('y', { idx: 0 }), desc('x', { idx: 1 })];
    const ex = alignEx(a, b);
    assert.equal(ex.ambiguousCount > 0, true, `应检出歧义：path=${JSON.stringify(ex.path)}`);
    // 唯一路径的场景不得误报
    const c = [desc('x', { idx: 0 }), desc('y', { idx: 1 })];
    const d = [desc('x', { idx: 0 }), desc('y', { idx: 1 })];
    assert.equal(alignEx(c, d).ambiguousCount, 0);
});

test('planFamilyMerge：歧义层的同位 MATCH 降级 two-groups（不硬并，两份都留）', async () => {
    // 真并列最优构造：B 在同位放了**两条相同正文**，A 只有一条 —— 配给哪条同分（cost 都是 2），
    // 对应关系不唯一 ⇒ 该 MATCH 层必须标歧义并降级，不得伪造「唯一对应」。
    const P = (k) => ({ name: '角色', is_user: false, mes: `公共前缀第${k}层的内容足够长了吧-${k}` });
    const P6 = { name: '角色', is_user: false, mes: '同正文重复层，放在中段制造并列最优-66' };
    const a = [...Array.from({ length: 5 }, (_, i) => P(i + 1)), P6, ...Array.from({ length: 4 }, (_, i) => P(i + 7))];
    const b = [...Array.from({ length: 5 }, (_, i) => P(i + 1)), P6, structuredClone(P6), ...Array.from({ length: 4 }, (_, i) => P(i + 7))];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family', formatPlan(p));
    assert.equal(p.stats.ambiguousCount > 0, true, `应检出并列最优：${formatPlan(p)}`);
    const ambig = p.floors.filter((f) => f.ambig);
    assert.equal(ambig.length, p.stats.ambiguousCount);
    for (const f of ambig) assert.notEqual(f.kind, 'swipe-merge', `歧义层不得 swipe-merge：${JSON.stringify(f)}`);
});

/* ---------------- 预算与取消 ---------------- */

test('预算：cells 超限 → uncertain/budget-exceeded，floors 为空（不截断不假装）', async () => {
    const a = Array.from({ length: 50 }, (_, i) => ({ name: '角色', is_user: false, mes: `甲层内容-${i}-${'pad'.repeat(6)}` }));
    const b = a.slice();
    const p = await planFamilyMerge({ aRows: a, bRows: b, maxCells: 10 }); // 50×50=2500 ≫ 10
    assert.equal(p.verdict, 'uncertain');
    assert.equal(p.reason, 'budget-exceeded');
    assert.deepEqual(p.floors, []);
    assert.ok(p.stats.cells >= 2500);
});

test('取消：abortFlag 置位 → uncertain/aborted，且在有限时间内返回', async () => {
    const a = Array.from({ length: 3000 }, (_, i) => ({ name: '角色', is_user: false, mes: `内容-${i}-${'pad'.repeat(10)}` }));
    const b = a.slice();
    const abortFlag = { aborted: false };
    const t0 = Date.now();
    const promise = planFamilyMerge({ aRows: a, bRows: b, abortFlag });
    setTimeout(() => { abortFlag.aborted = true; }, 20);
    const p = await promise;
    const ms = Date.now() - t0;
    assert.equal(p.verdict, 'uncertain');
    assert.equal(p.reason, 'aborted');
    assert.deepEqual(p.floors, []);
    assert.ok(ms < 5000, `取消应在有界时间内返回，实际 ${ms}ms`);
});

test('旧 2000 层护栏已移除：2500 层相同聊天判 same-family（identical）', async () => {
    const a = Array.from({ length: 2500 }, (_, i) => ({ name: '角色', is_user: false, mes: `第${i}层：正文要够长才能当证据，所以这里补足八字以上。${i}` }));
    const p = await planFamilyMerge({ aRows: a, bRows: a.slice() });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.mode, 'identical');
});

/* ---------------- 10000 层稀疏插删（A7 的单元级实现钉） ---------------- */

test('10000 层稀疏插删：可证实未修改的消息在错位后仍共享身份（不被护栏拒收）', async () => {
    // ① 源 10000 层，每层唯一正文
    const N = 10000;
    const src = Array.from({ length: N }, (_, i) => ({ name: '角色', is_user: false, mes: `唯一正文第${i}层，八字节以上的证据文本-${i}` }));
    // ② B = A 删掉 7 个已知位 + 插入 5 个已知新层
    const delAt = new Set([100, 2000, 4000, 6000, 8000, 9500, 9999]);
    const insAt = new Map([[500, '插入层甲，唯一的正文内容-甲'], [3500, '插入层乙，唯一的正文内容-乙'], [7000, '插入层丙，唯一的正文内容-丙'], [8800, '插入层丁，唯一的正文内容-丁'], [9900, '插入层戊，唯一的正文内容-戊']]);
    const b = [];
    for (let i = 0; i < N; i += 1) {
        if (insAt.has(i)) b.push({ name: '角色', is_user: false, mes: insAt.get(i) });
        if (!delAt.has(i)) b.push(src[i]);
    }
    if (insAt.has(N)) b.push({ name: '角色', is_user: false, mes: insAt.get(N) });
    // ③ 对齐后：每个未删除的源楼层必须与其唯一对应共享身份（swipe-merge 且 aIdx/bIdx 正确）
    const p = await planFamilyMerge({ aRows: src, bRows: b });
    assert.equal(p.verdict, 'same-family', formatPlan(p));
    const shared = new Map(); // aIdx → bIdx
    for (const f of p.floors) if (f.kind === 'swipe-merge') shared.set(f.aIdx, f.bIdx);
    let checked = 0;
    let bj = 0;
    for (let i = 0; i < N; i += 1) {
        if (insAt.has(i)) bj += 1;
        if (!delAt.has(i)) {
            assert.equal(shared.get(i), bj, `源第 ${i} 层未与 B 第 ${bj} 层共享身份`);
            checked += 1;
            bj += 1;
        }
    }
    assert.ok(checked >= N - delAt.size, `应核对 ${N - delAt.size} 层，实际 ${checked}`);
});

/* ---------------- Worker 协议与主线程降级 ---------------- */

test('ALIGN_MSG 协议常量：start/cancel/progress/result/error 五种齐全', () => {
    assert.deepEqual({ ...ALIGN_MSG }, {
        START: 'start', CANCEL: 'cancel', PROGRESS: 'progress', RESULT: 'result', ERROR: 'error',
    });
});

test('无 Worker 环境：主线程分片降级跑通，结果与同步 planFamilyMerge 一致；dispose 幂等且可复用', async () => {
    const runner = createAlignRunner({ workerFactory: null }); // 显式无 Worker
    assert.equal(runner.hasWorker, false);
    const a = Array.from({ length: 60 }, (_, i) => ({ name: '角色', is_user: false, mes: `降级测试-${i}-${'pad'.repeat(6)}` }));
    const asyncPlan = await runner.run(a, a.slice(), { yieldEvery: 8 });
    const syncPlan = await planFamilyMerge({ aRows: a, bRows: a.slice() });
    assert.deepEqual(asyncPlan, syncPlan);
    runner.dispose();
    runner.dispose(); // 幂等
    const again = await runner.run(a, a.slice()); // dispose 后仍可复用（重建）
    assert.equal(again.verdict, 'same-family');
});

test('降级路径的取消有界：跑到一半置 aborted → result/error 二选一且不悬挂', async () => {
    const runner = createAlignRunner({ workerFactory: null });
    const abortFlag = { aborted: false };
    const big = Array.from({ length: 4000 }, (_, i) => ({ name: '角色', is_user: false, mes: `取消测试-${i}-${'pad'.repeat(10)}` }));
    const t0 = Date.now();
    const promise = runner.run(big, big.slice(), { abortFlag, yieldEvery: 16 });
    setTimeout(() => { abortFlag.aborted = true; }, 15);
    const plan = await promise; // runner 的约定：取消以「uncertain/aborted 计划」返回，不 reject、不悬挂
    assert.ok(Date.now() - t0 < 5000, '取消必须有界');
    assert.equal(plan.verdict, 'uncertain');
    assert.equal(plan.reason, 'aborted');
    runner.dispose();
});
