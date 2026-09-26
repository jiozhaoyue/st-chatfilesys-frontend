/**
 * ChatFilesys — 文件源（`jsonlSource`，`off` 模式）：直接扫磁盘 jsonl 的 ChatSource 实现
 *
 * **为什么必须绕开宿主端点语义**（父任务 design.md §1.1，本任务 R3）：
 * 装了接缝之后，`/api/chats/get` 返回的是「**本键所在分支的投影**」，不是「该会话文件的
 * 全部消息」——两者语义不同。消费层（图 / 检索 / 大纲 / 看板…）要的是**文件事实**，
 * 故本实现一律经**原生通道**（`deps.nativeFetch`，调用方传 `seam.native`）读磁盘，
 * 绝不经过接缝；`off` 模式下接缝本就没装，缺省的 `globalThis.fetch` 就是原生通道。
 * **库模式下必须显式注入**——那时缺省的 `fetch` 就是接缝本身（会读到投影而非磁盘事实），
 * 这种情况本层不抛错（L0-11），但会在每次 `describe().notes` 里记一条并把保真度置 `partial`。
 *
 * - 会话枚举：原生 `/api/chats/search`（宿主的**磁盘枚举**；候选过滤复用 `importer#planImport`
 *   单点——剔除本插件的库隐容器 `__cfsys__`，那些不是聊天）
 * - 读一个会话：原生 `/api/chats/get` 的 `[header, ...行]`；坏行跳过并记入 notes
 *   （不并进父会话：宿主原生「创建分支 / 创建检查点」落下的文件是**独立会话**，
 *   `kind='branch-file'`；合不合并留给建图策略 B2 决定）
 * - 群聊标记（`kind='group'`）**只认调用方给的枚举层钩子** `deps.isGroup(fileName)`：
 *   宿主 `/api/chats/search` 的条目里没有群聊字段（群聊住另一端点/目录），本层不猜宿主契约，
 *   钩子缺省即「都是普通聊天」（读到群聊时会读空 + 记 note，L0-11 仍成立）
 */

import { planImport } from '../importer.js';
import { normMode } from '../mode.js';
import { normalizeChatKey } from '../seam.js';
import { BRANCH_NAME_RE, CHECKPOINT_NAME_RE } from '../takeover.js';
import { splitSessionRows } from './normalize.js';
import { createSourceNotes } from './notes.js';

/** 文件名主体（去 `.jsonl`） */
const bareName = (name) => String(name || '').replace(/\.jsonl$/i, '');

/** 聊天键里的文件名部分（`avatar::文件名` → `文件名`） */
const fileNameOfKey = (key) => String(key || '').split('::').pop();

/**
 * 磁盘条目的会话类型：宿主原生「创建分支 / 创建检查点」落下的派生文件是独立会话，
 * 其余是普通聊天（群聊由枚举层钩子标出，见 `deps.isGroup` 说明）。
 * @param {string} fileName
 * @returns {'chat'|'branch-file'}
 */
function fileKind(fileName) {
    const n = bareName(fileName);
    return BRANCH_NAME_RE.test(n) || CHECKPOINT_NAME_RE.test(n) ? 'branch-file' : 'chat';
}

/**
 * 创建文件源。
 *
 * @param {import('./types.js').ChatSourceDeps} [deps]
 * @returns {import('./types.js').ChatSource}
 */
export function createJsonlSource(deps = {}) {
    const log = deps.log ?? console.warn;
    const characterOf = typeof deps.character === 'function' ? deps.character : () => ({});
    const injectedNative = typeof deps.nativeFetch === 'function';
    const nativeFetch = injectedNative ? deps.nativeFetch : (...a) => globalThis.fetch(...a);
    const headers = typeof deps.headers === 'function' ? deps.headers : () => ({ 'Content-Type': 'application/json' });
    /** 群聊标记**只认枚举层钩子**：宿主 `/api/chats/search` 的条目里没有群聊字段
     *（群聊住另一端点/目录），本层不猜宿主契约；未提供钩子 → 一律 `chat` */
    const isGroupOf = typeof deps.isGroup === 'function' ? deps.isGroup : () => false;

    const notes = createSourceNotes({
        log,
        hint: '文件源（off）：枚举与读取都直接落在磁盘 jsonl 上（原生通道），不经宿主端点——'
            + '绕过接缝把 `/api/chats/get` 返回成「本键所在分支的投影」的语义差异',
        // 源的性质（不是某次调用的问题）：缺省 `fetch` 在库模式下就是接缝 → 每次调用都要说清
        sticky: injectedNative || normMode(deps.mode) === 'off' ? [] : [{
            msg: `未显式注入原生通道（\`nativeFetch\`），而当前存储模式是「${normMode(deps.mode)}」：`
                + '缺省的 `fetch` 可能已被接缝接管——读到的可能是「本键所在分支的投影」，不是磁盘原文',
            partial: true,
        }],
    });

    /** 枚举磁盘聊天文件（原生端点；宿主 `displayPastChats` 先例：空 query） */
    async function listChatFiles() {
        const c = characterOf() || {};
        const res = await nativeFetch('/api/chats/search', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ query: '', avatar_url: c.avatarUrl }),
        });
        if (!res?.ok) throw new Error(`/api/chats/search HTTP ${res?.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    /** 读一个聊天文件（原生端点）：返回 `[header, ...行]`；读不到返回 null */
    async function readChatFile(fileName) {
        const c = characterOf() || {};
        const res = await nativeFetch('/api/chats/get', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ ch_name: c.name, file_name: bareName(fileName), avatar_url: c.avatarUrl }),
        });
        if (!res?.ok) return null;
        const data = await res.json();
        return Array.isArray(data) ? data : null;
    }

    /** 一个文件 → 一条引用（`id === key`，两档同源同值 → 可直接比对） */
    function refOf(fileName, kind) {
        const c = characterOf() || {};
        const key = normalizeChatKey(c.avatarUrl, fileName);
        return {
            id: key,
            key,
            characterId: c.characterId ?? '',
            name: fileName,
            kind,
            origin: 'file',
        };
    }

    const emptySession = (ref) => ({ ref: ref ? { ...ref } : null, header: {}, messages: [] });

    async function listSessions() {
        return await notes.scope(async () => notes.guard('枚举聊天文件', [], async () => {
            const listing = await listChatFiles();
            // 候选过滤单点 = importer#planImport（本插件的库隐容器不是聊天）。
            // `includeCurrent: true`：本层是「有哪些会话」，当前打开的那个当然也在其中。
            const { candidates } = planImport(listing, { includeCurrent: true });
            // 群聊标记**只认枚举层钩子**（`deps.isGroup`）：宿主搜索响应里没有这个字段，
            // 群聊住另一端点/目录——本层不猜宿主契约，钩子缺省即「都是普通聊天」
            return candidates.map(({ fileName }) => (
                refOf(fileName, isGroupOf(fileName) ? 'group' : fileKind(fileName))
            ));
        }));
    }

    async function readSession(ref) {
        const fallback = emptySession(ref);
        return await notes.scope(async () => notes.guard(`读取会话「${ref?.name || ref?.key}」`, fallback, async () => {
            const fileName = bareName(ref?.name || fileNameOfKey(ref?.key));
            if (!fileName) {
                notes.note('会话引用缺少文件名，按空会话处理', { partial: true });
                return fallback;
            }
            // 群聊**不接管**（宿主群聊住 `/api/chats/group/get`，本层不碰）：降级为空，不猜内容
            if (ref?.kind === 'group') {
                notes.note(`会话「${fileName}」是群聊（不接管），按空会话处理`, { partial: true });
                return fallback;
            }
            const data = await readChatFile(fileName);
            if (!data) {
                notes.note(`会话「${fileName}」读不到（原生通道无响应或非数组），按空会话处理`, { partial: true });
                return fallback;
            }
            const { header, messages, skipped, headerSuspect } = splitSessionRows(data);
            if (skipped) {
                notes.note(`会话「${fileName}」有 ${skipped} 行无法解析（已跳过）`, { partial: true });
            }
            if (headerSuspect) {
                // 行为不变（首行仍当 header），只是把「这文件可能少了一行」说出来
                notes.note(`会话「${fileName}」的首行不像聊天头（含 \`mes\` 或缺 \`chat_metadata\`/\`user_name\`），`
                    + '已按聊天头处理', { partial: true });
            }
            return { ref: { ...ref }, header, messages };
        }));
    }

    async function graphInputs() {
        // 外层作用域：下面的 listSessions / readSession 是内层调用，不会把本次记录清掉
        return await notes.scope(async () => {
            const sessions = [];
            for (const ref of await listSessions()) {
                sessions.push(await readSession(ref));
            }
            // 文件源没有家族/分支模型（那是库源给得出的东西）
            return { sessions };
        });
    }

    function describe() {
        return { tier: 'jsonl', fidelity: notes.fidelity(), notes: notes.list() };
    }

    return { listSessions, readSession, graphInputs, describe };
}
