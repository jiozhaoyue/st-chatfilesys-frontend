/**
 * ChatFilesys — 数据源归一（**纯函数**，可单测；无 DOM / 无网络 / 无适配器依赖）
 *
 * 职责：把两种来源（磁盘 jsonl 行 / 库内楼层行）归一成**同一个 `Message` / `header` 形状**，
 * 让上层消费能力（图 / 检索 / 大纲 / 看板 / Diff / 画廊…）与「数据从哪来」无关
 * （design.md §3，prd.md R5）。
 *
 * 三条规则（design.md §3）：
 * 1. **逐字段保真**：宿主与第三方写进消息里的键**一个不丢**（不做白名单裁剪）；
 *    归一后的**键序**按「标准字段在前、其余按原序在后」固定下来——两档同数据的产出
 *    连 `JSON.stringify` 形态都一致（既有代码里大量用 JSON 串比对，如 `takeover#checkPrefix`）。
 * 2. **缺就不补**：`extra` 与 `swipes` / `swipe_info` / `swipe_id` 缺就不补默认值
 *    （补默认值会污染老数据——与 T7「编辑正文不删 token_count」同一取舍）。
 *    故 `extra` 缺失时**没有** `extra` 键；有单 swipe 的老行也不会凭空长出一个 `swipes` 数组。
 * 3. **不管字段类型**：`mes` 非字符串（历史脏数据/第三方乱写）一律**原样保留**——
 *    字符串化就是改数据；容错是上层的事，本层只保证「是对象」这一条（L0-11：宁缺不崩）。
 */

/** Message 的标准字段顺序（design.md §1 的 `Message` 形状） */
const MESSAGE_FIELDS = ['mes', 'is_user', 'name', 'send_date', 'extra', 'swipes', 'swipe_info', 'swipe_id'];

/** header 的标准字段顺序（宿主 jsonl 首行的标准三件） */
const HEADER_FIELDS = ['user_name', 'character_name', 'chat_metadata'];

/** 纯对象判定（数组/null 都不算） */
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 深拷贝（**保真**：`structuredClone` 保留 `undefined` 值等 JSON 表达不了的东西；
 * 与 `core/projection.js` 同一个克隆手法）。不可克隆（含函数/宿主对象）→ 抛错，
 * 由调用方按「该行不可用」处理。
 */
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * 落一个键（**必须走 defineProperty**）：一行里出现 `__proto__` 时（`JSON.parse` 会把它建成
 * 自有数据键），普通赋值 `out[k] = v` 既不落这个字段、又**换掉输出对象的原型**——
 * 前者丢字段（违反逐字段保真），后者是原型污染。defineProperty 语义与普通赋值等价，
 * 但对 `__proto__` 这类键安全。**不改 `Object.create(null)`**：那会让输出对象的原型不是
 * `Object.prototype`，打挂既有用例里的深比对。
 */
function setKey(out, k, v) {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** 按 `fields` 的顺序把 `raw` 的自有键搬进新对象：有则取、无则不补，未知键原样排在后面 */
function reshape(raw, fields) {
    const out = {};
    for (const k of fields) if (Object.hasOwn(raw, k)) setKey(out, k, clone(raw[k]));
    for (const k of Object.keys(raw)) if (!Object.hasOwn(out, k)) setKey(out, k, clone(raw[k]));
    return out;
}

/**
 * 一行原始消息 → `Message`。
 * @param {unknown} raw 已解析的对象
 * @returns {object|null} 非对象（含数组/null）或不可克隆 → null（调用方记入 notes 并跳过）
 */
export function normalizeMessage(raw) {
    if (!isObj(raw)) return null;
    try {
        return reshape(raw, MESSAGE_FIELDS);
    } catch {
        return null; // 不可克隆的行：跳过，不让整次读取失败
    }
}

/**
 * 一行原始聊天头 → `header`。
 * @param {unknown} raw 已解析的对象
 * @returns {object} 非对象 → `{}`（空文件没有首行，也就没有聊天头）
 */
export function normalizeHeader(raw) {
    if (!isObj(raw)) return {};
    try {
        return reshape(raw, HEADER_FIELDS);
    } catch {
        return {};
    }
}

/** JSON 文本 → 对象（坏行返回 null；数组/标量不是合法聊天行） */
function parseLineText(text) {
    try {
        const v = JSON.parse(text);
        return isObj(v) ? v : null;
    } catch {
        return null;
    }
}

/**
 * 首行**像不像**聊天头。
 *
 * 判据只读参考 `core/seam.js#isHeaderRow`（本模块不 import 它，免得把接缝整份拖进数据源）：
 * 对象、**不带** `mes`、且带 `chat_metadata` 或 `user_name`。
 * 本判定**只用来报警**（记一条 note），绝不改变取值行为——首行永远按 header 处理
 * （`prd.md` §六 之外的行为不在本任务改）。
 */
function looksLikeHeader(row) {
    const obj = typeof row === 'string' ? parseLineText(row) : row;
    return isObj(obj) && !Object.hasOwn(obj, 'mes')
        && (Object.hasOwn(obj, 'chat_metadata') || Object.hasOwn(obj, 'user_name'));
}

/**
 * 行解析（纯函数，design.md §3「行解析」）：
 * 宿主的 `/api/chats/get` 把每行 `JSON.parse` 成对象再回（`importApi().readChatFile` 有实测记录），
 * 而导入旅程拿到的契约是**行字符串**——本函数两种都吃。
 *
 * @param {unknown} raw 一行：JSON 字符串 或 已解析对象
 * @returns {object|null} 对象 → 归一后的 `Message`；坏 JSON / 非对象行 → null
 */
export function messageFromLine(raw) {
    const obj = typeof raw === 'string' ? parseLineText(raw) : raw;
    return normalizeMessage(obj);
}

/**
 * `[header, ...行]` → `{ header, messages, skipped, headerSuspect }`（首行是聊天头，其余是消息）。
 *
 * 坏行**跳过并计数**（design.md §2.1）：一处坏行不该让整个会话读不出来。
 *
 * @param {unknown} rows 宿主 get 响应的数组形态（元素可为字符串或对象）
 * @returns {{header: object, messages: Array<object>, skipped: number, headerSuspect: boolean}}
 *   `headerSuspect` = 首行**不像**聊天头（含 `mes`、或缺 `chat_metadata`/`user_name`）。
 *   此时首行**仍然**被当 header 处理（行为不变），只是让调用方记一条说明——
 *   否则「首行其实是消息」这种文件会静默少一行。
 */
export function splitSessionRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const [head, ...rest] = list;
    const messages = [];
    let skipped = 0;
    for (const row of rest) {
        const msg = messageFromLine(row);
        if (msg) messages.push(msg);
        else skipped += 1;
    }
    const headerSuspect = list.length > 0 && !looksLikeHeader(head);
    return { header: normalizeHeader(head), messages, skipped, headerSuspect };
}
