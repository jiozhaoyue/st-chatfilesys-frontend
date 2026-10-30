/**
 * 旧家族隔离迁移单测：`core/legacy-family-migration.js`（implement-v2 C1.2）
 *
 * 契约（family-operation-v2.md §2「旧数据映射」+ design-v2.md「迁移顺序」）：
 * · **按 gid / variantId 引用逐分支重建，不按 floorNo 聚合** —— 三个私有组同 floorNo
 *   必须成为三个**不同消息**（旧 store-bridge 按位置折叠是把它们错并成一个组的 bug 形态）；
 * · 每个旧 gid 对应新 messageId；组内每个完整 raw 对应 versionId；旧 active（swipe_id）映射为 selected；
 * · 旧结构共享选择时不虚构历史（同 gid 各分支 selected 一致）；
 * · header / 未知字段 / 键绑定逐项保全；markerFloor → markerMessageId；
 * · 缺引用 → ok:false + 路径报告，**不碰源、不造假数据**；输入对象整体不可变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importLegacy } from '../../public/scripts/extensions/third-party/chatfilesys/core/legacy-family-migration.js';
import { familyFromStore } from '../../public/scripts/extensions/third-party/chatfilesys/core/store-bridge.js';
import { projectBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-codec.js';
import { validateFamily } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-state.js';

/* ---------------- 旧形态夹具 ---------------- */

const D = (h, m = 0) => `2026-06-21T${String(h).padStart(2, '0')}:16:${String(m).padStart(2, '0')}.000Z`;
const row = (name, is_user, mes, extra = {}) => ({ name, is_user, mes, send_date: D(14), ...extra });

/** 旧家族：主分支 4 楼（含三件套行 / 无 mes 合法 JSON 行 / 重复正文）+ 两条分支私有楼 */
function legacyFixture() {
    const r1 = row('我', true, '我们出发吧，森林的北边有个废弃的哨塔。');
    const r2 = {
        ...row('Seraphina', false, '夜色像湿苔一样贴上来。你确定要今晚走？'),
        swipes: ['夜色像湿苔一样贴上来。你确定要今晚走？', '你握紧剑柄，摇了摇头：白天更安全。'],
        swipe_info: [
            { send_date: D(14), extra: {}, unknown_si: 'a 保留' },
            { send_date: D(15), extra: { note: '变体二' } },
        ],
        swipe_id: 1,
    };
    const r3 = { note: '合法 JSON 但不是消息行', unknown_keep: 'y' }; // 无 mes
    const r4 = row('我', true, '我们出发吧，森林的北边有个废弃的哨塔。'); // 与 r1 重复正文，不同身份
    const g6v = row('Seraphina', false, 'B 线私有 3 楼', { send_date: D(16), unknown_v: 'u1' });
    const g7v0 = row('Seraphina', false, 'B 线 4 楼·版一', { send_date: D(17), extra: {} });
    const g7v1 = row('Seraphina', false, 'B 线 4 楼·版二', { send_date: D(18), extra: {} });
    const r8 = row('Seraphina', false, 'C 线私有 4 楼（storedRows 形态）', { send_date: D(19), extra: { tag: 'c' } });

    const header = {
        user_name: 'User', character_name: 'Seraphina',
        create_date: '2026-06-21', unknown_header: { keep: 'header 未知字段' },
    };
    const model = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4' } },
            // b1 fork@2：3/4 楼私有（g6 单变体组、g7 组内两变体 = swipe 降级形态）
            { id: 'b1', name: '支线·塔顶', is_default: false, fork_base: 2, path: { 1: 'g1', 2: 'g2', 3: 'g6', 4: 'g7' } },
            // b2 fork@3：4 楼私有（g8，来自 storedRows）；与主分支共享 g1–g3
            { id: 'b2', name: '支线·原地', is_default: false, fork_base: 3, path: { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g8' } },
        ],
        groups: {
            g6: { id: 'g6', floor: 3, owner: 'b1', active: 0, variants: [g6v] },
            g7: { id: 'g7', floor: 4, owner: 'b1', active: 0, variants: [g7v0, g7v1] },
        },
    };
    const storedRows = [
        { floorNo: 4, variantId: 'g8', seq: 0, content: JSON.stringify(r8), contentHash: null, sendDate: D(19) },
    ];
    const keyBindings = {
        chat_cp1: { branchId: 'b1', isCheckpoint: true, markerFloor: 4 },
        chat_main: { branchId: 'b_main' },
    };
    return { header, body: [r1, r2, r3, r4], model, storedRows, keyBindings };
}

/* ---------------- 迁移成功 + 逐分支投影对账 ---------------- */

test('importLegacy：ok 且 validateFamily 通过；逐分支投影与旧数据逐值一致（含 header 与未知字段）', () => {
    const fx = legacyFixture();
    const before = structuredClone(fx);
    const migrated = importLegacy(fx);
    assert.deepEqual(fx, before); // 输入不可变
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.deepEqual(validateFamily(migrated.family), { ok: true, paths: [] });

    const f = migrated.family;
    // 主分支：header + 4 行原样（三件套行、无 mes 行都原样带出）
    assert.deepEqual(projectBranch(f, 'b_main'), [header0(f), ...fx.body]);
    // b1：共享 1/2 楼 + 私有 g6（单变体裸行）+ g7（两变体展开成三件套，active=0）
    const b1rows = projectBranch(f, 'b1');
    assert.equal(b1rows.length, 5);
    assert.deepEqual(b1rows[3], { name: 'Seraphina', is_user: false, mes: 'B 线私有 3 楼', send_date: D(16), unknown_v: 'u1' });
    assert.deepEqual(b1rows[4], {
        name: 'Seraphina', is_user: false, mes: 'B 线 4 楼·版一', send_date: D(17), extra: {},
        swipes: ['B 线 4 楼·版一', 'B 线 4 楼·版二'],
        swipe_info: [{ send_date: D(17), extra: {} }, { send_date: D(18), extra: {} }],
        swipe_id: 0,
    });
    // b2：共享 1–3 楼 + storedRows 的 g8
    const b2rows = projectBranch(f, 'b2');
    assert.deepEqual(b2rows[4], JSON.parse(fx.storedRows[0].content));
});

/** 迁移后 header 的引用（每次 importLegacy 都是新对象，这里现取） */
function header0(family) {
    return family.branches.b_main.header;
}

test('importLegacy：**按 gid 不按 floorNo** —— 同 floorNo 的三个私有组是三个不同消息', () => {
    const f = importLegacy(legacyFixture()).family;
    // 同楼层不同分支
    assert.equal(f.branches.b_main.entries[3].messageId, 'm_g4');
    assert.equal(f.branches.b1.entries[3].messageId, 'm_g7');
    assert.equal(f.branches.b2.entries[3].messageId, 'm_g8');
    // 共享 gid → 同一消息身份（同楼层同 gid 反向验证）
    assert.equal(f.branches.b_main.entries[0].messageId, 'm_g1');
    assert.equal(f.branches.b1.entries[0].messageId, 'm_g1');
    assert.equal(f.branches.b2.entries[0].messageId, 'm_g1');
    // 同楼层不同 gid ≠ 同一消息（旧按 floorNo 折叠会错并的形态）
    assert.notEqual(f.branches.b_main.entries[3].messageId, f.branches.b1.entries[3].messageId);
});

test('importLegacy：三件套行 → 多版本 + selected 按 swipe_id；共享 gid 不虚构各自选择', () => {
    const f = importLegacy(legacyFixture()).family;
    const e = f.branches.b_main.entries[1]; // g2 三件套，swipe_id=1
    assert.deepEqual(e.visibleVersionIds, ['v_g2_0', 'v_g2_1']);
    assert.equal(e.selectedVersionId, 'v_g2_1');
    // b1 共享 g2：旧结构共享 active ⇒ selected 一致（不虚构「B 曾另选」）
    assert.equal(f.branches.b1.entries[1].selectedVersionId, 'v_g2_1');
    // 版本 raw 保留每条 swipeInfo 未知字段
    assert.equal(f.messages.m_g2.versions.v_g2_0.swipeInfo.unknown_si, 'a 保留');
    // g7 组内两变体 → 两版本，active=0 → selected=v_g7_0
    assert.deepEqual(f.branches.b1.entries[3].visibleVersionIds, ['v_g7_0', 'v_g7_1']);
    assert.equal(f.branches.b1.entries[3].selectedVersionId, 'v_g7_0');
});

test('importLegacy：重复正文 → 不同 messageId（身份 ≠ 文本）', () => {
    const f = importLegacy(legacyFixture()).family;
    assert.notEqual(f.branches.b_main.entries[0].messageId, f.branches.b_main.entries[3].messageId);
});

test('importLegacy：无 mes 合法 JSON 行 → opaque 原样保留，不吞行', () => {
    const f = importLegacy(legacyFixture()).family;
    const mid = f.branches.b_main.entries[2].messageId;
    assert.equal(f.messages[mid].opaque, true);
    // 投影对账已在上例覆盖（body 第 3 行原样出现）
});

test('importLegacy：分支 header / 名字 / isDefault / 活跃分支逐项保全', () => {
    const f = importLegacy(legacyFixture()).family;
    assert.equal(f.activeBranchId, 'b_main');
    assert.equal(f.branches.b_main.isDefault, true);
    assert.equal(f.branches.b1.isDefault, false);
    assert.equal(f.branches.b1.name, '支线·塔顶');
    assert.equal(f.branches.b_main.header.unknown_header.keep, 'header 未知字段');
    // 每分支 header 都带原 header（旧模型一份 header 全家族共享）
    assert.deepEqual(f.branches.b2.header, f.branches.b_main.header);
});

test('importLegacy：keyBindings 保全 + markerFloor → markerMessageId（按目标分支 path 映射）', () => {
    const f = importLegacy(legacyFixture()).family;
    assert.deepEqual(f.keyBindings.chat_cp1, { branchId: 'b1', isCheckpoint: true, markerMessageId: 'm_g7' });
    assert.deepEqual(f.keyBindings.chat_main, { branchId: 'b_main', isCheckpoint: false, markerMessageId: null });
});

test('importLegacy：markerFloor 越界 → 不猜测，markerMessageId=null 且给 warning', () => {
    const fx = legacyFixture();
    fx.keyBindings.chat_cp1.markerFloor = 99; // b1 只有 4 楼
    const r = importLegacy(fx);
    assert.equal(r.ok, true);
    assert.equal(r.family.keyBindings.chat_cp1.markerMessageId, null);
    assert.ok((r.warnings || []).some((w) => w.includes('chat_cp1')), JSON.stringify(r.warnings));
});

/* ---------------- 缺引用：ok:false + 路径报告，不造数据 ---------------- */

test('importLegacy：path 引用无数据的 gid → ok:false / missing-reference，paths 定位到 gid', () => {
    const fx = legacyFixture();
    fx.model.branches[1].path[4] = 'g_ghost'; // b1 的 4 楼引用不存在的组
    const r = importLegacy(fx);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-reference');
    assert.ok(r.paths.some((p) => p.includes('g_ghost') && p.includes('b1')), JSON.stringify(r.paths));
});

test('importLegacy：活跃分支 body 行数不足 → ok:false（不造空行凑数）', () => {
    const fx = legacyFixture();
    fx.body = fx.body.slice(0, 2); // 主分支 path 有 4 楼
    const r = importLegacy(fx);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-reference');
});

test('importLegacy：模型缺分支表 → ok:false / legacy-model', () => {
    const fx = legacyFixture();
    fx.model.branches = [];
    const r = importLegacy(fx);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'legacy-model');
});

/* ---------------- store-bridge v2 桥：旧适配器形态 → 迁移器 ---------------- */

test('familyFromStore：旧 meta+floors → v2 Family；共享 gid 同消息、同楼不同 gid 不同消息', () => {
    const storeFamily = {
        familyId: 'fam-store-1', characterId: 'Seraphina',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 },
            { id: 'b1', name: '支线', is_default: false, fork_floor: 1 },
        ],
        branchPaths: {
            b_main: { 1: 'g1', 2: 'g2' },
            b1: { 1: 'g1', 2: 'g3' },
        },
        model: { active_branch: 'b_main' },
    };
    const floors = [
        { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify(row('我', true, '一楼')), contentHash: null, sendDate: D(14) },
        { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify(row('S', false, '主分支二楼')), contentHash: null, sendDate: D(14) },
        { floorNo: 2, variantId: 'g3', seq: 0, content: JSON.stringify(row('S', false, '支线二楼', { unknown_x: 'keep' })), contentHash: null, sendDate: D(15) },
    ];
    const r = familyFromStore(storeFamily, floors, { header: { user_name: 'User', unknown_h: 1 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.family.familyId, 'fam-store-1'); // 身份透传
    assert.equal(r.family.characterId, 'Seraphina');
    assert.deepEqual(validateFamily(r.family), { ok: true, paths: [] });
    // 共享 gid → 同一消息身份；同 floorNo 的 g2/g3 → 不同消息（不按 floorNo 聚合）
    assert.equal(r.family.branches.b_main.entries[0].messageId, r.family.branches.b1.entries[0].messageId);
    assert.notEqual(r.family.branches.b_main.entries[1].messageId, r.family.branches.b1.entries[1].messageId);
    // 投影对账：b1 = header + 共享一楼 + 自己的二楼（未知字段保全）
    assert.deepEqual(projectBranch(r.family, 'b1'), [
        { user_name: 'User', unknown_h: 1 },
        row('我', true, '一楼'),
        row('S', false, '支线二楼', { unknown_x: 'keep' }),
    ]);
});

test('familyFromStore：缺行 → 透传迁移器的 missing-reference（不造空行）', () => {
    const storeFamily = {
        familyId: 'fam-store-2',
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        model: { active_branch: 'b_main' },
    };
    const r = familyFromStore(storeFamily, [
        { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify(row('我', true, '一楼')) },
    ], { header: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-reference');
});
