/**
 * store-bridge 单测：库形态 ⇄ 现有模型形态互转（design.md §8.2）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromStore, storeFromModel, opsToStoreOps } from '../../public/scripts/extensions/third-party/chatfilesys/core/store-bridge.js';

const family = {
    familyId: 'f1', chatKey: 'av1::chat1', characterId: 'c1', name: 'chat1', integrity: 3,
    branches: [
        { id: 'b_main', name: '主分支', is_default: true, fork_floor: 0, parent_branch_id: null },
        { id: 'b2', name: '支线', is_default: false, fork_floor: 1, parent_branch_id: null },
    ],
    branchPaths: { b_main: { 1: 'g1', 2: 'g2' }, b2: { 1: 'g1', 2: 'g3' } },
    model: { active_branch: 'b_main', branches: [], groups: {} },
};

const floors = [
    { floorNo: 1, variantId: 'g1', seq: 0, content: '{"name":"我","is_user":true,"mes":"a","send_date":1}', contentHash: 'h1', sendDate: 1 },
    { floorNo: 2, variantId: 'g2', seq: 0, content: '{"name":"AI","is_user":false,"mes":"b","send_date":2}', contentHash: 'h2', sendDate: 2 },
    { floorNo: 2, variantId: 'g3', seq: 0, content: '{"name":"AI","is_user":false,"mes":"b2","send_date":3}', contentHash: 'h3', sendDate: 3 },
];

test('modelFromStore：branches/path 映射 + active 认定', () => {
    const m = modelFromStore(family, floors);
    assert.equal(m.active_branch, 'b_main');
    assert.equal(m.branches.length, 2);
    assert.equal(m.branches[1].fork_base, 1);
    assert.equal(m.branches[1].path[2], 'g3');
});

test('modelFromStore：groups 折叠组重建（非活跃分支变体）', () => {
    const m = modelFromStore(family, floors);
    // g3 属于非活跃分支 b2 → 折叠进 groups；g2（活跃）不进
    assert.ok(m.groups.g3);
    assert.equal(m.groups.g3.floor, 2);
    assert.equal(m.groups.g3.variants.length, 1);
    assert.equal(m.groups.g3.variants[0].mes, 'b2');
    assert.equal(m.groups.g2, undefined);
});

test('modelFromStore：活跃分支行不重复进 groups（不变量 3 保持）', () => {
    const m = modelFromStore(family, floors);
    const active = m.branches.find((b) => b.id === m.active_branch);
    const activeGids = new Set(Object.values(active.path));
    for (const gid of Object.keys(m.groups)) {
        assert.equal(activeGids.has(gid), false);
    }
});

test('storeFromModel：往返无损（branches/branchPaths/身份）', () => {
    const m = modelFromStore(family, floors);
    const meta = storeFromModel(m, { familyId: 'f1', chatKey: 'av1::chat1', characterId: 'c1', name: 'chat1', integrity: 3 });
    assert.equal(meta.familyId, 'f1');
    assert.equal(meta.branches.length, 2);
    assert.equal(meta.branches[1].fork_floor, 1);
    assert.equal(meta.branchPaths.b2[2], 'g3');
});

test('opsToStoreOps：M1 恒等透传', () => {
    const ops = [{ op: 'remove', path: '/1' }];
    assert.deepEqual(opsToStoreOps(ops), ops);
    assert.deepEqual(opsToStoreOps(null), []);
});
