import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { seedModel, seedBody } from './fixtures.mjs';

test('种子模型通过全部不变量校验', () => {
    const m = seedModel();
    const r = validate(m, 5);
    assert.deepEqual(r, { ok: true, errors: [] });
});

test('不变量2：path 楼层号不连续被检出', () => {
    const m = seedModel();
    const main = m.branches.find((b) => b.is_default);
    delete main.path[3];
    const r = validate(m, 5);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('不连续')));
});

test('不变量3：活跃分支引用的组同时存在于 groups → 重复存储被检出', () => {
    const m = seedModel();
    m.groups['g5'] = { id: 'g5', floor: 5, owner: null, active: 0, variants: [{ name: 'x', is_user: false, mes: 'dup' }] };
    const r = validate(m, 5);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('重复存储')));
});

test('不变量3：非活跃分支引用的组缺失被检出', () => {
    const m = seedModel();
    delete m.groups['g6'];
    const r = validate(m, 5);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('g6')));
});

test('body 行数与活跃分支楼层数不一致被检出', () => {
    const m = seedModel();
    const r = validate(m, 7);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('body 行数')));
});

test('active_branch 不存在被检出', () => {
    const m = seedModel();
    m.active_branch = 'b_nope';
    const r = validate(m, 5);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('active_branch')));
});

test('body 与 seed 夹具一致性（防止夹具漂移）', () => {
    const body = seedBody();
    assert.equal(body.length, 5);
    assert.ok(Array.isArray(body[1].swipes) && body[1].swipes.length === 2);
});
