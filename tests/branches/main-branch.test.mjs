/**
 * T9 单测：主分支可换（R8.3 / AC22）
 *
 * 「主分支」= 家族里 `is_default` 的那条 = **主键绑定所在分支** = 打开这个聊天看到的内容。
 * 覆盖：
 * - `setDefaultBranch` 迁移 `is_default`（目标不存在即抛；恰一条为真）
 * - `setMainBranch` 让家族活跃分支跟到同一条（否则「点了设为主分支、打开还是旧分支」，
 *   且旧主分支因「仍是活跃分支」删不掉）
 * - `setBindingBranch` 把主键绑定改到目标分支（保留该键原有 mainChat / 检查点标记）
 * - 不变式「恰一条 is_default，且它 = 主键绑定所在分支」在换主分支后成立
 * - 换完旧主分支可删；不换则删不掉（删除的护城河）
 * - N1（2026-09-26）：普通「切换分支」也要守住这条不变式——主键上切换 → 标记跟走；
 *   绑定键（非主键）上切换 → 家族主分支不动
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    setDefaultBranch, setMainBranch, getBranch, deleteBranch, validate,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { setBindingBranch, boundKeysOfBranch, pinActiveForBoundKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/key-bindings.js';
import { branchIdForKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/takeover.js';
import { planSwitch } from '../../public/scripts/extensions/third-party/chatfilesys/core/projection.js';

/** 真机形态：主键（无绑定）+ 一条原生分支键（绑 b1），家族活跃分支 = 主分支 */
function family() {
    const model = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3' } },
            { id: 'b1', name: '主聊天 - Branch #1', is_default: false, fork_base: 2, path: { 1: 'g1', 2: 'g2', 3: 'g7' } },
        ],
        groups: { g7: { id: 'g7', floor: 3, owner: 'b1', active: 0, variants: [{ mes: '分支三' }] } },
    };
    return {
        familyId: 'f_test', chatKey: 'av1::主聊天', integrity: 'c-1',
        model,
        keyBindings: { 'av1::主聊天 - Branch #1': { branchId: 'b1', mainChat: '主聊天' } },
    };
}

/* ---------------- setDefaultBranch ---------------- */

test('main-branch：setDefaultBranch 迁移 is_default，且恰一条为真', () => {
    const m = family().model;
    setDefaultBranch(m, 'b1');
    assert.equal(getBranch(m, 'b1').is_default, true);
    assert.equal(getBranch(m, 'b_main').is_default, false);
    assert.equal(m.branches.filter((b) => b.is_default).length, 1);
    assert.equal(m.branches.find((b) => b.is_default).id, 'b1');
    // 同一引用（调用方接着用）
    assert.equal(setDefaultBranch(m, 'b_main').id, 'b_main');
    assert.equal(m.branches.find((b) => b.is_default).id, 'b_main');
});

test('main-branch：setDefaultBranch 目标不存在即抛，不改模型', () => {
    const m = family().model;
    assert.throws(() => setDefaultBranch(m, 'b9'), /不存在/);
    assert.equal(m.branches.find((b) => b.is_default).id, 'b_main');
});

/* ---------------- setMainBranch ---------------- */

test('main-branch：setMainBranch 迁移 is_default 且家族活跃分支跟到同一条', () => {
    const m = family().model;
    setMainBranch(m, 'b1');
    assert.equal(getBranch(m, 'b1').is_default, true);
    assert.equal(m.active_branch, 'b1', '活跃分支跟到目标（否则打开还是旧分支 / 旧主分支删不掉）');
});

test('main-branch：换主分支后旧主分支可以删；没换则删不掉（删除的护城河）', () => {
    const m = family().model;
    assert.throws(() => deleteBranch(m, 'b_main'), /默认分支不可删除/, '主分支拦住删除');
    setMainBranch(m, 'b1');
    deleteBranch(m, 'b_main'); // 不再默认、也不再是活跃分支 → 可删
    assert.equal(getBranch(m, 'b_main'), null, '旧主分支已删');
    assert.equal(getBranch(m, 'b1').is_default, true, '新主分支仍在');
});

/* ---------------- setBindingBranch ---------------- */

test('main-branch：setBindingBranch 给主键建绑定（原本没有绑定键）', () => {
    const f = family();
    const next = setBindingBranch(f.keyBindings, f.chatKey, 'b1');
    assert.ok(next, '应产生新表');
    assert.deepEqual(next[f.chatKey], { branchId: 'b1' });
    // 原生分支键的绑定原样保留
    assert.deepEqual(next['av1::主聊天 - Branch #1'], { branchId: 'b1', mainChat: '主聊天' });
    // 纯函数：不改入参
    assert.equal(Object.hasOwn(f.keyBindings, f.chatKey), false);
});

test('main-branch：setBindingBranch 保留该键原有的 mainChat / 检查点标记', () => {
    const key = 'av1::主聊天 - checkpoint #1';
    const kb = { [key]: { branchId: 'b2', mainChat: '主聊天', isCheckpoint: true, markerFloor: 3 } };
    const next = setBindingBranch(kb, key, 'b1');
    assert.deepEqual(next[key], { branchId: 'b1', mainChat: '主聊天', isCheckpoint: true, markerFloor: 3 });
});

test('main-branch：setBindingBranch 保守语义——已在目标分支 / 缺参数 → null（不做无谓写入）', () => {
    const f = family();
    assert.equal(setBindingBranch(f.keyBindings, 'av1::主聊天 - Branch #1', 'b1'), null);
    assert.equal(setBindingBranch(null, null, 'b1'), null);
    assert.equal(setBindingBranch(f.keyBindings, f.chatKey, ''), null);
    assert.equal(setBindingBranch(null, f.chatKey, 'b1') !== null, true, '无表但要建绑定 → 建');
});

/* ---------------- 组合：不动点（不变式） ---------------- */

test('main-branch：换主分支后不变式成立——恰一条 is_default，且它 = 主键绑定所在分支', () => {
    const f = family();
    // 换主分支前：主键无绑定 → 解析到活跃分支 = 主分支 = is_default ✓（起点自洽）
    assert.equal(branchIdForKey(f, f.chatKey), 'b_main');
    assert.equal(f.model.branches.find((b) => b.is_default).id, 'b_main');

    // 走一次「设为主分支 b1」：模型侧与键绑定的落地（index.js 的实际组合）
    setMainBranch(f.model, 'b1');
    f.keyBindings = setBindingBranch(f.keyBindings, f.chatKey, 'b1') ?? f.keyBindings;

    const defaults = f.model.branches.filter((b) => b.is_default);
    assert.equal(defaults.length, 1, '恰一条 is_default');
    assert.equal(defaults[0].id, branchIdForKey(f, f.chatKey), 'is_default = 主键绑定所在分支');
    assert.equal(branchIdForKey(f, f.chatKey), 'b1', '打开这个聊天看到的是新主分支');
    // 绑定键（原生分支键）不受影响：它仍绑自己的分支
    assert.deepEqual(boundKeysOfBranch(f.keyBindings, 'b1').map(([k]) => k),
        ['av1::主聊天 - Branch #1', 'av1::主聊天']);
});

test('main-branch：换主分支只动标记，不改分支结构与层数', () => {
    const f = family();
    const before = JSON.stringify({ branches: f.model.branches.map((b) => ({ id: b.id, path: b.path, fork: b.fork_base })), groups: f.model.groups });
    setMainBranch(f.model, 'b1');
    const after = JSON.stringify({ branches: f.model.branches.map((b) => ({ id: b.id, path: b.path, fork: b.fork_base })), groups: f.model.groups });
    assert.equal(after, before, '结构（path / fork_base / groups）与换主分支无关');
});

test('main-branch：顺序不能颠倒——只改标记不切换，body/groups 分区就错位（实现必须先走切换）', () => {
    const m = family().model;
    setMainBranch(m, 'b1');
    const v = validate(m, 3);
    assert.equal(v.ok, false, '直接改标记会留下「活跃分支引用的组还在折叠区」');
    assert.ok(v.errors.some((e) => e.includes('g7')), JSON.stringify(v.errors));
});

test('main-branch：完整动作（先切换 + 再迁移标记 + 主键绑定）后模型自洽且不变式成立', () => {
    const f = family();
    const body = [{ mes: '一' }, { mes: '二' }, { mes: '三' }]; // 主分支的投影（3 层）
    // ① 既有切换机制：active_branch 换人 + 折叠/展开分区（index.js 的实际顺序）
    planSwitch(f.model, 'b1', body);
    // ② 迁移主分支标记
    setMainBranch(f.model, 'b1');
    // ③ 主键的绑定改到目标分支（与模型同一次落库）
    f.keyBindings = setBindingBranch(f.keyBindings, f.chatKey, 'b1') ?? f.keyBindings;

    const v = validate(f.model, 3);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(f.model.groups.g3?.variants?.[0]?.mes, '三', '旧主分支的尾组折进折叠区');
    assert.equal(f.model.groups.g7, undefined, '新主分支的尾组离开折叠区');
    assert.equal(f.model.branches.find((b) => b.is_default).id, branchIdForKey(f, f.chatKey));
    assert.equal(branchIdForKey(f, f.chatKey), 'b1');
    // 旧主分支此刻既不默认、也不活跃 → 可删
    deleteBranch(f.model, 'b_main');
    assert.equal(getBranch(f.model, 'b_main'), null);
});

/* ---------------- N1：普通「切换分支」后的主分支归属（2026-09-26） ---------------- */

/** 现实起点：主键已绑到 b1（= 设为主分支的产物），家族活跃分支与 is_default 都在 b1 */
function familyAfterMainSwitch() {
    const f = family();
    setMainBranch(f.model, 'b1');
    f.keyBindings = setBindingBranch(f.keyBindings, f.chatKey, 'b1') ?? f.keyBindings;
    return f;
}

test('main-branch：主键上普通切换 → is_default 跟到目标分支，不变式仍成立（N1）', () => {
    const f = familyAfterMainSwitch();
    assert.equal(f.model.branches.find((b) => b.is_default).id, 'b1');
    // 普通切换（结构树上点另一条分支）：入向模型把活跃分支改到 b_main，库里存的是 b1
    const incoming = structuredClone(f.model);
    incoming.active_branch = 'b_main';
    const pinned = pinActiveForBoundKey(f, f.chatKey, incoming);
    assert.equal(pinned.active_branch, 'b_main', '主键上的切换是家族级切换（不得 pin 回旧值）');
    assert.equal(pinned.branches.find((b) => b.is_default).id, 'b_main', '主分支标记跟到目标分支');
    assert.equal(pinned.branches.filter((b) => b.is_default).length, 1, '恰一条 is_default');
    // 同一次写入里的键绑定跟随（`core/seam.js#followKeyBinding` 的同一动作）
    const after = { ...f, model: pinned, keyBindings: setBindingBranch(f.keyBindings, f.chatKey, 'b_main') };
    assert.equal(after.model.branches.find((b) => b.is_default).id, branchIdForKey(after, after.chatKey),
        '不变式：is_default = 主键绑定所在分支');
});

test('main-branch：绑定键（非主键）上普通切换 → 家族 is_default 不动（N1）', () => {
    const f = familyAfterMainSwitch();
    const branchKey = 'av1::主聊天 - Branch #1';
    const incoming = structuredClone(f.model);
    incoming.active_branch = 'b_main';
    const pinned = pinActiveForBoundKey(f, branchKey, incoming);
    assert.equal(pinned.active_branch, 'b1', '绑定键上的切换只改它自己的绑定，家族活跃分支保持不动');
    assert.equal(pinned.branches.find((b) => b.is_default).id, 'b1', '绑定键上的切换不是换主分支');
    // 根键（无绑定）没有分叉可言：原样返回（那里的切换本来就是家族级）
    const plain = { chatKey: f.chatKey, keyBindings: {}, model: f.model };
    assert.equal(pinActiveForBoundKey(plain, plain.chatKey, incoming), incoming);
});
