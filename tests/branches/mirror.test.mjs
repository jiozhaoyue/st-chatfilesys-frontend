/**
 * T2 单测：模式判定（core/mode.js）+ 双写落盘器（core/mirror.js）。
 * 假定时器注入 → 防抖调度可确定断言；native 注入 → 回环自触发可断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normMode, isPureLike, isMirror, STORAGE_MODES, STORAGE_MODE_LABELS } from '../../public/scripts/extensions/third-party/chatfilesys/core/mode.js';
import { createMirror, buildMirrorSave, splitChatKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/mirror.js';
import { installSeam } from '../../public/scripts/extensions/third-party/chatfilesys/core/seam.js';

/* ---------------- 模式判定 ---------------- */

test('mode：非法值一律回落 off；三个模式各自判定正确', () => {
    assert.deepEqual(STORAGE_MODES, ['off', 'pure', 'mirror']);
    assert.equal(normMode('pure'), 'pure');
    assert.equal(normMode('mirror'), 'mirror');
    assert.equal(normMode('off'), 'off');
    for (const bad of [true, false, 1, null, undefined, 'PURE', 'nonsense', {}]) {
        assert.equal(normMode(bad), 'off', `非法值 ${JSON.stringify(bad)} 应回落 off`);
    }
    assert.equal(isPureLike('pure'), true);
    assert.equal(isPureLike('mirror'), true);
    assert.equal(isPureLike('off'), false);
    assert.equal(isMirror('mirror'), true);
    assert.equal(isMirror('pure'), false);
    Object.values(STORAGE_MODE_LABELS).forEach((v) => assert.equal(typeof v, 'string'));
});

/* ---------------- 落盘体组成 ---------------- */

/** 家族：主键 av::chat1（主分支 2 层）；另有绑定键（检查点，不落文件） */
function family() {
    return {
        familyId: 'f1', chatKey: 'av::chat1', integrity: 'c-9',
        hostMetadata: { variables: { hp: 3 }, extensions: { 'third-party/p': { x: 1 } } },
        keyBindings: { 'av::打斗前': { branchId: 'b_cp', mainChat: 'chat1', isCheckpoint: true, markerFloor: 1 } },
        model: {
            active_branch: 'b_main',
            branches: [
                { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } },
                { id: 'b_cp', name: '打斗前', is_default: false, fork_base: 1, path: { 1: 'g1' } },
            ],
            groups: {},
        },
    };
}
const floors = [
    { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ mes: '一' }), sendDate: 1 },
    { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ mes: '二' }), sendDate: 2 },
];

test('mirror：拆分聊天键（avatar::文件名，文件名可含 ::）', () => {
    assert.deepEqual(splitChatKey('av.png::chat1'), { avatarUrl: 'av.png', fileName: 'chat1' });
    assert.deepEqual(splitChatKey('av::a::b'), { avatarUrl: 'av', fileName: 'a::b' });
    assert.deepEqual(splitChatKey(''), { avatarUrl: '', fileName: '' });
});

test('mirror：落盘体是标准聊天文件——header 带宿主字段、**不带**本插件模型', () => {
    const body = buildMirrorSave(family(), floors);
    assert.equal(body.file_name, 'chat1');
    assert.equal(body.avatar_url, 'av');
    assert.equal(body.force, true);
    const meta = body.chat[0].chat_metadata;
    assert.deepEqual(meta.variables, { hp: 3 }, '其他插件的命名空间照旧保留');
    assert.deepEqual(meta.extensions['third-party/p'], { x: 1 });
    assert.equal(meta.integrity, 'c-9');
    assert.equal('chatfilesys' in meta.extensions, false, '副本不得带本插件模型（否则会被误认成增强模式）');
    assert.equal(meta.main_chat, undefined, '键级 main_chat 不落到主文件');
    assert.deepEqual(body.chat.slice(1), [{ mes: '一' }, { mes: '二' }], '正文 = 主键所在走法的投影');
});

test('mirror：主键走法变短时正文跟着变短（副本永远等于当前走法）', () => {
    const fam = family();
    fam.model.branches.find((b) => b.id === 'b_main').path = { 1: 'g1' };
    const body = buildMirrorSave(fam, floors);
    assert.deepEqual(body.chat.slice(1), [{ mes: '一' }]);
});

/* ---------------- 防抖调度 ---------------- */

function fakeTimers() {
    let seq = 0;
    const q = new Map();
    return {
        setTimeout(fn, ms) { const id = ++seq; q.set(id, { fn, ms }); return id; },
        clearTimeout(id) { q.delete(id); },
        /** 触发全部到点的定时器（返回触发个数） */
        fire() { const items = [...q.values()]; q.clear(); items.forEach((t) => t.fn()); return items.length; },
        pending: () => q.size,
        firstDelay: () => (q.values().next().value || {}).ms,
    };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function mirrorFixture({ timers, nativeImpl } = {}) {
    const adapter = {
        calls: { loadFamily: 0, loadFloors: 0 },
        async loadFamily() { this.calls.loadFamily++; return family(); },
        async loadFloors() { this.calls.loadFloors++; return { floors, hasMore: false }; },
    };
    const saves = [];
    const native = nativeImpl ?? (async (url, init) => {
        saves.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
    });
    const mirror = createMirror({ adapter, native, log: () => {}, timers, debounceMs: 1500 });
    return { adapter, saves, mirror };
}

test('mirror：防抖——同一家族连续标脏只落一次，窗口 = 1.5 秒', async () => {
    const timers = fakeTimers();
    const { saves, mirror } = mirrorFixture({ timers });
    mirror.markDirty({ familyId: 'f1', chatKey: 'av::chat1' });
    mirror.markDirty({ familyId: 'f1' });
    mirror.markDirty({ familyId: 'f1' });
    assert.equal(timers.pending(), 1, '重标脏应重置同一个定时器');
    assert.equal(timers.firstDelay(), 1500);
    assert.equal(saves.length, 0, '窗口内不落盘');
    assert.equal(mirror.state.pending, true);
    timers.fire();
    await settle();
    assert.equal(saves.length, 1, '窗口到点只落一次');
    assert.equal(saves[0].url, '/api/chats/save');
    assert.equal(mirror.state.pending, false);
    assert.equal(mirror.state.writeCount, 1);
    assert.ok(mirror.state.lastWrittenAt);
});

test('mirror：多个家族各落一次', async () => {
    const timers = fakeTimers();
    const { saves, mirror } = mirrorFixture({ timers });
    mirror.markDirty({ familyId: 'f1' });
    mirror.markDirty({ familyId: 'f2' });
    timers.fire();
    await settle();
    assert.equal(saves.length, 2);
});

test('mirror：落盘失败只记状态不抛（L0-11 不阻断聊天）', async () => {
    const timers = fakeTimers();
    const { mirror } = mirrorFixture({ timers, nativeImpl: async () => ({ ok: false, status: 500 }) });
    mirror.markDirty({ familyId: 'f1' });
    timers.fire();
    await settle();
    assert.match(mirror.state.lastError, /HTTP 500/);
    assert.equal(mirror.state.pending, false);
    assert.equal(mirror.state.writeCount, 0);
});

test('mirror：家族不存在 → 不落盘、给明确 reason', async () => {
    const saves = [];
    const mirror = createMirror({
        adapter: { async loadFamily() { return null; }, async loadFloors() { return { floors }; } },
        native: async (url, init) => { saves.push(url); return { ok: true, status: 200 }; },
        log: () => {},
        timers: fakeTimers(),
    });
    const r = await mirror.exportByChatKey('av::not-in-library');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-in-library');
    assert.equal(saves.length, 0);
    assert.equal(mirror.state.lastError, null, '「不在库」不是失败，不该记为错误');
});

test('mirror：flushNow 立刻落盘并清空未决窗口', async () => {
    const timers = fakeTimers();
    const { saves, mirror } = mirrorFixture({ timers });
    mirror.markDirty({ familyId: 'f1' });
    await mirror.flushNow();
    assert.equal(saves.length, 1);
    assert.equal(timers.pending(), 0, '立刻落盘应取消挂起的防抖定时器');
    mirror.markDirty({ familyId: 'f1' });
    mirror.dispose();
    assert.equal(timers.pending(), 0, 'dispose 清掉挂起定时器');
});

/* ---------------- 回环自触发 ---------------- */

test('mirror：落盘经 seam.native（绕开接缝）→ 库写次数不增加（无回环）', async () => {
    const timers = fakeTimers();
    const original = globalThis.fetch;
    const adapter = {
        calls: { loadFamily: 0, loadFloors: 0, applyOps: 0 },
        async loadFamily() { this.calls.loadFamily++; return family(); },
        async loadFloors() { this.calls.loadFloors++; return { floors, hasMore: false }; },
        async applyOps() { this.calls.applyOps++; return { ok: true, integrity: 'c-10', totalMessages: 2 }; },
    };
    let mirror = null;
    const seam = installSeam(adapter, { log: () => {}, onWrote: (e) => mirror?.markDirty(e) });
    // 故意把 native 指成 globalThis.fetch（若 mirror 误用被拦截的 fetch，就会回环写库）
    const interceptedCalls = [];
    mirror = createMirror({
        adapter,
        native: (...args) => { interceptedCalls.push(args[0]); return seam.native(...args); },
        log: () => {},
        timers,
    });
    try {
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av', file_name: 'chat1', operations: [{ op: 'replace', path: '/0', value: { mes: '改' } }] }),
        });
        const afterSeamWrite = adapter.calls.applyOps;
        assert.equal(afterSeamWrite, 1, '接缝写库一次');
        timers.fire();
        await settle();
        assert.equal(interceptedCalls.length, 1, '落盘走 native 通道一次');
        assert.equal(adapter.calls.applyOps, afterSeamWrite, '落盘不得再触发一次库写（无回环）');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});
