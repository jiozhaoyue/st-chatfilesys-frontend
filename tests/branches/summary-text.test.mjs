/**
 * 摘要文本清洗单测：`core/summary-text.js`
 *
 * 这一条的直接来源是一次**真机翻车**：2026-09-28 用实例里配好的「类脑-GGg3.1p」
 * （`gemini-3.1-pro-preview`）跑分支总结，拿回来的"摘要"是 **`</think_nya~`**
 * ——思维链的闭合残片。用户看到的是这个而不是概括。
 *
 * 覆盖三类输入：正常文本（不许被改坏）、带思维块的（要剥干净）、
 * 以及**不闭合的半截标签**（最阴的一种，模型真会这么吐）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSummaryText } from '../../public/scripts/extensions/third-party/chatfilesys/core/summary-text.js';

test('清洗：正常摘要**原样保留**（不许把好文本改坏）', () => {
    assert.equal(cleanSummaryText('两人决定夜探哨塔'), '两人决定夜探哨塔');
    assert.equal(cleanSummaryText('  多余的   空白  '), '多余的 空白');
    assert.equal(cleanSummaryText('带标点，有逗号。'), '带标点，有逗号。');
});

test('清洗：成对思维块被整段剥掉（含 `<thinking>` 变体与属性）', () => {
    assert.equal(cleanSummaryText('<think>先想一下…</think>两人决定夜探哨塔'), '两人决定夜探哨塔');
    assert.equal(cleanSummaryText('<thinking type="a">…</thinking>结论是和解'), '结论是和解');
    assert.equal(cleanSummaryText('<THINK>大写也要认</THINK>留下这句'), '留下这句');
});

test('清洗：**不闭合**的半截标签要处理掉——这就是真机那次 `</think_nya~`', () => {
    // 模型吐出的闭合残片（标签名后还带了杂字符）
    assert.equal(cleanSummaryText('</think_nya~'), '', '剥完只剩空 ⇒ 调用方据此报「生成结果为空」');
    assert.equal(cleanSummaryText('</think_nya~两人决定夜探哨塔'), '两人决定夜探哨塔');
    // 开头是 `<` 且找不到 `>` ⇒ 整串都是残片
    assert.equal(cleanSummaryText('<没有闭合'), '');
});

test('清洗：剥掉包裹的引号 / 书名号 / 方括号（提示词要求了，但模型不一定听）', () => {
    assert.equal(cleanSummaryText('「两人决定夜探哨塔」'), '两人决定夜探哨塔');
    assert.equal(cleanSummaryText('"两人决定夜探哨塔"'), '两人决定夜探哨塔');
    assert.equal(cleanSummaryText('【两人决定夜探哨塔】'), '两人决定夜探哨塔');
    assert.equal(cleanSummaryText('（两人决定夜探哨塔）'), '两人决定夜探哨塔');
    // 内部的引号不许动
    assert.equal(cleanSummaryText('他说「走吧」然后离开'), '他说「走吧」然后离开');
});

test('清洗：非字符串输入也能吃下（不抛、且返回字符串）', () => {
    assert.equal(cleanSummaryText(null), '');
    assert.equal(cleanSummaryText(undefined), '');
    assert.equal(cleanSummaryText(42), '42');
    // 退化输入只断言「是字符串、没抛」——`[object Object]` 被首尾括号剥成什么样子
    // 不是这条用例该关心的事（真实调用方永远不会喂对象进来）
    assert.equal(typeof cleanSummaryText({}), 'string');
    assert.equal(typeof cleanSummaryText([1, 2]), 'string');
});

test('清洗：思维块在中间时，两侧内容都留下', () => {
    assert.equal(cleanSummaryText('前段<think>思考</think>后段'), '前段后段');
});

test('清洗：宿主把 `undefined` 字符串化交回来时按**空**处理（真机实测形态）', () => {
    // Dev Luker 8003 实测：`generateQuietPrompt` 返回的是字面量 "undefined"（内部没真调用）。
    // 那不是摘要——按空处理，调用方才会去试下一条链路 / 报「生成结果为空」。
    assert.equal(cleanSummaryText('undefined'), '');
    assert.equal(cleanSummaryText('null'), '');
    assert.equal(cleanSummaryText('NaN'), '');
    assert.equal(cleanSummaryText('  undefined  '), '');
    // 但**含**这个词的正常文本不许被误伤
    assert.equal(cleanSummaryText('状态是 undefined 的一种'), '状态是 undefined 的一种');
});
