/**
 * ChatFilesys — RFC6902 补丁应用器（纯函数，零依赖）
 *
 * 用途（design.md T0 §1A.3）：宿主的 `chats/meta/patch` 送来的是挂在**整份 chat_metadata**
 * 上的 RFC6902 增量。M1 时期该请求被整包丢弃（只递增版本号），导致其他插件写入的元数据
 * 不生效——本模块就是修这个缺陷的应用器。
 *
 * 语义（RFC6902 / RFC6901 子集，覆盖宿主与插件实际会产生的形态）：
 * - add     ：目标父级必须存在；对象→置值，数组→按下标插入（`-` 表示追加）
 * - remove  ：目标必须存在；对象→删键，数组→按下标删除（后续元素前移）
 * - replace ：目标必须存在；对象→置值，数组→按下标赋值
 * - move    ：先 remove 后 add（下标按移除后的文档解释，与主流实现一致）
 * - copy    ：取源值的深拷贝后 add
 * - test    ：深比较不通过则整批失败
 *
 * 失败策略：**整批原子**——任何一步失败即抛出，调用方负责「不写入」。
 * 本模块不碰 DOM、不发请求、不读设置。
 */

/** JSON Pointer（RFC6901）→ 路径段数组；根为 "" → [] */
export function parsePointer(pointer) {
    if (pointer === '' || pointer === undefined || pointer === null) return [];
    const p = String(pointer);
    if (p[0] !== '/') throw new Error(`ops-apply: 非法 JSON Pointer "${p}"（须以 / 开头）`);
    return p.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * 路径段数组 → JSON Pointer 字符串（段内 `~` `/` 转义，与 parsePointer 互逆）。
 * 用途：把一条 op 的路径前缀剥掉后重新拼出合法子路径（直接 join 会把段内的 `/` 误当分隔符）。
 */
export function joinPointer(tokens) {
    return (tokens || []).map((t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** 按路径取值；缺失返回 { found: false } */
function getAt(doc, tokens) {
    let cur = doc;
    for (const t of tokens) {
        if (Array.isArray(cur)) {
            const i = toIndex(t, cur.length);
            if (i === null || i >= cur.length) return { found: false };
            cur = cur[i];
        } else if (cur && typeof cur === 'object') {
            if (!Object.prototype.hasOwnProperty.call(cur, t)) return { found: false };
            cur = cur[t];
        } else {
            return { found: false };
        }
    }
    return { found: true, value: cur };
}

/** 数组下标解析：仅接受规范十进制（RFC6902 禁止前导零） */
function toIndex(token, len) {
    if (token === '-') return len; // 追加位
    if (!/^(0|[1-9]\d*)$/.test(String(token))) return null;
    return Number(token);
}

function parentOf(doc, tokens) {
    if (!tokens.length) return { parent: null, key: null };
    const { found, value } = getAt(doc, tokens.slice(0, -1));
    if (!found) throw new Error(`ops-apply: 父级路径不存在 "/${tokens.slice(0, -1).join('/')}"`);
    return { parent: value, key: tokens[tokens.length - 1] };
}

/** 深比较（JSON 语义）：`test` op 与变体身份判定共用 */
export function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const deepCopy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function addAt(doc, tokens, value) {
    if (!tokens.length) throw new Error('ops-apply: add 到根（""）不支持——调用方应整份替换');
    const { parent, key } = parentOf(doc, tokens);
    if (Array.isArray(parent)) {
        const i = toIndex(key, parent.length);
        if (i === null || i > parent.length) throw new Error(`ops-apply: add 数组下标非法 "${key}"`);
        parent.splice(i, 0, value);
        return;
    }
    if (parent && typeof parent === 'object') {
        parent[key] = value;
        return;
    }
    throw new Error(`ops-apply: add 目标父级不是容器（"/${tokens.slice(0, -1).join('/')}"）`);
}

function removeAt(doc, tokens) {
    if (!tokens.length) throw new Error('ops-apply: remove 根不支持');
    const { parent, key } = parentOf(doc, tokens);
    if (Array.isArray(parent)) {
        const i = toIndex(key, parent.length);
        if (i === null || i >= parent.length) throw new Error(`ops-apply: remove 数组下标越界 "${key}"`);
        parent.splice(i, 1);
        return;
    }
    if (parent && typeof parent === 'object') {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) {
            throw new Error(`ops-apply: remove 目标不存在 "/${tokens.join('/')}"`);
        }
        delete parent[key];
        return;
    }
    throw new Error(`ops-apply: remove 目标父级不是容器`);
}

function replaceAt(doc, tokens, value) {
    if (!tokens.length) throw new Error('ops-apply: replace 根不支持');
    const { found } = getAt(doc, tokens);
    if (!found) throw new Error(`ops-apply: replace 目标不存在 "/${tokens.join('/')}"`);
    const { parent, key } = parentOf(doc, tokens);
    if (Array.isArray(parent)) {
        const i = toIndex(key, parent.length);
        if (i === null || i >= parent.length) throw new Error(`ops-apply: replace 数组下标越界 "${key}"`);
        parent[i] = value;
        return;
    }
    parent[key] = value;
}

/**
 * 对 `doc` 就地应用一批 RFC6902 操作。
 * **调用方必须传入可写的克隆**（本函数就地修改）；推荐 `applyOpsToObject(clone(x), ops)`。
 *
 * @param {object} doc 目标对象（就地修改）
 * @param {Array<{op: string, path: string, from?: string, value?: any}>} ops
 * @returns {object} 同一个 doc 引用
 * @throws {Error} 任何一步失败（整批原子：已应用的部分不保证回滚，故调用方应在克隆上调用）
 */
export function applyOpsToObject(doc, ops) {
    if (!Array.isArray(ops)) throw new Error('ops-apply: ops 必须是数组');
    for (const raw of ops) {
        if (!raw || typeof raw !== 'object') throw new Error('ops-apply: 非法操作项');
        const { op, path } = raw;
        const tokens = parsePointer(path);
        switch (op) {
            case 'add':
                addAt(doc, tokens, deepCopy(raw.value));
                break;
            case 'remove':
                removeAt(doc, tokens);
                break;
            case 'replace':
                replaceAt(doc, tokens, deepCopy(raw.value));
                break;
            case 'move': {
                const fromTokens = parsePointer(raw.from);
                const { found, value } = getAt(doc, fromTokens);
                if (!found) throw new Error(`ops-apply: move 源不存在 "${raw.from}"`);
                const moving = deepCopy(value);
                removeAt(doc, fromTokens);
                addAt(doc, tokens, moving);
                break;
            }
            case 'copy': {
                const { found, value } = getAt(doc, parsePointer(raw.from));
                if (!found) throw new Error(`ops-apply: copy 源不存在 "${raw.from}"`);
                addAt(doc, tokens, deepCopy(value));
                break;
            }
            case 'test': {
                const { found, value } = getAt(doc, tokens);
                if (!found || !deepEqual(value, raw.value)) {
                    throw new Error(`ops-apply: test 不通过 "/${tokens.join('/')}"`);
                }
                break;
            }
            default:
                throw new Error(`ops-apply: 不支持的操作 "${op}"`);
        }
    }
    return doc;
}
