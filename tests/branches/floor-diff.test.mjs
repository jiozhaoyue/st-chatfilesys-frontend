/**
 * W1 单测：`core/floor-diff.js#detectRemovedFloors`
 *
 * 覆盖真机的四种删除形态（单条 / 删最后一条 / 从某层删到末尾 / 跨块批量）+ 四类必须**不判定**
 * 的情形（追加、整体换载、前置加载、参数非法），因为在错误判定下改模型会静默改坏分支结构。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRemovedFloors } from '../../public/scripts/extensions/third-party/chatfilesys/core/floor-diff.js';

/** 真机形态：body 是消息对象数组（对象引用就是身份） */
function body(...names) {
    return names.map((n) => ({ name: n, mes: `m-${n}` }));
}

test('floor-diff：中间删一条 → 精确指出该层', () => {
    const [a, b, c, d] = body('a', 'b', 'c', 'd');
    assert.deepEqual(detectRemovedFloors([a, b, c, d], [a, c, d]), [2]);
    assert.deepEqual(detectRemovedFloors([a, b, c, d], [a, b, d]), [3]);
    assert.deepEqual(detectRemovedFloors([a, b, c, d], [b, c, d]), [1]);
});

test('floor-diff：删最后一条（宿主 deleteLastMessage / 重生成回退）', () => {
    const [a, b, c] = body('a', 'b', 'c');
    assert.deepEqual(detectRemovedFloors([a, b, c], [a, b]), [3]);
});

test('floor-diff：从某层删到末尾（宿主 chat.length = N 截断）', () => {
    const [a, b, c, d] = body('a', 'b', 'c', 'd');
    assert.deepEqual(detectRemovedFloors([a, b, c, d], [a, b]), [3, 4]);
    assert.deepEqual(detectRemovedFloors([a, b, c, d], []), [1, 2, 3, 4]);
});

test('floor-diff：跨块批量删除（deleteMessages([0, 2]) 降序 splice）', () => {
    const [a, b, c, d, e] = body('a', 'b', 'c', 'd', 'e');
    assert.deepEqual(detectRemovedFloors([a, b, c, d, e], [b, d, e]), [1, 3]);
    assert.deepEqual(detectRemovedFloors([a, b, c, d, e], [a, c, e]), [2, 4]);
});

test('floor-diff：行数不变或变多 → 不判定（追加/换 swipe/编辑交给各自的路径）', () => {
    const [a, b] = body('a', 'b');
    const c = body('c')[0];
    assert.equal(detectRemovedFloors([a, b], [a, b]), null, '行数不变');
    assert.equal(detectRemovedFloors([a, b], [a, b, c]), null, '追加');
    assert.equal(detectRemovedFloors([a, b], [c, a, b]), null, '前置加载更早的消息（MORE_MESSAGES_LOADED）');
});

test('floor-diff：对象被整体换过（重新加载聊天）→ 不判定，绝不当成删除', () => {
    // getChat 整批 splice 新对象：引用全不同，但行数可能刚好少一行
    const oldBody = body('a', 'b', 'c');
    const newBody = body('a', 'b');
    assert.equal(detectRemovedFloors(oldBody, newBody), null);
});

test('floor-diff：当前里出现基线没有的对象 → 不判定（不是「只删了若干层」）', () => {
    const [a, b, c] = body('a', 'b', 'c');
    const x = body('x')[0];
    assert.equal(detectRemovedFloors([a, b, c], [a, x]), null);
});

test('floor-diff：参数非法 → 不判定', () => {
    const [a] = body('a');
    assert.equal(detectRemovedFloors(null, [a]), null);
    assert.equal(detectRemovedFloors([a], null), null);
    assert.equal(detectRemovedFloors(undefined, undefined), null);
});

test('floor-diff：同一对象在多层出现（原生克隆/重复引用）仍能定位', () => {
    const a = body('a')[0];
    const x = body('x')[0];
    assert.deepEqual(detectRemovedFloors([a, x, a], [a]), [2, 3]);
});
