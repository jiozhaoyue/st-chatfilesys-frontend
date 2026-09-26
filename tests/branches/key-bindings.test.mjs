/**
 * T4r.9 单测：键绑定纯函数（走法改名双向对齐，design.md §5.6 不变式 3）
 *
 * 覆盖：绑定键查询 / 改名后的旧键→新键迁移 / 保守语义（新键已占用不覆盖、键不存在不迁）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundKeysOfBranch, migrateBindingKey, dropBindingsOfBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/key-bindings.js';

/** 真机形态的 keyBindings：根键无绑定，原生分支/检查点键各绑一条走法 */
function kb() {
    return {
        'char.png::主聊天': { branchId: 'b_main' },
        'char.png::主聊天 - branch #1': { branchId: 'b1', mainChat: '主聊天' },
        'char.png::主聊天 - checkpoint #1': { branchId: 'b2', mainChat: '主聊天', isCheckpoint: true, markerFloor: 3 },
    };
}

test('key-bindings：boundKeysOfBranch 只取该走法的绑定键', () => {
    assert.deepEqual(boundKeysOfBranch(kb(), 'b1').map(([k]) => k), ['char.png::主聊天 - branch #1']);
    assert.deepEqual(boundKeysOfBranch(kb(), 'b2').map(([k]) => k), ['char.png::主聊天 - checkpoint #1']);
    assert.deepEqual(boundKeysOfBranch(kb(), 'b9'), [], '无绑定键');
    assert.deepEqual(boundKeysOfBranch(null, 'b1'), []);
    assert.deepEqual(boundKeysOfBranch(kb(), ''), []);
});

test('key-bindings：migrateBindingKey 把旧键搬到新键，绑定值原样带走', () => {
    const before = kb();
    const next = migrateBindingKey(before, 'char.png::主聊天 - branch #1', 'char.png::打斗之前');
    assert.ok(next, '应产生新表');
    assert.equal(Object.hasOwn(next, 'char.png::主聊天 - branch #1'), false, '旧键移除');
    assert.deepEqual(next['char.png::打斗之前'], { branchId: 'b1', mainChat: '主聊天' });
    // 纯函数：不改入参
    assert.equal(Object.hasOwn(before, 'char.png::主聊天 - branch #1'), true);
    // 其余绑定不动，且键数量不变（一次改名只搬一个键）
    assert.deepEqual(next['char.png::主聊天'], before['char.png::主聊天']);
    assert.deepEqual(next['char.png::主聊天 - checkpoint #1'], before['char.png::主聊天 - checkpoint #1']);
    assert.equal(Object.keys(next).length, Object.keys(before).length);
});

test('key-bindings：migrateBindingKey 保守语义——旧键不存在不迁', () => {
    assert.equal(migrateBindingKey(kb(), 'char.png::不存在', 'char.png::新名'), null);
});

test('key-bindings：migrateBindingKey 保守语义——新键已被占用不覆盖', () => {
    assert.equal(migrateBindingKey(kb(), 'char.png::主聊天 - branch #1', 'char.png::主聊天'), null);
});

test('key-bindings：migrateBindingKey 空参数/同名键 → 不迁', () => {
    assert.equal(migrateBindingKey(kb(), 'a', 'a'), null);
    assert.equal(migrateBindingKey(kb(), '', 'b'), null);
    assert.equal(migrateBindingKey(kb(), 'a', ''), null);
    assert.equal(migrateBindingKey(null, 'a', 'b'), null);
});

test('key-bindings：检查点标记随迁移保留（改名不丢 isCheckpoint/markerFloor）', () => {
    const next = migrateBindingKey(kb(), 'char.png::主聊天 - checkpoint #1', 'char.png::到那一层为止');
    assert.deepEqual(next['char.png::到那一层为止'], { branchId: 'b2', mainChat: '主聊天', isCheckpoint: true, markerFloor: 3 });
    // 迁移后仍能被该走法查回
    assert.deepEqual(boundKeysOfBranch(next, 'b2').map(([k]) => k), ['char.png::到那一层为止']);
});

test('key-bindings：dropBindingsOfBranch 删走法时清掉它全部绑定键（不变式 2）', () => {
    const before = kb();
    const next = dropBindingsOfBranch(before, 'b1');
    assert.ok(next, '有绑定键 → 应产生新表');
    assert.equal(Object.hasOwn(next, 'char.png::主聊天 - branch #1'), false, '该走法的键移除');
    assert.equal(Object.keys(next).length, 2, '一次只清该走法的键');
    assert.deepEqual(boundKeysOfBranch(next, 'b1'), [], '清完不再有指向它的绑定');
    // 纯函数：不改入参
    assert.equal(Object.hasOwn(before, 'char.png::主聊天 - branch #1'), true);
});

test('key-bindings：dropBindingsOfBranch 保守语义——无绑定键/空参数不写库', () => {
    assert.equal(dropBindingsOfBranch(kb(), 'b9'), null, '库内新建的走法没有绑定键 → null（不做无谓写入）');
    assert.equal(dropBindingsOfBranch(kb(), ''), null);
    assert.equal(dropBindingsOfBranch(null, 'b1'), null);
    assert.equal(dropBindingsOfBranch({}, 'b1'), null);
});

test('key-bindings：改名后解绑——迁移过的新键也能被 drop 清掉', () => {
    const migrated = migrateBindingKey(kb(), 'char.png::主聊天 - checkpoint #1', 'char.png::到那一层为止');
    const dropped = dropBindingsOfBranch(migrated, 'b2');
    assert.deepEqual(boundKeysOfBranch(dropped, 'b2'), []);
    assert.equal(Object.hasOwn(dropped, 'char.png::到那一层为止'), false);
});
