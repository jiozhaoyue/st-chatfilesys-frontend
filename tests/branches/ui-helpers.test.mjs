/**
 * T4 单测：面板辅助纯函数（N5/N13/N15）
 * - 走法标签默认自动序号 / 自定义名附后
 * - 摘要截断
 * - 拼出走法消息行（活跃走法在 body、非活跃走法在 groups 折叠区）
 * - 树布局方向（向下 / 向右）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeLabel, branchSummaryOf, assembleBranchLines } from '../../public/scripts/extensions/third-party/chatfilesys/ui/common.js';
import { layoutTree } from '../../public/scripts/extensions/third-party/chatfilesys/ui/tree.js';

/* ---------------- 标签（N5/N13：默认自动序号） ---------------- */

test('ui：走法标签默认自动序号，自定义名附在序号后', () => {
    assert.equal(nodeLabel({ name: '主分支' }, 0), '#1');
    assert.equal(nodeLabel({ name: '分支2' }, 1), '#2');       // 插件自动命名 → 只显示序号
    assert.equal(nodeLabel({ name: '分叉·F3' }, 2), '#3');
    assert.equal(nodeLabel({ name: '' }, 3), '#4');
    assert.equal(nodeLabel({}, 0), '#1');
    assert.equal(nodeLabel({ name: '打斗之前' }, 4), '#5 打斗之前'); // 自定义名保留
    assert.equal(nodeLabel({ name: '我的聊天 - Branch #1' }, 5), '#6 我的聊天 - B…'); // 长名截断
});

test('ui：摘要截断到 24 字；空摘要不显示', () => {
    assert.equal(branchSummaryOf({}), '');
    assert.equal(branchSummaryOf({ summary: '   ' }), '');
    assert.equal(branchSummaryOf({ summary: '短' }), '短');
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const cut = branchSummaryOf({ summary: long });
    assert.equal(cut.length, 25); // 24 字 + 省略号
    assert.ok(cut.endsWith('…'));
});

/* ---------------- 走法消息行拼接（摘要输入） ---------------- */

function model() {
    return {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } },
            { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7' } },
        ],
        groups: { g7: { id: 'g7', floor: 2, owner: 'b1', active: 0, variants: [{ mes: '支线二' }] } },
    };
}
const CHAT = [{ mes: '一' }, { mes: '二' }];

test('ui：拼走法行——活跃走法取 body，非活跃走法取 groups 折叠区', () => {
    const m = model();
    assert.deepEqual(assembleBranchLines(m, CHAT, m.branches[0]), [{ mes: '一' }, { mes: '二' }]);
    assert.deepEqual(assembleBranchLines(m, CHAT, m.branches[1]), [{ mes: '一' }, { mes: '支线二' }]);
});

test('ui：拼走法行——多变体组取组内 active；缺口不外溢', () => {
    const m = model();
    m.groups.g7 = { id: 'g7', floor: 2, owner: 'b1', active: 1, variants: [{ mes: 'v0' }, { mes: 'v1' }] };
    assert.deepEqual(assembleBranchLines(m, CHAT, m.branches[1]), [{ mes: '一' }, { mes: 'v1' }]);
    // body 缺行（库不自洽）→ 该层跳过，不抛
    assert.deepEqual(assembleBranchLines(m, [], m.branches[0]), []);
    assert.deepEqual(assembleBranchLines(null, CHAT, m.branches[0]), []);
});

/* ---------------- 树方向（N13：可切右） ---------------- */

test('ui：树布局向下/向右——深度轴与兄弟轴互换', () => {
    const m = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1' } },
            { id: 'b1', name: '分支2', is_default: false, fork_base: 1, path: { 1: 'g1' } },
        ],
        groups: {},
    };
    const down = layoutTree(m, { direction: 'down' });
    const right = layoutTree(m, { direction: 'right' });
    const byId = (arr) => new Map(arr.map((n) => [n.branch.id, n]));
    const d = byId(down); const r = byId(right);
    // b1 是 b_main 的子 → 深度 1
    assert.ok(d.get('b1').y > d.get('b_main').y, '向下：深度增加 = y 增大');
    assert.equal(d.get('b1').x, d.get('b_main').x, '向下：单子节点 x 不变');
    assert.ok(r.get('b1').x > r.get('b_main').x, '向右：深度增加 = x 增大');
    assert.equal(r.get('b1').y, r.get('b_main').y, '向右：单子节点 y 不变');
    // 默认参数 = 向下
    assert.deepEqual(layoutTree(m).map((n) => [n.x, n.y]), down.map((n) => [n.x, n.y]));
    // 父子关系两种方向都一致
    assert.equal(d.get('b1').parent, 'b_main');
    assert.equal(r.get('b1').parent, 'b_main');
});
