/**
 * 错误目录单测：`core/errors.js`
 *
 * 这张表是**用户全部可见失败的文案源**，也是用户报障时唯一的检索键（`CFS-<域><号>`）。
 * 它坏一次的代价是「用户看到一句看不懂的宿主异常」或「给了一个查不到的编号」——两种都
 * 只在真机上、由用户先发现。故这里把它变成**机器可判**的门禁：
 *
 * 1. **编号形状**：`CFS-<域大写字母><三位数字>`，且域字母必须登记在 `DOMAINS` 里
 *    （没登记 → 界面显示「未分类」，等于归因丢失）
 * 2. **在册编号都有 `what` 与至少一个 `fix`**——目录文件头承诺的「编目而非拼接」靠这条守住
 * 3. **`what` 是人话**：不出现 `undefined` / `[object` / 栈帧 / 内部异常名（原始文本只许进 `detail`）
 * 4. **`why` 不编**：要么非空人话，要么显式 `null`——**空串不算**（「未定位」必须显式）
 * 5. **源码里写死的 `CFS-xxxx` 全部在册**：不在册的编号会被渲染成「未登记」，而新增分支时
 *    最容易顺手写一个没登记的编号。这条是本文件最有价值的守卫
 * 6. **未登记编号的兜底形态**：`registered:false` 且文案里明确说「没有登记」（写错要看得见）
 * 7. `makeError` 的上下文合流（`ctx.why` 覆盖 / `detail` 归位 / `headline` 带编号）
 * 8. `fromException` / `summarize` / `diagnosisText` 三个消费面的形态
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DOMAINS, ERROR_CATALOG, hasCode, allCodes, domainOf,
    makeError, fromException, summarize, diagnosisText,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../public/scripts/extensions/third-party/chatfilesys');

/* ---------------- 1. 编号形状 ---------------- */

test('编号形状：CFS-<域><三位数字>，且域字母登记在 DOMAINS 里', () => {
    assert.ok(allCodes().length > 0, '目录是空的');
    for (const code of allCodes()) {
        const m = /^CFS-([A-Z])(\d{3})$/.exec(code);
        assert.ok(m, `编号形状不合规：${code}`);
        assert.ok(DOMAINS[m[1]], `域字母未登记（界面会显示「未分类」）：${code} → ${m[1]}`);
        assert.equal(domainOf(code), m[1], `${code} 的域解析不一致`);
        assert.ok(String(ERROR_CATALOG[code].what || '').trim(), `${code} 缺 what`);
    }
});

test('domainOf 对不合形状的输入一律给 null（不许猜）', () => {
    for (const bad of ['', null, undefined, 'CFS-N01', 'CFS-nn001', 'CFS-N0001', 'N001', 42]) {
        assert.equal(domainOf(bad), null, `不该识别出域：${String(bad)}`);
    }
});

/* ---------------- 2. 每条都有 what 与 fix ---------------- */

test('每条在册编号都有非空 what 与至少一个 fix 动作', () => {
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
        assert.equal(typeof def.what, 'string', `${code} 的 what 不是字符串`);
        assert.ok(def.what.trim(), `${code} 的 what 是空的`);
        assert.ok(Array.isArray(def.fix) && def.fix.length, `${code} 没有 fix 动作`);
        for (const f of def.fix) {
            const label = typeof f === 'string' ? f : f?.label;
            assert.ok(typeof label === 'string' && label.trim(), `${code} 的某个 fix 项没有 label`);
        }
    }
});

/* ---------------- 3. what 是人话 ---------------- */

test('what 是人话：不出现 undefined / [object / 栈帧 / 内部异常名', () => {
    const smells = [
        [/undefined/, 'undefined'],
        [/\[object /, '[object ...]'],
        [/\n\s*at\s+\S+/, '栈帧'],
        [/\.js:\d+/, '源码位置'],
        [/\b(?:TypeError|ReferenceError|SyntaxError)\b/, '内部异常名'],
    ];
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
        for (const [rx, label] of smells) {
            assert.ok(!rx.test(def.what), `${code} 的 what 里出现了${label}：${def.what}`);
        }
    }
});

/* ---------------- 4. why 不编 ---------------- */

test('why 要么非空人话，要么显式 null（空串不算——「未定位」必须显式）', () => {
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
        if (def.why === null) continue;
        assert.equal(typeof def.why, 'string', `${code} 的 why 既不是字符串也不是 null`);
        assert.ok(def.why.trim(), `${code} 的 why 是空串：要么写清原因，要么写 null`);
    }
});

/* ---------------- 5. 源码里写死的编号全部在册 ---------------- */

function pluginSourceFiles(root) {
    return fs.readdirSync(root, { recursive: true })
        .map((rel) => path.join(root, String(rel)))
        .filter((p) => /\.(js|mjs)$/.test(p) && fs.statSync(p).isFile());
}

test('源码里写死的 CFS-xxxx 编号全部在册（没登记会被渲染成「未登记」）', () => {
    const where = new Map();   // code → 首次出现的位置
    for (const file of pluginSourceFiles(SRC)) {
        if (path.basename(file) === 'errors.js') continue;   // 目录自身是编号的**定义处**
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/CFS-[A-Za-z0-9]{2,}/g)) {
            if (!where.has(m[0])) where.set(m[0], path.relative(SRC, file));
        }
    }
    assert.ok(where.size > 0, '一个编号都没扫到？扫描根可能错了');
    const missing = [...where].filter(([code]) => !hasCode(code));
    assert.deepEqual(missing, [],
        `这些编号在源码里用了但没登记进 ERROR_CATALOG：${JSON.stringify(missing)}`);
});

test('反向：目录里有编号从没被任何调用点用过（提示可能是死条目）', () => {
    const used = new Set();
    for (const file of pluginSourceFiles(SRC)) {
        if (path.basename(file) === 'errors.js') continue;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/CFS-[A-Za-z0-9]{2,}/g)) used.add(m[0]);
    }
    const unused = allCodes().filter((c) => !used.has(c));
    // 不判失败——只把事实摆出来，避免「加了编号却没人用」悄悄堆积
    if (unused.length) console.log(`    [提示] ${unused.length} 个编号暂无调用点：${unused.join(', ')}`);
    assert.ok(true);
});

/* ---------------- 6. 未登记编号的兜底形态 ---------------- */

test('未登记编号：显式 registered:false，且文案里说清「没有登记」', () => {
    const e = makeError('CFS-Z999', { detail: 'boom' });
    assert.equal(e.registered, false);
    assert.match(e.text, /没有登记/, '未登记却不说，写错编号就会静默变空白');
    assert.ok(e.fix.length >= 1, '兜底也要给得出下一步动作');
    assert.equal(e.domain, 'Z');
    assert.equal(e.domainLabel, '未分类', '未登记的域必须显式标「未分类」');
    assert.equal(e.what, '操作失败。');
});

/* ---------------- 7. makeError 的上下文合流 ---------------- */

test('makeError：ctx.why 覆盖目录里的 null（调用点有证据时）', () => {
    const e = makeError('CFS-B001', { why: '库返回了空行集', detail: 'TypeError: x is not a function' });
    assert.equal(e.why, '库返回了空行集');
    assert.match(e.detail, /TypeError/);
    assert.ok(e.headline.includes('CFS-B001'), 'headline 必须带编号（用户报障靠它）');
    assert.match(e.text, /库返回了空行集/);
});

test('makeError：调用点给空白 why 时不许把目录里的原因抹掉', () => {
    const base = makeError('CFS-S002');
    assert.ok(base.why && base.why.includes('三档'), '目录里本来就有 why');
    for (const blank of ['   ', '\n', undefined, null]) {
        const e = makeError('CFS-S002', { why: blank });
        assert.equal(e.why, base.why, `why=${JSON.stringify(blank)} 时不该覆盖目录里的原因`);
    }
});

test('makeError：why 缺位时文案显式写「未定位（没有足够证据，不编原因）」', () => {
    const e = makeError('CFS-B002');
    assert.equal(e.why, null);
    assert.match(e.text, /未定位/);
    assert.match(e.text, /不编原因/);
});

test('makeError：fix 项规范化——字符串与对象都收敛成 {label}', () => {
    const e = makeError('CFS-G001');
    assert.ok(e.fix.every((f) => typeof f === 'object' && typeof f.label === 'string'));
});

/* ---------------- 8. 三个消费面 ---------------- */

test('fromException：把任意异常收敛成一条，原始栈进 detail', () => {
    const e = fromException(new Error('boom'), 'CFS-G003');
    assert.equal(e.code, 'CFS-G003');
    assert.equal(e.registered, true);
    assert.match(e.detail, /boom/);
    assert.ok(e.text.includes('CFS-G003'));
});

test('summarize：聚合成「N 项失败」并按域计数（界面不刷屏）', () => {
    const s = summarize([makeError('CFS-B001'), makeError('CFS-B002'), makeError('CFS-N001')]);
    assert.equal(s.count, 3);
    assert.equal(s.byDomain['分支'], 2);
    assert.equal(s.byDomain['结构图'], 1);
    assert.match(s.headline, /3 项失败/);
    assert.equal(summarize([]).count, 0);
    assert.equal(summarize(null).count, 0);
    assert.equal(summarize([null, undefined, makeError('CFS-B001')]).count, 1, '空项要被滤掉');
});

test('diagnosisText：带 meta 与逐条完整文本（用户贴给作者就够定位）', () => {
    const t = diagnosisText([makeError('CFS-N003'), makeError('CFS-B001')], { 版本: '2.7.0', 模式: '纯库' });
    assert.match(t, /版本: 2\.7\.0/);
    assert.match(t, /模式: 纯库/);
    assert.match(t, /--- 第 1 条 ---/);
    assert.match(t, /--- 第 2 条 ---/);
    assert.match(t, /CFS-N003/);
    assert.match(t, /CFS-B001/);
});
