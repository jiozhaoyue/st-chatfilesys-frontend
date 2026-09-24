/**
 * merge.js 单测：完全相同去重 / LCP 分叉 / hash 冲突二重校验 / 多变体 / prepareRows 容错
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHash, prepareRows, alignMerge } from '../../public/scripts/extensions/third-party/chatfilesys/core/merge.js';

async function rowsOf(...rows) {
    const out = [];
    for (const r of rows) out.push({ hash: await computeHash(r), row: r, sendDate: r.send_date ?? null, sender: r.name ?? null });
    return out;
}

const msg = (name, mes, extra = {}) => ({ name, is_user: name === '我', mes, ...extra });

test('computeHash：归一化一致（BOM/换行差异不敏感）', async () => {
    const h1 = await computeHash({ name: '我', is_user: true, mes: 'hello\nworld' });
    const h2 = await computeHash({ name: ' 我 ', is_user: true, mes: 'hello\r\nworld﻿' });
    assert.equal(h1, h2);
    const h3 = await computeHash({ name: '我', is_user: true, mes: 'different' });
    assert.notEqual(h1, h3);
});

test('alignMerge：完全相同 → 幂等去重', async () => {
    const A = await rowsOf(msg('我', 'a'), msg('AI', 'b'));
    const B = await rowsOf(msg('我', 'a'), msg('AI', 'b'));
    const r = await alignMerge(A, B);
    assert.equal(r.stats.deduped, 2);
    assert.equal(r.stats.merged, 0);
    assert.equal(r.ops.length, 0);
});

test('alignMerge：前缀相同 → LCP 分叉', async () => {
    const A = await rowsOf(msg('我', 'a'), msg('AI', 'b'), msg('我', 'c'));
    const B = await rowsOf(msg('我', 'a'), msg('AI', 'b'), msg('我', 'x'), msg('AI', 'y'));
    const r = await alignMerge(A, B);
    assert.equal(r.forkFloor, 2);
    assert.equal(r.stats.deduped, 2);
    assert.equal(r.stats.merged, 2);
    assert.equal(r.ops.length, 2);
    assert.equal(r.ops[0].variantId, 'm1');
});

test('alignMerge：hash 相同但 sendDate 不同 → 不合并（conflictVariants 计数）', async () => {
    const A = await rowsOf(msg('我', 'a', { send_date: 111 }));
    const B = await rowsOf(msg('我', 'a', { send_date: 999 }));
    const r = await alignMerge(A, B);
    // 同 hash 不同 sendDate：LCP 停在 0 → 分叉语义
    assert.equal(r.forkFloor, 0);
    assert.ok(r.stats.conflictVariants >= 1);
    assert.equal(r.stats.merged, 1);
});

test('alignMerge：库空 → 全量导入', async () => {
    const B = await rowsOf(msg('我', 'a'), msg('AI', 'b'));
    const r = await alignMerge([], B);
    assert.equal(r.forkFloor, 0);
    assert.equal(r.stats.merged, 2);
    assert.equal(r.ops.length, 2);
});

test('prepareRows：跳过 header 与非法行', async () => {
    const lines = [
        JSON.stringify({ user_name: 'unused', chat_metadata: {} }), // header
        JSON.stringify({ name: '我', is_user: true, mes: 'a', send_date: 1 }),
        'not-json',
        JSON.stringify({ name: 'AI', is_user: false, mes: 'b' }),
    ];
    const { rows, stats } = await prepareRows(lines);
    assert.equal(rows.length, 2);
    assert.equal(stats.skipped, 1);
    assert.equal(rows[0].floorNo, 1);
});

test('多变体（swipes）行各自独立 hash', async () => {
    const base = { name: 'AI', is_user: false, send_date: 5 };
    const h1 = await computeHash({ ...base, mes: 'v1' });
    const h2 = await computeHash({ ...base, mes: 'v2' });
    assert.notEqual(h1, h2);
});
