/**
 * T8 单测：入库提醒的判定与压制（core/import-prompt.js，纯函数；R8.1 / AC21）
 *
 * 覆盖：
 * - 压制记录归一（脏数据收敛、去重去空）
 * - 触发判定五道闸（无键 / 群聊 / 已有弹窗 / 已入库 / 被压制）
 * - 两个「不再提醒」的落点（该键 / 全局）与语义
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IMPORT_PROMPT_MODE, normImportPrompt, isImportPromptMuted, shouldPromptImport,
    muteImportPromptKey, muteImportPromptAll, withImportPromptMutes,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/import-prompt.js';

const KEY = 'av1::主聊天';

/* ---------------- 归一 ---------------- */

test('import-prompt：normImportPrompt 收敛脏数据成固定形状', () => {
    assert.deepEqual(normImportPrompt(null), { never: false, mutedKeys: [] });
    assert.deepEqual(normImportPrompt(undefined), { never: false, mutedKeys: [] });
    assert.deepEqual(normImportPrompt('nonsense'), { never: false, mutedKeys: [] });
    assert.deepEqual(normImportPrompt({}), { never: false, mutedKeys: [] });
    // never 任意真值 → 布尔化
    assert.deepEqual(normImportPrompt({ never: 1 }), { never: true, mutedKeys: [] });
    // mutedKeys 去重、去空、字符串化
    assert.deepEqual(normImportPrompt({ mutedKeys: [KEY, KEY, '', null, 42] }),
        { never: false, mutedKeys: [KEY, '42'] });
    // 非数组 → 空
    assert.deepEqual(normImportPrompt({ mutedKeys: 'x' }), { never: false, mutedKeys: [] });
    // 恒为新对象（不改入参）
    const raw = { never: true, mutedKeys: [KEY] };
    const out = normImportPrompt(raw);
    assert.notEqual(out.mutedKeys, raw.mutedKeys);
});

/* ---------------- 压制判定 ---------------- */

test('import-prompt：isImportPromptMuted——never 一律压制，否则只看该键', () => {
    assert.equal(isImportPromptMuted(null, KEY), false);
    assert.equal(isImportPromptMuted({ never: true }, KEY), true);
    assert.equal(isImportPromptMuted({ never: true, mutedKeys: [] }, 'av1::别的'), true, 'never 与键无关');
    assert.equal(isImportPromptMuted({ mutedKeys: [KEY] }, KEY), true);
    assert.equal(isImportPromptMuted({ mutedKeys: [KEY] }, 'av1::别的'), false, '只压该键');
    assert.equal(isImportPromptMuted({ mutedKeys: [KEY] }, ''), false, '空键不匹配');
});

/* ---------------- 触发判定（五道闸） ---------------- */

test('import-prompt：未入库 + 未压制 → 弹', () => {
    assert.equal(shouldPromptImport({ prompt: null, chatKey: KEY, inLibrary: false }), true);
    assert.equal(shouldPromptImport({
        prompt: { never: false, mutedKeys: ['av1::别的'] }, chatKey: KEY, inLibrary: false,
    }), true);
});

test('import-prompt：已入库不弹（这个聊天已经在库里了）', () => {
    assert.equal(shouldPromptImport({ prompt: null, chatKey: KEY, inLibrary: true }), false);
});

test('import-prompt：被压制不弹——③ 只压该键、④ 全局压', () => {
    assert.equal(shouldPromptImport({
        prompt: { mutedKeys: [KEY] }, chatKey: KEY, inLibrary: false,
    }), false, '③ 该键不再提醒');
    assert.equal(shouldPromptImport({
        prompt: { mutedKeys: [KEY] }, chatKey: 'av1::别的', inLibrary: false,
    }), true, '③ 不影响别的聊天');
    assert.equal(shouldPromptImport({
        prompt: { never: true }, chatKey: 'av1::任何', inLibrary: false,
    }), false, '④ 完全不再提醒');
});

test('import-prompt：无聊天键 / 群聊 / 已有弹窗 → 不弹', () => {
    assert.equal(shouldPromptImport({ prompt: null, chatKey: '', inLibrary: false }), false);
    assert.equal(shouldPromptImport({ prompt: null, chatKey: null, inLibrary: false }), false);
    assert.equal(shouldPromptImport({
        prompt: null, chatKey: KEY, inLibrary: false, isGroupChat: true,
    }), false, '群聊端点不在接缝路由内，保持原生（R0）');
    assert.equal(shouldPromptImport({
        prompt: null, chatKey: KEY, inLibrary: false, hasDialogOpen: true,
    }), false, '不叠窗');
    assert.equal(shouldPromptImport(), false, '空参数不弹');
});

/* ---------------- 两个「不再提醒」的落点 ---------------- */

test('import-prompt：③「这个聊天不再提醒」只加该键，保留 never 与已记的键', () => {
    const p1 = muteImportPromptKey(normImportPrompt(null), KEY);
    assert.deepEqual(p1, { never: false, mutedKeys: [KEY] });
    const p2 = muteImportPromptKey(p1, 'av1::另一个');
    assert.deepEqual(p2.mutedKeys, [KEY, 'av1::另一个']);
    // 幂等：同一个键再记一次不重复
    assert.deepEqual(muteImportPromptKey(p2, KEY).mutedKeys, [KEY, 'av1::另一个']);
    // 空键 → 原样返回（不写坏记录）
    assert.deepEqual(muteImportPromptKey(p1, ''), p1);
});

test('import-prompt：④「完全不再提醒」置 never，已记的键保留（将来可逐键恢复）', () => {
    const p = muteImportPromptAll({ never: false, mutedKeys: [KEY] });
    assert.deepEqual(p, { never: true, mutedKeys: [KEY] });
    assert.equal(isImportPromptMuted(p, 'av1::任何别的'), true);
});

test('import-prompt：三个按钮取向的取值稳定（弹窗与分流共用同一组常量）', () => {
    assert.deepEqual(IMPORT_PROMPT_MODE, { PURE: 'pure', MIRROR: 'mirror', SKIP: 'skip' });
});

/* ---------------- 两个小勾选的落点（W8：勾选与按钮取向无关） ---------------- */

test('import-prompt：withImportPromptMutes——两个勾选各自生效、都不勾则原样', () => {
    const base = { never: false, mutedKeys: [] };
    // 都不勾 → 原样（不产生空改动，调用方据此跳过落盘）
    assert.deepEqual(withImportPromptMutes(base, KEY, {}), base);
    assert.deepEqual(withImportPromptMutes(base, KEY, { muteKey: false, muteAll: false }), base);
    // 只勾「这个聊天不再提醒」
    assert.deepEqual(withImportPromptMutes(base, KEY, { muteKey: true }), { never: false, mutedKeys: [KEY] });
    // 只勾「全部不再提醒」
    assert.deepEqual(withImportPromptMutes(base, KEY, { muteAll: true }), { never: true, mutedKeys: [] });
    // 两个都勾 → 都落（never 已覆盖一切，mutedKeys 仍留着，便于将来逐键恢复）
    assert.deepEqual(withImportPromptMutes(base, KEY, { muteKey: true, muteAll: true }),
        { never: true, mutedKeys: [KEY] });
});

test('import-prompt：withImportPromptMutes——保留既有记录、脏数据先归一、幂等', () => {
    const old = { never: false, mutedKeys: ['av1::老的'] };
    const p = withImportPromptMutes(old, KEY, { muteKey: true });
    assert.deepEqual(p.mutedKeys, ['av1::老的', KEY]);
    assert.equal(isImportPromptMuted(p, KEY), true);
    assert.equal(isImportPromptMuted(p, 'av1::别的'), false, '别的聊天照弹');
    // 幂等：同一键再勾一次不重复
    assert.deepEqual(withImportPromptMutes(p, KEY, { muteKey: true }), p);
    // 脏记录先归一
    assert.deepEqual(withImportPromptMutes('nonsense', KEY, { muteKey: true }),
        { never: false, mutedKeys: [KEY] });
});
