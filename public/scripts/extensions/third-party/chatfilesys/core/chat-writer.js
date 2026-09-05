/**
 * ChatFilesys — 写路径封装（官方消息 API 适配层，2.4 迁移后零弃用调用）
 *
 * 官方 API（research/brainstorm-0905/79-luker-chat-and-state.md + 2026-09-06 宿主实测，
 * tests/e2e/probe_writer_api*.py，事实回写 design.md「二期实测事实」）：
 * - ctx.deleteMessages(indices, { silent? })   批量升序原始索引自动偏移；返回被删对象
 * - ctx.addMessages(messages, { silent? })     尾段顺序追加；返回新索引；swipes 字段透传
 * - ctx.updateMessages(updates, { silent? })   patch 为顶层字段整替换（非深合并）；批量一次持久化
 * - 持久化自动携带当前内存 chat_metadata → setModel 后调用即「ops + metadata 同车」
 * - silent: true 仅抑制事件，照常落盘（结构操作避免事件风暴，UI 刷新由调用方调度）
 * - integrity 冲突由核心内部消化（resolveChatWriteConflict），调用方不感知 409，写入最终收敛
 */

/**
 * patch 操作的消息路径方案——已按实例源码定案（public/script.js updateMessages/
 * patchChatMessagesInternal）：operations 直接作用于消息数组，路径为 "/<index>"（可再挂字段段）。
 */
export function bodyPath(index, field) {
    return `/${index}${field ? '/' + field : ''}`;
}

/**
 * 本地应用 RFC6902 操作（op 语义基准；单测用它模拟官方 API 的内存效果）。
 * doc 为消息数组本身（路径 "/<index>" 直接作用于数组根；也兼容嵌套对象路径）。
 *
 * 支持 op：test / add / replace / remove（数组：add 按索引插入、'-' 追加、remove 后续前移）。
 */
export function applyOperationsLocally(doc, operations) {
    const decodeTokens = (path) =>
        path.split('/').filter((s) => s.length > 0).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));

    const locate = (path) => {
        const tokens = decodeTokens(path);
        if (tokens.length === 0) throw new Error(`applyOperationsLocally: 空路径`);
        let container = doc;
        for (let i = 0; i < tokens.length - 1; i++) {
            const t = tokens[i];
            container = Array.isArray(container) ? container[Number(t)] : container[t];
            if (container === undefined || container === null) throw new Error(`applyOperationsLocally: 路径不存在 "${path}"`);
        }
        return { container, last: tokens[tokens.length - 1] };
    };
    const read = ({ container, last }) => (Array.isArray(container) ? container[Number(last)] : container[last]);

    for (const op of operations || []) {
        switch (op.op) {
            case 'test': {
                if (JSON.stringify(read(locate(op.path))) !== JSON.stringify(op.value)) {
                    throw new Error(`applyOperationsLocally: test 失败 @ ${op.path}`);
                }
                break;
            }
            case 'add': {
                const tokens = decodeTokens(op.path);
                const last = tokens[tokens.length - 1];
                const container = tokens.length >= 2
                    ? tokens.slice(0, -1).reduce((n, t) => (Array.isArray(n) ? n[Number(t)] : n[t]), doc)
                    : doc;
                if (Array.isArray(container)) {
                    if (last === '-') container.push(op.value);
                    else container.splice(Number(last), 0, op.value);
                } else {
                    container[last] = op.value;
                }
                break;
            }
            case 'replace': {
                const { container, last } = locate(op.path);
                if (Array.isArray(container)) {
                    const i = Number(last);
                    if (!Number.isInteger(i) || i < 0 || i >= container.length) {
                        throw new Error(`applyOperationsLocally: 数组索引越界 @ ${op.path}`);
                    }
                    container[i] = op.value;
                } else {
                    container[last] = op.value;
                }
                break;
            }
            case 'remove': {
                const { container, last } = locate(op.path);
                if (Array.isArray(container)) {
                    const i = Number(last);
                    if (!Number.isInteger(i) || i < 0 || i >= container.length) {
                        throw new Error(`applyOperationsLocally: 数组索引越界 @ ${op.path}`);
                    }
                    container.splice(i, 1);
                } else {
                    delete container[last];
                }
                break;
            }
            default:
                throw new Error(`applyOperationsLocally: 不支持的 op "${op.op}"`);
        }
    }
    return doc;
}

const pathTokens = (path) => String(path || '').split('/').filter((s) => s.length > 0);

/**
 * 创建写入口（官方消息 API 封装）。依赖注入以便单测：
 * @param {object} io
 * @param {function} io.deleteMessages  (index|number[], options?) => Promise
 * @param {function} io.addMessages     (messages, options?) => Promise<number|number[]>
 * @param {function} io.updateMessages  (updates, options?) => Promise
 */
export function createChatWriter({ deleteMessages, addMessages, updateMessages } = {}) {
    if (typeof deleteMessages !== 'function') throw new Error('createChatWriter: deleteMessages 必填');
    if (typeof addMessages !== 'function') throw new Error('createChatWriter: addMessages 必填');
    if (typeof updateMessages !== 'function') throw new Error('createChatWriter: updateMessages 必填');

    /**
     * 执行结构操作（projection 生成的 RFC6902 子集）→ 官方消息 API 批量调用。
     *
     * 映射（保持「ops + metadata 同车」：官方持久化自动携带当前内存 chat_metadata）：
     * - remove → 一次 deleteMessages（升序原始索引，官方自动偏移）
     * - add    → 一次 addMessages（尾段顺序追加；调用方保证 add 位于删除后的尾段）
     * - replace → 一次 updateMessages（按索引分组合并为 patch 批量）
     * 形态不合（add 不连续、test op 等）直接抛错，拒绝静默错写。
     *
     * @param {Array} operations
     * @param {{silent?: boolean}} [options] silent 透传（抑制事件、照常持久化）
     * @returns {Promise<{removed: number, added: number, updated: number}>}
     */
    async function applyOperations(operations, { silent = true } = {}) {
        if (!Array.isArray(operations)) throw new Error('applyOperations: operations 必须为数组');

        const removeIdx = [];
        const adds = [];
        const replaces = [];
        for (const op of operations) {
            const tokens = pathTokens(op.path);
            if (op.op === 'remove' && tokens.length === 1) {
                const i = Number(tokens[0]);
                if (!Number.isInteger(i) || i < 0) throw new Error(`applyOperations: 非法 remove 索引 @ ${op.path}`);
                removeIdx.push(i);
            } else if (op.op === 'add' && tokens.length === 1) {
                // "/<index>"（含 "-" 追加形态）；本扩展只生成显式索引
                adds.push({ index: tokens[0] === '-' ? null : Number(tokens[0]), value: op.value });
            } else if (op.op === 'replace' && tokens.length === 2) {
                replaces.push({ index: Number(tokens[0]), field: tokens[1], value: op.value });
            } else if (op.op === 'replace' && tokens.length === 1) {
                replaces.push({ index: Number(tokens[0]), field: null, value: op.value });
            } else {
                throw new Error(`applyOperations: 不支持的操作形态 ${op.op} @ ${op.path}`);
            }
        }

        let removed = 0;
        let added = 0;
        let updated = 0;

        if (removeIdx.length > 0) {
            removeIdx.sort((a, b) => a - b);
            await deleteMessages(removeIdx, { silent });
            removed = removeIdx.length;
        }

        if (adds.length > 0) {
            // 尾段顺序追加契约：索引连续升序；有删除时首增索引必须等于最小删除索引
            // （本扩展的 remove 恒为连续尾段 [k..curMax-1]，删除后长度 = k）
            let prev = null;
            for (const a of adds) {
                if (a.index !== null && prev !== null && a.index !== prev + 1) {
                    throw new Error(`applyOperations: add 索引不连续（${prev} → ${a.index}）`);
                }
                prev = a.index;
            }
            if (removeIdx.length > 0 && adds[0].index !== removeIdx[0]) {
                throw new Error(`applyOperations: add 起始索引 ${adds[0].index} ≠ 删除后长度 ${removeIdx[0]}`);
            }
            await addMessages(adds.map((a) => a.value), { silent });
            added = adds.length;
        }

        if (replaces.length > 0) {
            const byIndex = new Map();
            for (const r of replaces) {
                if (!Number.isInteger(r.index) || r.index < 0) throw new Error(`applyOperations: 非法 replace 索引`);
                const patch = byIndex.get(r.index) || {};
                if (r.field === null) Object.assign(patch, r.value);
                else patch[r.field] = r.value;
                byIndex.set(r.index, patch);
            }
            await updateMessages([...byIndex.entries()].map(([index, patch]) => ({ index, patch })), { silent });
            updated = replaces.length;
        }

        return { removed, added, updated };
    }

    return { applyOperations };
}
