/**
 * trash.js 单测：先快照后移除 / 按龄清理 / onPurge 回调 / 还原参数
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrash } from '../../public/scripts/extensions/third-party/chatfilesys/core/trash.js';

function mockBackend(items = []) {
    const store = new Map(items.map((x) => [x.trashId, x]));
    const order = [];
    return {
        order, store,
        async moveToTrash({ source, content }) {
            order.push(['move', source]);
            const trashId = `t${store.size + 1}`;
            store.set(trashId, { trashId, source, movedAt: Date.now(), content });
            return { ok: true, trashId };
        },
        async listTrash() { return [...store.values()].map(({ trashId, source, movedAt }) => ({ trashId, source, movedAt })); },
        async restoreFromTrash({ trashId }) {
            const x = store.get(trashId);
            if (!x) return { ok: false };
            order.push(['restore', trashId]);
            return { ok: true, content: x.content, source: x.source, movedAt: x.movedAt };
        },
        async deleteFromTrash({ trashId }) {
            order.push(['delete', trashId]);
            store.delete(trashId);
            return { ok: true };
        },
    };
}

test('snapshotAndMove：先快照（回收站持有副本）语义', async () => {
    const be = mockBackend();
    const trash = createTrash({ backend: be });
    const r = await trash.snapshotAndMove({ source: 'chat1.jsonl', content: 'line1\nline2\n' });
    assert.equal(r.ok, true);
    assert.ok(r.trashId);
    assert.equal(be.order[0][0], 'move');
});

test('purgeExpired：按 movedAt+maxAge 清理', async () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 天前
    const be = mockBackend([
        { trashId: 'old1', source: 'a.jsonl', movedAt: old },
        { trashId: 'new1', source: 'b.jsonl', movedAt: Date.now() },
    ]);
    const trash = createTrash({ backend: be });
    const purged = await trash.purgeExpired();
    assert.equal(purged, 1);
    const rest = await trash.listAll();
    assert.equal(rest.length, 1);
    assert.equal(rest[0].trashId, 'new1');
});

test('onPurge：清理后回调触发', async () => {
    const be = mockBackend([{ trashId: 'o', source: 'x', movedAt: 1 }]);
    const trash = createTrash({ backend: be });
    let fired = 0;
    trash.onPurge((n) => { fired = n; });
    await trash.purgeExpired();
    assert.equal(fired, 1);
});

test('restore：参数正确传递', async () => {
    const be = mockBackend();
    const trash = createTrash({ backend: be });
    await trash.snapshotAndMove({ source: 'c.jsonl', content: 'X' });
    const r = await trash.restore({ trashId: 't1' });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'X');
    assert.equal(r.source, 'c.jsonl');
});

test('purgeExpired 不误删未过期条目（边界：正好 7 天）', async () => {
    const MAX = 7 * 24 * 60 * 60 * 1000;
    const edge = Date.now() - MAX;
    const be = mockBackend([{ trashId: 'edge', source: 'e', movedAt: edge }]);
    const trash = createTrash({ backend: be });
    // **注入 now**（purgeExpired(now) 是既有接缝）：判据是 `movedAt + maxAge < now`，
    // 用真实时钟时「算 edge」与「purge 内部取 now」之间的毫秒漂移会让这条边界断言偶发失败
    // （实测 62 次跑 1 次挂，正是它）。钉死在到期那一刻 → 严格相等不清理。
    const purged = await trash.purgeExpired(edge + MAX);
    // movedAt + maxAge == now 不小于 now → 不清理（严格小于才清）
    assert.equal(purged, 0);
    // 过 1 毫秒就该清（把「严格小于」这个方向也钉住）
    assert.equal(await trash.purgeExpired(edge + MAX + 1), 1);
});
