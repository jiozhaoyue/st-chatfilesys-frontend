import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDeleteFloor } from '../../public/scripts/extensions/third-party/chatfilesys/core/projection.js';
import { validate, getBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { applyOperationsLocally } from '../../public/scripts/extensions/third-party/chatfilesys/core/chat-writer.js';
import { seedModel, seedBody } from './fixtures.mjs';

test('删除活跃 body 内的楼层：remove 一发 + 全局重编号', () => {
    const body = seedBody();
    const m = seedModel(body);
    const { operations, model } = planDeleteFloor(m, 2, body);

    assert.deepEqual(operations.map((o) => `${o.op} ${o.path}`), ['remove /1']);
    const nextBody = applyOperationsLocally(structuredClone(body), operations);
    assert.equal(nextBody.length, 4);

    // main：{1:g1, 2:g3, 3:g4, 4:g5}（原 3..5 前移）
    const main = getBranch(model, 'b_main');
    assert.deepEqual(main.path, { 1: 'g1', 2: 'g3', 3: 'g4', 4: 'g5' });

    // b1：fork_base 4→3，私有组楼层 5/6 → 4/5
    const b1 = getBranch(model, 'b1');
    assert.equal(b1.fork_base, 3);
    assert.deepEqual(b1.path, { 1: 'g1', 2: 'g3', 3: 'g4', 4: 'g6', 5: 'g7' });
    assert.equal(model.groups['g6'].floor, 4);
    assert.equal(model.groups['g7'].floor, 5);

    // b2：fork@2 只含楼层2 → 失去唯一自有层，fork_base 2→1
    const b2 = getBranch(model, 'b2');
    assert.deepEqual(b2.path, { 1: 'g1' });
    assert.equal(b2.fork_base, 1);

    assert.equal(validate(model, nextBody.length).ok, true);
});

test('删除仅存在于折叠分支的楼层：无 body 操作，组被清理', () => {
    const body = seedBody();
    const m = seedModel(body); // main 活跃，max=5；b1 有折叠楼层 6
    const { operations, model } = planDeleteFloor(m, 6, body);

    assert.deepEqual(operations, []);
    const b1 = getBranch(model, 'b1');
    assert.deepEqual(b1.path, { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4', 5: 'g6' });
    assert.equal(model.groups['g7'], undefined);
    assert.equal(b1.fork_base, 4);
    assert.equal(validate(model, 5).ok, true);
});

test('删除超范围楼层抛错', () => {
    const body = seedBody();
    const m = seedModel(body);
    assert.throws(() => planDeleteFloor(m, 9, body), /超出范围/);
    assert.throws(() => planDeleteFloor(m, 0, body), /超出范围/);
});
