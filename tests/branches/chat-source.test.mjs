/**
 * chat-source 单测（B1 / AC1）：数据源抽象（`core/source/*`）
 *
 * 覆盖七组：
 * 1. **归一纯函数**：`normalizeMessage` / `normalizeHeader` / `messageFromLine` / `splitSessionRows`
 *    （含 `__proto__` 键安全、首行不像聊天头的报警）
 * 2. **同形性**：同一份数据两种来源（磁盘 jsonl / 库内家族）→ 归一后的 messages 与 header 深比对一致
 * 3. **边界与降级**：空目录 / 空库 / 空文件 / 群聊（只认 `isGroup` 钩子）/ 原生分支文件 / 坏行
 *    （文件档 + 库档都钉）/ 缺 `chatKey` / 依赖抛错（**绝不抛到上层**）
 * 4. **降级口径**：库模式下未注入原生通道 = 读到接缝（记一条，不抛）
 * 5. **选源**：三种 `storage_mode` → 选中对应实现（单点判定）
 * 6. **建图输入**：会话集合 + 库源的家族模型
 * 7. **自述作用域**：`notes` 以「一次公开调用」为界（重置 / 可重入）
 *
 * 依赖全注入：宿主端点用假的 `nativeFetch`，存储用假适配器——不碰网络、不碰磁盘、不碰 Dev 实例。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createChatSource, sourceTierForMode, createJsonlSource, createLibrarySource,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/source/chat-source.js';
import {
    normalizeMessage, normalizeHeader, messageFromLine, splitSessionRows,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/source/normalize.js';
import { enableForChat } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { normalizeChatKey } from '../../public/scripts/extensions/third-party/chatfilesys/core/seam.js';
import { line, seedBody, T } from './fixtures.mjs';

const AVATAR = 'char.png';
const CHAR = { avatarUrl: AVATAR, characterId: 'c1', name: '角色' };
const CHAT = '聊天';
const KEY = normalizeChatKey(AVATAR, CHAT);          // `char.png::聊天`（规则单点 = seam）
const HEADER = { user_name: 'unused', character_name: 'unused', chat_metadata: { main_chat: null, extensions: {} } };

/* ---------------- 假依赖 ---------------- */

/**
 * 假的**原生通道**（`seam.native` 的位置）：/api/chats/search 回文件清单，/api/chats/get 回
 * `[header, ...行]`。行可以是对象（宿主真机形态：每行 JSON.parse 后回）也可以是字符串。
 */
function fakeHost({ files = {}, search = {}, failSearch = false, getStatus = 200 } = {}) {
    const calls = [];
    const nativeFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        calls.push({ url: String(url), body });
        if (String(url).includes('chats/search')) {
            if (failSearch) throw new Error('search 通道炸了');
            const names = Object.keys(files);
            return { ok: true, json: async () => names.map((file_name) => ({ file_name, message_count: null, ...(search[file_name] || {}) })) };
        }
        if (String(url).includes('chats/get')) {
            if (getStatus !== 200) return { ok: false, status: getStatus, json: async () => ({}) };
            return { ok: true, json: async () => (files[body.file_name] ?? []) };
        }
        return { ok: true, json: async () => ({}) };
    };
    return { nativeFetch, calls };
}

/** 捕获日志：既避免测试输出被 warn 淹没，也用来断言「降级必须留日志」（L0-11） */
function captureLog() {
    const lines = [];
    return { lines, log: (m) => lines.push(String(m)) };
}

/** 库内家族（形态照 `importer#buildFamilyFromJsonl` 的产物：一行 = 一个楼层变体 `g<层号>`） */
function libraryFamily({
    familyId = 'f1', chatKey = KEY, characterId = 'c1', name = CHAT, body = seedBody(),
    model = null, keyBindings = {}, hostMetadata = null, integrity = 'c-1',
} = {}) {
    const rows = body.map((row, i) => ({
        floorNo: i + 1, variantId: `g${i + 1}`, seq: 0, content: JSON.stringify(row), contentHash: null,
        sendDate: row?.send_date ?? null,
    }));
    return { familyId, chatKey, characterId, name, integrity, hostMetadata, keyBindings, model: model || enableForChat(body), rows };
}

/** 假适配器（契约同 `core/storage/adapter.js`；`fail*` 用来测静默降级） */
function fakeAdapter(families = [], { failList = false, failLoad = false, failFloors = false } = {}) {
    const rowsOf = new Map(families.map((f) => [f.familyId, f.rows]));
    return {
        async listFamilies({ characterId } = {}) {
            if (failList) throw new Error('listFamilies 炸了');
            return families
                .filter((f) => !characterId || f.characterId === characterId)
                .map((f) => ({ familyId: f.familyId, name: f.name, updatedAt: 1 }));
        },
        async loadFamily({ familyId, chatKey } = {}) {
            if (failLoad) throw new Error('loadFamily 炸了');
            const f = families.find((x) => (familyId != null && x.familyId === familyId)
                || (chatKey != null && (x.chatKey === chatKey || Object.hasOwn(x.keyBindings || {}, chatKey))));
            return f ? { ...f, keyBindings: f.keyBindings || {} } : null;
        },
        async loadFloors({ familyId } = {}) {
            if (failFloors) throw new Error('loadFloors 炸了');
            return { floors: rowsOf.get(familyId) || [], hasMore: false };
        },
    };
}

/** 文件源（同一份数据：body 逐行写进 jsonl） */
function jsonlSourceOf(body = seedBody(), opts = {}) {
    const host = fakeHost({ files: { [CHAT]: [HEADER, ...body] }, ...opts });
    return { source: createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch }), host };
}

/** 库源（同一份数据：body 逐行走库内家族） */
function librarySourceOf({ families = [libraryFamily()], character = CHAR, adapter = null } = {}) {
    return createLibrarySource({ character: () => character, adapter: adapter || fakeAdapter(families) });
}

/* ---------------- 1. 归一纯函数 ---------------- */

test('归一：标准字段在前、未知键一个不丢（逐字段保真）', () => {
    const raw = {
        custom_flag: { a: 1 },       // 第三方命名空间
        mes: '正文', is_user: false, name: 'Seraphina', send_date: 123,
        extra: { chatfilesys: { tags: [{ name: 'X', color: '#f00' }] } },
        swipes: ['正文', '另一条'], swipe_info: [{ send_date: 1 }], swipe_id: 1,
    };
    const msg = normalizeMessage(raw);
    assert.deepEqual(Object.keys(msg), [
        'mes', 'is_user', 'name', 'send_date', 'extra', 'swipes', 'swipe_info', 'swipe_id', 'custom_flag',
    ]);
    assert.deepEqual(msg, raw);                          // 值一个不改
    assert.notEqual(msg, raw);                           // 新对象（不共享引用）
    assert.notEqual(msg.extra, raw.extra);
});

test('归一：缺 extra / 缺 swipe 三件套 → 不补默认值（补默认值会污染老数据）', () => {
    const msg = normalizeMessage({ mes: '单 swipe 老行', is_user: true, name: '我', send_date: T });
    assert.deepEqual(msg, { mes: '单 swipe 老行', is_user: true, name: '我', send_date: T });
    assert.equal('extra' in msg, false);
    assert.equal('swipes' in msg, false);
    assert.equal('swipe_info' in msg, false);
    assert.equal('swipe_id' in msg, false);
    // 有但为空的对象/数组原样保留（只「缺」才不补）
    assert.deepEqual(normalizeMessage({ mes: 'x', extra: {} }).extra, {});
});

test('归一：类型异常（mes 非字符串）原样保留——字符串化就是改数据', () => {
    assert.equal(normalizeMessage({ mes: 42, is_user: false }).mes, 42);
    assert.equal(normalizeMessage({ mes: null, is_user: false }).mes, null);
    assert.deepEqual(normalizeMessage({ mes: 'x', extra: null }).extra, null);
});

test('归一：非对象（null / 数组 / 字符串 / 数字）→ null（该行不可用）', () => {
    for (const bad of [null, undefined, [], ['a'], '一段文本', 7, true]) {
        assert.equal(normalizeMessage(bad), null);
    }
});

test('归一：header 三件标准字段在前、其余原样；非对象 → 空对象', () => {
    const raw = { __probe_top: 1, user_name: 'u', character_name: 'c', chat_metadata: { main_chat: 'p' } };
    assert.deepEqual(Object.keys(normalizeHeader(raw)), ['user_name', 'character_name', 'chat_metadata', '__probe_top']);
    assert.deepEqual(normalizeHeader(raw), raw);
    assert.deepEqual(normalizeHeader(null), {});
    assert.deepEqual(normalizeHeader([]), {});
});

test('归一：行解析两种形态都收（JSON 字符串 / 已解析对象），坏 JSON → null', () => {
    assert.deepEqual(messageFromLine('{"mes":"a","is_user":true}'), { mes: 'a', is_user: true });
    assert.deepEqual(messageFromLine({ mes: 'a', is_user: true }), { mes: 'a', is_user: true });
    assert.equal(messageFromLine('{"mes":"a"'), null);   // 坏行（截断的 JSON）
    assert.equal(messageFromLine('"就是个字符串"'), null);
    assert.equal(messageFromLine('42'), null);
});

test('归一：splitSessionRows —— 首行是 header，坏行跳过并计数', () => {
    const { header, messages, skipped, headerSuspect } = splitSessionRows([
        HEADER, '{"mes":"一","is_user":true}', '{{{坏行', { mes: '二', is_user: false },
    ]);
    assert.deepEqual(header, HEADER);
    assert.deepEqual(messages, [{ mes: '一', is_user: true }, { mes: '二', is_user: false }]);
    assert.equal(skipped, 1);
    assert.equal(headerSuspect, false);                        // 首行是正经聊天头 → 不报警
    // 空文件（连 header 都没有）
    assert.deepEqual(splitSessionRows([]), { header: {}, messages: [], skipped: 0, headerSuspect: false });
    assert.deepEqual(splitSessionRows(null), { header: {}, messages: [], skipped: 0, headerSuspect: false });
});

test('归一：`__proto__` 键不丢字段、也不换掉输出对象原型（原型污染防线）', () => {
    // JSON.parse 会把 `__proto__` 建成**自有数据键**——普通赋值既丢字段又改原型
    const raw = JSON.parse('{"mes":"d","is_user":true,"__proto__":{"polluted":1}}');
    const msg = normalizeMessage(raw);
    assert.deepEqual(Object.keys(msg), ['mes', 'is_user', '__proto__']);   // 一个键不丢
    assert.deepEqual(Object.getOwnPropertyDescriptor(msg, '__proto__').value, { polluted: 1 });
    assert.equal(Object.getPrototypeOf(msg), Object.prototype);            // 原型没被换掉
    assert.equal({}.polluted, undefined);                                 // 没污染到全局原型
    // header 走同一条 reshape，同样安全
    const h = normalizeHeader(JSON.parse('{"user_name":"u","__proto__":{"x":1}}'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(h, '__proto__').value, { x: 1 });
    assert.equal(Object.getPrototypeOf(h), Object.prototype);
});

test('归一：首行不像聊天头（含 mes）→ 仍按 header 处理，但置 headerSuspect 报警', () => {
    const rows = [{ mes: '其实这是第一行消息', is_user: true }, { mes: '第二行' }];
    const out = splitSessionRows(rows);
    // 行为不变：首行照旧当聊天头（本任务不改「首行即 header」这条既有行为）
    assert.deepEqual(out.header, { mes: '其实这是第一行消息', is_user: true });
    assert.deepEqual(out.messages, [{ mes: '第二行' }]);
    assert.equal(out.headerSuspect, true);
    // 字符串形态的首行也判得出来
    assert.equal(splitSessionRows([JSON.stringify({ mes: 'x' }), { mes: 'y' }]).headerSuspect, true);
    // 有 user_name / chat_metadata 的就算像聊天头
    assert.equal(splitSessionRows([{ user_name: 'u' }, { mes: 'y' }]).headerSuspect, false);
    assert.equal(splitSessionRows([{ chat_metadata: {} }, { mes: 'y' }]).headerSuspect, false);
});

/* ---------------- 2. 同形性（AC1 核心） ---------------- */

test('同形：同一份数据，文件源与库源 readSession 的 messages 深比对一致（含键序）', async () => {
    const body = seedBody();
    const ji = jsonlSourceOf(body);
    const li = librarySourceOf({ families: [libraryFamily({ body })] });
    const fromFile = await ji.source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    const fromLib = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    assert.deepEqual(fromFile.messages, body);
    assert.deepEqual(fromLib.messages, body);
    assert.deepEqual(fromFile.messages, fromLib.messages);
    // 键序也一致（归一固定标准字段在前 → JSON 串形态可比对，既有代码大量用这种比对）
    assert.equal(JSON.stringify(fromFile.messages), JSON.stringify(fromLib.messages));
    // swipe 三件套逐字段在手（本仓不丢宿主/第三方的 swipe 字段）
    const swiped = fromLib.messages[1];
    assert.deepEqual(swiped.swipes, body[1].swipes);
    assert.deepEqual(swiped.swipe_info, body[1].swipe_info);
    assert.equal(swiped.swipe_id, body[1].swipe_id);
});

test('同形：header 跨档互比——库内数字版本号经 normIntegrity 后与文件源同形', async () => {
    const body = seedBody();
    const MODEL = enableForChat(body);
    const hostExt = { otherplugin: { keep: 1 } };                  // 别的插件的命名空间，整份回显
    const FILE_HEADER = {
        user_name: 'unused',
        character_name: 'unused',
        chat_metadata: { extensions: { ...hostExt, chatfilesys: MODEL }, integrity: '1' },
    };
    const host = fakeHost({ files: { [CHAT]: [FILE_HEADER, ...body] } });
    const ji = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    // 库内那份版本号是**数字**（SQLite 动态类型 / 早期建档）：不过 normIntegrity 就会给出 1 而不是 '1'
    const li = librarySourceOf({
        families: [libraryFamily({ body, model: MODEL, hostMetadata: { extensions: hostExt }, integrity: 1 })],
    });
    const ref = { id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' };
    const fromFile = await ji.readSession({ ...ref, kind: 'chat', origin: 'file' });
    const fromLib = await li.readSession(ref);
    assert.equal(fromLib.header.chat_metadata.integrity, '1');     // 与 seam#composeChatMetadata 同一个单点
    assert.deepEqual(fromFile.header, fromLib.header);             // 两档 header 同形（比的是值，header 键序由来源决定）
    assert.equal(ji.describe().fidelity, 'full');                  // 干净数据不该因为读了一下 header 就报缺项
});

test('同形：jsonl 行给字符串时同样能读（宿主两种形态都可能是真机事实）', async () => {
    const body = seedBody();
    const host = fakeHost({ files: { [CHAT]: [HEADER, ...body.map((r) => JSON.stringify(r)), '{坏行'] } });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const s = await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.deepEqual(s.messages, body.map((r) => normalizeMessage(r)));
    assert.equal(source.describe().fidelity, 'partial');       // 有坏行 = 有跳过
    assert.match(source.describe().notes.join('|'), /1 行无法解析/);
});

test('同形：listSessions 的键集合一致（同一聊天，两种来源同键）', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const ji = jsonlSourceOf(body);
    const li = librarySourceOf({ families: [libraryFamily({ body })] });
    const fileRefs = await ji.source.listSessions();
    const libRefs = await li.listSessions();
    assert.deepEqual(fileRefs.map((r) => r.key), [KEY]);
    assert.deepEqual(libRefs.map((r) => r.key), [KEY]);
    assert.deepEqual(fileRefs.map((r) => [r.kind, r.origin]), [['chat', 'file']]);
    assert.deepEqual(libRefs.map((r) => [r.kind, r.origin]), [['family-member', 'library']]);
    assert.equal(fileRefs[0].id, libRefs[0].id);               // id 同源同值（跨档可直接比对）
    assert.equal(fileRefs[0].name, libRefs[0].name);           // 文件名主体同形
});

test('源级：缺 extra / 缺 swipe 三件套的行，两条源读出来**都没有**这些键（不补默认值）', async () => {
    // 纯函数用例已钉住 normalizeMessage；这里钉**源级**——真实读取路径上也不该凭空长字段
    const body = [{ name: '我', is_user: true, mes: '老行', send_date: T }];
    const ji = jsonlSourceOf(body);
    const li = librarySourceOf({ families: [libraryFamily({ body })] });
    const fromFile = await ji.source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    const fromLib = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    for (const [tier, s] of [['file', fromFile], ['library', fromLib]]) {
        assert.deepEqual(s.messages, body, `${tier}：逐字段保真`);
        for (const k of ['extra', 'swipes', 'swipe_info', 'swipe_id']) {
            assert.equal(k in s.messages[0], false, `${tier}：不该凭空多出 ${k}`);
        }
    }
});

test('同形：自述 —— 两档 tier 不同、首条 notes 是来源说明且不算缺项（保真度仍 full）', () => {
    const ji = jsonlSourceOf([]);
    const li = librarySourceOf();
    const d1 = ji.source.describe();
    const d2 = li.describe();
    assert.equal(d1.tier, 'jsonl');
    assert.equal(d2.tier, 'library');
    assert.equal(d1.fidelity, 'full');
    assert.equal(d2.fidelity, 'full');
    assert.match(d1.notes[0], /^文件源/);
    assert.match(d2.notes[0], /^库源/);
});

/* ---------------- 3. 边界 ---------------- */

test('边界：空目录 → listSessions = []（空不是错：保真度仍 full、无缺项记录）', async () => {
    const host = fakeHost({ files: {} });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    assert.deepEqual(await source.listSessions(), []);
    const d = source.describe();
    assert.equal(d.fidelity, 'full');
    assert.equal(d.notes.length, 1);                           // 只有来源自述
});

test('边界：空库 → listSessions = []；读未入库会话 → 空会话 + 记录，不抛', async () => {
    const li = librarySourceOf({ families: [] });
    assert.deepEqual(await li.listSessions(), []);
    const s = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    assert.deepEqual(s.messages, []);
    assert.deepEqual(s.header, {});
    assert.equal(li.describe().fidelity, 'partial');
    assert.match(li.describe().notes.join('|'), /不在库中/);
});

test('边界：空文件（get 回 []）→ header {} + messages []，不当作失败', async () => {
    const host = fakeHost({ files: { [CHAT]: [] } });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const s = await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.deepEqual(s.header, {});
    assert.deepEqual(s.messages, []);
    assert.deepEqual((await source.listSessions()).map((r) => r.key), [KEY]);
});

test('边界：群聊标记只认枚举层钩子（isGroup）——注入钩子则标 group，读它降级为空', async () => {
    const host = fakeHost({
        files: { [CHAT]: [HEADER, line('我', true, '一')], '群聊甲': [HEADER, line('我', true, '群里的')] },
    });
    const source = createJsonlSource({
        character: () => CHAR, nativeFetch: host.nativeFetch,
        isGroup: (fileName) => fileName === '群聊甲',
    });
    const refs = await source.listSessions();
    const byName = new Map(refs.map((r) => [r.name, r]));
    assert.equal(byName.get(CHAT).kind, 'chat');
    assert.equal(byName.get('群聊甲').kind, 'group');
    const s = await source.readSession(byName.get('群聊甲'));
    assert.deepEqual(s.messages, []);
    assert.match(source.describe().notes.join('|'), /群聊（不接管）/);
});

test('边界：未注入 isGroup 钩子时不误判群聊（不读响应里的 is_group——那是编造的宿主契约）', async () => {
    // 宿主 `/api/chats/search` 的条目其实只有 file_name/file_size/message_count/last_mes/preview_message
    // （群聊住另一端点）；这里故意在响应里塞 `is_group` —— 本层也不该认它
    const host = fakeHost({
        files: { [CHAT]: [HEADER, line('我', true, '一')], '群聊甲': [HEADER, line('我', true, '一')] },
        search: { '群聊甲': { is_group: true } },
    });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const refs = await source.listSessions();
    assert.deepEqual(refs.map((r) => r.kind), ['chat', 'chat']);
    assert.equal(source.describe().fidelity, 'full');          // 没有「降级为空」这回事
});

test('边界：库源同样只认 isGroup 钩子——家族被标群聊时读它降级为空 + 记录', async () => {
    const li = createLibrarySource({
        character: () => CHAR,
        adapter: fakeAdapter([libraryFamily()]),
        isGroup: (fileName) => fileName === CHAT,
    });
    const refs = await li.listSessions();
    assert.equal(refs[0].kind, 'group');
    const s = await li.readSession(refs[0]);
    assert.deepEqual(s.messages, []);
    assert.match(li.describe().notes.join('|'), /群聊（不接管）/);
});

test('边界：库源未注入 isGroup 钩子 → 一律 family-member', async () => {
    const li = librarySourceOf();
    assert.deepEqual((await li.listSessions()).map((r) => r.kind), ['family-member']);
});

test('边界：原生分支/检查点文件是独立会话（kind=branch-file，不并进父会话）', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const host = fakeHost({
        files: {
            [CHAT]: [HEADER, ...body],
            [`${CHAT} - Branch #1`]: [HEADER, body[0]],
            [`${CHAT} - Checkpoint #2`]: [HEADER, ...body],
        },
    });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const refs = await source.listSessions();
    assert.deepEqual(refs.map((r) => [r.name, r.kind]), [
        [CHAT, 'chat'],
        [`${CHAT} - Branch #1`, 'branch-file'],
        [`${CHAT} - Checkpoint #2`, 'branch-file'],
    ]);
    // 父会话与分支文件各读各的（没有合并，也没有截断父会话）
    const parent = await source.readSession(refs[0]);
    const branch = await source.readSession(refs[1]);
    assert.equal(parent.messages.length, 2);
    assert.equal(branch.messages.length, 1);
});

test('边界：库隐容器（__cfsys__）不在会话列表里（候选过滤复用 importer#planImport）', async () => {
    const host = fakeHost({ files: { [CHAT]: [HEADER, line('我', true, '一')], '__cfsys__f1': [HEADER] } });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    assert.deepEqual((await source.listSessions()).map((r) => r.name), [CHAT]);
});

test('边界：坏 JSON 行跳过并记入 notes（一处坏行不让整个会话读不出来）', async () => {
    const host = fakeHost({ files: { [CHAT]: [HEADER, line('我', true, '一'), '{坏行', line('AI', false, '二')] } });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const s = await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.equal(s.messages.length, 2);
    assert.equal(source.describe().fidelity, 'partial');
    assert.match(source.describe().notes.join('|'), /1 行无法解析（已跳过）/);
});

test('边界：库内行损坏（坏 JSON）→ 跳过后仍报 partial 并留记录（不静默吞掉）', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const fam = libraryFamily({ body });
    fam.rows[1].content = '{坏 JSON';                     // 库内第 2 行内容损坏（projectionOf 会静默跳过）
    const li = librarySourceOf({ families: [fam] });
    const s = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    assert.equal(s.messages.length, 1);                    // 好行照读
    const d = li.describe();
    assert.equal(d.fidelity, 'partial');                   // 差了一条不许谎报 full
    assert.match(d.notes.join('|'), /库内行不齐/);
});

test('边界：库内行缺失（path 指向的行不在行表里）→ 同样记账', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const fam = libraryFamily({ body });
    fam.rows = fam.rows.slice(0, 1);                       // 行表比分支 path 少一层
    const li = librarySourceOf({ families: [fam] });
    const s = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    assert.equal(s.messages.length, 1);
    assert.equal(li.describe().fidelity, 'partial');
    assert.match(li.describe().notes.join('|'), /库内行不齐/);
});

test('边界：jsonl 首行不像聊天头 → 记一条 note 并置 partial（行为仍是「首行当 header」）', async () => {
    const host = fakeHost({
        files: { [CHAT]: [{ mes: '缺头的老文件', is_user: true }, line('AI', false, '二')] },
    });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    const s = await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.equal(s.messages.length, 1);                    // 行为不变：首行仍归 header
    assert.equal(s.header.mes, '缺头的老文件');
    const d = source.describe();
    assert.equal(d.fidelity, 'partial');
    assert.match(d.notes.join('|'), /首行不像聊天头/);
});

test('边界：家族 schema 缺 chatKey → 跳过该家族 + 记一条（不产出 key=undefined 的引用）', async () => {
    const fam = libraryFamily();
    delete fam.chatKey;
    const li = librarySourceOf({ families: [fam] });
    assert.deepEqual(await li.listSessions(), []);
    const d = li.describe();
    assert.equal(d.fidelity, 'partial');
    assert.match(d.notes.join('|'), /没有 chatKey/);
});

test('边界：库源的家族无分支结构（模型缺失）→ 空会话 + 记录，不抛', async () => {
    const fam = libraryFamily({ body: [line('我', true, '一')] });
    fam.model = { active_branch: null, branches: [], groups: {} };
    const li = librarySourceOf({ families: [fam] });
    const s = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    assert.deepEqual(s.messages, []);
    assert.match(li.describe().notes.join('|'), /没有分支结构/);
});

test('边界：库源多键绑定 → 每个键一份引用（id = 键），主键不重复列', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const boundKey = normalizeChatKey(AVATAR, `${CHAT} - Branch #1`);
    const ckKey = normalizeChatKey(AVATAR, `${CHAT} - Checkpoint #2`);
    const li = librarySourceOf({
        families: [libraryFamily({
            body,
            keyBindings: { [boundKey]: { branchId: 'b1' }, [ckKey]: { branchId: 'b1', isCheckpoint: true, markerFloor: 1 } },
        })],
    });
    const refs = await li.listSessions();
    assert.deepEqual(refs.map((r) => r.key), [KEY, boundKey, ckKey]);
    assert.deepEqual(refs.map((r) => r.id), [KEY, boundKey, ckKey]);
    // 主键的 name = 家族名（保留磁盘大小写）；绑定键的 name 取自键——键经 normalizeChatKey 小写化
    assert.deepEqual(refs.map((r) => r.name), [CHAT, `${CHAT} - branch #1`, `${CHAT} - checkpoint #2`]);
    assert.ok(refs.every((r) => r.origin === 'library' && r.kind === 'family-member'));
});

test('库源：按键读会话 = 该键绑定分支的投影（不是家族活跃分支）', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二'), line('我', true, '三')];
    const boundKey = normalizeChatKey(AVATAR, `${CHAT} - Branch #1`);
    // 家族活跃分支 b_main 三层；键 binding 指向分叉于第 1 层的 b1（只有第 1 层）
    const model = {
        active_branch: 'b_main',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3' } },
            { id: 'b1', name: `${CHAT} - Branch #1`, is_default: false, fork_base: 1, path: { 1: 'g1' } },
        ],
        groups: {},
    };
    const li = librarySourceOf({
        families: [libraryFamily({ body, model, keyBindings: { [boundKey]: { branchId: 'b1', mainChat: CHAT } } })],
    });
    const masterKey = await li.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'family-member', origin: 'library' });
    const bound = await li.readSession({ id: boundKey, key: boundKey, name: `${CHAT} - Branch #1`, kind: 'family-member', origin: 'library' });
    assert.deepEqual(masterKey.messages, body);                       // 主键 = 家族活跃分支（3 层）
    assert.deepEqual(bound.messages, [normalizeMessage(body[0])]);    // 绑定键 = 它自己那条分支（1 层）
    // 键级 main_chat（父线索）按键回显，不落进家族级
    assert.equal(bound.header.chat_metadata.main_chat, CHAT);
    assert.equal('main_chat' in masterKey.header.chat_metadata, false);
    // 家族模型随会话给出（B2 建图骨架：分支结构是库源原生一等公民）
    assert.equal(bound.branches.familyId, 'f1');
    assert.deepEqual(bound.branches.model.branches.map((b) => b.id), ['b_main', 'b1']);
});

/* ---------------- 4. 静默降级（铁律 L0-11） ---------------- */

test('降级：枚举通道抛错 → listSessions = [] + 记录，不抛到上层', async () => {
    const host = fakeHost({ files: {}, failSearch: true });
    const lg = captureLog();
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch, log: lg.log });
    assert.deepEqual(await source.listSessions(), []);
    const d = source.describe();
    assert.equal(d.fidelity, 'partial');
    assert.match(d.notes.join('|'), /枚举聊天文件失败/);
    assert.ok(lg.lines.some((m) => /枚举聊天文件失败/.test(m)), '降级必须留日志（L0-11）');
});

test('降级：get 非 200 → 空会话 + 记录，不抛', async () => {
    const host = fakeHost({ files: { [CHAT]: [HEADER] }, getStatus: 500 });
    const lg = captureLog();
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch, log: lg.log });
    const s = await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.deepEqual(s.messages, []);
    assert.match(source.describe().notes.join('|'), /读不到/);
    assert.ok(lg.lines.some((m) => /读不到/.test(m)));
});

test('降级：库适配器抛错（list/load/floors）× 三处 → 空结果 + 记录，不抛', async () => {
    const cases = [
        { opts: { failList: true }, probe: (s) => s.listSessions(), note: /枚举库内家族失败/ },
        { opts: { failLoad: true }, probe: (s) => s.readSession({ key: KEY }), note: /读取会话.*失败/ },
        { opts: { failFloors: true }, probe: (s) => s.readSession({ key: KEY }), note: /读取会话.*失败/ },
    ];
    for (const c of cases) {
        const lg = captureLog();
        const source = createLibrarySource({
            character: () => CHAR,
            adapter: fakeAdapter([libraryFamily()], c.opts),
            log: lg.log,
        });
        const out = await c.probe(source);
        assert.ok(Array.isArray(out) ? out.length === 0 : out.messages.length === 0);
        assert.equal(source.describe().fidelity, 'partial');
        assert.match(source.describe().notes.join('|'), c.note);
        assert.ok(lg.lines.some((m) => c.note.test(m)));
    }
});

test('降级：库源没有 adapter（未注入）→ 静默降级为空，不抛', async () => {
    const lg = captureLog();
    const source = createLibrarySource({ character: () => CHAR, log: lg.log });
    assert.deepEqual(await source.listSessions(), []);
    const s = await source.readSession({ key: KEY });
    assert.deepEqual(s.messages, []);
    assert.equal(source.describe().fidelity, 'partial');
    assert.equal(lg.lines.length, 2);
});

test('降级：原生通道自身抛错（如 globalThis.fetch 不可用）也走同一条降级记录路径', async () => {
    const lg = captureLog();
    const source = createJsonlSource({
        character: () => CHAR,
        nativeFetch: async () => { throw new Error('原生通道不可用'); },
        log: lg.log,
    });
    assert.deepEqual(await source.listSessions(), []);
    assert.match(source.describe().notes.join('|'), /原生通道不可用/);
    assert.ok(lg.lines.some((m) => /原生通道不可用/.test(m)));
});

test('降级：库模式下未注入原生通道 → 记一条（缺省 fetch 就是接缝），且不抛', async () => {
    const source = createJsonlSource({ character: () => CHAR, mode: 'mirror', log: () => {} });
    const d0 = source.describe();
    assert.equal(d0.fidelity, 'partial');
    assert.match(d0.notes.join('|'), /未显式注入原生通道/);
    assert.match(d0.notes[0], /^文件源/);                      // 自述仍居首
    // 真读一次（Node 里相对 URL 的 fetch 必失败）→ 作用域重置后这条**仍在**：它是源的性质，不是某次的问题
    await source.listSessions();
    const d1 = source.describe();
    assert.equal(d1.fidelity, 'partial');
    assert.match(d1.notes.join('|'), /未显式注入原生通道/);
});

test('降级：off 模式未注入原生通道不算问题（那时接缝本就没装）', async () => {
    for (const mode of ['off', undefined]) {
        const source = createJsonlSource({ character: () => CHAR, mode, log: () => {} });
        const d = source.describe();
        assert.equal(d.fidelity, 'full');
        assert.doesNotMatch(d.notes.join('|'), /未显式注入原生通道/);
    }
});

/* ---------------- 5. 选源（单点判定） ---------------- */

test('选源：off → jsonl；pure / mirror → library；非法与缺省 → off（normMode 既有语义）', () => {
    assert.equal(sourceTierForMode('off'), 'jsonl');
    assert.equal(sourceTierForMode('pure'), 'library');
    assert.equal(sourceTierForMode('mirror'), 'library');
    assert.equal(sourceTierForMode(undefined), 'jsonl');
    assert.equal(sourceTierForMode('乱写的模式'), 'jsonl');
    assert.equal(sourceTierForMode(null), 'jsonl');
});

test('选源：createChatSource 三模式选中对应实现（describe().tier 自述）', () => {
    const deps = { character: () => CHAR, adapter: fakeAdapter([libraryFamily()]) };
    assert.equal(createChatSource({ ...deps, mode: 'off' }).describe().tier, 'jsonl');
    assert.equal(createChatSource({ ...deps, mode: 'pure' }).describe().tier, 'library');
    assert.equal(createChatSource({ ...deps, mode: 'mirror' }).describe().tier, 'library');
    assert.equal(createChatSource({ ...deps }).describe().tier, 'jsonl');
});

/* ---------------- 6. 建图输入 ---------------- */

test('graphInputs：文件源只给会话（无家族模型）；库源额外给出每个家族一份模型', async () => {
    const body = [line('我', true, '一'), line('AI', false, '二')];
    const ji = jsonlSourceOf(body);
    const g1 = await ji.source.graphInputs();
    assert.equal(g1.sessions.length, 1);
    assert.deepEqual(g1.sessions[0].messages, body);
    assert.equal('branches' in g1, false);                     // off 模式没有家族模型
    assert.equal('branches' in g1.sessions[0], false);

    const fam2 = libraryFamily({ familyId: 'f2', chatKey: normalizeChatKey(AVATAR, '另一个聊天'), name: '另一个聊天', body });
    const li = librarySourceOf({ families: [libraryFamily({ body }), fam2] });
    const g2 = await li.graphInputs();
    assert.equal(g2.sessions.length, 2);
    assert.deepEqual(g2.branches.map((b) => b.familyId), ['f1', 'f2']);
    assert.deepEqual(g2.branches[0].model.branches.map((b) => b.id), ['b_main']);
    assert.equal(g2.sessions[0].branches.familyId, 'f1');
});

/* ---------------- 7. 自述的作用域（一次公开调用 = 一次） ---------------- */

test('自述：notes 以「一次公开调用」为作用域——下次调用重置，describe 报最近一次', async () => {
    const host = fakeHost({ files: { [CHAT]: [HEADER, line('我', true, '一'), '{坏行'] } });
    const source = createJsonlSource({ character: () => CHAR, nativeFetch: host.nativeFetch });
    await source.readSession({ id: KEY, key: KEY, name: CHAT, kind: 'chat', origin: 'file' });
    assert.equal(source.describe().fidelity, 'partial');
    assert.match(source.describe().notes.join('|'), /1 行无法解析/);
    // 下一次（干净的一次）调用 → 记录重置，保真度回到 full，旧记录不残留
    await source.listSessions();
    const d = source.describe();
    assert.equal(d.fidelity, 'full');
    assert.match(d.notes[0], /^文件源/);                        // 来源自述仍居首
    assert.doesNotMatch(d.notes.join('|'), /1 行无法解析/);
});

test('自述：graphInputs 是外层作用域——内层调用不把外层的记录清掉', async () => {
    const fam = libraryFamily();
    const adapter = {
        async listFamilies() { return [{ familyId: 'f1', name: CHAT }, { familyId: 'f2', name: '幽灵家族' }]; },
        async loadFamily({ familyId, chatKey } = {}) {
            if (familyId != null) return familyId === 'f1' ? { ...fam, keyBindings: {} } : null;
            return chatKey === fam.chatKey ? { ...fam, keyBindings: {} } : null;
        },
        async loadFloors() { return { floors: fam.rows, hasMore: false }; },
    };
    const li = createLibrarySource({ character: () => CHAR, adapter });
    const g = await li.graphInputs();
    assert.equal(g.sessions.length, 1);
    const d = li.describe();
    assert.equal(d.fidelity, 'partial');
    assert.match(d.notes.join('|'), /幽灵家族.*读不到/);         // 枚举阶段（内层 listSessions）记的没被清掉
    assert.match(d.notes.join('|'), /^库源/);
    assert.equal(d.notes.filter((n) => n.startsWith('库源')).length, 1);   // 自述不重复堆叠
});
