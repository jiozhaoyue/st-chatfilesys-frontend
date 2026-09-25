/**
 * ops-apply.js 单测：RFC6902 六种操作 + 边界 + 整批失败
 * 对应 design.md T0 §1A.3（修掉「chats/meta/patch 整包丢弃」的数据丢失缺陷）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePointer, applyOpsToObject } from '../../public/scripts/extensions/third-party/chatfilesys/core/ops-apply.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ---------------- parsePointer ---------------- */

test('parsePointer：根 / 嵌套 / 转义', () => {
    assert.deepEqual(parsePointer(''), []);
    assert.deepEqual(parsePointer('/a/b/c'), ['a', 'b', 'c']);
    assert.deepEqual(parsePointer('/a~1b'), ['a/b']);   // ~1 => /
    assert.deepEqual(parsePointer('/a~0b'), ['a~b']);   // ~0 => ~
    assert.deepEqual(parsePointer('/0'), ['0']);
});

test('parsePointer：非法指针抛错', () => {
    assert.throws(() => parsePointer('a/b'), /非法 JSON Pointer/);
});

/* ---------------- add ---------------- */

test('add：对象置值 / 数组按下标插入 / "-" 追加', () => {
    assert.deepEqual(applyOpsToObject({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]), { a: 1, b: 2 });
    assert.deepEqual(
        applyOpsToObject({ xs: [1, 3] }, [{ op: 'add', path: '/xs/1', value: 2 }]),
        { xs: [1, 2, 3] },
    );
    assert.deepEqual(
        applyOpsToObject({ xs: [1, 2] }, [{ op: 'add', path: '/xs/-', value: 3 }]),
        { xs: [1, 2, 3] },
    );
});

test('add：深路径 / 父级不存在即失败', () => {
    assert.deepEqual(
        applyOpsToObject({ a: { b: {} } }, [{ op: 'add', path: '/a/b/c', value: 'v' }]),
        { a: { b: { c: 'v' } } },
    );
    assert.throws(() => applyOpsToObject({ a: {} }, [{ op: 'add', path: '/a/x/y', value: 1 }]), /父级路径不存在/);
});

test('add：数组下标非法（前导零 / 越界 / 非数字）即失败', () => {
    assert.throws(() => applyOpsToObject({ xs: [1] }, [{ op: 'add', path: '/xs/01', value: 9 }]), /下标非法/);
    assert.throws(() => applyOpsToObject({ xs: [1] }, [{ op: 'add', path: '/xs/5', value: 9 }]), /下标非法/);
    assert.throws(() => applyOpsToObject({ xs: [1] }, [{ op: 'add', path: '/xs/x', value: 9 }]), /下标非法/);
});

/* ---------------- remove ---------------- */

test('remove：对象删键 / 数组移位', () => {
    assert.deepEqual(applyOpsToObject({ a: 1, b: 2 }, [{ op: 'remove', path: '/a' }]), { b: 2 });
    assert.deepEqual(applyOpsToObject({ xs: ['a', 'b', 'c'] }, [{ op: 'remove', path: '/xs/1' }]), { xs: ['a', 'c'] });
});

test('remove：目标不存在即失败', () => {
    assert.throws(() => applyOpsToObject({ a: 1 }, [{ op: 'remove', path: '/zzz' }]), /remove 目标不存在/);
    assert.throws(() => applyOpsToObject({ xs: [1] }, [{ op: 'remove', path: '/xs/3' }]), /越界/);
});

/* ---------------- replace ---------------- */

test('replace：对象与数组均要求目标已存在', () => {
    assert.deepEqual(applyOpsToObject({ a: 1 }, [{ op: 'replace', path: '/a', value: 9 }]), { a: 9 });
    assert.deepEqual(applyOpsToObject({ xs: [1, 2] }, [{ op: 'replace', path: '/xs/1', value: 9 }]), { xs: [1, 9] });
    assert.throws(() => applyOpsToObject({ a: 1 }, [{ op: 'replace', path: '/b', value: 9 }]), /replace 目标不存在/);
});

/* ---------------- move / copy ---------------- */

test('move：跨位置搬迁；数组内移动按下标语义', () => {
    assert.deepEqual(
        applyOpsToObject({ a: { b: 1 }, c: {} }, [{ op: 'move', from: '/a/b', path: '/c/d' }]),
        { a: {}, c: { d: 1 } },
    );
    assert.deepEqual(
        applyOpsToObject({ xs: ['a', 'b', 'c'] }, [{ op: 'move', from: '/xs/0', path: '/xs/2' }]),
        { xs: ['b', 'c', 'a'] },
    );
    assert.throws(() => applyOpsToObject({ a: 1 }, [{ op: 'move', from: '/zzz', path: '/a' }]), /move 源不存在/);
});

test('copy：取深拷贝，源后续改动不影响副本', () => {
    const doc = applyOpsToObject({ a: { deep: [1, 2] } }, [{ op: 'copy', from: '/a', path: '/b' }]);
    assert.deepEqual(doc, { a: { deep: [1, 2] }, b: { deep: [1, 2] } });
    doc.a.deep.push(3);
    assert.deepEqual(doc.b.deep, [1, 2], '源改动不得影响副本');
    assert.throws(() => applyOpsToObject({ a: 1 }, [{ op: 'copy', from: '/zzz', path: '/a' }]), /copy 源不存在/);
});

/* ---------------- test ---------------- */

test('test：通过则不动，不通过即失败（键序不敏感）', () => {
    const doc = { a: { x: 1, y: [1, 2] } };
    assert.deepEqual(applyOpsToObject(clone(doc), [{ op: 'test', path: '/a', value: { y: [1, 2], x: 1 } }]), doc);
    assert.throws(() => applyOpsToObject(clone(doc), [{ op: 'test', path: '/a/x', value: 2 }]), /test 不通过/);
    assert.throws(() => applyOpsToObject(clone(doc), [{ op: 'test', path: '/nope', value: 1 }]), /test 不通过/);
});

/* ---------------- 批量与边界 ---------------- */

test('批量：多操作顺序执行（后一步看得见前一步的结果）', () => {
    const r = applyOpsToObject(
        { meta: { namespaces: {} } },
        [
            { op: 'add', path: '/meta/namespaces/foo', value: { k: 1 } },
            { op: 'replace', path: '/meta/namespaces/foo/k', value: 2 },
            { op: 'add', path: '/meta/active', value: 'foo' },
        ],
    );
    assert.deepEqual(r, { meta: { namespaces: { foo: { k: 2 } }, active: 'foo' } });
});

test('失败即抛出（调用方须在克隆上调用，保证不写入半成品）', () => {
    const doc = { a: 1 };
    const snapshot = clone(doc);
    assert.throws(() => applyOpsToObject(doc, [
        { op: 'add', path: '/b', value: 2 },
        { op: 'remove', path: '/missing' },
    ]));
    // 前一步已就地生效——这正是「必须在克隆上调用」的原因，用例把该契约固定住
    assert.deepEqual(doc, { a: 1, b: 2 });
    assert.deepEqual(snapshot, { a: 1 });
});

test('非法入参与未知操作', () => {
    assert.throws(() => applyOpsToObject({}, null), /ops 必须是数组/);
    assert.throws(() => applyOpsToObject({}, [null]), /非法操作项/);
    assert.throws(() => applyOpsToObject({ a: 1 }, [{ op: 'merge', path: '/a' }]), /不支持的操作/);
});

/* ---------------- 真实形态：chat_metadata 补丁 ---------------- */

test('真实形态：同时改其他插件命名空间与本插件模型', () => {
    const meta = {
        integrity: 'c-abc',
        main_chat: 'Seraphina',
        extensions: {
            'third-party/someplugin': { flag: true },
            chatfilesys: { active_branch: 'b1', branches: [], groups: {} },
        },
        variables: { hp: 10 },
    };
    const out = applyOpsToObject(clone(meta), [
        { op: 'add', path: '/extensions/third-party~1someplugin/extra', value: [1, 2] },
        { op: 'replace', path: '/variables/hp', value: 7 },
        { op: 'replace', path: '/extensions/chatfilesys/active_branch', value: 'b2' },
        { op: 'remove', path: '/main_chat' },
    ]);
    assert.deepEqual(out.extensions['third-party/someplugin'], { flag: true, extra: [1, 2] });
    assert.equal(out.variables.hp, 7);
    assert.equal(out.extensions.chatfilesys.active_branch, 'b2');
    assert.equal('main_chat' in out, false);
});
