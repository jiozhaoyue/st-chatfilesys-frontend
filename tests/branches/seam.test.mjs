/**
 * seam.js 单测：mock fetch + mock adapter，覆盖读/写/冲突/透传/降级 五类（design.md §4）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSeam, normalizeChatKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/seam.js';

/** mock adapter：内存实现 + 调用记录 */
function mockAdapter() {
    const calls = { loadFamily: 0, saveFloors: 0, applyOps: 0, saveModel: 0 };
    const family = {
        familyId: 'f1', chatKey: 'av1::chat1', characterId: 'c1', name: 'chat1', integrity: 'c-5',
        // T0/R0：聊天头保留面（其他插件命名空间 + 宿主字段）——读时须整份回显
        hostMetadata: {
            main_chat: 'root_chat',
            variables: { hp: 10 },
            extensions: { 'third-party/someplugin': { flag: true } },
        },
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0, parent_branch_id: null }],
        branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        model: {
            active_branch: 'b_main',
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } }],
            groups: {},
        },
    };
    const floors = [
        { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ name: '我', is_user: true, mes: 'a' }), contentHash: null, sendDate: 1 },
        { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'AI', is_user: false, mes: 'b' }), contentHash: null, sendDate: 2 },
    ];
    return {
        calls, family, floors,
        conflictNext: false,
        async loadFamily({ chatKey }) { this.calls.loadFamily++; return chatKey === family.chatKey ? family : null; },
        async loadFloors() { return { floors: this.floors, hasMore: false }; },
        async saveFloors() { this.calls.saveFloors++; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 'c-6' }; },
        async applyOps() { this.calls.applyOps++; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 'c-6' }; },
        async saveModel(args) { this.calls.saveModel++; this.lastSaveModelArgs = args; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 'c-6' }; },
        async renameFamily() { return { ok: true, integrity: 'c-6' }; },
        async deleteFamily() { return { ok: true }; },
    };
}

test('normalizeChatKey：小写+去空白+剥 .jsonl 后缀（真机两侧键收敛）', () => {
    assert.equal(normalizeChatKey(' AV1 ', 'Chat1.JSONL'), 'av1::chat1');
    assert.equal(normalizeChatKey('av1.png', 'chat1'), normalizeChatKey('av1.png', 'chat1.jsonl'));
});

test('seam：get 已接管 → 拼装 [header,...rows] 响应', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', headers: {}, body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body));
        assert.equal(body.length, 3);
        assert.equal(body[0].chat_metadata.extensions.chatfilesys.branches[0].id, 'b_main');
        assert.equal(body[1].mes, 'a');
        assert.equal(adapter.calls.loadFamily, 1);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：get 未接管 → 透传原始 fetch', async () => {
    const original = async () => new Response('native', { status: 200 });
    globalThis.fetch = original;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'x', file_name: 'unknown' }),
        });
        assert.equal(await res.text(), 'native');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：save → applyOps 调用且响应 ok', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 'c-5',
                chat: [{ name: '我', is_user: true, mes: 'a' }, { name: 'AI', is_user: false, mes: 'b' }],
            }),
        });
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.integrity, 'c-6'); // T1/N19：库内字符串版本号原样回显（不再桥接）
        assert.equal(adapter.calls.saveFloors, 1);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：save 请求体带 header 行 → 剥掉不污染楼层（真机形态 chat=[header,...msgs]）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.saveFloors = async (args) => { captured = args; return { ok: true, integrity: 'c-6' }; };
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1',
                chat: [
                    { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'c-5' } },
                    { name: '我', is_user: true, mes: 'a' },
                ],
            }),
        });
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(captured.floors.length, 1); // header 行被剥，只写 1 楼层
        assert.equal(JSON.parse(captured.floors[0].content).mes, 'a');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：get 响应 header 带库内版本号（宿主 saveChatInternal 无 integrity 拒存）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        });
        const body = await res.json();
        assert.equal(body[0].chat_metadata.integrity, 'c-5');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：版本号形态统一为字符串——入向原样交给适配器（N19：作废「无法解析就放行」）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seen = [];
    adapter.applyOps = async (args) => { seen.push(args.expectedIntegrity); return { ok: true, integrity: 'c-6' }; };
    const seam = installSeam(adapter);
    try {
        // 宿主自造 uuid（混合状态）：原样下传 → 适配器按字符串不等判定为冲突（不再静默放行）
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: '3f2b8c11-xxxx-uuid', operations: [] }),
        });
        // 数字入向（早期库内形态/老客户端）：归一成字符串
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 5, operations: [] }),
        });
        // 未带版本号 → null（不锁）
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', operations: [] }),
        });
        assert.deepEqual(seen, ['3f2b8c11-xxxx-uuid', '5', null]);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：append → saveFloors 参数正确（floorNo 续接活跃分支 maxFloor）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.saveFloors = async (args) => { captured = args; return { ok: true, integrity: 'c-6' }; };
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/append', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 5, messages: [{ name: '我', mes: 'new', send_date: 9 }] }),
        });
        const body = await res.json();
        assert.equal(body.appended, 1);
        assert.equal(captured.floors.length, 1);
        assert.equal(captured.floors[0].floorNo, 3); // 活跃分支 maxFloor=2 → 新楼层 3
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：patch → 消息补丁交给适配器应用（ops 原样转发 + 版本号 + 条数）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.applyOps = async (args) => { captured = args; return { ok: true, integrity: 'c-6', totalMessages: 2 }; };
    const seam = installSeam(adapter);
    try {
        const ops = [{ op: 'replace', path: '/1', value: { mes: 'edited' } }];
        const res = await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 5, operations: ops }),
        });
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.applied, 1);
        assert.equal(body.total_messages, 2);
        assert.equal(body.integrity, 'c-6');
        assert.deepEqual(captured.ops, ops);
        assert.equal(captured.familyId, 'f1');
        assert.equal(captured.expectedIntegrity, '5');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：patch 请求体带的聊天头并入落库（T0c：宿主 patch 常载整份 chat_metadata）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.applyOps = async (args) => { captured = args; return { ok: true, integrity: 'c-6', totalMessages: 2 }; };
    const seam = installSeam(adapter);
    try {
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'add', path: '/0/extra/x', value: 1 }],
                chat_metadata: {
                    main_chat: 'root_chat',
                    variables: { hp: 10 },
                    extensions: { 'third-party/other': { v: 2 }, chatfilesys: null },
                },
            }),
        });
        // 入向命名空间并入（库内既有的 someplugin 不丢），本插件项不进 hostMetadata
        assert.deepEqual(captured.hostMetadata.extensions, {
            'third-party/someplugin': { flag: true },
            'third-party/other': { v: 2 },
        });
        assert.equal(captured.hostMetadata.main_chat, 'root_chat');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：patch 只在「走法切换」时让入向模型决定结构（旧副本不盖库内结构）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seen = [];
    adapter.applyOps = async (args) => { seen.push(args.model); return { ok: true, integrity: 'c-6', totalMessages: 2 }; };
    const seam = installSeam(adapter);
    const modelOf = (active) => ({
        active_branch: active,
        branches: [{ id: 'b_main', path: { 1: 'g1', 2: 'g2' } }, { id: 'bX', path: { 1: 'g1' } }],
        groups: {},
    });
    try {
        // ① 入向模型与库内同走法（普通消息写）→ 不采用入向模型（可能是旧副本）
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'add', path: '/1/extra/x', value: 1 }],
                chat_metadata: { extensions: { chatfilesys: modelOf('b_main') } },
            }),
        });
        assert.equal(seen[0], undefined);
        // ② 入向模型换了活跃走法 → 采用（重投影需要目标走法）
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'remove', path: '/1' }],
                chat_metadata: { extensions: { chatfilesys: modelOf('bX') } },
            }),
        });
        assert.equal(seen[1].active_branch, 'bX');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：patch test 不通过 → 409（宿主走冲突重放）；中间插入 → 400（宿主回退全量保存）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        adapter.applyOps = async () => ({ ok: false, reason: 'test-failed', detail: '"/1"' });
        let res = await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', operations: [{ op: 'test', path: '/1', value: 1 }] }),
        });
        assert.equal(res.status, 409);

        adapter.applyOps = async () => ({ ok: false, reason: 'mid-insert-unsupported', detail: '插入位置 <2' });
        res = await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', operations: [{ op: 'add', path: '/1', value: {} }] }),
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).reason, 'mid-insert-unsupported');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：patch force=true → 不锁版本号（宿主显式覆盖信号）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.applyOps = async (args) => { captured = args; return { ok: true, integrity: 'c-6', totalMessages: 2 }; };
    const seam = installSeam(adapter);
    try {
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 5, force: true, operations: [{ op: 'remove', path: '/1' }] }),
        });
        assert.equal(captured.expectedIntegrity, null);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：append 请求体带的聊天头一并落库（T0c：命名空间跟着 append 进来）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let metaArgs = null;
    adapter.saveModel = async (args) => { metaArgs = args; return { ok: true, integrity: 'c-9' }; };
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/append', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                messages: [{ name: '我', mes: 'new', send_date: 9 }],
                chat_metadata: { extensions: { 'third-party/late': { k: 1 } } },
            }),
        });
        const body = await res.json();
        assert.equal(body.integrity, 'c-9'); // 返回最终（元数据落库后）的版本号
        assert.ok(metaArgs, '应将聊天头落库');
        assert.equal(metaArgs.keepCurrent, true); // 模型不动（结构由本插件维护）
        assert.deepEqual(metaArgs.hostMetadata.extensions, {
            'third-party/someplugin': { flag: true },
            'third-party/late': { k: 1 },
        });
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：冲突 → 409', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    adapter.conflictNext = true;
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 4, operations: [] }),
        });
        assert.equal(res.status, 409);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：非聊天 URL → 透传', async () => {
    const original = async () => new Response('gen', { status: 200 });
    globalThis.fetch = original;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/backends/text-completion-api/status', { method: 'GET' });
        assert.equal(await res.text(), 'gen');
        assert.equal(adapter.calls.loadFamily, 0);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：adapter 抛错 → 透传且不 reject', async () => {
    const original = async () => new Response('fallback', { status: 200 });
    globalThis.fetch = original;
    const adapter = mockAdapter();
    adapter.loadFamily = async () => { throw new Error('boom'); };
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        });
        assert.equal(await res.text(), 'fallback');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta → saveModel 持久化模型且响应合规', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/meta', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 'c-5',
                chat_metadata: { extensions: { chatfilesys: { active_branch: 'b_x', branches: [], groups: { g1: [1] } } } },
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.integrity, 'c-6');
        assert.equal(adapter.calls.saveModel, 1);
        assert.equal(adapter.lastSaveModelArgs.familyId, 'f1');
        assert.equal(adapter.lastSaveModelArgs.model.active_branch, 'b_x');
        assert.deepEqual(adapter.lastSaveModelArgs.model.groups, { g1: [1] });
        assert.equal(adapter.lastSaveModelArgs.expectedIntegrity, 'c-5');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta/patch → RFC6902 真正应用（T0/R0：不再整包丢弃）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [
                    { op: 'add', path: '/extensions/third-party~1someplugin/extra', value: [1, 2] },
                    { op: 'replace', path: '/variables/hp', value: 7 },
                    { op: 'add', path: '/top_note', value: 'n' },
                ],
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.applied, 3);
        // 聊天头侧改动生效，且其他内容不丢
        assert.deepEqual(adapter.lastSaveModelArgs.hostMetadata.extensions['third-party/someplugin'],
            { flag: true, extra: [1, 2] });
        assert.equal(adapter.lastSaveModelArgs.hostMetadata.variables.hp, 7);
        assert.equal(adapter.lastSaveModelArgs.hostMetadata.top_note, 'n');
        assert.equal(adapter.lastSaveModelArgs.hostMetadata.main_chat, 'root_chat');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta/patch 的删除与自管项 op 按批次定性（T0c：宿主旧副本不得抹掉内容）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        // 真机 op 形态（Dev 8003 实测）：宿主把「快照有、内存副本没有」的键一律 remove，
        // 连本插件模型内部（path 项）也删。这一批同时要删别人的命名空间 → 判为旧副本差分。
        const res = await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [
                    { op: 'test', path: '/main_chat', value: 'root_chat' },
                    { op: 'remove', path: '/main_chat' },
                    { op: 'remove', path: '/variables/hp' },
                    { op: 'remove', path: '/extensions/third-party~1someplugin' },
                    { op: 'remove', path: '/extensions/chatfilesys/branches/0/path/2' },
                    { op: 'add', path: '/extensions/chatfilesys/branches/0/path/3', value: 'g3' },
                    { op: 'add', path: '/kept', value: 1 },
                ],
            }),
        });
        assert.equal(res.status, 200);
        const meta = adapter.lastSaveModelArgs.hostMetadata;
        assert.equal(meta.main_chat, 'root_chat'); // 顶层键不被宿主旧副本删掉
        assert.deepEqual(meta.variables, { hp: 10 });
        assert.deepEqual(meta.extensions['third-party/someplugin'], { flag: true });
        assert.equal(meta.kept, 1); // 非删除的 op 照常生效
        // 旧副本差分里自管路径的删除同样不可信；新增（本插件 UI 的登记）照常生效
        const model = adapter.lastSaveModelArgs.model;
        assert.deepEqual(model.branches[0].path, { 1: 'g1', 2: 'g2', 3: 'g3' });
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：干净批次的删除照常应用（本插件 deleteFloor 重编号走这条）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        // 本插件 saveMetadata 的差分前后同源：只动自己的命名空间，不含别人的 remove
        const res = await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [
                    { op: 'replace', path: '/extensions/chatfilesys/active_branch', value: 'b_y' },
                    { op: 'remove', path: '/extensions/chatfilesys/branches/0/path/2' },
                ],
            }),
        });
        assert.equal(res.status, 200);
        const model = adapter.lastSaveModelArgs.model;
        assert.equal(model.active_branch, 'b_y');
        assert.deepEqual(model.branches[0].path, { 1: 'g1' }); // 楼层重编号：path/2 删除生效
        assert.equal(adapter.lastSaveModelArgs.hostMetadata.main_chat, 'root_chat');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta/patch 整体替换 /extensions → 降级为逐命名空间合并（不抹别人）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'replace', path: '/extensions', value: { 'third-party/new': { a: 1 } } }],
            }),
        });
        const ext = adapter.lastSaveModelArgs.hostMetadata.extensions;
        assert.deepEqual(ext['third-party/new'], { a: 1 });
        assert.deepEqual(ext['third-party/someplugin'], { flag: true }); // 库内既有命名空间不被整体替换抹掉
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta/patch 应用失败 → 400 且不写入（不静默丢内容）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'replace', path: '/不存在的字段', value: 1 }],
            }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.reason, 'patch-apply-failed');
        assert.equal(adapter.calls.saveModel, 0, '失败时不得落库');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：get 回显聊天头整份内容（其他插件命名空间 + main_chat 不丢）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', headers: {}, body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        });
        const body = await res.json();
        const meta = body[0].chat_metadata;
        assert.equal(meta.main_chat, 'root_chat');
        assert.deepEqual(meta.variables, { hp: 10 });
        assert.deepEqual(meta.extensions['third-party/someplugin'], { flag: true });
        assert.equal(meta.extensions.chatfilesys.active_branch, 'b_main'); // 本插件模型覆盖在 extensions 下
        assert.equal(meta.integrity, 'c-5');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta 整份写 → 其他插件命名空间并入保留（不因只认本插件模型而丢）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        await globalThis.fetch('/api/chats/meta', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                chat_metadata: {
                    main_chat: 'root_chat',
                    new_ns: { from: 'other-plugin' },
                    extensions: {
                        'third-party/someplugin': { flag: true },
                        chatfilesys: { active_branch: 'b_x', branches: [], groups: {} },
                    },
                },
            }),
        });
        const host = adapter.lastSaveModelArgs.hostMetadata;
        assert.deepEqual(host.new_ns, { from: 'other-plugin' });
        assert.deepEqual(host.extensions['third-party/someplugin'], { flag: true });
        assert.equal('chatfilesys' in host.extensions, false, '本插件模型不得落进聊天头保留面');
        assert.equal('integrity' in host, false, '版本号不得落进聊天头保留面');
        assert.equal(adapter.lastSaveModelArgs.model.active_branch, 'b_x');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：messages 行整字段往返（extra 自定义键 / swipes / swipe_info 不丢）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const row = {
        name: 'AI', is_user: false, mes: 'hi', send_date: 123,
        extra: { plugin_x: { deep: [1, 2, 3] }, bookmark_link: 'cp1' },
        swipes: ['hi', 'hey'], swipe_info: [{ send_date: 1, extra: { k: 1 } }, { send_date: 2, extra: { k: 2 } }], swipe_id: 1,
    };
    adapter.floors = [{ floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify(row), contentHash: null, sendDate: 123 }];
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get', {
            method: 'POST', headers: {}, body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        });
        const body = await res.json();
        assert.deepEqual(body[1], row, '消息行必须逐字段一致');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：宿主保存不得抹掉其他插件的命名空间（extensions 逐命名空间合并）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        // 宿主这次只带自己的模型：extensions 里没有 third-party/someplugin
        await globalThis.fetch('/api/chats/meta', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                chat_metadata: { extensions: { chatfilesys: { active_branch: 'b_x', branches: [], groups: {} } } },
            }),
        });
        const host = adapter.lastSaveModelArgs.hostMetadata;
        assert.deepEqual(host.extensions['third-party/someplugin'], { flag: true },
            '整体替换 extensions 会抹掉其他插件的命名空间（真机实测会时有时无地丢）');
        assert.equal(host.main_chat, 'root_chat');
        assert.deepEqual(host.variables, { hp: 10 });
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：群聊端点不在拦截路由内（保持原生，行为不变）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    adapter.calls.native = 0;
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/group/save', { method: 'POST', body: '{}' });
        assert.equal(adapter.calls.saveModel + adapter.calls.saveFloors, 0, '群聊请求不得走本插件存储');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta 冲突 → 409', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    adapter.conflictNext = true;
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/meta', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 4, chat_metadata: {} }),
        });
        assert.equal(res.status, 409);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：get-delta → 分片区间响应形态', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.loadFloors = async (args) => { captured = args; return { floors: adapter.floors.slice(0, 1), hasMore: true }; };
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/get-delta', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', from_index: 0, limit: 1 }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(captured.from, 0);
        assert.equal(captured.limit, 1);
        assert.equal(body.chat.length, 1);
        assert.equal(body.next_index, 1);
        assert.equal(body.has_more, true);
        assert.equal(body.chat_metadata.extensions.chatfilesys.branches[0].id, 'b_main');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：dispose 后恢复原始 fetch', async () => {
    const original = async () => new Response('restored', { status: 200 });
    globalThis.fetch = original;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    seam.dispose();
    const res = await globalThis.fetch('/api/chats/get', {
        method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
    });
    assert.equal(await res.text(), 'restored');
});
