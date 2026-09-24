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
        familyId: 'f1', chatKey: 'av1::chat1', characterId: 'c1', name: 'chat1', integrity: 5,
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
        async loadFloors() { return { floors, hasMore: false }; },
        async saveFloors() { this.calls.saveFloors++; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 6 }; },
        async applyOps() { this.calls.applyOps++; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 6 }; },
        async saveModel(args) { this.calls.saveModel++; this.lastSaveModelArgs = args; return this.conflictNext ? { ok: false, conflict: true } : { ok: true, integrity: 6 }; },
        async renameFamily() { return { ok: true, integrity: 6 }; },
        async deleteFamily() { return { ok: true }; },
    };
}

test('normalizeChatKey：小写+去空白', () => {
    assert.equal(normalizeChatKey(' AV1 ', 'Chat1.JSONL'), 'av1::chat1.jsonl');
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
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                chat: [{ name: '我', is_user: true, mes: 'a' }, { name: 'AI', is_user: false, mes: 'b' }],
            }),
        });
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.integrity, 6);
        assert.equal(adapter.calls.saveFloors, 1);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：append → saveFloors 参数正确（floorNo 续接活跃分支 maxFloor）', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.saveFloors = async (args) => { captured = args; return { ok: true, integrity: 6 }; };
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

test('seam：patch → ops 透传 applyOps', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    let captured = null;
    adapter.applyOps = async (args) => { captured = args; return { ok: true, integrity: 6 }; };
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
        assert.deepEqual(captured.ops, ops);
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
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                chat_metadata: { extensions: { chatfilesys: { active_branch: 'b_x', branches: [], groups: { g1: [1] } } } },
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.integrity, 6);
        assert.equal(adapter.calls.saveModel, 1);
        assert.equal(adapter.lastSaveModelArgs.familyId, 'f1');
        assert.equal(adapter.lastSaveModelArgs.model.active_branch, 'b_x');
        assert.deepEqual(adapter.lastSaveModelArgs.model.groups, { g1: [1] });
        assert.equal(adapter.lastSaveModelArgs.expectedIntegrity, 5);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam：meta/patch → saveModel keepCurrent 防漏写', async () => {
    const original = globalThis.fetch;
    const adapter = mockAdapter();
    const seam = installSeam(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 5,
                operations: [{ op: 'replace', path: '/active_branch', value: 'b_y' }],
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(adapter.lastSaveModelArgs.keepCurrent, true);
        assert.equal(adapter.lastSaveModelArgs.model, null);
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
