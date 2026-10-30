/**
 * v2 家族状态层单测：`core/family-state.js`
 *
 * 覆盖 implement-v2 C1.1：selectVersion / hideVersion / deleteMessage / setManualParent /
 * validateFamily。契约出处逐条标 spec（family-operation-v2.md §2）：
 * · 选择分支局部（规则 6）：切 A 不暗改 B —— 本模块最核心的一条；
 * · 隐藏回退（规则 6）：前项 → 后项；最后一版报 last-visible-version；
 * · 身份 ≠ 位置（规则 2）：同正文两条消息不同 messageId，selectVersion 不串；
 * · 展示序（规则 4）：按 swipe_info.send_date，缺失者保槽位 —— 隐藏回退按**展示序**找前项。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateFamily, selectVersion, hideVersion, deleteMessage, setManualParent,
    displayOrder,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/family-state.js';
import { twoBranches, shiftedThreeBranches } from './fixtures-v2.mjs';

const codeOf = (fn) => {
    try {
        fn();
    } catch (e) {
        return e.code || String(e?.message || e);
    }
    return null; // 没抛 = 用例自身失败，断言处会红
};

/* ---------------- validateFamily：好例 ---------------- */

test('validateFamily：twoBranches / shiftedThreeBranches 均 ok 且 paths 空', () => {
    assert.deepEqual(validateFamily(twoBranches()), { ok: true, paths: [] });
    assert.deepEqual(validateFamily(shiftedThreeBranches()), { ok: true, paths: [] });
});

test('validateFamily：schemaVersion 非 2 → 拒绝并定位', () => {
    const f = twoBranches();
    f.schemaVersion = 1;
    const r = validateFamily(f);
    assert.equal(r.ok, false);
    assert.ok(r.paths.some((p) => p.includes('schemaVersion')), JSON.stringify(r.paths));
});

/* ---------------- validateFamily：坏例矩阵 ---------------- */

test('validateFamily：entry 引用不存在的 message → invalid-reference 定位到 entry', () => {
    const f = twoBranches();
    f.branches.A.entries[0].messageId = 'm_ghost';
    const r = validateFamily(f);
    assert.equal(r.ok, false);
    assert.ok(r.paths.some((p) => p.includes('branches.A.entries[0]')), JSON.stringify(r.paths));
});

test('validateFamily：version 缺失 / rawRowRef 缺失 / selected 不在可见集 / 可见集空 / 可见集重复 → 全部拒绝', () => {
    // version 缺失
    let f = twoBranches();
    f.branches.A.entries[0].visibleVersionIds = ['v_ghost', 'v2'];
    assert.ok(validateFamily(f).paths.some((p) => p.includes('entries[0]')));

    // rawRowRef 缺失
    f = twoBranches();
    f.branches.A.entries[1].rawRowRef = 'rw_ghost';
    assert.ok(validateFamily(f).paths.some((p) => p.includes('entries[1]') && p.includes('rawRowRef')));

    // selected 不在可见集
    f = twoBranches();
    f.branches.A.entries[0].selectedVersionId = 'v2';
    f.branches.A.entries[0].visibleVersionIds = ['v1'];
    assert.ok(validateFamily(f).paths.some((p) => p.includes('selectedVersionId')));

    // 可见集空
    f = twoBranches();
    f.branches.A.entries[0].visibleVersionIds = [];
    assert.ok(validateFamily(f).paths.some((p) => p.includes('visibleVersionIds')));

    // 可见集重复
    f = twoBranches();
    f.branches.A.entries[0].visibleVersionIds = ['v1', 'v1'];
    assert.ok(validateFamily(f).paths.some((p) => p.includes('visibleVersionIds')));
});

test('validateFamily：activeBranchId 不存在 / 两个 isDefault → 拒绝', () => {
    let f = twoBranches();
    f.activeBranchId = 'Z';
    assert.ok(validateFamily(f).paths.some((p) => p.includes('activeBranchId')));

    f = twoBranches();
    f.branches.B.isDefault = true;
    assert.ok(validateFamily(f).paths.some((p) => p.includes('isDefault')));
});

/* ---------------- selectVersion：分支局部选择（spec 规则 6 的核心钉） ---------------- */

test('selectVersion：A 切 v2 → A 变、B 不动、原对象一字不改', () => {
    const family = twoBranches();
    const next = selectVersion(family, 'A', 'm1', 'v2');
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v2');
    // B 自始选 v2 —— 切 A 后 B 仍是它自己的 v2（不被暗改，也不被同步）
    assert.equal(next.branches.B.entries[0].selectedVersionId, 'v2');
    // 原对象不可变
    assert.equal(family.branches.A.entries[0].selectedVersionId, 'v1');
    assert.notEqual(next, family);
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] });
});

test('selectVersion：反向切 B → A 的选择不受影响', () => {
    const family = selectVersion(twoBranches(), 'A', 'm1', 'v2'); // A 先切到 v2
    const next = selectVersion(family, 'B', 'm1', 'v1');
    assert.equal(next.branches.B.entries[0].selectedVersionId, 'v1');
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v2'); // A 保持
});

test('selectVersion：三分支错位家族中切 A，B/C 各自选择不动', () => {
    const family = shiftedThreeBranches();
    const next = selectVersion(family, 'A', 'm1', 'v2');
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v2');
    assert.equal(next.branches.B.entries[0].selectedVersionId, 'v2');
    assert.equal(next.branches.C.entries[0].selectedVersionId, 'v2');
    assert.equal(family.branches.A.entries[0].selectedVersionId, 'v1');
});

test('selectVersion：不存在的 version → invalid-reference；存在但不可见 → version-not-visible', () => {
    const family = twoBranches();
    assert.equal(codeOf(() => selectVersion(family, 'A', 'm1', 'v_ghost')), 'invalid-reference');
    // v2 存在但 A 当前不可见集若不含它则拒 —— 先造一个「A 可见集只有 v1」的态
    const hidden = hideVersion(twoBranches(), 'A', 'm1', 'v2');
    assert.equal(codeOf(() => selectVersion(hidden, 'A', 'm1', 'v2')), 'version-not-visible');
});

test('selectVersion：不存在的 branch / message → invalid-reference', () => {
    const family = twoBranches();
    assert.equal(codeOf(() => selectVersion(family, 'Z', 'm1', 'v1')), 'invalid-reference');
    assert.equal(codeOf(() => selectVersion(family, 'A', 'm_ghost', 'v1')), 'invalid-reference');
});

/* ---------------- 同正文不同身份（spec 规则 2：不按文本合一） ---------------- */

test('同正文两条消息是不同 messageId：切其一不影响其二', () => {
    const f = shiftedThreeBranches();
    // m4 与一条同正文的新消息 m4copy 并存
    f.messages.m4copy = structuredClone(f.messages.m4);
    f.branches.A.entries.push({
        messageId: 'm4copy', visibleVersionIds: ['v4c'], selectedVersionId: 'v4c',
        rawRowRef: 'rw-A4copy', dirty: false,
    });
    f.rawRows['rw-A4copy'] = structuredClone(f.rawRows['rw-A4']);
    f.messages.m4copy.versions.v4c = structuredClone(f.messages.m4.versions.v4);
    f.branches.A.entries[2].visibleVersionIds = ['v4'];
    assert.deepEqual(validateFamily(f), { ok: true, paths: [] }); // 同正文不同 id 合法

    const next = selectVersion(f, 'A', 'm4copy', 'v4c');
    assert.equal(next.branches.A.entries[3].messageId, 'm4copy'); // 只动目标条目
    assert.equal(next.branches.A.entries[2].selectedVersionId, 'v4'); // 同正文的兄弟消息不动
    assert.equal(next.branches.B.entries[2].selectedVersionId, 'v4'); // 别的分支不动
});

/* ---------------- hideVersion（spec 规则 6） ---------------- */

test('hideVersion：A 隐藏未选中的 v2 → 可见集收缩、选择不变；B 完全不受影响', () => {
    const family = twoBranches();
    const next = hideVersion(family, 'A', 'm1', 'v2');
    assert.deepEqual(next.branches.A.entries[0].visibleVersionIds, ['v1']);
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v1');
    assert.deepEqual(next.branches.B.entries[0].visibleVersionIds, ['v1', 'v2']); // B 不变
    assert.equal(next.branches.B.entries[0].selectedVersionId, 'v2');
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] });
});

test('hideVersion：隐藏当前所选 → 回退到展示序前项（等日期按原下标）', () => {
    const f = twoBranches();
    // 造三版本 m1：v1@D1、v2@D1、v3@D2，selected=v2；展示序 [v1, v2, v3]（等日期按原下标）
    f.messages.m1.versions.v3 = {
        raw: { name: 'Seraphina', is_user: false, mes: '第三版', send_date: '2026-01-01T00:02:00.000Z' },
        swipeInfo: { send_date: '2026-01-01T00:02:00.000Z' }, sourceRefs: ['src:c'],
    };
    const e = f.branches.A.entries[0];
    e.visibleVersionIds = ['v1', 'v2', 'v3'];
    e.selectedVersionId = 'v2';
    e.rawRowRef = 'rw-a1'; // 保持原 ref，回退只看可见集与展示序

    const next = hideVersion(f, 'A', 'm1', 'v2');
    assert.deepEqual(next.branches.A.entries[0].visibleVersionIds, ['v1', 'v3']);
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v1'); // 展示序里 v2 的前项
});

test('hideVersion：隐藏展示序首位的所选 → 回退到后项', () => {
    const f = twoBranches();
    // v1 无日期（保槽位 0）、v2@D2：展示序 [v1, v2]；selected=v1（首位）
    f.messages.m1.versions.v1.swipeInfo = null; // 缺失日期
    const e = f.branches.A.entries[0];
    e.selectedVersionId = 'v1';
    const next = hideVersion(f, 'A', 'm1', 'v1');
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v2'); // 无前项 → 后项
});

test('hideVersion：最后一版不许隐藏 → last-visible-version（提示改用删除消息）', () => {
    const family = twoBranches();
    // m2 只有 v3 一版 → 隐藏即空，必须报 last-visible-version
    assert.equal(codeOf(() => hideVersion(family, 'A', 'm2', 'v3')), 'last-visible-version');
    // m1 有两版：隐藏 v1 合法，所选回退到后项 v2
    const next = hideVersion(family, 'A', 'm1', 'v1');
    assert.deepEqual(next.branches.A.entries[0].visibleVersionIds, ['v2']);
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v2');
});

test('hideVersion：隐藏不存在/不可见的版本 → invalid-reference', () => {
    const family = twoBranches();
    assert.equal(codeOf(() => hideVersion(family, 'A', 'm1', 'v_ghost')), 'invalid-reference');
    assert.equal(codeOf(() => hideVersion(family, 'A', 'm_b5', 'v1')), 'invalid-reference'); // v1 不属 m_b5
});

/* ---------------- deleteMessage（只删当前 entry，身份留给仍引用它的分支） ---------------- */

test('deleteMessage：A 删 m1 → A 少一层；B 的 m1 原样；messages 记录不回收（purge 归 C3）', () => {
    const family = twoBranches();
    const next = deleteMessage(family, 'A', 'm1');
    assert.equal(next.branches.A.entries.length, 1);
    assert.equal(next.branches.A.entries[0].messageId, 'm2');
    assert.equal(next.branches.B.entries[0].messageId, 'm1'); // B 不动
    assert.ok(next.messages.m1); // 身份记录保留
    assert.ok(next.rawRows['rw-b1']); // B 的原始行保留
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] });
    // 原对象不可变
    assert.equal(family.branches.A.entries.length, 2);
});

test('deleteMessage：不存在分支/消息 → invalid-reference', () => {
    const family = twoBranches();
    assert.equal(codeOf(() => deleteMessage(family, 'Z', 'm1')), 'invalid-reference');
    assert.equal(codeOf(() => deleteMessage(family, 'A', 'm_b5')), 'invalid-reference'); // A 没引用它
});

/* ---------------- setManualParent（spec 规则 7） ---------------- */

test('setManualParent：新增 manual 关系，端点与方向正确', () => {
    const f = twoBranches();
    f.relations = [];
    const next = setManualParent(f, 'B', 'A'); // B 的父 = A
    const rel = next.relations.at(-1);
    assert.equal(rel.kind, 'manual');
    assert.equal(rel.fromBranchId, 'B');
    assert.equal(rel.toBranchId, 'A');
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] });
});

test('setManualParent：自环 → self-parent；一个分支已有 manual 父再设 → multiple-manual-parents；成环 → parent-cycle', () => {
    let f = twoBranches();
    f.relations = [];
    assert.equal(codeOf(() => setManualParent(f, 'A', 'A')), 'self-parent');

    // 已有 manual 父（fixtures 自带 rel-1 是 derived，不算）；先设一个
    let g = setManualParent({ ...twoBranches(), relations: [] }, 'B', 'A');
    assert.equal(codeOf(() => setManualParent(g, 'B', g.activeBranchId === 'A' ? 'B' : 'A')), 'self-parent');
    assert.equal(codeOf(() => setManualParent(g, 'B', 'B')), 'self-parent');

    // multiple-manual-parents：B 已有父 A，再设父（造第三个分支 C）
    const h = twoBranches();
    h.relations = [];
    h.branches.C = structuredClone(h.branches.B);
    h.branches.C.name = 'C';
    h.branches.C.isDefault = false;
    const withC = setManualParent(h, 'B', 'A');
    assert.equal(codeOf(() => setManualParent(withC, 'B', 'C')), 'multiple-manual-parents');

    // 成环：A←B←C 再设 C 的父为 A
    let k = twoBranches();
    k.relations = [];
    k.branches.C = structuredClone(k.branches.B);
    k.branches.C.name = 'C';
    k.branches.C.isDefault = false;
    k = setManualParent(k, 'B', 'A');
    k = setManualParent(k, 'C', 'B');
    assert.equal(codeOf(() => setManualParent(k, 'A', 'C')), 'parent-cycle');
});

test('setManualParent：端点不存在 → invalid-reference；derived 不被 manual 覆盖（原关系保留）', () => {
    const f = twoBranches(); // relations 自带一条 derived rel-1（B→A）
    assert.equal(codeOf(() => setManualParent(f, 'B', 'Z')), 'invalid-reference');
    const next = setManualParent(f, 'B', 'A'); // 同端点再设 manual：derived 保留，manual 追加
    assert.equal(next.relations.filter((r) => r.kind === 'derived').length, 1);
    assert.equal(next.relations.filter((r) => r.kind === 'manual').length, 1);
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] });
});

/* ---------------- displayOrder（spec 规则 4：日期序，缺失保槽位） ---------------- */

test('displayOrder：按 send_date 升序、缺失者保原槽位、等日期按原下标', () => {
    const f = twoBranches();
    const e = f.branches.A.entries[0];
    // 全有日期：v1@D1, v2@D2 → [v1, v2]
    assert.deepEqual(displayOrder(e, f), ['v1', 'v2']);

    // v2 日期更早 → [v2, v1]
    f.messages.m1.versions.v2.swipeInfo = { send_date: '2025-12-31T00:00:00.000Z' };
    assert.deepEqual(displayOrder(e, f), ['v2', 'v1']);

    // v1 无日期（保槽位 0），v2 有日期 → [v1, v2]
    f.messages.m1.versions.v1.swipeInfo = null;
    assert.deepEqual(displayOrder(e, f), ['v1', 'v2']);

    // 日期不可解析 = 视同缺失，保槽位
    f.messages.m1.versions.v1.swipeInfo = { send_date: '垃圾日期' };
    assert.deepEqual(displayOrder(e, f), ['v1', 'v2']);
});
