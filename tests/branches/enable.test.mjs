import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableForChat, registerAppendedGroup, validate, getActive, maxFloor, createBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { seedBody } from './fixtures.mjs';

test('enableForChat：每行一层一组，默认分支 path 连续', () => {
    const body = seedBody();
    const m = enableForChat(body);
    const main = getActive(m);
    assert.equal(main.id, 'b_main');
    assert.equal(main.is_default, true);
    assert.deepEqual(Object.keys(main.path).map(Number), [1, 2, 3, 4, 5]);
    assert.deepEqual(Object.values(main.path), ['g1', 'g2', 'g3', 'g4', 'g5']);
    assert.equal(validate(m, body.length).ok, true);
});

test('registerAppendedGroup：原生 append 后登记新楼层', () => {
    const body = seedBody();
    const m = enableForChat(body);
    body.push({ name: '我', is_user: true, mes: '新的一层', send_date: 1, extra: {} });
    const gid = registerAppendedGroup(m, body.length);
    assert.equal(gid, 'g6');
    assert.equal(maxFloor(getActive(m)), 6);
    assert.equal(validate(m, body.length).ok, true);
});

test('registerAppendedGroup：跳层登记应抛错', () => {
    const body = seedBody();
    const m = enableForChat(body);
    assert.throws(() => registerAppendedGroup(m, 9), /maxFloor\+1/);
});

/**
 * W3 回归（2026-09-26）：在**原生分支/检查点键**上发消息时，body 是该键所在分支的投影，
 * 而家族活跃分支是另一条（T1 接管刻意不改它）。登记目标必须按键解析——按家族活跃分支登记
 * 会抛「新楼层 ≠ maxFloor+1」，该键的新楼层永远进不了模型（后续 metadata 写把库内 path 抹回旧版）。
 */
test('registerAppendedGroup：绑定分支上追加 → 登记到该分支，家族活跃分支不动', () => {
    const body = seedBody();                       // 主分支 5 层
    const m = enableForChat(body);
    const b1 = createBranch(m, { name: '主聊天 - Branch #1', forkFloor: 2, activate: false }); // b1：只到第 2 层
    assert.equal(maxFloor(getActive(m)), 5, '家族活跃分支仍是主分支');
    // 打开该绑定键（body = b1 的投影 2 行）+ 用户又发一条 → body 3 行
    const gid = registerAppendedGroup(m, 3, b1.id);
    assert.equal(b1.path[3], gid, '新楼层登记到本键所在分支');
    assert.equal(maxFloor(b1), 3);
    assert.equal(maxFloor(getActive(m)), 5, '绝不改家族活跃分支');
    assert.equal(m.branches[0].path[3], 'g3', '主分支第 3 层不受影响');
});

test('registerAppendedGroup：指定不存在的分支 → 抛错（不静默落到家族活跃分支）', () => {
    const m = enableForChat(seedBody());
    assert.throws(() => registerAppendedGroup(m, 6, 'b9'), /不存在/);
});

test('createBranch：fork 引用共享前缀，零复制', () => {
    const body = seedBody();
    const m = enableForChat(body);
    const b = createBranch(m, { name: '支线', forkFloor: 3, activate: false });
    for (let f = 1; f <= 3; f++) assert.equal(b.path[f], getActive(m).path[f]);
    assert.equal(Object.keys(b.path).length, 3);
    assert.equal(validate(m, body.length).ok, true);
});
