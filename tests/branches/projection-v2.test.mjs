/**
 * v2 逐分支投影单测：`core/family-codec.js`（implement-v2 C1.2）
 *
 * 契约（family-operation-v2.md §2 规则 3/4/5）：
 * · dirty=false → 直接克隆 rawRowRef 整行（未知字段、原始三件套原样）；
 * · dirty=true → 按选中 ID 与可见集重组三件套，**完整复制每条 swipeInfo 未知字段**；
 * · selected 用 versionId 映射，不按排序后下标；未编辑投影保持原数组顺序；
 * · 分支 header（含未知字段）随投影首元素返回。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-codec.js';
import { selectVersion, hideVersion } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-state.js';
import { twoBranches } from './fixtures-v2.mjs';

/* ---------------- dirty=false：原样克隆 ---------------- */

test('未编辑分支投影 = [header, ...rawRows 逐字节克隆]；未知 header 字段保留', () => {
    const f = twoBranches();
    const rows = projectBranch(f, 'A');
    assert.deepEqual(rows[0], f.branches.A.header); // 含 header，未知字段原样
    assert.deepEqual(rows[1], f.rawRows['rw-a1']); // 原始三件套整行克隆
    assert.deepEqual(rows[2], f.rawRows['rw-a2']);

    const rowsB = projectBranch(f, 'B');
    assert.deepEqual(rowsB[0], f.branches.B.header);
    assert.deepEqual(rowsB[1], f.rawRows['rw-b1']); // B 的原生行（swipe_id=1 那份）
    assert.deepEqual(rowsB[2], f.rawRows['rw-b5']);
});

test('投影不改源库：两次投影互不影响、rawRows 不被改写', () => {
    const f = twoBranches();
    const a1 = projectBranch(f, 'A');
    const b1 = projectBranch(f, 'B');
    a1[1].swipe_id = 99; // 改投影产物
    assert.equal(f.rawRows['rw-a1'].swipe_id, 0); // 源不受影响
    assert.deepEqual(projectBranch(f, 'B'), b1);
});

/* ---------------- dirty=true：按选中 ID 与可见集重组三件套 ---------------- */

test('dirty=true 且可见 2 版：swipes/swipe_info/swipe_id 按可见集重组，swipeInfo 未知字段完整保留', () => {
    const f = twoBranches();
    // 给 v2 的 swipeInfo 加一个未知字段 —— 重组时必须带出来
    f.messages.m1.versions.v2.swipeInfo.unknown_si = '保留我';
    const e = f.branches.A.entries[0];
    e.selectedVersionId = 'v2';
    e.dirty = true;

    const rows = projectBranch(f, 'A');
    const row = rows[1];
    assert.deepEqual(row.swipes, [
        f.messages.m1.versions.v1.raw.mes,
        f.messages.m1.versions.v2.raw.mes,
    ]);
    assert.equal(row.swipe_id, 1); // selected=v2 在可见集 [v1,v2] 里的下标
    assert.deepEqual(row.swipe_info[1], { send_date: '2026-01-01T00:01:00.000Z', extra: { note: '变体二' }, unknown_si: '保留我' });
    assert.equal(row.mes, f.messages.m1.versions.v2.raw.mes); // 主体 = 所选版本的 raw
});

test('dirty=true 隐藏一版后：三件套按**剩余可见集**重组，selected 下标按 versionId 映射（不是原数组下标）', () => {
    const f = twoBranches();
    // 三版本：v1@D1、v2@D2、v3@D3
    f.messages.m1.versions.v3 = {
        raw: { name: 'Seraphina', is_user: false, mes: '第三版', send_date: '2026-01-01T00:03:00.000Z' },
        swipeInfo: { send_date: '2026-01-01T00:03:00.000Z' }, sourceRefs: ['src:c'],
    };
    const e = f.branches.A.entries[0];
    e.visibleVersionIds = ['v1', 'v2', 'v3'];
    e.selectedVersionId = 'v3'; // 选 v3、隐藏 v1 → 可见 [v2, v3]，selected=v3 的下标是 **1**（可见集内），不是原数组里的 2
    const hidden = hideVersion(f, 'A', 'm1', 'v1');
    const e2 = hidden.branches.A.entries[0];
    assert.equal(e2.selectedVersionId, 'v3');
    e2.dirty = true;

    const row = projectBranch(hidden, 'A')[1];
    assert.deepEqual(row.swipes, ['你握紧剑柄，摇了摇头：白天更安全。', '第三版']);
    assert.equal(row.swipe_id, 1); // versionId 映射，不是旧下标
    assert.equal(row.mes, '第三版');
});

test('dirty=true 单可见版本：不生成三件套（裸单行）', () => {
    const f = twoBranches();
    const e = f.branches.A.entries[1]; // m2 单版本
    e.dirty = true;
    const row = projectBranch(f, 'A')[2];
    assert.equal(row.swipes, undefined);
    assert.equal(row.swipe_info, undefined);
    assert.equal(row.swipe_id, undefined);
    assert.equal(row.mes, '火把给我，你在前面探路。');
});

/* ---------------- 顺序与异常 ---------------- */

test('未编辑投影保持原数组顺序（展示序不影响存储数组）', () => {
    const f = twoBranches();
    // v2 日期比 v1 早 → 展示序是 [v2, v1]，但 dirty=false 的投影**原样**（swipe_id=0 仍是 v1）
    f.messages.m1.versions.v2.swipeInfo = { send_date: '2025-12-31T00:00:00.000Z' };
    const row = projectBranch(f, 'A')[1];
    assert.deepEqual(row.swipes, [
        f.messages.m1.versions.v1.raw.mes,
        f.messages.m1.versions.v2.raw.mes,
    ]);
    assert.equal(row.swipe_id, 0);
});

test('opaque 消息（无 mes 的合法 JSON 行）：dirty=false 原样投影，不吞行', () => {
    const f = twoBranches();
    f.messages.m_opq = { opaque: true, versions: { v_opq: { raw: { note: '注释行', unknown: 1 }, swipeInfo: null, sourceRefs: [] } } };
    f.rawRows['rw-opq'] = { note: '注释行', unknown: 1 };
    f.branches.A.entries.push({
        messageId: 'm_opq', visibleVersionIds: ['v_opq'], selectedVersionId: 'v_opq',
        rawRowRef: 'rw-opq', dirty: false,
    });
    const rows = projectBranch(f, 'A');
    assert.deepEqual(rows[3], { note: '注释行', unknown: 1 }); // 原样带出，不是丢弃
});

test('引用损坏的家族投影 → invalid-reference（不静默造空行）', () => {
    const f = twoBranches();
    f.branches.A.entries[1].rawRowRef = 'rw_ghost';
    assert.throws(() => projectBranch(f, 'A'), (e) => e.code === 'invalid-reference');
    const g = twoBranches();
    g.branches.A.entries[0].selectedVersionId = 'v_ghost'; // 不在可见集
    g.branches.A.entries[0].dirty = true;
    assert.throws(() => projectBranch(g, 'A'), (e) => e.code === 'invalid-reference');
});

test('分支不存在 → invalid-reference', () => {
    assert.throws(() => projectBranch(twoBranches(), 'Z'), (e) => e.code === 'invalid-reference');
});
