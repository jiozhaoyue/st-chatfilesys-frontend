/**
 * patch-rows.js 单测：宿主 chats/patch 的 ops 语义（T0b）
 *
 * 用例形态全部来自真机探针（tests/e2e/probe_patch_ops.py，2026-09-25 Dev 8003）：
 *   - 插件改消息字段 → `add /0/extra/third-party~1probe-row`
 *   - 宿主编辑消息 / swipe → `test /N` + `replace /N`
 *   - 删消息 → `test /N` + `remove /N`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBodyPatch } from '../../public/scripts/extensions/third-party/chatfilesys/core/patch-rows.js';

const line = (mes, extra = {}) => ({ name: 'AI', is_user: false, mes, send_date: 100, extra });

/** 行表：[[floorNo, variantId, 消息对象], …] */
function mkRows(entries) {
    return entries.map(([floorNo, variantId, obj]) => ({
        floorNo, variantId, seq: 0, content: JSON.stringify(obj), contentHash: null, sendDate: obj?.send_date ?? null,
    }));
}

/** 模型：[[走法 id, path], …] + 活跃走法 */
function mkModel(branches, active, groups = {}) {
    return {
        active_branch: active,
        branches: branches.map(([id, path]) => ({ id, name: id, is_default: id === 'b_main', fork_base: 0, path: { ...path } })),
        groups,
    };
}

/** 线性家族：主分支 3 层（g1..g3） */
function linear() {
    const rows = mkRows([
        [1, 'g1', line('第一层')],
        [2, 'g2', line('第二层')],
        [3, 'g3', line('第三层')],
    ]);
    const model = mkModel([['b_main', { 1: 'g1', 2: 'g2', 3: 'g3' }]], 'b_main');
    return { rows, model, path: model.branches[0].path };
}

const plan = (ctx, ops, over = {}) => planBodyPatch({
    rows: ctx.rows, path: ctx.path, ops, model: ctx.model, ...over,
});

test('patch-rows：字段级 add（真机形态 /0/extra/第三方键）→ 落进行内容', () => {
    const ctx = linear();
    const ops = [{ op: 'add', path: '/0/extra/third-party~1probe-row', value: { n: 42, deep: { arr: [7, 8] } } }];
    const r = plan(ctx, ops);
    assert.equal(r.ok, true);
    const first = JSON.parse(r.rows.find((x) => x.floorNo === 1).content);
    assert.deepEqual(first.extra['third-party/probe-row'], { n: 42, deep: { arr: [7, 8] } });
    assert.equal(first.mes, '第一层'); // 其余字段不动
    assert.equal(first.extra.name, undefined);
    assert.equal(r.deletes.length, 0);
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g2', 3: 'g3' });
});

test('patch-rows：字段级 replace / deep remove（插件改字段的另两种形态）', () => {
    const ctx = linear();
    ctx.rows = mkRows([
        [1, 'g1', line('第一层', { keep: 1, drop: 2 })],
        [2, 'g2', line('第二层')],
        [3, 'g3', line('第三层')],
    ]);
    const r = plan(ctx, [
        { op: 'replace', path: '/0/extra/keep', value: 9 },
        { op: 'remove', path: '/0/extra/drop' },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(r.rows[0].content).extra, { keep: 9 });
});

test('patch-rows：字段级 test 不通过 → test-failed（seam 映射 409，不静默写）', () => {
    const ctx = linear();
    const r = plan(ctx, [{ op: 'test', path: '/0/mes', value: '不是这一层的内容' }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'test-failed');
});

test('patch-rows：整行 test + replace（宿主编辑消息 / swipe 的真机形态）', () => {
    const ctx = linear();
    const before = line('第二层');
    const after = { ...before, mes: '第二层（改过）', swipes: ['第二层', '第二层（改过）'], swipe_id: 1, swipe_info: [{}, {}] };
    const r = plan(ctx, [
        { op: 'test', path: '/1', value: before },
        { op: 'replace', path: '/1', value: after },
    ]);
    assert.equal(r.ok, true);
    const row = r.rows.find((x) => x.floorNo === 2);
    assert.equal(row.variantId, 'g2'); // 变体身份不变（同一层的同一变体被编辑）
    assert.deepEqual(JSON.parse(row.content), after);
});

test('patch-rows：删除楼层 → 全局删层（所有走法前移、被删行进 deletes、折叠组楼层前移）', () => {
    const rows = mkRows([
        [1, 'g1', line('一')],
        [2, 'g2', line('二')],
        [3, 'g3', line('三')],
        [4, 'g4', line('四')],
        [3, 'g7', line('支线三')], // 分管 b1 在第 3 层的私有变体
        [4, 'g8', line('支线四')],
    ]);
    const model = mkModel([
        ['b_main', { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4' }],
        ['b1', { 1: 'g1', 2: 'g2', 3: 'g7', 4: 'g8' }],
    ], 'b_main', { g7: { id: 'g7', floor: 3, owner: 'b1', active: 0, variants: [line('支线三')] } });
    const r = planBodyPatch({
        rows, path: model.branches[0].path, model,
        ops: [{ op: 'test', path: '/1', value: line('二') }, { op: 'remove', path: '/1' }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g3', 3: 'g4' });
    const b1 = r.model.branches.find((b) => b.id === 'b1');
    assert.deepEqual(b1.path, { 1: 'g1', 2: 'g7', 3: 'g8' });
    assert.deepEqual(r.model.groups.g7.floor, 2); // 折叠组楼层前移
    // 落库后表 = upsert + delete 的结果（旧键行必须删掉，否则同一变体会留孤儿行）
    const after = new Map(rows.map((x) => [`${x.floorNo}#${x.variantId}`, x]));
    for (const d of r.deletes) after.delete(`${d.floorNo}#${d.variantId}`);
    for (const u of r.rows) after.set(`${u.floorNo}#${u.variantId}`, u);
    assert.deepEqual([...after.keys()].sort(), ['1#g1', '2#g3', '2#g7', '3#g4', '3#g8']);
    assert.ok(r.deletes.some((d) => d.floorNo === 2 && d.variantId === 'g2')); // 被删层的行
    assert.ok(r.deletes.some((d) => d.floorNo === 3 && d.variantId === 'g3')); // 换层后旧键行
});

test('patch-rows：尾部追加（宿主 append 真机形态 add /len）→ 新变体、path 扩位', () => {
    const ctx = linear();
    const r = plan(ctx, [{ op: 'add', path: '/3', value: line('第四层') }]);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 4);
    const newRow = r.rows.find((x) => x.floorNo === 4);
    assert.equal(newRow.variantId, 'g4'); // 分配器默认续号
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4' });
    assert.deepEqual(r.deletes, []);
});

test('patch-rows：追加采用入向模型已登记的变体号（本扩展 syncAppendedFloors 形态）', () => {
    const ctx = linear();
    ctx.model = mkModel([['b_main', { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g9' }]], 'b_main');
    const r = plan(ctx, [{ op: 'add', path: '/3', value: line('第四层') }]);
    assert.equal(r.ok, true);
    assert.equal(r.rows.find((x) => x.floorNo === 4).variantId, 'g9');
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g9' });
});

test('patch-rows：走法切换（删尾段 + 加目标走法行）→ 重投影，其他走法原样保留', () => {
    // 主分支 1..3；支线 b1 与主分支共享 1..2，第 3 层是自己的 g4
    const rows = mkRows([
        [1, 'g1', line('一')],
        [2, 'g2', line('二')],
        [3, 'g3', line('主三')],
        [3, 'g4', line('支三')],
    ]);
    const model = mkModel([
        ['b_main', { 1: 'g1', 2: 'g2', 3: 'g3' }],
        ['b1', { 1: 'g1', 2: 'g2', 3: 'g4' }],
    ], 'b1');
    const r = planBodyPatch({
        rows, path: { 1: 'g1', 2: 'g2', 3: 'g3' }, model,
        ops: [{ op: 'remove', path: '/2' }, { op: 'add', path: '/2', value: line('支三') }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g2', 3: 'g4' }); // 采用目标走法的变体
    assert.deepEqual(r.model.branches.find((b) => b.id === 'b_main').path, { 1: 'g1', 2: 'g2', 3: 'g3' }); // 旧走法不动
    assert.deepEqual(r.deletes, []); // g3 行保留（非活跃走法仍引用）
    assert.equal(r.rows.find((x) => x.variantId === 'g4').floorNo, 3);
});

test('patch-rows：切到更短走法（纯 remove）→ 重投影而非全局删层', () => {
    const rows = mkRows([
        [1, 'g1', line('一')],
        [2, 'g2', line('二')],
        [3, 'g3', line('主三')],
        [4, 'g4', line('主四')],
        [5, 'g5', line('主五')],
    ]);
    const model = mkModel([
        ['b_main', { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4', 5: 'g5' }],
        ['b1', { 1: 'g1', 2: 'g2', 3: 'g6' }],
    ], 'b1');
    rows.push({ floorNo: 3, variantId: 'g6', seq: 0, content: JSON.stringify(line('支三')), contentHash: null, sendDate: null });
    const r = planBodyPatch({
        rows, path: model.branches[0].path, model,
        ops: [
            { op: 'remove', path: '/4' }, { op: 'remove', path: '/3' },
            { op: 'remove', path: '/2' }, { op: 'add', path: '/2', value: line('支三') },
        ],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.path, { 1: 'g1', 2: 'g2', 3: 'g6' });
    assert.deepEqual(r.model.branches.find((b) => b.id === 'b_main').path, { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4', 5: 'g5' });
    assert.deepEqual(r.deletes, []); // 主分支的 3/4/5 层一律保留
});

test('patch-rows：中间插入新楼层 → 拒绝（模型无法表达，宿主会回退全量保存）', () => {
    const ctx = linear();
    const r = plan(ctx, [{ op: 'add', path: '/1', value: line('插到第二层') }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mid-insert-unsupported');
});

test('patch-rows：非法形态（根路径 / 非索引路径 / 越界）一律拒绝，不半写', () => {
    const ctx = linear();
    assert.equal(plan(ctx, [{ op: 'add', path: '', value: {} }]).reason, 'root-path-unsupported');
    assert.equal(plan(ctx, [{ op: 'add', path: '/extensions/x', value: 1 }]).reason, 'non-index-path');
    assert.equal(plan(ctx, [{ op: 'remove', path: '/9' }]).reason, 'index-out-of-range');
    assert.equal(plan(ctx, [{ op: 'replace', path: '/9/mes', value: 'x' }]).reason, 'index-out-of-range');
    assert.equal(plan(ctx, [{ op: 'flip', path: '/0' }]).reason, 'unsupported-op');
});

test('patch-rows：投影不全（path 引用的变体无行）→ projection-incomplete（不猜）', () => {
    const ctx = linear();
    ctx.rows = ctx.rows.filter((r) => r.variantId !== 'g2');
    const r = plan(ctx, [{ op: 'add', path: '/0/extra/x', value: 1 }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'projection-incomplete');
});

test('patch-rows：空 ops → 原样返回（不产生写入）', () => {
    const ctx = linear();
    const r = plan(ctx, []);
    assert.equal(r.ok, true);
    assert.equal(r.deletes.length, 0);
    assert.deepEqual(r.rows.map((x) => `${x.floorNo}#${x.variantId}`), ['1#g1', '2#g2', '3#g3']);
    assert.deepEqual(r.path, ctx.path);
});
