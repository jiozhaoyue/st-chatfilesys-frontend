import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFromLine, lineFromGroup, activeProjection, planSwitch } from '../../public/scripts/extensions/third-party/chatfilesys/core/projection.js';
import { validate } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { applyOperationsLocally, bodyPath } from '../../public/scripts/extensions/third-party/chatfilesys/core/chat-writer.js';
import { seedModel, seedBody } from './fixtures.mjs';

test('groupFromLine ⇄ lineFromGroup 对多 swipe 行 round-trip 无损', () => {
    const body = seedBody();
    const swipedLine = body[1];
    const g = groupFromLine('g2', 2, swipedLine);
    assert.equal(g.variants.length, 2);
    assert.equal(g.active, 0);
    assert.equal(g.variants[1].send_date, swipedLine.swipe_info[1].send_date);
    assert.deepEqual(g.variants[1].extra, swipedLine.swipe_info[1].extra);
    const back = lineFromGroup(g);
    assert.deepEqual(back, swipedLine);
    assert.deepEqual(groupFromLine('g2', 2, back), g);
});

test('groupFromLine ⇄ lineFromGroup 对单行 round-trip 无损', () => {
    const body = seedBody();
    const g = groupFromLine('g4', 4, body[3]);
    assert.equal(g.variants.length, 1);
    assert.deepEqual(lineFromGroup(g), body[3]);
});

test('activeProjection：path 楼层号与 body 行位置对齐', () => {
    const body = seedBody();
    const m = seedModel(body);
    const proj = activeProjection(m, body);
    assert.equal(proj.length, 5);
    assert.deepEqual(proj.map((p) => p.floor), [1, 2, 3, 4, 5]);
    assert.deepEqual(proj.map((p) => p.gid), ['g1', 'g2', 'g3', 'g4', 'g5']);
});

test('planSwitch main→b1：共享前缀不动，尾部 remove+add，模型折叠/展开正确', () => {
    const body = seedBody();
    const m = seedModel(body);
    const { operations, model, switchedTo } = planSwitch(m, 'b1', body);

    assert.equal(switchedTo, 'b1');
    assert.deepEqual(operations.map((o) => `${o.op} ${o.path}`), [
        `remove ${bodyPath(4)}`,
        `add ${bodyPath(4)}`,
        `add ${bodyPath(5)}`,
    ]);

    // 本地应用操作 → body 即目标分支投影
    const nextBody = applyOperationsLocally(structuredClone(body), operations);
    assert.equal(nextBody.length, 6);
    assert.equal(nextBody[4].mes, '『你们攀上旋梯。塔顶的风铃是一个古老的警报器——它醒了。』');
    assert.equal(nextBody[5].mes, '拔剑。先下手为强。');

    // 模型：main 的 g5 折叠（owner 派生为共享），b1 的 g6/g7 离开 groups
    assert.ok(model.groups['g5'], 'main 尾组应折叠');
    assert.equal(model.groups['g5'].owner, null);
    assert.equal(model.groups['g6'], undefined);
    assert.equal(model.groups['g7'], undefined);
    assert.equal(validate(model, nextBody.length).ok, true);
});

test('planSwitch 往返 main→b1→main：body 与模型均还原', () => {
    const body = seedBody();
    const m = seedModel(body);
    const snapshot = structuredClone({ model: m, body });

    const s1 = planSwitch(m, 'b1', body);
    const body1 = applyOperationsLocally(structuredClone(body), s1.operations);
    const s2 = planSwitch(m, 'b_main', body1);
    const body2 = applyOperationsLocally(structuredClone(body1), s2.operations);

    assert.deepEqual(body2, snapshot.body);
    assert.deepEqual(JSON.parse(JSON.stringify(s2.model)), JSON.parse(JSON.stringify(snapshot.model)));
    assert.equal(validate(s2.model, body2.length).ok, true);
});

test('planSwitch main→b2（未续聊分支）：body 收缩，尾组全部折叠', () => {
    const body = seedBody();
    const m = seedModel(body);
    const { operations, model } = planSwitch(m, 'b2', body);

    assert.deepEqual(operations.map((o) => o.op), ['remove', 'remove', 'remove']);
    const nextBody = applyOperationsLocally(structuredClone(body), operations);
    assert.equal(nextBody.length, 2);
    assert.equal(validate(model, 2).ok, true);
    for (const gid of ['g3', 'g4', 'g5']) {
        assert.ok(model.groups[gid], `${gid} 应折叠`);
        assert.equal(model.groups[gid].owner, null);
    }
});

test('planSwitch 同分支：无操作', () => {
    const body = seedBody();
    const m = seedModel(body);
    const { operations } = planSwitch(m, 'b_main', body);
    assert.deepEqual(operations, []);
});
