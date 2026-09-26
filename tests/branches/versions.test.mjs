/**
 * T7 单测：每层版本管理（R5 末段 / AC17 / AC19）
 *
 * 覆盖：
 *  - **该层版本清单**（展平 = 组 × 组内版本）：当前项标注、活的正文优先、W3 的按键分支解析、
 *    越界/无模型返回空、当前分支没有该层时的处理
 *  - **组内版本的下标规则**：① 写前快照（活的正文才是真身）② 切换不合并 `extra`
 *    ③ 删除至少留一个 + 删当前取下一个/末尾取前一个 ④ 降序逐条
 *  - **等价性**：`降序逐条删` ≡ `一次批量删`（穷举 n=2..6 × 每个当前版本 × 全部非空真子集，
 *    与引用实现 `swipe-data.test.mjs` 的同款不变量：这是第三方扩展下标一致性的验收标准）
 *  - 重排（当前项跟着内容走）与编辑（当前项同步改活正文；不顺手造 `swipes` 字段）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    versionsAt, targetBranchForGroup, variantText, currentVariantIndex, lineVariants,
    snapshotActive, activateVariant, deleteVariants, deletionOrder, moveVariant, editVariantText,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/versions.js';

/* ---------------- 夹具 ---------------- */

/** 两层分支 + 第 2 层两组的家族（b_main 走 g1/g2，b1 走 g1/g7@g8）；g7 有 2 个组内版本 */
function forkModel() {
    return {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } },
            { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7', 3: 'g8' } },
        ],
        groups: {
            g7: { id: 'g7', floor: 2, owner: 'b1', active: 1, variants: [{ mes: '支线二-0' }, { mes: '支线二-1' }] },
            g8: { id: 'g8', floor: 3, owner: 'b1', active: 0, variants: [{ mes: '支线三' }] },
        },
    };
}

/** b_main 的投影 body：第 2 层是 3 个原生 swipe，当前是第 2 个（`mes` 被编辑过 → 活的正文） */
function mainBody() {
    return [
        { mes: '一', is_user: true, send_date: 1 },
        {
            mes: '主线二（改过）',
            is_user: false,
            send_date: 2,
            swipes: ['s0', '主线二', 's2'],
            swipe_id: 1,
            swipe_info: [{ send_date: 10, extra: { k: 0 } }, { send_date: 11, extra: { k: 1 } }, { send_date: 12, extra: { k: 2 } }],
        },
    ];
}

/** 一条 n 个版本的宿主 native 行（`extra` 与当前那一版的 `swipe_info` 一致——真机的常态） */
function mkLine(n, active = 0) {
    return {
        name: 'AI',
        is_user: false,
        mes: `t${active}`,
        swipes: Array.from({ length: n }, (_, i) => `t${i}`),
        swipe_id: active,
        extra: { i: active },
        swipe_info: Array.from({ length: n }, (_, i) => ({
            send_date: 1000 + i, gen_started: 1, gen_finished: 2, extra: { i },
        })),
    };
}

/* ---------------- 文本与下标基础 ---------------- */

test('versions：variantText——字符串 / 分段数组 / 空值', () => {
    assert.equal(variantText('正文'), '正文');
    assert.equal(variantText([{ text: '甲' }, { text: '乙' }]), '甲乙');
    assert.equal(variantText([{ text: '甲' }, 'raw']), '甲');
    assert.equal(variantText(null), '');
    assert.equal(variantText(undefined), '');
    assert.equal(variantText(42), '42');
});

test('versions：currentVariantIndex——夹进 [0, n-1]；非整数/越界按 0 起算', () => {
    assert.equal(currentVariantIndex({ swipes: ['a', 'b', 'c'], swipe_id: 2 }), 2);
    assert.equal(currentVariantIndex({ swipes: ['a', 'b', 'c'], swipe_id: 9 }), 2, '越界夹到末位');
    assert.equal(currentVariantIndex({ swipes: ['a', 'b', 'c'], swipe_id: -3 }), 0);
    assert.equal(currentVariantIndex({ swipes: ['a', 'b'], swipe_id: '1' }), 0, '非整数视作 0');
    assert.equal(currentVariantIndex({ swipes: ['a', 'b'], swipe_id: 1.5 }), 0);
    assert.equal(currentVariantIndex({ mes: 'x' }), 0, '没有 swipes 数组恒为 0');
    assert.equal(currentVariantIndex(null), 0);
});

test('versions：lineVariants——当前那一版取活的 mes（swipes[active] 可能滞后）', () => {
    const v = lineVariants(mainBody()[1]);
    assert.equal(v.count, 3);
    assert.equal(v.active, 1);
    assert.deepEqual(v.texts, ['s0', '主线二（改过）', 's2']);
    assert.deepEqual(v.sendDates, [10, 2, 12], '当前项的 send_date 取活的那份');
    // 没有 swipes 数组 → 单版本
    assert.deepEqual(lineVariants({ mes: '独苗' }), { count: 1, active: 0, texts: ['独苗'], sendDates: [undefined] });
});

/* ---------------- 该层版本清单 ---------------- */

test('versions：versionsAt——展平「组 × 组内版本」，标出当前项与目标分支', () => {
    const m = forkModel();
    const d = versionsAt(m, 2, mainBody(), null);
    assert.equal(d.floor, 2);
    assert.equal(d.currentGid, 'g2');
    assert.deepEqual(d.groups.map((g) => [g.gid, g.isCurrent, g.variantCount, g.active, g.targetBranchId]), [
        ['g2', true, 3, 1, null],
        ['g7', false, 2, 1, 'b1'],
    ]);
    assert.deepEqual(d.groups[0].branchIds, ['b_main']);
    assert.deepEqual(d.groups[1].branchIds, ['b1']);
    assert.deepEqual(d.items.map((x) => [x.key, x.text, x.isCurrent]), [
        ['g2#0', 's0', false],
        ['g2#1', '主线二（改过）', true],
        ['g2#2', 's2', false],
        ['g7#0', '支线二-0', false],
        ['g7#1', '支线二-1', false],
    ]);
    assert.equal(d.currentKey, 'g2#1');
});

test('versions：versionsAt——按传入分支认「当前组」（W3：绑定键上 ≠ 家族活跃分支）', () => {
    const m = forkModel();
    // 打开原生分支键 b1：body 是 b1 的投影（第 2 层 = b1 的组 g7）
    const bodyOfB1 = [{ mes: '一' }, { mes: '支线二-1' }];
    const d = versionsAt(m, 2, bodyOfB1, 'b1');
    assert.equal(d.currentGid, 'g7');
    assert.deepEqual(d.groups.map((g) => [g.gid, g.isCurrent, g.variantCount, g.targetBranchId]), [
        ['g2', false, 1, 'b_main'],
        ['g7', true, 1, null],
    ]);
    assert.equal(d.items.find((x) => x.isCurrent).key, 'g7#0');
    assert.equal(d.items.find((x) => x.key === 'g7#0').text, '支线二-1', '当前组读 body');
    // g2 的正文既不在 body 也不在 model.groups（它相对活跃分支「在 body 里」）→ **不抛**、空正文
    assert.equal(d.items.find((x) => x.key === 'g2#0').text, '');
});

test('versions：versionsAt——当前分支没有该层时无「当前组」，每组都给出目标分支', () => {
    const m = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1' } },
            { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7' } },
        ],
        groups: { g7: { id: 'g7', floor: 2, owner: 'b1', active: 0, variants: [{ mes: '支线二' }] } },
    };
    const d = versionsAt(m, 2, [{ mes: '一' }]);
    assert.equal(d.currentGid, null);
    assert.equal(d.groups.length, 1);
    assert.equal(d.groups[0].isCurrent, false);
    assert.equal(d.groups[0].targetBranchId, 'b1');
    assert.equal(d.currentKey, null);
    assert.deepEqual(d.items.map((x) => x.isCurrent), [false]);
});

test('versions：versionsAt——无模型 / 楼层非法 / 该层无组 → 空清单', () => {
    const m = forkModel();
    for (const d of [versionsAt(null, 2, mainBody()), versionsAt(m, 0, mainBody()), versionsAt(m, 1.5, mainBody())]) {
        assert.deepEqual(d.items, []);
        assert.deepEqual(d.groups, []);
    }
    const none = versionsAt(m, 9, mainBody());
    assert.deepEqual(none.items, []);
    assert.equal(none.currentGid, null);
});

test('versions：versionsAt——单组层的组仍是「当前组」（版本按钮不出，但清单自洽）', () => {
    const m = forkModel();
    const d = versionsAt(m, 1, [{ mes: '一' }]);
    assert.equal(d.groups.length, 1);
    assert.equal(d.groups[0].isCurrent, true);
    assert.deepEqual(d.groups[0].branchIds, ['b_main', 'b1'], '共享组列出全部引用它的分支');
});

/* ---------------- 目标分支（组被多条分支共享时先挑一条） ---------------- */

test('versions：targetBranchForGroup——当前组不切；别的组挑一条；共享组优先非默认分支', () => {
    const m = forkModel();
    assert.equal(targetBranchForGroup(m, 'g2', 2, null), null, '当前组不切分支');
    assert.equal(targetBranchForGroup(m, 'g7', 2, null), 'b1');
    assert.equal(targetBranchForGroup(m, 'g7', 2, 'b1'), null, '已在那条分支上时无需切');
    // 三条分支共享 g7：deriveOwner 判共享（null）→ 退回「非默认分支」
    m.branches.push({ id: 'b2', name: '第三条', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7' } });
    assert.equal(targetBranchForGroup(m, 'g7', 2, null), 'b1', '多条候选时给出确定的一条');
    assert.equal(targetBranchForGroup(m, 'g9', 2, null), null, '没人引用的组无目标分支');
});

/* ---------------- ① 写前快照 ---------------- */

test('versions：snapshotActive——活的 mes/extra 落进当前版本的副本', () => {
    const line = mainBody()[1];
    line.extra = { live: true };
    snapshotActive(line);
    assert.equal(line.swipes[1], '主线二（改过）', '活的 mes 才是真身');
    assert.deepEqual(line.swipe_info[1].extra, { live: true });
    assert.deepEqual(line.swipe_info[0].extra, { k: 0 }, '别的版本原样保留');
    assert.equal(line.swipe_info.length, 3, '整表与 swipes 等长');
    assert.equal(line.swipe_info[1].send_date, 2);
});

test('versions：snapshotActive——swipe_info 缺失/偏短时按位补齐；越界 swipe_id 被夹回', () => {
    const line = { mes: 'b', swipes: ['a', 'b'], swipe_id: 7, send_date: 5, extra: { x: 1 } };
    snapshotActive(line);
    assert.equal(line.swipe_id, 1, 'swipe_id 夹进合法区间');
    assert.deepEqual(line.swipe_info, [
        { send_date: 5, extra: { x: 1 } },
        { send_date: 5, extra: { x: 1 } },
    ]);
});

test('versions：snapshotActive——没有 swipes 数组时**原样不动**（R0：不补默认字段）', () => {
    const before = { name: 'U', is_user: true, mes: 'x', send_date: 1, extra: { a: 1 } };
    const line = structuredClone(before);
    snapshotActive(line);
    assert.deepEqual(line, before);
    assert.ok(!('swipes' in line) && !('swipe_id' in line) && !('swipe_info' in line));
});

/* ---------------- ② 切换（不合并 extra） ---------------- */

test('versions：activateVariant——整份搬时间戳与 extra，**不合并**（防跨版本泄漏）', () => {
    const line = {
        mes: 't0', swipes: ['t0', 't1'], swipe_id: 0,
        send_date: 1, gen_started: 7, gen_finished: 8, extra: { media: 'a.png', token_count: 12 },
        swipe_info: [{ send_date: 1, extra: { media: 'a.png' } }, { send_date: 2, extra: { only: 'b' } }],
    };
    activateVariant(line, 1);
    assert.equal(line.swipe_id, 1);
    assert.equal(line.mes, 't1');
    assert.equal(line.send_date, 2);
    assert.equal(line.gen_started, undefined, '目标版本没有 gen_started → 不残留上一个版本的');
    assert.deepEqual(line.extra, { only: 'b' }, '旧版本的 media/token_count 不得泄漏');
});

test('versions：activateVariant——目标版本不存在即抛（不改行）', () => {
    const line = mkLine(2, 0);
    const before = structuredClone(line);
    assert.throws(() => activateVariant(line, 2), /目标版本 2 不存在/);
    assert.throws(() => activateVariant(line, -1), /目标版本/);
    assert.throws(() => activateVariant(line, 0.5), /目标版本/);
    assert.deepEqual(line, before);
    assert.throws(() => activateVariant({ mes: 'x' }, 0), /只有 0 个版本/);
});

/* ---------------- ③④ 删除 ---------------- */

test('versions：deleteVariants——至少保留一个（全选/单版本都抛，且不改行）', () => {
    const line = mkLine(3, 0);
    const before = structuredClone(line);
    assert.throws(() => deleteVariants(line, [0, 1, 2]), /至少要保留一个版本/);
    assert.deepEqual(line, before, '校验先于快照：非法入参完全不改行');
    assert.throws(() => deleteVariants(mkLine(1, 0), [0]), /只有 1 个版本/);
    assert.throws(() => deleteVariants(line, []), /请先选择要删除的版本/);
    assert.throws(() => deleteVariants(line, [-1]), /目标版本不存在/);
    assert.throws(() => deleteVariants(line, [9]), /目标版本不存在/);
    assert.throws(() => deleteVariants(line, [1.5]), /目标版本不存在/);
});

test('versions：deleteVariants——删当前项取下一个；末尾则取前一个；非当前项不动当前', () => {
    // 删中间（当前）
    const a = mkLine(4, 1);
    let r = deleteVariants(a, [1]);
    assert.deepEqual(a.swipes, ['t0', 't2', 't3']);
    assert.equal(a.swipe_id, 1);
    assert.equal(a.mes, 't2', '删掉当前项 → 取下一个幸存者');
    assert.deepEqual(r.kept, [0, 2, 3]);
    assert.deepEqual(r.removed, [1]);
    // 删末尾（当前）→ 取前一个
    const b = mkLine(4, 3);
    deleteVariants(b, [3]);
    assert.deepEqual(b.swipes, ['t0', 't1', 't2']);
    assert.equal(b.swipe_id, 2);
    assert.equal(b.mes, 't2');
    // 删非当前项 → 当前内容不动
    const c = mkLine(4, 0);
    deleteVariants(c, [2]);
    assert.deepEqual(c.swipes, ['t0', 't1', 't3']);
    assert.equal(c.swipe_id, 0);
    assert.equal(c.mes, 't0');
    // 键重复只删一次
    const d1 = mkLine(4, 0);
    const d2 = mkLine(4, 0);
    deleteVariants(d1, [1, 1]);
    deleteVariants(d2, [1]);
    assert.deepEqual(d1, d2);
});

test('versions：deleteVariants——swipe_info 跟着删（同一下标）', () => {
    const line = mkLine(3, 2);
    deleteVariants(line, [0]);
    assert.deepEqual(line.swipes, ['t1', 't2']);
    assert.deepEqual(line.swipe_info.map((x) => x.extra), [{ i: 1 }, { i: 2 }]);
    assert.equal(line.swipe_id, 1);
    assert.equal(line.mes, 't2');
    assert.deepEqual(line.extra, { i: 2 }, '当前版本的 extra 仍是它自己的');
});

test('versions：deletionOrder——去重 + 降序 + 过滤非整数/负数', () => {
    assert.deepEqual(deletionOrder([2, 0, 2, -1, 1]), [2, 1, 0]);
    assert.deepEqual(deletionOrder([1.5, 'x', null, undefined, 3]), [3]);
    assert.deepEqual(deletionOrder([]), []);
    assert.deepEqual(deletionOrder(null), []);
});

test('versions：等价性——**降序逐条删 ≡ 一次批量删**（穷举 n=2..6 × 当前版本 × 全部非空真子集）', () => {
    let cases = 0;
    for (let n = 2; n <= 6; n++) {
        for (let active = 0; active < n; active++) {
            for (let mask = 1; mask < (1 << n) - 1; mask++) {   // 非空真子集
                const subset = [];
                for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(i);
                const batch = mkLine(n, active);
                deleteVariants(batch, subset);
                const step = mkLine(n, active);
                for (const k of deletionOrder(subset)) deleteVariants(step, [k]);
                assert.deepEqual(step, batch, `n=${n} active=${active} subset=[${subset}]`);
                cases++;
            }
        }
    }
    assert.ok(cases > 100, `穷举用例数偏少（${cases}）`);
});

/* ---------------- 重排（当前项跟着内容走） ---------------- */

test('versions：moveVariant——正文与元数据一起搬，当前可见内容跟着它所属的那一份', () => {
    const line = mkLine(3, 0);
    moveVariant(line, 0, 2);   // 与引用实现同语义：**交换**两个位置（不是整体位移）
    assert.deepEqual(line.swipes, ['t2', 't1', 't0']);
    assert.deepEqual(line.swipe_info.map((x) => x.extra), [{ i: 2 }, { i: 1 }, { i: 0 }]);
    assert.equal(line.swipe_id, 2, '当前那一份搬到了新位置');
    assert.equal(line.mes, 't0');
    assert.deepEqual(line.extra, { i: 0 });
    // 当前项不在交换范围内 → 下标不动
    const other = mkLine(4, 3);
    moveVariant(other, 0, 1);
    assert.equal(other.swipe_id, 3);
    assert.equal(other.mes, 't3');
    assert.deepEqual(other.swipes, ['t1', 't0', 't2', 't3']);
    // from === to 合法（内容不动；快照会按「活的正文才是真身」重写当前版本的副本，故比内容面）
    const same = mkLine(3, 1);
    const before = structuredClone(same);
    moveVariant(same, 1, 1);
    assert.deepEqual(same.swipes, before.swipes);
    assert.deepEqual(same.swipe_info.map((x) => x.extra), before.swipe_info.map((x) => x.extra));
    assert.equal(same.swipe_id, 1);
    assert.equal(same.mes, 't1');
    assert.deepEqual(same.extra, before.extra);
    // 越界抛错
    assert.throws(() => moveVariant(mkLine(3, 0), 0, 3), /目标版本下标越界/);
    assert.throws(() => moveVariant(mkLine(3, 0), -1, 1), /目标版本下标越界/);
    assert.throws(() => moveVariant({ mes: 'x' }, 0, 1), /只有 0 个版本/);
});

/* ---------------- 编辑 ---------------- */

test('versions：editVariantText——当前版本同步改活正文；非当前只改副本；先快照', () => {
    const line = mkLine(3, 1);
    line.mes = 'EDITED';
    editVariantText(line, 1, '新正文');
    assert.equal(line.mes, '新正文', '当前项编辑后界面看到的立刻是新文本');
    assert.equal(line.swipes[1], '新正文');
    // 非当前项：活正文不动；且切之前的快照已把 EDITED 落进 swipes[1]（前一次调用已完成切换语义）
    const other = mkLine(3, 0);
    other.mes = 'EDITED0';
    editVariantText(other, 2, 'X');
    assert.equal(other.swipes[2], 'X');
    assert.equal(other.mes, 'EDITED0');
    assert.equal(other.swipes[0], 'EDITED0', '写前快照：活的正文进了当前版本的副本');
    // 越界抛错
    assert.throws(() => editVariantText(mkLine(3, 0), 3, 'X'), /目标版本 3 不存在/);
});

test('versions：editVariantText——单版本行只改 mes，**不**顺手造出 swipes（R0：不补字段）', () => {
    const line = { name: 'U', is_user: true, mes: '旧' };
    editVariantText(line, 0, '新');
    assert.equal(line.mes, '新');
    assert.ok(!('swipes' in line) && !('swipe_id' in line) && !('swipe_info' in line));
    assert.throws(() => editVariantText({ mes: 'x' }, 1, 'y'), /只有 1 个版本/);
});

/* ---------------- 与版本按钮的出现条件一致（不变式 5 的数据面） ---------------- */

test('versions：版本清单的组数 = 该层 swipe 组数（>1 才出按钮）', () => {
    const m = forkModel();
    assert.equal(versionsAt(m, 1, mainBody()).groups.length, 1);
    assert.equal(versionsAt(m, 2, mainBody()).groups.length, 2);
    assert.equal(versionsAt(m, 3, mainBody()).groups.length, 1, '只有 b1 有第 3 层');
});
