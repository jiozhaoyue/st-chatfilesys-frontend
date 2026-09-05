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

test('createBranch：fork 引用共享前缀，零复制', () => {
    const body = seedBody();
    const m = enableForChat(body);
    const b = createBranch(m, { name: '支线', forkFloor: 3, activate: false });
    for (let f = 1; f <= 3; f++) assert.equal(b.path[f], getActive(m).path[f]);
    assert.equal(Object.keys(b.path).length, 3);
    assert.equal(validate(m, body.length).ok, true);
});
