/**
 * 家族建模层单测：`core/family-model.js`
 *
 * 本模块是「`MergePlan` → 家族模型 + 待落库行」的**装配层**，也是「变为 swipe」这条能力的落点。
 * 夹具逐条对应 `design.md` §10.3 的构造契约（**含 2026-09-29 复核后补定的四条**）与 §10.4 的验证口径：
 *
 * · (a)/(a') 同层改写 vs 同层多版本：共享层零复制、多版本并进同一条行的 `swipes`，`swipe_id` 指向 A 那版
 * · (b)/(b') 中间删层 / 尾部删层：B 的 path 必须 1..N 连续（`branches.js#createBranchWithPath` 的门）
 * · (c)/(f)  产出的模型必须过 `validate`，且「非活跃引用进 groups、活跃引用不进」
 * · (c2)     A 侧**只回写真正变了的行**（补定第 3 条）
 * · (c3)     A = 家族**活跃分支**（即使它不是默认分支），且 `active_branch` 原样不改（补定第 2 条）
 * · (d)      **真往返**：`modelFromPlan → storeFromModel → modelFromStore`，共享层 body 行带原生 `swipes`
 * · (e)/(g)  运行期**守卫**：非活跃分支同一层各持私有组 ⇒ 整体降级（补定第 4 条）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelFromPlan } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-model.js';
import { planFamilyMerge } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-align.js';
import { validate } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { storeFromModel, modelFromStore } from '../../public/scripts/extensions/third-party/chatfilesys/core/store-bridge.js';
import { projectionOf } from '../../public/scripts/extensions/third-party/chatfilesys/core/patch-rows.js';

/* ---------------- 夹具 ---------------- */

const PAD = '正文正文正文正文正文正文正文正文正文正文';
const TEXT_A = (i) => `甲-第${i}层-${PAD}${i}`; // 长于 MIN_EVIDENCE_LEN(8)
const TEXT_B = (i) => `乙-第${i}层-${PAD}${i}`;
const TEXT_C = (i) => `丙-第${i}层-${PAD}${i}`;
const d = (day) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;

const row = (mes, extra = {}) => ({ name: '角色', is_user: false, mes, send_date: d(1), ...extra });

/** A 侧 n 层甲文（日期递增，便于判「较新」） */
const aRowsOf = (n) => Array.from({ length: n }, (_, i) => row(TEXT_A(i + 1), { send_date: d(i + 1) }));

const pathOf = (n, prefix = 'g') => {
    const p = {};
    for (let f = 1; f <= n; f += 1) p[f] = `${prefix}${f}`;
    return p;
};

const branchesOf = (model) => {
    const a = model.branches.find((b) => b.is_default);
    const b = model.branches.find((x) => !x.is_default);
    return { a, b };
};

const rowAt = (floors, floorNo, variantId) => floors.find((r) => r.floorNo === floorNo && r.variantId === variantId);

/** 造「同层多版本」的 B 层：当前正文是新的，旧版原样留在 swipes 里（宿主真实形态） */
const swipeRegen = (oldText, newText, extra = {}) => row(newText, { swipes: [oldText, newText], swipe_id: 1, ...extra });

/**
 * (a)/(a') 的共同夹具：10 层，前 6 层同源，第 3 层是「重写 + 旧版留 swipe」，第 5 层是完全改写。
 * 于是：第 3 层 = swipe-merge（两版并进一条行），第 5 层 = two-groups（B 新建一行）。
 */
function rewriteCase() {
    const n = 10;
    const aRows = aRowsOf(n);
    const bRows = Array.from({ length: n }, (_, i) => {
        const f = i + 1;
        if (f === 3) return swipeRegen(TEXT_A(3), TEXT_B(3), { send_date: d(20) });
        if (f === 5) return row(TEXT_B(5), { send_date: d(21) });
        return row(TEXT_A(f), { send_date: d(f) });
    });
    return { aRows, bRows, n };
}

/* ---------------- (a) / (a')：共享层零复制 + 多版本并进 swipe ---------------- */

test('(a) 同层改写 vs 同层多版本：共享层 B.path[j] === A.path[j]，改写层分出新组', async () => {
    const { aRows, bRows, n } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    const { model } = modelFromPlan({ plan, aRows, bRows });
    const { a, b } = branchesOf(model);
    for (let f = 1; f <= n; f += 1) {
        if (f === 5) assert.notEqual(b.path[5], a.path[5], '第 5 层（同位置不同文）必须分出新组');
        else assert.equal(b.path[f], a.path[f], `第 ${f} 层应零复制共享同一组`);
    }
    // 改写层的新组落在 groups（B 私有），而不是 body
    assert.ok(model.groups[b.path[5]], 'B 的改写层新组应在 groups');
    assert.equal(model.groups[b.path[5]].floor, 5);
});

test("(a') 共享层那条行带原生 swipes（≥2、两版都在、swipe_id 指向 A 那一版）", async () => {
    const { aRows, bRows } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    const { model, floors, stats } = modelFromPlan({ plan, aRows, bRows });
    const { a } = branchesOf(model);

    const entry = rowAt(floors, 3, a.path[3]);
    assert.ok(entry, '共享层（第 3 层）必须有一条落库行');
    const line = JSON.parse(entry.content);

    assert.ok(Array.isArray(line.swipes), '同层多版本 ⇒ 行必须带 swipes（宿主原生左右箭头）');
    assert.ok(line.swipes.length >= 2, `swipes 至少 2 条，实为 ${line.swipes.length}`);
    assert.equal(line.swipes[0], TEXT_A(3), '首条 = A 的版本');
    assert.equal(line.swipes.at(-1), TEXT_B(3), '末条 = B 的版本（较新）');
    assert.ok(line.swipes.includes(TEXT_A(3)) && line.swipes.includes(TEXT_B(3)), '两版正文都要在');
    assert.equal(line.swipe_id, 0, 'swipe_id 指向 A 那一版（A 的显示一字不变，不取较新那条）');
    assert.equal(line.swipes[line.swipe_id], TEXT_A(3), 'active 必须落在 A 的正文上');
    assert.equal(line.mes, TEXT_A(3), '行的正文 = A 那一版（合并不改动原分支）');
    assert.equal(line.swipe_info.length, line.swipes.length, 'swipe_info 必须同步补齐');

    // provenance：每条版本带 src 与源下标（design.md §4 · M4 / 雷区 L27）
    const prov = stats.provenance.find((p) => p.floorNo === 3);
    assert.ok(prov, '合并层必须登记出处');
    assert.deepEqual(prov.variants, [{ src: 'a', srcIdx: 0 }, { src: 'b', srcIdx: 1 }]);
});

/* ---------------- (b) / (b')：中间删层与尾部删层 ---------------- */

test('(b) 中间删层：B 的 path 仍 1..m 连续（无空号，绝不违不变量 2）', async () => {
    const aRows = aRowsOf(10);
    const bRows = aRows.filter((_, i) => i !== 4); // 删掉 A 的第 5 层
    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    const { model } = modelFromPlan({ plan, aRows, bRows });
    const { a, b } = branchesOf(model);

    const keys = Object.keys(b.path).map(Number).sort((x, y) => x - y);
    assert.deepEqual(keys, Array.from({ length: 9 }, (_, i) => i + 1), 'B 的楼层号必须连续 1..9');
    assert.deepEqual(a.path, pathOf(10), 'A 侧 10 层原样不动（被删的是 B 的第 5 层）');
    assert.equal(plan.floors.find((f) => f.kind === 'only-a').aIdx, 4, 'A 的第 5 层应是 only-a');
    // 删层点之后序号错位 ⇒ B 之后的层各自新建一行（§10.3 登记的行为：共有层会在库里存两份）
    for (let f = 5; f <= 9; f += 1) assert.notEqual(b.path[f], a.path[f + 1]);
    assert.ok(Object.keys(model.groups).length >= 5, 'B 的错位段应各建新组');
});

test('(b\') 尾部删层：B.path 恰是 A.path 的前缀（零复制，不新建行）', async () => {
    const aRows = aRowsOf(10);
    const bRows = aRows.slice(0, 6); // B 是 A 的前 6 层
    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    assert.equal(plan.mode, 'ancestor');
    const { model, floors } = modelFromPlan({ plan, aRows, bRows });
    const { a, b } = branchesOf(model);

    assert.equal(Object.keys(b.path).length, 6);
    for (let f = 1; f <= 6; f += 1) assert.equal(b.path[f], a.path[f]);
    assert.deepEqual(Object.keys(model.groups), [], '零复制 ⇒ 不产任何新组');
    assert.equal(floors.length, 0, 'B 是一字不差的纯前缀 ⇒ 没有任何行需要回写（A 侧只写变了的行）');
});

/* ---------------- (c)：构造出的模型必须过 validate ---------------- */

test('(c) 产出模型过 validate（bodyLength = A 分支楼层数）', async () => {
    const { aRows, bRows, n } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    const { model } = modelFromPlan({ plan, aRows, bRows });
    const r = validate(model, n);
    assert.equal(r.ok, true, `validate 未通过：${r.errors.join(' / ')}`);
});

test('(c2) A 侧只回写真正变了的行（并出 ≥2 版的那几条；未变的 A 行不进 floors）', async () => {
    const { aRows, bRows } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    const { model, floors } = modelFromPlan({ plan, aRows, bRows });
    const { a } = branchesOf(model);
    const aGids = new Set(Object.values(a.path));

    const aSide = floors.filter((r) => aGids.has(r.variantId));
    assert.deepEqual(aSide.map((r) => r.floorNo), [3], '只有第 3 层并出了 2 版');
    // 其余 A 行（未变）一律不重写 —— 避免写放大、不抹掉库里已存的 contentHash
    for (const f of [1, 2, 4, 5, 6, 7, 8, 9, 10]) {
        assert.equal(rowAt(floors, f, a.path[f]), undefined, `A 第 ${f} 层未变，不得回写`);
    }
});

test('(c3) A = 家族活跃分支（即使它不是默认分支），且 active_branch 原样不改', async () => {
    const n = 6;
    const aRows = aRowsOf(n);
    // 家族：默认分支 b_main 与**活跃**分支 bb 在第 3 层用不同组（bb 私有的是 g31，b_main 私有的是 g3）
    const family = {
        active_branch: 'bb',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: pathOf(n) },
            { id: 'bb', name: 'B线', is_default: false, fork_base: 2, path: { 1: 'g1', 2: 'g2', 3: 'g31', 4: 'g4', 5: 'g5', 6: 'g6' } },
        ],
        groups: { g3: { id: 'g3', floor: 3, active: 0, variants: [row(TEXT_C(3), { send_date: d(9) })] } },
    };
    // B：第 3 层与 A 同源（swipe 重生成）⇒ 应共享**活跃分支 bb** 的 g31，而不是默认分支的 g3
    const bRows = Array.from({ length: n }, (_, i) => {
        const f = i + 1;
        if (f === 3) return swipeRegen(aRows[2].mes, TEXT_B(3), { send_date: d(20) });
        return row(TEXT_A(f), { send_date: d(f) });
    });

    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    const before = structuredClone(family);
    const { model, floors, stats } = modelFromPlan({ plan, aRows, bRows, family });

    assert.equal(stats.ok, true, `不应降级：${stats.reason}`);
    assert.deepEqual(family, before, 'modelFromPlan 不得改输入（纯）');
    assert.equal(model.active_branch, 'bb', 'active_branch 必须原样不改（不得默默切换用户正看的分支）');

    const bb = model.branches.find((b) => b.id === 'bb');
    const bnew = model.branches.find((b) => b.id !== 'b_main' && b.id !== 'bb');
    assert.equal(bnew.path[3], bb.path[3], '共享层必须引用活跃分支的组');
    assert.equal(bnew.path[3], 'g31');
    assert.notEqual(bnew.path[3], 'g3', '不得引用默认分支的组');

    // A 侧只回写变了的行（这里只有第 3 层）
    const aGids = new Set(Object.values(bb.path));
    assert.deepEqual(floors.filter((r) => aGids.has(r.variantId)).map((r) => r.floorNo), [3]);

    const vr = validate(model, n);
    assert.equal(vr.ok, true, `validate 未通过：${vr.errors.join(' / ')}`);
});

/* ---------------- (d)：真往返（本任务最要紧的一条） ---------------- */

test('(d) 往返：共享层 body 行带原生 swipes（宿主侧左右箭头 = 用户要的「变为 swipe」）', async () => {
    const { aRows, bRows, n } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    const { model, floors } = modelFromPlan({ plan, aRows, bRows });
    const { a } = branchesOf(model);

    // A 侧只回写变了的行 ⇒ 未变的 A 行不在本批 floors 里（它们已在库中）。
    // 故这里模拟库内既有行：A 各层的原始行 + 本批新增/改写行（同键由后者覆盖）。
    const stored = aRows.map((r, i) => ({
        floorNo: i + 1, variantId: a.path[i + 1], seq: 0,
        content: JSON.stringify(r), contentHash: null, sendDate: r.send_date ?? null,
    }));
    const rows = [...stored, ...floors];

    // 建模 → 库 meta → 折回模型（往返链路）
    const meta = storeFromModel(model, { familyId: 'f1', chatKey: 'av::c', characterId: 'c1', name: 'c' });
    const family = { ...meta, model: { active_branch: model.active_branch } };
    const back = modelFromStore(family, rows);

    const active = back.branches.find((x) => x.id === back.active_branch);
    const body = projectionOf(active.path, rows); // 投影单点（与接缝读路径同一份）
    assert.equal(body.length, n, '既有行 + 本批行 = 完整 body（缺行会被静默跳过，故须显式断言长度）');

    const shared = body[3 - 1];
    assert.ok(Array.isArray(shared.swipes) && shared.swipes.length >= 2,
        '共享层 body 行必须自带 swipes（长度 ≥ 2）');
    assert.ok(shared.swipes.includes(TEXT_A(3)) && shared.swipes.includes(TEXT_B(3)), '两版正文都要在');
    assert.equal(shared.swipes[shared.swipe_id], TEXT_A(3), 'swipe_id 指向 A 那一版');

    // B 的改写层仍是 B 私有（折回后在 groups）
    const bBranch = back.branches.find((x) => !x.is_default);
    assert.ok(back.groups[bBranch.path[5]], 'B 的改写层组在折回后仍应存在');
});

/* ---------------- (e)：运行期守卫（补定第 4 条 / §10.4 更正后的口径） ---------------- */

test('(e) 守卫拦住：新 B 与既有非活跃分支 C 在同一层各持私有组 ⇒ 整体降级，不合并', async () => {
    const n = 10;
    const aRows = aRowsOf(n);
    // B：前 6 层与 A 同源，后 4 层是 B 独有（two-groups ⇒ 各建新组 ⇒ 第 7 层与 C 的 g11 撞层）
    const bRows = [
        ...Array.from({ length: 6 }, (_, i) => row(TEXT_A(i + 1), { send_date: d(i + 1) })),
        ...Array.from({ length: 4 }, (_, k) => row(TEXT_B(7 + k), { send_date: d(30 + k) })),
    ];
    // 既有家族：A（活跃 + 默认）+ C（非活跃，第 7 层是它自己的私有组 g11）
    const family = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: pathOf(n) },
            { id: 'bc', name: 'C线', is_default: false, fork_base: 6, path: { ...pathOf(6), 7: 'g11' } },
        ],
        groups: { g11: { id: 'g11', floor: 7, active: 0, variants: [row(TEXT_C(7), { send_date: d(9) })] } },
    };
    const before = structuredClone(family);
    // 守卫前，这份家族本身是合法的（validate 通过）—— 冲突来自「加入新 B」之后
    assert.equal(validate(family, n).ok, true);

    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    const r = modelFromPlan({ plan, aRows, bRows, family });

    assert.equal(r.stats.ok, false, '非活跃分支同层各持私有组 ⇒ 必须整体降级（不合并、列候选）');
    assert.equal(r.stats.reason, 'group-collision');
    assert.equal(r.stats.floor, 7);
    assert.deepEqual(r.floors, [], '降级不产任何行');
    assert.deepEqual(family, before, 'modelFromPlan 不得改输入（纯）');
    assert.deepEqual(r.model, before, '降级时家族原样带回');
});

test('(g) 守卫拦住（既有家族内已冲突）：两条非活跃分支在同一层各有私有组 ⇒ 降级', async () => {
    const n = 3;
    const aRows = aRowsOf(n);
    const bRows = aRows.map((r) => ({ ...r })); // B 与 A 一字不差（plan 本身判 same-family）
    const family = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: pathOf(n) }, // g1,g2,g3
            { id: 'b1', name: 'B1', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g11', 3: 'g12' } },
            { id: 'b2', name: 'B2', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g21', 3: 'g22' } },
        ],
        groups: {
            g11: { id: 'g11', floor: 2, active: 0, variants: [row(TEXT_C(2), { send_date: d(9) })] },
            g12: { id: 'g12', floor: 3, active: 0, variants: [row(TEXT_C(3), { send_date: d(9) })] },
            g21: { id: 'g21', floor: 2, active: 0, variants: [row(TEXT_B(2), { send_date: d(9) })] },
            g22: { id: 'g22', floor: 3, active: 0, variants: [row(TEXT_B(3), { send_date: d(9) })] },
        },
    };
    // 家族「过 validate」但往返会丢组：这正是守卫存在的理由（validate 查不出这个冲突）
    assert.equal(validate(family, n).ok, true, 'validate 查不出「同层两个非活跃私有组」');

    const plan = await planFamilyMerge({ aRows, bRows });
    assert.equal(plan.verdict, 'same-family');
    const before = structuredClone(family);
    const r = modelFromPlan({ plan, aRows, bRows, family });

    assert.equal(r.stats.ok, false);
    assert.equal(r.stats.reason, 'group-collision');
    assert.equal(r.stats.floor, 2);
    assert.deepEqual(r.floors, []);
    assert.deepEqual(r.model, before, '降级时家族原样带回');
});

/* ---------------- (f)：不变量 3（活跃引用不进 groups，非活跃引用必进） ---------------- */

test('(f) 非活跃分支引用的组落在 model.groups，活跃分支引用的组不在 groups', async () => {
    const { aRows, bRows } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });
    const { model } = modelFromPlan({ plan, aRows, bRows });
    const { a, b } = branchesOf(model);

    const activeGids = new Set(Object.values(a.path));
    for (const gid of Object.keys(model.groups)) {
        assert.equal(activeGids.has(gid), false, `活跃分支引用的组 ${gid} 不得进 groups`);
    }
    for (const gid of Object.values(b.path)) {
        if (!activeGids.has(gid)) assert.ok(model.groups[gid], `B 的私有组 ${gid} 必须进 groups`);
    }
});

/* ---------------- 边界：一律不抛，返回可降级结果 ---------------- */

test('边界：空 plan / 非 same-family / 空行 → 不抛，返回降级结果', async () => {
    const { aRows, bRows } = rewriteCase();
    const plan = await planFamilyMerge({ aRows, bRows });

    for (const bad of [null, undefined, {}, { verdict: 'different', floors: [] }]) {
        const r = modelFromPlan({ plan: bad, aRows, bRows });
        assert.equal(r.stats.ok, false);
        assert.deepEqual(r.floors, []);
        assert.ok(r.model && typeof r.model === 'object');
    }
    // aRows / bRows 为空
    assert.equal(modelFromPlan({ plan, aRows: [], bRows }).stats.ok, false);
    assert.equal(modelFromPlan({ plan, aRows, bRows: [] }).stats.ok, false);
    // 非 same-family 的方案不得拿来建模
    assert.equal(modelFromPlan({ plan: { verdict: 'uncertain', floors: [] }, aRows, bRows }).stats.ok, false);
    // 带 family 的降级：family 原样带回
    const fam = { active_branch: 'b_main', branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: pathOf(3) }], groups: {} };
    const rd = modelFromPlan({ plan: null, aRows, bRows, family: fam });
    assert.equal(rd.stats.ok, false);
    assert.deepEqual(rd.model, fam);
});
