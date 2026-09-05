import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    bodyPath,
    applyOperationsLocally,
    createChatWriter,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/chat-writer.js';

test('bodyPath："/<index>" 方案（已按实例源码定案）', () => {
    assert.equal(bodyPath(0), '/0');
    assert.equal(bodyPath(4, 'mes'), '/4/mes');
});

test('applyOperationsLocally：add/replace/remove/test 语义与 RFC6902 一致（doc=消息数组）', () => {
    const doc = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];

    applyOperationsLocally(doc, [
        { op: 'add', path: bodyPath(1), value: { mes: 'x' } },          // 插入
        { op: 'replace', path: bodyPath(0, 'mes'), value: 'A' },        // 字段替换
        { op: 'remove', path: bodyPath(3) },                            // 移除（后续前移）
        { op: 'add', path: bodyPath('-'), value: { mes: 'tail' } },     // 追加
        { op: 'test', path: bodyPath(0, 'mes'), value: 'A' },
    ]);
    assert.deepEqual(doc.map((m) => m.mes), ['A', 'x', 'b', 'tail']);

    assert.throws(() => applyOperationsLocally(doc, [{ op: 'test', path: bodyPath(0, 'mes'), value: 'wrong' }]), /test 失败/);
    assert.throws(() => applyOperationsLocally(doc, [{ op: 'remove', path: bodyPath(99) }]), /越界/);
});

/* ---------------- createChatWriter：ops → 官方消息 API 批量调用 ---------------- */

function makeIo() {
    const calls = { delete: [], add: [], update: [] };
    return {
        calls,
        io: {
            deleteMessages: async (idx, opts) => { calls.delete.push({ idx, opts }); return []; },
            addMessages: async (msgs, opts) => { calls.add.push({ msgs, opts }); return msgs.map((_, i) => i); },
            updateMessages: async (upd, opts) => { calls.update.push({ upd, opts }); },
        },
    };
}

test('createChatWriter：切换形态 ops（尾段 remove 降序 + add 顺序）→ deleteMessages 升序批量 + addMessages 批量', async () => {
    const { calls, io } = makeIo();
    const writer = createChatWriter(io);
    // planSwitch 生成形态：remove 降序（保索引）+ add 从 k 顺序插入
    const ops = [
        { op: 'remove', path: bodyPath(4) },
        { op: 'remove', path: bodyPath(3) },
        { op: 'remove', path: bodyPath(2) },
        { op: 'add', path: bodyPath(2), value: { mes: 't1' } },
        { op: 'add', path: bodyPath(3), value: { mes: 't2' } },
        { op: 'add', path: bodyPath(4), value: { mes: 't3' } },
    ];
    const r = await writer.applyOperations(ops);
    assert.deepEqual(calls.delete, [{ idx: [2, 3, 4], opts: { silent: true } }]);
    assert.deepEqual(calls.add, [{ msgs: [{ mes: 't1' }, { mes: 't2' }, { mes: 't3' }], opts: { silent: true } }]);
    assert.deepEqual(calls.update, []);
    assert.deepEqual(r, { removed: 3, added: 3, updated: 0 });
});

test('createChatWriter：纯追加（cur 为目标前缀，无 remove）→ addMessages 尾段追加', async () => {
    const { calls, io } = makeIo();
    const writer = createChatWriter(io);
    const r = await writer.applyOperations([
        { op: 'add', path: bodyPath(3), value: { mes: 'n1' } },
        { op: 'add', path: bodyPath(4), value: { mes: 'n2' } },
    ]);
    assert.deepEqual(calls.delete, []);
    assert.deepEqual(calls.add[0].msgs, [{ mes: 'n1' }, { mes: 'n2' }]);
    assert.deepEqual(r, { removed: 0, added: 2, updated: 0 });
});

test('createChatWriter：删层形态（单 remove）→ deleteMessages([i])', async () => {
    const { calls, io } = makeIo();
    const writer = createChatWriter(io);
    const r = await writer.applyOperations([{ op: 'remove', path: bodyPath(1) }]);
    assert.deepEqual(calls.delete, [{ idx: [1], opts: { silent: true } }]);
    assert.deepEqual(calls.add, []);
    assert.deepEqual(r, { removed: 1, added: 0, updated: 0 });
});

test('createChatWriter：replace ops → updateMessages 按索引分组合并 patch（顶层整替换语义）', async () => {
    const { calls, io } = makeIo();
    const writer = createChatWriter(io);
    const r = await writer.applyOperations([
        { op: 'replace', path: bodyPath(3, 'mes'), value: '新内容' },
        { op: 'replace', path: bodyPath(3, 'extra'), value: { note: 1 } },
        { op: 'replace', path: bodyPath(5, 'mes'), value: '另一条' },
    ]);
    assert.deepEqual(calls.update, [{
        upd: [
            { index: 3, patch: { mes: '新内容', extra: { note: 1 } } },
            { index: 5, patch: { mes: '另一条' } },
        ],
        opts: { silent: true },
    }]);
    assert.deepEqual(r, { removed: 0, added: 0, updated: 3 });
});

test('createChatWriter：silent=false 透传（调用方自行接管事件）', async () => {
    const { calls, io } = makeIo();
    const writer = createChatWriter(io);
    await writer.applyOperations([{ op: 'remove', path: bodyPath(0) }], { silent: false });
    assert.equal(calls.delete[0].opts.silent, false);
});

test('createChatWriter：形态不合抛错（add 不连续 / add 起点错位 / test op / 非法索引）', async () => {
    const { io } = makeIo();
    const writer = createChatWriter(io);
    await assert.rejects(
        () => writer.applyOperations([
            { op: 'add', path: bodyPath(2), value: {} },
            { op: 'add', path: bodyPath(5), value: {} },
        ]),
        /不连续/,
    );
    await assert.rejects(
        () => writer.applyOperations([
            { op: 'remove', path: bodyPath(3) },
            { op: 'remove', path: bodyPath(2) },
            { op: 'add', path: bodyPath(1), value: {} },
        ]),
        /≠ 删除后长度/,
    );
    await assert.rejects(
        () => writer.applyOperations([{ op: 'test', path: bodyPath(0, 'mes'), value: 'x' }]),
        /不支持的操作形态/,
    );
    await assert.rejects(
        () => writer.applyOperations([{ op: 'remove', path: bodyPath(-1) }]),
        /非法 remove 索引/,
    );
});

test('createChatWriter：API 拒绝向上抛（调用方负责 saveChat 全量回退）', async () => {
    const writer = createChatWriter({
        deleteMessages: async () => { throw new Error('disk full'); },
        addMessages: async () => 0,
        updateMessages: async () => {},
    });
    await assert.rejects(() => writer.applyOperations([{ op: 'remove', path: bodyPath(0) }]), /disk full/);
});

test('createChatWriter：依赖缺失抛错', () => {
    assert.throws(() => createChatWriter({ addMessages: async () => {}, updateMessages: async () => {} }), /deleteMessages/);
    assert.throws(() => createChatWriter({ deleteMessages: async () => {}, updateMessages: async () => {} }), /addMessages/);
    assert.throws(() => createChatWriter({ deleteMessages: async () => {}, addMessages: async () => {} }), /updateMessages/);
});
