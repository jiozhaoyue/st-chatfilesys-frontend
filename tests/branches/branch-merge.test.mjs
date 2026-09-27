/**
 * 分支合并单测：`core/branch-merge.js`
 *
 * 合并是本仓**唯一会改动「哪些组属于哪条分支」的写操作之一**，而且它的结果直接落成一条新分支
 * ——错了就是「用户的两条历史被缝成一条坏的」。故这里把三条硬性质各钉几条：
 *
 * 1. **纯**：`planMerge` 不改输入模型（跑完 `deepEqual` 原模型）——它是「规划」，不是「执行」
 * 2. **公共前缀不重建组**：前缀处必须**沿用同一个 gid**（新建组会让共享前缀失去零复制）
 * 3. **冲突可判且可读**：两侧都有内容且组不同 → 一条冲突记录，带**字数**（不带正文）
 * 4. **只取并集，不丢边**：一侧独有的层全部保留（「把 B 的尾巴接过来」就是这条的推论）
 * 5. **边界**：同一条分支自合并 / 分支不存在 / 模型不可用 → `ok:false` + 人话原因（不抛）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    planMerge, commonPrefixLength, describeMerge, defaultMergeName,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/branch-merge.js';

/* ---------------- 夹具 ---------------- */

/** 一个组（只有合并判定关心的字段；`variants` 给字数用） */
const grp = (id, floor, owner, text = '内容') => ({
    id, floor, owner, active: 0, variants: [{ name: 'X', is_user: false, mes: text }],
});

/**
 * 三条分支：
 * - `main` 1..4（g1..g4）
 * - `A`   1..4（前两层与 main 共享 g1/g2，第 3、4 层是自己的 g5/g6）
 * - `B`   1..3（前两层共享，第 3 层是自己的 g7）
 * 于是 A 与 B 的公共前缀 = 2，第 3 层是**冲突**，第 4 层只有 A 有。
 */
function mkModel() {
    return {
        active_branch: 'A',
        branches: [
            { id: 'main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4' } },
            { id: 'A', name: 'A线', is_default: false, fork_base: 2, path: { 1: 'g1', 2: 'g2', 3: 'g5', 4: 'g6' } },
            { id: 'B', name: 'B线', is_default: false, fork_base: 2, path: { 1: 'g1', 2: 'g2', 3: 'g7' } },
        ],
        groups: {
            g5: grp('g5', 3, 'A', 'A 的第三层'),
            g6: grp('g6', 4, 'A', 'A 的第四层'),
            g7: grp('g7', 3, 'B', 'B 的第三层比 A 短'),
        },
    };
}

/** 字数函数（夹具里 = 正文长度；真实调用方从 body / groups 两处取） */
const charsOf = (model) => (floor, gid) => {
    const g = model.groups[gid];
    return g?.variants?.[0]?.mes?.length ?? 0;
};

/* ---------------- 1. 纯 ---------------- */

test('合并：planMerge 不改输入模型（它是规划，不是执行）', () => {
    const m = mkModel();
    const before = JSON.parse(JSON.stringify(m));
    planMerge(m, { aId: 'A', bId: 'B', charsOf: charsOf(m) });
    assert.deepEqual(m, before, '规划过程不能碰模型');
});

/* ---------------- 2/4. 前缀与并集 ---------------- */

test('合并：公共前缀**沿用同一个 gid**（不许重建组——否则共享前缀失去零复制）', () => {
    const m = mkModel();
    const p = planMerge(m, { aId: 'A', bId: 'B', charsOf: charsOf(m) });
    assert.equal(p.commonFloor, 2);
    assert.equal(p.path[1], 'g1');
    assert.equal(p.path[2], 'g2');
    const sharedSteps = p.steps.filter((s) => s.side === 'shared' && s.floor <= 2);
    assert.equal(sharedSteps.length, 2);
    for (const s of sharedSteps) assert.ok(String(s.gid).startsWith('g'), '前缀步的 gid 必须是原有组');
});

test('合并：一侧独有的层全部保留（「把 B 的尾巴接过来」是这条的推论）', () => {
    const m = mkModel();
    // A 独有第 4 层；B 只有三层。
    const p = planMerge(m, { aId: 'A', bId: 'B', choices: { 3: 'b' }, charsOf: charsOf(m) });
    assert.equal(p.path[4], 'g6', 'A 独有的第 4 层必须保留');
    assert.equal(p.path[3], 'g7', '选了 B 侧 ⇒ 第 3 层用 B 的组');
    assert.equal(p.stats.floors, 4);
});

test('合并：B 比 A 长时，B 多出来的尾巴接上（并集的另一半）', () => {
    const m = mkModel();
    // 给 B 加一层（只有 B 有）
    m.branches.find((b) => b.id === 'B').path[4] = 'g8';
    m.groups.g8 = grp('g8', 4, 'B', 'B 独有的第四层');
    const p = planMerge(m, { aId: 'A', bId: 'B', choices: { 3: 'a' }, charsOf: charsOf(m) });
    // 第 4 层两边都有（g6 vs g8）⇒ 也是冲突，默认取 a
    assert.equal(p.stats.conflicts, 2, '第 3、4 层两边内容都不同 ⇒ 两条冲突');
    const p2 = planMerge(m, { aId: 'A', bId: 'B', choices: { 3: 'a', 4: 'b' }, charsOf: charsOf(m) });
    assert.equal(p2.path[4], 'g8', '选了 B 侧 ⇒ 接上 B 的尾巴');
});

/* ---------------- 3. 冲突可判可读 ---------------- */

test('合并：冲突记录带层号与两侧字数，**不带正文**', () => {
    const m = mkModel();
    const p = planMerge(m, { aId: 'A', bId: 'B', charsOf: charsOf(m) });
    assert.equal(p.conflicts.length, 1);
    const c = p.conflicts[0];
    assert.equal(c.floor, 3);
    assert.equal(c.aGid, 'g5');
    assert.equal(c.bGid, 'g7');
    assert.equal(c.aChars, 'A 的第三层'.length);
    assert.equal(c.bChars, 'B 的第三层比 A 短'.length);
    assert.ok(!('mes' in c) && !('text' in c), '冲突记录不许携带正文（弹窗铁律）');
});

test('合并：未指定的冲突按 defaultSide 处理，且**如实计入 unresolved**', () => {
    const m = mkModel();
    const auto = planMerge(m, { aId: 'A', bId: 'B', charsOf: charsOf(m) });
    assert.equal(auto.conflicts[0].picked, 'a');
    assert.equal(auto.stats.unresolved, 1, '没给选择 ⇒ 必须报「还有 1 处没定」');

    const explicit = planMerge(m, { aId: 'A', bId: 'B', choices: { 3: 'b' }, charsOf: charsOf(m) });
    assert.equal(explicit.stats.unresolved, 0);
    assert.equal(explicit.conflicts[0].picked, 'b');

    const defaultB = planMerge(m, { aId: 'A', bId: 'B', defaultSide: 'b', charsOf: charsOf(m) });
    assert.equal(defaultB.path[3], 'g7');
});

test('合并：前缀之后又用回同一个组 ⇒ 算「合上了」，不算冲突', () => {
    const m = mkModel();
    m.branches.find((b) => b.id === 'B').path[3] = 'g5';   // 与 A 同组
    const p = planMerge(m, { aId: 'A', bId: 'B', charsOf: charsOf(m) });
    assert.equal(p.conflicts.length, 0, '同组不是冲突');
    assert.equal(p.path[3], 'g5');
    assert.equal(p.steps.find((s) => s.floor === 3).side, 'shared');
});

/* ---------------- 5. 边界 ---------------- */

test('合并：同一分支自合并 / 分支不存在 / 模型不可用 → ok:false + 人话原因（不抛）', () => {
    const m = mkModel();
    for (const [opts, kw] of [
        [{ aId: 'A', bId: 'A' }, '同一分支'],
        [{ aId: 'A', bId: 'nope' }, '找不到分支'],
        [{ aId: 'nope', bId: 'B' }, '找不到分支'],
    ]) {
        const r = planMerge(m, opts);
        assert.equal(r.ok, false, `${JSON.stringify(opts)} 应当失败`);
        assert.ok(r.reason.includes(kw), `原因应能看懂：${r.reason}`);
        assert.deepEqual(r.conflicts, []);
    }
    assert.equal(planMerge(null, { aId: 'A', bId: 'B' }).ok, false);
    assert.equal(planMerge({}, { aId: 'A', bId: 'B' }).ok, false);
});

test('commonPrefixLength：不同即停（前缀后的巧合同组不算前缀）', () => {
    const a = { path: { 1: 'g1', 2: 'g2', 3: 'g3' } };
    const b = { path: { 1: 'g1', 2: 'gX', 3: 'g3' } };
    assert.equal(commonPrefixLength(a, b), 1, '第 2 层不同就停，第 3 层相同也不算');
    assert.equal(commonPrefixLength(a, { path: { 1: 'g1', 2: 'g2', 3: 'g3' } }), 3, '完全相同 ⇒ 全前缀');
    assert.equal(commonPrefixLength({ path: {} }, a), 0);
});

test('合并：两条完全相同的分支 ⇒ 零冲突，结果与它们相同', () => {
    const m = mkModel();
    const a = m.branches.find((x) => x.id === 'A');
    m.branches.push({ ...a, id: 'A2', name: 'A 的副本', is_default: false });
    const p = planMerge(m, { aId: 'A', bId: 'A2', charsOf: charsOf(m) });
    assert.equal(p.stats.conflicts, 0);
    assert.equal(p.stats.unresolved, 0);
    assert.deepEqual(p.path, a.path);
});

/* ---------------- 可读文案 ---------------- */

test('describeMerge：说得出「共几层 / 共享几层 / 各取几层 / 几处冲突」', () => {
    const m = mkModel();
    const p = planMerge(m, { aId: 'A', bId: 'B', choices: { 3: 'b' }, charsOf: charsOf(m) });
    const s = describeMerge(p);
    assert.ok(s.includes('4 层'), s);
    assert.ok(s.includes('前 2 层共享'), s);
    assert.ok(s.includes('1 处冲突'), s);
    assert.ok(!describeMerge({ ok: false, reason: 'x' }).includes('成功'), '失败不许说成成功');
});

test('defaultMergeName：名字里带来源（分支多起来时比「合并」两个字有用）', () => {
    const m = mkModel();
    const n = defaultMergeName(m.branches[1], m.branches[2]);
    assert.ok(n.includes('A线') && n.includes('B线'), n);
    assert.ok(defaultMergeName({ name: '非常非常非常长的分支名字' }, { name: 'x' }).length < 30);
});
