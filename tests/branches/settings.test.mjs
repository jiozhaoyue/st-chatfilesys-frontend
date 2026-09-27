/**
 * 设置中枢单测：`core/settings-registry.js`
 *
 * 这张表是本插件**全部可调项的单一事实源**，所以它错一次，代价是「用户改了没生效」
 * 或「UI 上少一项、代码里多一项」——两种都很难在真机上发现。故这里逐条钉住：
 *
 * 1. **表本身自洽**：key 唯一、类型合法、enum 的默认值在候选里、number 的默认值在区间内、
 *    每项都有非空 `describe` 与 `why`（用户要求「该暴露的暴露」，且未暴露项要有理由）
 * 2. **规范化**：非法输入一律回落默认值且标 `fixed`（不是抛、也不是原样存）
 * 3. **读写往返**：写进去的值读出来一致；点分路径真的落在嵌套结构里（不是扁平键）
 * 4. **`changed` 语义**：写同值 → `changed:false`（调用方据此不触发重装接缝这种重活）
 * 5. **`ensureAll` 就是迁移**：旧形状/非法值在启动那一步被纠正并**报出来**
 * 6. **`exportRegistry` 与表逐项对应**（agent 友好面不许漏项或造项）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SETTINGS, BY_KEY, TYPES, APPLY, GROUP_ORDER, defaults, grouped, normalize,
    readSetting, writeSetting, ensureAll, resetSetting, resetAll, exportRegistry,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/settings-registry.js';

/* ---------------- 1. 表自洽 ---------------- */

test('注册表：key 唯一且都带前缀域（不许出现裸 key）', () => {
    const seen = new Set();
    for (const s of SETTINGS) {
        assert.ok(!seen.has(s.key), `key 重复：${s.key}`);
        seen.add(s.key);
        assert.ok(/^[a-z_]+(\.[a-z_]+)+$|^[a-z_]+$/.test(s.key), `key 形状不合法：${s.key}`);
    }
    assert.equal(seen.size, SETTINGS.length);
});

test('注册表：每一项都有 label/group/describe/why，且类型在允许集内', () => {
    for (const s of SETTINGS) {
        assert.ok(s.label, `${s.key} 缺 label`);
        assert.ok(s.group, `${s.key} 缺 group`);
        assert.ok(TYPES.includes(s.type), `${s.key} 类型不合法：${s.type}`);
        assert.equal(typeof s.describe, 'string');
        assert.ok(s.describe.length >= 8, `${s.key} 的 describe 太短，用户看不懂：${s.describe}`);
        // 「该暴露的暴露」的配套要求：**每一项都要说得出为什么可调**，否则它不该在表里
        assert.equal(typeof s.why, 'string');
        assert.ok(s.why.length >= 8, `${s.key} 缺 why（为什么默认值是这个 / 为什么可调）`);
        assert.ok(Object.values(APPLY).includes(s.apply), `${s.key} 的 apply 不合法：${s.apply}`);
    }
});

test('注册表：enum 候选非空且默认值在其中；number 的默认值落在 [min,max] 内', () => {
    for (const s of SETTINGS) {
        if (s.type === 'enum') {
            assert.ok(Array.isArray(s.values) && s.values.length >= 2, `${s.key} 的 values 不足`);
            assert.ok(s.values.includes(s.default), `${s.key} 的默认值 ${s.default} 不在候选里`);
            for (const v of s.values) {
                assert.ok(s.valueLabels?.[v], `${s.key}.${v} 缺中文标签（UI 上要给人看）`);
            }
        }
        if (s.type === 'number') {
            assert.equal(typeof s.default, 'number');
            assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max), `${s.key} 缺 min/max（不设区间就成不了滑块）`);
            assert.ok(s.default >= s.min && s.default <= s.max, `${s.key} 默认值越界`);
            assert.ok(s.step > 0, `${s.key} 缺 step`);
        }
        if (s.type === 'boolean') assert.equal(typeof s.default, 'boolean');
    }
});

test('注册表：每一项的 apply 都是**已知动作**（有声明就必须有人执行）', () => {
    // 这条防的是「表里写了 apply:'graph'，但 index.js 根本没处理这个动作」——
    // 那会变成「改了阈值不生效」且看不出原因。动作集合是封闭的。
    const known = new Set(Object.values(APPLY));
    for (const s of SETTINGS) assert.ok(known.has(s.apply));
});

test('注册表：分组顺序表覆盖了全部实际分组（不留「最后按名字排」的意外）', () => {
    const used = new Set(SETTINGS.map((s) => s.group));
    for (const g of used) assert.ok(GROUP_ORDER.includes(g), `分组「${g}」没进 GROUP_ORDER，顺序会意外`);
});

test('注册表：可调项足够多（「全部用户可调」的下限检查）', () => {
    assert.ok(SETTINGS.length >= 20, `可调项只有 ${SETTINGS.length} 项，与「全部可调」的目标不符`);
});

/* ---------------- 2. 规范化 ---------------- */

test('normalize：非法输入回落默认值并标 fixed（不抛、不原样存）', () => {
    const bad = normalize('graph.chunk_size', 'abc');
    assert.equal(bad.value, BY_KEY.get('graph.chunk_size').default);
    assert.equal(bad.fixed, true);

    // 字符串数字：老版本/手改 JSON 的常见形态，要能救回来（而不是当成 NaN 丢掉）
    const s = normalize('graph.chunk_size', '300');
    assert.equal(s.value, 300);
    assert.equal(s.fixed, true);

    const b = normalize('ui.toast', 'true');
    assert.equal(b.value, true);
    assert.equal(b.fixed, true);
});

test('normalize：number 超界被夹住（夹住也算 fixed）', () => {
    const def = BY_KEY.get('graph.chunk_size');
    const hi = normalize('graph.chunk_size', 999999);
    assert.equal(hi.value, def.max);
    assert.equal(hi.fixed, true);
    const lo = normalize('graph.chunk_size', -5);
    assert.equal(lo.value, def.min);
    assert.equal(lo.fixed, true);
});

test('normalize：enum 只认候选值，别的回落默认', () => {
    assert.equal(normalize('storage_mode', 'pure').value, 'pure');
    assert.equal(normalize('storage_mode', 'nonsense').value, 'off');
    assert.equal(normalize('graph.direction', 'LR').value, 'LR');
    assert.equal(normalize('graph.direction', 'diagonal').value, 'TB');
});

test('normalize：未知 key → undefined（不编一个值出来）', () => {
    const r = normalize('nope.nope', 1);
    assert.equal(r.value, undefined);
});

/* ---------------- 3/4. 读写 ---------------- */

test('读写：点分路径真的落在**嵌套**结构里（不是扁平键）', () => {
    const store = {};
    writeSetting(store, 'graph.chunk_size', 555);
    assert.equal(store.graph.chunk_size, 555, '应该写进 store.graph.chunk_size');
    assert.equal(store['graph.chunk_size'], undefined, '不该写成一个扁平带点的键');
    assert.equal(readSetting(store, 'graph.chunk_size'), 555);
});

test('读写：写同值 → changed:false（调用方据此不做重活）', () => {
    const store = {};
    const first = writeSetting(store, 'graph.minimap_budget', 400);
    assert.equal(first.changed, true);
    const again = writeSetting(store, 'graph.minimap_budget', 400);
    assert.equal(again.changed, false, '同值重写不该报「变了」');
    assert.equal(again.apply, APPLY.NONE, '没变就不该要求任何 apply');
});

test('读写：写非法值 → 存的是**规范化后**的值，并回报 fixed', () => {
    const store = {};
    const r = writeSetting(store, 'graph.chunk_size', 999999);
    assert.equal(r.fixed, true);
    assert.equal(r.value, BY_KEY.get('graph.chunk_size').max);
    assert.equal(store.graph.chunk_size, BY_KEY.get('graph.chunk_size').max);
});

test('读：缺失项读出来就是默认值（不需要先 ensureAll 才有值）', () => {
    for (const s of SETTINGS) {
        assert.deepEqual(readSetting({}, s.key), s.default, `${s.key} 缺省读值不是默认值`);
    }
});

test('readSetting：未启用分支也不抛（store 是 null）', () => {
    assert.equal(readSetting(null, 'graph.chunk_size'), BY_KEY.get('graph.chunk_size').default);
});

/* ---------------- 5. ensureAll = 迁移 ---------------- */

test('ensureAll：把缺失项**真的写进存储**（用户打开设置文件能看到全部可调项）', () => {
    const store = {};
    const { fixed } = ensureAll(store);
    assert.deepEqual(fixed, [], '空存储不该报「纠正过」');
    for (const s of SETTINGS) {
        assert.deepEqual(readSetting(store, s.key), s.default, `${s.key} 没被落进存储`);
    }
});

test('ensureAll：旧形状/非法值被纠正**并报出来**（这就是迁移，不另写脚本）', () => {
    const store = { storage_mode: 'nonsense', graph: { chunk_size: 'abc' }, tree_direction: 'diagonal' };
    const { fixed } = ensureAll(store);
    assert.ok(fixed.includes('storage_mode'));
    assert.ok(fixed.includes('graph.chunk_size'));
    assert.ok(fixed.includes('tree_direction'));
    assert.equal(store.storage_mode, 'off');
    assert.equal(store.graph.chunk_size, BY_KEY.get('graph.chunk_size').default);
});

test('ensureAll：合法值原样保留（迁移不许把用户改过的值冲掉）', () => {
    const store = { graph: { chunk_size: 777 }, storage_mode: 'pure' };
    ensureAll(store);
    assert.equal(store.graph.chunk_size, 777);
    assert.equal(store.storage_mode, 'pure');
});

test('resetSetting / resetAll：能回到默认，且回报改了哪些', () => {
    const store = {};
    writeSetting(store, 'graph.chunk_size', 777);
    const one = resetSetting(store, 'graph.chunk_size');
    assert.equal(one.value, BY_KEY.get('graph.chunk_size').default);

    writeSetting(store, 'graph.chunk_size', 777);
    writeSetting(store, 'ui.toast', false);
    const all = resetAll(store);
    assert.ok(all.changed.includes('graph.chunk_size'));
    assert.ok(all.changed.includes('ui.toast'));
    assert.deepEqual(defaults(), Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])));
});

/* ---------------- 6. 导出（agent 友好面） ---------------- */

test('exportRegistry：与表逐项对应（不漏项、不造项、字段齐全）', () => {
    const reg = exportRegistry();
    assert.equal(reg.count, SETTINGS.length);
    assert.equal(reg.settings.length, SETTINGS.length);
    const keys = reg.settings.map((s) => s.key);
    assert.deepEqual(keys, SETTINGS.map((s) => s.key), '顺序与内容都必须一一对应');
    for (const s of reg.settings) {
        for (const f of ['key', 'label', 'group', 'type', 'default', 'describe', 'why', 'apply']) {
            assert.ok(s[f] !== undefined, `${s.key} 导出缺字段 ${f}`);
        }
    }
    // 可 JSON 序列化（文档站/脚本要直接吃它）
    const round = JSON.parse(JSON.stringify(reg));
    assert.equal(round.count, reg.count);
});

test('exportRegistry：分组键集合与 grouped() 一致（UI 与导出不许各说各话）', () => {
    const reg = exportRegistry();
    const flat = reg.groups.flatMap((g) => g.keys).sort();
    assert.deepEqual(flat, SETTINGS.map((s) => s.key).sort());
    assert.deepEqual(reg.groups.map((g) => g.name), grouped().map((g) => g.name));
});
