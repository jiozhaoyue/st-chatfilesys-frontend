/**
 * T4 单测：面板辅助纯函数（N5/N13/N15）
 * - 分支标签默认自动序号 / 自定义名附后
 * - 摘要截断
 * - 拼出分支消息行（活跃分支在 body、非活跃分支在 groups 折叠区）
 * - 树布局方向（向下 / 向右）
 * - **该层 swipe 组列表 / 版本按钮计数**（R5 2026-09-25：版本按钮的唯一数据源）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeLabel, branchSummaryOf, assembleBranchLines, swipeGroupsAt, versionButtonLabel, detectForkFloors, getActiveBranch } from '../../public/scripts/extensions/third-party/chatfilesys/ui/common.js';
import { layoutTree } from '../../public/scripts/extensions/third-party/chatfilesys/ui/tree.js';
import { branchIdForKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/takeover.js';

/* ---------------- 标签（N5/N13：默认自动序号） ---------------- */

test('ui：分支标签默认自动序号，自定义名附在序号后', () => {
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

/* ---------------- 分支消息行拼接（摘要输入） ---------------- */

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

test('ui：拼分支行——活跃分支取 body，非活跃分支取 groups 折叠区', () => {
    const m = model();
    assert.deepEqual(assembleBranchLines(m, CHAT, m.branches[0]), [{ mes: '一' }, { mes: '二' }]);
    assert.deepEqual(assembleBranchLines(m, CHAT, m.branches[1]), [{ mes: '一' }, { mes: '支线二' }]);
});

test('ui：拼分支行——多变体组取组内 active；缺口不外溢', () => {
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

/* ---------------- 该层 swipe 组（R5：版本按钮的唯一数据源） ---------------- */

/** 两层分支 + 二层两组的家族（b_main 走 g1/g2，b1 走 g1/g7 → 第 2 层是分叉点） */
function forkModel() {
    return {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } },
            { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7' } },
        ],
        groups: { g7: { id: 'g7', floor: 2, owner: 'b1', active: 0, variants: [{ mes: '支线二' }] } },
    };
}

test('ui：swipeGroupsAt——组序 = 分支声明顺序，当前组标注 isActive', () => {
    const m = forkModel();
    const g = swipeGroupsAt(m, 2, [{ mes: '一二' }, { mes: '主线二' }]);
    assert.equal(g.length, 2, '第 2 层两个组');
    assert.deepEqual(g.map((x) => x.gid), ['g2', 'g7']);
    assert.deepEqual(g.map((x) => x.isActive), [true, false]);
    // 共享组的归属：两条分支都列在 g1 上
    const g1 = swipeGroupsAt(m, 1, [{ mes: '一' }]);
    assert.equal(g1.length, 1);
    assert.deepEqual(g1[0].branchIds, ['b_main', 'b1']);
});

test('ui：swipeGroupsAt——组内 swipe 数：活跃组读 body 行，折叠组读 variants', () => {
    const m = forkModel();
    // 活跃组的 body 行带 3 个原生 swipe，swipe_id=2
    const active = swipeGroupsAt(m, 2, [{}, { mes: 'v2', swipes: ['v0', 'v1', 'v2'], swipe_id: 2 }])[0];
    assert.equal(active.variantCount, 3);
    assert.equal(active.activeVariant, 2);
    // 折叠组的 variants 数
    m.groups.g7.variants = [{ mes: 'a' }, { mes: 'b' }];
    m.groups.g7.active = 1;
    const folded = swipeGroupsAt(m, 2, [{}, { mes: '主线二' }])[1];
    assert.equal(folded.variantCount, 2);
    assert.equal(folded.activeVariant, 1);
});

test('ui：swipeGroupsAt——单组层只返回一个组；越界/无模型返回空', () => {
    const m = forkModel();
    assert.equal(swipeGroupsAt(m, 1, [{}]).length, 1);
    assert.deepEqual(swipeGroupsAt(m, 9, []), [], '该层没有组 → 空');
    assert.deepEqual(swipeGroupsAt(null, 2, []), []);
    assert.deepEqual(swipeGroupsAt(m, 0, []), [], '楼层号从 1 起');
});

test('ui：versionButtonLabel——组数 ≤ 1 → 空串（该消息上零插件元素）', () => {
    const m = forkModel();
    assert.equal(versionButtonLabel(m, 1, [{}]), '', '单组层不出按钮');
    assert.equal(versionButtonLabel(m, 2, [{}, { mes: '主线二' }]), '⎇ 1/2', '当前组序号/组总数');
    assert.equal(versionButtonLabel(null, 2, []), '');
});

test('ui：versionButtonLabel——切到第二条分支后当前组序号随之变化', () => {
    const m = forkModel();
    m.active_branch = 'b1';
    // b1 为活跃时 g7 进 body（当前组），g2 折叠
    const g = swipeGroupsAt(m, 2, [{ mes: '一' }, { mes: '支线二' }]);
    assert.equal(g.length, 2);
    assert.deepEqual(g.map((x) => x.isActive), [false, true]);
    assert.equal(versionButtonLabel(m, 2, [{ mes: '一' }, { mes: '支线二' }]), '⎇ 2/2');
});

test('ui：detectForkFloors 与 swipeGroupsAt 的「分叉点」判定一致（不变式 5）', () => {
    const m = forkModel();
    const forks = detectForkFloors(m);
    for (const f of [1, 2]) {
        assert.equal(forks.has(f), swipeGroupsAt(m, f, [{}]).length > 1, `第 ${f} 层`);
    }
    assert.deepEqual([...forks], [2]);
});

/* ---------------- W3：当前分支由调用方传入（按键绑定优先，回落家族活跃分支） ---------------- */

test('ui：getActiveBranch 收 branchId 参数——绑定键优先，缺省回落 active_branch', () => {
    const m = forkModel();
    assert.equal(getActiveBranch(m).id, 'b_main', '缺省 = 家族活跃分支');
    assert.equal(getActiveBranch(m, 'b1').id, 'b1', '传入绑定分支 → 以它为准');
    assert.equal(getActiveBranch(m, null).id, 'b_main');
    assert.equal(getActiveBranch(m, '不存在的分支').id, 'b_main', '查不到回落 branches[0]');
});

test('ui：swipeGroupsAt/versionButtonLabel 按传入分支认「当前组」（W3 症状：别的组被标成当前组）', () => {
    const m = forkModel();
    // 打开原生分支键 b1 时：body 是 b1 的投影（第 1 层共享，第 2 层是 b1 的组）
    const bodyOfB1 = [{ mes: '一' }, { mes: '支线二', swipes: ['支线二', '支线二-2'], swipe_id: 1 }];
    const g = swipeGroupsAt(m, 2, bodyOfB1, 'b1');
    assert.deepEqual(g.map((x) => x.gid), ['g2', 'g7']);
    assert.deepEqual(g.map((x) => x.isActive), [false, true], '当前组 = b1 引用的那个组');
    // 组内版本数取自 body（b1 那行的 swipes 数），不是 groups 折叠区
    assert.equal(g[1].variantCount, 2);
    assert.equal(g[1].activeVariant, 1);
    assert.equal(versionButtonLabel(m, 2, bodyOfB1, 'b1'), '⎇ 2/2');
    // 同一份 body、缺省 branchId：仍按家族活跃分支判定 → 当前组错位（这就是 W3 要修的旧行为）
    assert.equal(versionButtonLabel(m, 2, bodyOfB1), '⎇ 1/2');
});

test('ui：assembleBranchLines 按传入分支判断「body 属于谁」', () => {
    const m = forkModel();
    const bodyOfB1 = [{ mes: '一' }, { mes: '支线二' }];
    // b1 是当前分支 → 它引用的组都在 body，直接取 body 两行
    assert.deepEqual(assembleBranchLines(m, bodyOfB1, m.branches[1], 'b1'), bodyOfB1);
});

test('ui：键绑定解析单点 = branchIdForKey（绑定键优先、回落家族活跃分支）', () => {
    const family = {
        model: { active_branch: 'b_main' },
        keyBindings: { 'av1::主聊天 - checkpoint #1': { branchId: 'b2', mainChat: '主聊天' } },
    };
    assert.equal(branchIdForKey(family, 'av1::主聊天 - checkpoint #1'), 'b2');
    assert.equal(branchIdForKey(family, 'av1::主聊天'), 'b_main');
    assert.equal(branchIdForKey({ model: { active_branch: 'b_main' } }, 'av1::任意'), 'b_main');
    assert.equal(branchIdForKey(null, 'x'), null);
});
