/**
 * chat-meta 单测：聊天头（chat_metadata）的拆装与合并（R0 / W5 / R2.1 共用）
 *
 * 覆盖：
 * - `splitChatMetadata`：只摘掉本插件两项（extensions.chatfilesys、integrity），其余全留
 * - `mergeHostMetadata`：顶层浅合并 + `extensions` **逐命名空间**合并（不整包抹掉别人）
 * - `stripKeyOwnedMeta`：**键归属**（F1/F2）——非主键的 `main_chat` 不进家族级
 * - `hostMetadataOfHeader`：从源 jsonl 首行取保留面（原生文件 / 本插件增强模式文件两种形态）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    OWN_EXTENSION_KEY, splitChatMetadata, mergeHostMetadata, stripKeyOwnedMeta, hostMetadataOfHeader,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/chat-meta.js';

const model = { active_branch: 'b_main', branches: [], groups: {} };

test('chat-meta：splitChatMetadata 只摘本插件两项，其余全留', () => {
    const { hostMetadata, model: m } = splitChatMetadata({
        integrity: 7,
        main_chat: 'root',
        variables: { hp: 3 },
        extensions: {
            [OWN_EXTENSION_KEY]: model,
            'third-party/other': { flag: true },
        },
    });
    assert.deepEqual(m, model);
    assert.equal(hostMetadata.integrity, undefined, '版本号真源在库，不进保留面');
    assert.equal(hostMetadata.main_chat, 'root');
    assert.deepEqual(hostMetadata.variables, { hp: 3 });
    assert.deepEqual(Object.keys(hostMetadata.extensions), ['third-party/other'], '别人的命名空间留下');
});

test('chat-meta：splitChatMetadata 边界（null / 无 extensions / extensions 被清空后不留空壳）', () => {
    assert.deepEqual(splitChatMetadata(null), { hostMetadata: {}, model: null });
    assert.deepEqual(splitChatMetadata(undefined), { hostMetadata: {}, model: null });
    assert.deepEqual(splitChatMetadata({ integrity: 1 }), { hostMetadata: {}, model: null });
    // 只有本插件命名空间 → 不留空的 extensions 壳
    const only = splitChatMetadata({ extensions: { [OWN_EXTENSION_KEY]: model } });
    assert.equal('extensions' in only.hostMetadata, false);
});

test('chat-meta：mergeHostMetadata 逐命名空间合并（不整包抹掉别人）', () => {
    const prev = {
        main_chat: 'root',
        variables: { hp: 1, mp: 2 },
        extensions: { a: { v: 1 }, b: { v: 2 } },
    };
    const incoming = { note_prompt: 'x', extensions: { b: { v: 9 }, c: { v: 3 } } };
    const merged = mergeHostMetadata(prev, incoming);
    assert.equal(merged.main_chat, 'root', '库内独有键保留');
    assert.equal(merged.note_prompt, 'x', '入向新键并入');
    assert.deepEqual(merged.variables, { hp: 1, mp: 2 }, '顶层同键整体替换（不做深合并）');
    assert.deepEqual(merged.extensions, { a: { v: 1 }, b: { v: 9 }, c: { v: 3 } },
        'a 不丢、b 取入向、c 新增');
});

test('chat-meta：mergeHostMetadata 是纯函数（不改入参）且容错空值', () => {
    const prev = { extensions: { a: { v: 1 } } };
    const out = mergeHostMetadata(prev, { extensions: { b: { v: 2 } } });
    assert.deepEqual(prev.extensions, { a: { v: 1 } }, '入参未被改');
    assert.deepEqual(out.extensions, { a: { v: 1 }, b: { v: 2 } });
    assert.deepEqual(mergeHostMetadata(null, null), {});
    assert.deepEqual(mergeHostMetadata('x', 3), {});
    // 只有一侧有 extensions 时也归一成对象
    assert.deepEqual(mergeHostMetadata({ extensions: { a: 1 } }, { top: 1 }).extensions, { a: 1 });
});

test('chat-meta：hostMetadataOfHeader 从源 jsonl 首行取保留面（原生文件）', () => {
    const header = {
        user_name: 'u', character_name: 'c',
        chat_metadata: { main_chat: '父聊天', variables: { hp: 1 }, extensions: { 'third-party/x': { f: 1 } } },
    };
    assert.deepEqual(hostMetadataOfHeader(header), {
        main_chat: '父聊天',
        variables: { hp: 1 },
        extensions: { 'third-party/x': { f: 1 } },
    });
});

test('chat-meta：hostMetadataOfHeader 剔除本插件两项（增强模式文件里的旧副本不得顶掉库内真源）', () => {
    const header = {
        user_name: 'u', character_name: 'c',
        chat_metadata: {
            integrity: 'c-old', other_plugin: 1,
            extensions: { [OWN_EXTENSION_KEY]: model, 'third-party/x': { f: 1 } },
        },
    };
    const host = hostMetadataOfHeader(header);
    assert.equal(host.integrity, undefined);
    assert.equal(host.extensions[OWN_EXTENSION_KEY], undefined);
    assert.equal(host.other_plugin, 1);
    assert.deepEqual(host.extensions, { 'third-party/x': { f: 1 } });
});

test('chat-meta：hostMetadataOfHeader 边界（无 header / 无 chat_metadata / 非对象）', () => {
    assert.deepEqual(hostMetadataOfHeader(null), {});
    assert.deepEqual(hostMetadataOfHeader(undefined), {});
    assert.deepEqual(hostMetadataOfHeader('x'), {});
    assert.deepEqual(hostMetadataOfHeader({ user_name: 'u' }), {});
    assert.deepEqual(hostMetadataOfHeader({ chat_metadata: null }), {});
});

/* ---------------- 键归属（F1/F2，2026-09-26） ---------------- */

test('chat-meta：stripKeyOwnedMeta 非主键的 main_chat 不进家族级，其余内容照常并入', () => {
    const family = {
        chatKey: 'av1::主聊天',
        keyBindings: { 'av1::主聊天 - Branch #1': { branchId: 'b1', mainChat: '主聊天' } },
    };
    // 绑定键（原生分支/检查点键）：它的父线索归它自己（住键绑定）→ 剔
    assert.deepEqual(
        stripKeyOwnedMeta(family, 'av1::主聊天 - Branch #1', { main_chat: '主聊天', variables: { hp: 1 } }),
        { variables: { hp: 1 } },
    );
    // 非主键且没有绑定的键（被并入家族的聊天，导入路径）→ 同样剔
    assert.deepEqual(stripKeyOwnedMeta(family, 'av1::另一个聊天', { main_chat: 'x', top: 1 }), { top: 1 });
    // 主键：main_chat 就是它自己的父线索（原生分支文件被单独导入当主键时确实有）→ 原样留
    assert.deepEqual(stripKeyOwnedMeta(family, 'av1::主聊天', { main_chat: '父聊天' }), { main_chat: '父聊天' });
});

test('chat-meta：stripKeyOwnedMeta 边界（无 main_chat / 无键 / 无家族 / 空入向）', () => {
    const family = { chatKey: 'av1::主聊天', keyBindings: {} };
    const same = { variables: { hp: 1 } };
    assert.equal(stripKeyOwnedMeta(family, 'av1::主聊天', same), same, '没有 main_chat 时原样返回（不造无谓差异）');
    assert.deepEqual(stripKeyOwnedMeta(family, null, { main_chat: 'x' }), { main_chat: 'x' });
    assert.deepEqual(stripKeyOwnedMeta(null, 'av1::别的', { main_chat: 'x' }), {});
    assert.deepEqual(stripKeyOwnedMeta(family, 'av1::主聊天', null), {});
    assert.deepEqual(stripKeyOwnedMeta(family, 'av1::主聊天', 'x'), {});
});
