/**
 * W4 单测：`core/rename-align.js#alignHostFileName`
 *
 * 核心判据（用户 2026-09-26 裁定「纯库下不调酒馆接口」）：**磁盘上真有该文件才调宿主改名**。
 * 绑定键在磁盘上从来没有文件，故默认路径必须「只改库内分支名、不调接口、不迁移键绑定」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignHostFileName } from '../../public/scripts/extensions/third-party/chatfilesys/core/rename-align.js';

const OLD_KEY = 'char.png::主聊天 - branch #1';
const AVATAR = 'char.png';
const chatKeyOf = (file) => `${AVATAR}::${String(file).replace(/\.jsonl$/i, '')}`;

/** 记录三个依赖的调用情况 */
function deps({ exists = false, rename = { ok: true, status: 200, file: '打斗之前' }, save = { ok: true } } = {}) {
    const calls = { fileExists: [], renameHost: [], saveBindings: [] };
    return {
        calls,
        deps: {
            keyBindings: { [OLD_KEY]: { branchId: 'b1', mainChat: '主聊天' }, 'char.png::主聊天': { branchId: 'b_main' } },
            branchId: 'b1',
            newName: '打斗之前',
            avatarUrl: AVATAR,
            chatKeyOf,
            fileExists: async (f) => { calls.fileExists.push(f); return exists; },
            renameHost: async (a) => { calls.renameHost.push(a); return rename; },
            saveBindings: async (b) => { calls.saveBindings.push(b); return save; },
        },
    };
}

test('rename-align：库内新建的分支没有绑定键 → no-binding，什么都不调', async () => {
    const { calls, deps: d } = deps();
    const r = await alignHostFileName({ ...d, branchId: 'b9' });
    assert.deepEqual(r, { ok: false, reason: 'no-binding' });
    assert.deepEqual(calls, { fileExists: [], renameHost: [], saveBindings: [] });
});

test('rename-align：磁盘上没有该文件 → 只改库内名（不调宿主接口、不迁移键绑定）', async () => {
    const { calls, deps: d } = deps({ exists: false });
    const r = await alignHostFileName(d);
    assert.deepEqual(r, { ok: false, reason: 'no-file' });
    assert.deepEqual(calls.fileExists, ['主聊天 - branch #1'], '探测的是绑定键的文件名（不带 .jsonl）');
    assert.deepEqual(calls.renameHost, [], '纯库下不得调酒馆接口');
    assert.deepEqual(calls.saveBindings, [], '键没变 → 不迁移绑定');
});

test('rename-align：磁盘上确有该文件 → 调宿主改名 + 键绑定迁到新键', async () => {
    const { calls, deps: d } = deps({ exists: true });
    const r = await alignHostFileName(d);
    assert.equal(r.ok, true);
    assert.equal(r.newKey, chatKeyOf('打斗之前'));
    assert.deepEqual(calls.renameHost, [{ oldFile: '主聊天 - branch #1', newFile: '打斗之前', avatarUrl: AVATAR }]);
    assert.equal(calls.saveBindings.length, 1);
    const next = calls.saveBindings[0];
    assert.equal(Object.hasOwn(next, OLD_KEY), false, '旧键迁走');
    assert.deepEqual(next[chatKeyOf('打斗之前')], { branchId: 'b1', mainChat: '主聊天' });
    assert.deepEqual(next['char.png::主聊天'], { branchId: 'b_main' }, '别的绑定不动');
});

test('rename-align：宿主做了文件名净化 → 新键按宿主回的那个名字', async () => {
    const { calls, deps: d } = deps({ exists: true, rename: { ok: true, status: 200, file: '打斗之前（净化）' } });
    const r = await alignHostFileName(d);
    assert.equal(r.ok, true);
    assert.equal(r.newKey, chatKeyOf('打斗之前（净化）'));
    assert.equal(Object.hasOwn(calls.saveBindings[0], chatKeyOf('打斗之前（净化）')), true);
});

test('rename-align：宿主改名失败 → 报错且不动键绑定', async () => {
    const { calls, deps: d } = deps({ exists: true, rename: { ok: false, status: 500 } });
    const r = await alignHostFileName(d);
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 500/);
    assert.deepEqual(calls.saveBindings, []);
});

test('rename-align：宿主改名抛错（网络异常）→ 报错不抛出、不动键绑定', async () => {
    const { deps: d } = deps({ exists: true });
    d.renameHost = async () => { throw new Error('boom'); };
    const r = await alignHostFileName(d);
    assert.deepEqual(r, { ok: false, reason: 'boom' });
});

test('rename-align：新键已被别的绑定占用 → 如实报冲突（不静默 ok）', async () => {
    const { calls, deps: d } = deps({ exists: true, rename: { ok: true, status: 200, file: '打斗之前' } });
    d.keyBindings = { ...d.keyBindings, [chatKeyOf('打斗之前')]: { branchId: 'b2' } };
    const r = await alignHostFileName(d);
    assert.deepEqual(r, { ok: false, reason: 'binding-key-conflict' });
    assert.deepEqual(calls.saveBindings, [], '不得覆盖别人的绑定');
});

test('rename-align：净化后同名 → 无需迁移，直接 ok', async () => {
    const { calls, deps: d } = deps({ exists: true, rename: { ok: true, status: 200, file: '主聊天 - branch #1' } });
    const r = await alignHostFileName(d);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.saveBindings, [], '键没变 → 不写库');
});

test('rename-align：绑定落库失败 → 报错（文件已改名，告知映射未跟上）', async () => {
    const { deps: d } = deps({ exists: true, save: { ok: false, reason: 'conflict' } });
    const r = await alignHostFileName(d);
    assert.equal(r.ok, false);
    assert.match(r.reason, /键绑定迁移失败/);
});
