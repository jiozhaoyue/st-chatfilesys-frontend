/**
 * ChatFilesys — 库源（`librarySource`，`pure` / `mirror` 模式）：读库内家族/楼层/变体/分支
 *
 * 与文件源**同形产出**，只是数据从库里来（prd.md R4/R5，design.md §2.2）：
 * - 会话枚举：列家族（经既有 `core/storage/adapter.js`，**不改适配器契约**）。
 *   一个家族给一份引用（家族主键）；家族有多个键绑定（原生分支/检查点键）时**每个键一份引用**
 * - 读一个会话：按**该键所在分支**投影出消息序列 —— 复用既有单点，
 *   不另写一套按键解析：
 *     · `core/takeover.js#branchIdForKey`（键绑定优先、回落家族活跃分支）
 *     · `core/patch-rows.js#projectionOf`（分支 path → 行表投影；接缝读路径与双写落盘同源）
 *   结果**与宿主在该键上看到的内容一致**。
 * - `branches`：家族模型（B2 建图直接用，不必像 TL 那样从「同深度相同消息」反推分支结构）
 * - 群聊标记（`kind='group'`）与文件源同一口径：**只认调用方给的枚举层钩子** `deps.isGroup(fileName)`，
 *   库里没有群聊字段，本层不猜（钩子缺省即「都是家族键」；读到群聊会读空 + 记 note，L0-11 仍成立）
 * - 库内行坏掉时（`projectionOf` 静默跳过）**本层自己记账**：分支有几层 vs 投影出几行，差一条就置 `partial`
 *   （`core/patch-rows.js` 是既有单点，R8 不动它）
 *
 * 不缓存（design.md §4：缓存是 B2 的事）：每次调用都真读，先把「读得对」立住。
 */

import { branchIdForKey } from '../takeover.js';
import { projectionOf } from '../patch-rows.js';
import { OWN_EXTENSION_KEY } from '../chat-meta.js';
import { normIntegrity } from '../integrity.js';
import { normalizeMessage } from './normalize.js';
import { createSourceNotes } from './notes.js';

/** 楼层行一次读全（Authority 档直传 SQL 参数，不能用 Infinity——同 `index.js` 的 1e9 先例） */
const FLOOR_LIMIT = 1e9;

/** 纯对象判定 */
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 聊天键里的文件名部分（`avatar::文件名` → `文件名`），与文件源的 `name` 同形 */
const nameOfKey = (key) => String(key || '').split('::').pop();

/**
 * 创建库源。
 *
 * @param {import('./types.js').ChatSourceDeps} [deps] `deps.adapter` 必需（缺省/抛错一律静默降级）
 * @returns {import('./types.js').ChatSource}
 */
export function createLibrarySource(deps = {}) {
    const log = deps.log ?? console.warn;
    const notes = createSourceNotes({
        log,
        hint: '库源（pure / mirror）：列出的是**已入库的家族及其绑定键**——磁盘上尚未导入的'
            + '文件（含原生分支/检查点文件）不在此列。两档条目数不同不是错，是来源不同',
    });
    const adapter = deps.adapter;
    const characterOf = typeof deps.character === 'function' ? deps.character : () => ({});
    /** 群聊标记**只认枚举层钩子**（与文件源同一口径）：宿主群聊住另一端点/目录，
     * 库里没有群聊字段，本层不猜；未提供钩子 → 一律 `family-member` */
    const isGroupOf = typeof deps.isGroup === 'function' ? deps.isGroup : () => false;

    /** 家族 → 一份引用（`id === key`，与文件源同源同值 → 可直接比对键集合） */
    function refOf(family, key) {
        // 主键用家族名（建档时就是它的文件名，保留磁盘上的大小写）；绑定键用键自己的文件名部分
        // （键已被 `normalizeChatKey` 小写化——那是全仓的键归一规则，不是本层的取舍）
        const name = key === family?.chatKey && family?.name ? family.name : nameOfKey(key);
        return {
            id: key,
            key,
            characterId: family?.characterId ?? (characterOf() || {}).characterId ?? '',
            name,
            kind: isGroupOf(name) ? 'group' : 'family-member',
            origin: 'library',
        };
    }

    /** 家族 → 建图骨架（家族/分支结构是库源的原生一等公民） */
    function branchModelOf(family) {
        return {
            familyId: family?.familyId ?? null,
            chatKey: family?.chatKey ?? null,
            name: family?.name ?? '',
            model: family?.model ?? null,
        };
    }

    /**
     * 会话聊天头（与宿主经接缝读该键时看到的那份**同形**）：家族保留的聊天头整份 + 版本号
     * + `extensions.chatfilesys` 模型视图（文件源里这份模型就住在文件头的同一位置）；
     * 键级的 `main_chat`（原生分支/检查点键的父线索）按键回显——它属于那个键，不进家族级。
     */
    function headerOf(family, chatKey) {
        const host = isObj(family?.hostMetadata) ? family.hostMetadata : {};
        const meta = {
            ...host,
            // 版本号必须过 `normIntegrity`（**单点** = `core/integrity.js`）：库内历史行可能是数字，
            // 而宿主经接缝看到的是 `normIntegrity` 出来的字符串——不过这一步两档就不同形（R5）
            integrity: normIntegrity(family?.integrity),
            extensions: { ...(host.extensions || {}), [OWN_EXTENSION_KEY]: family?.model ?? null },
        };
        const bound = chatKey != null ? family?.keyBindings?.[chatKey] : null;
        if (bound?.mainChat) meta.main_chat = bound.mainChat;
        return { user_name: 'unused', character_name: 'unused', chat_metadata: meta };
    }

    const emptySession = (ref) => ({ ref: ref ? { ...ref } : null, header: {}, messages: [] });

    async function listSessions() {
        return await notes.scope(async () => notes.guard('枚举库内家族', [], async () => {
            const characterId = (characterOf() || {}).characterId;
            const fams = await adapter.listFamilies({ characterId });
            const out = [];
            for (const item of fams || []) {
                const family = await loadFamilySafe(item?.familyId, item);
                if (!family) continue;
                if (!family.chatKey) {
                    // schema 破坏（家族没有主键）：产出 `key=undefined` 的引用比跳过更糟——
                    // 上层会拿到一堆同 id 的假条目，且 `fidelity` 还会谎报 full
                    notes.note(`家族「${family?.name || item?.name || item?.familyId}」没有 chatKey`
                        + '（库内 schema 不完整，已从列表跳过）', { partial: true });
                    continue;
                }
                out.push(refOf(family, family.chatKey)); // 家族主键（= 这个聊天本身）
                for (const key of Object.keys(family.keyBindings || {})) {
                    if (key === family.chatKey) continue; // 主键不重复列
                    out.push(refOf(family, key)); // 原生分支/检查点键各一份引用
                }
            }
            return out;
        }));
    }

    /** 单个家族读取：失败只记一条并返回 null（一个家族坏掉不拖垮整个列表） */
    async function loadFamilySafe(familyId, item) {
        try {
            const family = await adapter.loadFamily({ familyId });
            if (!family) {
                notes.note(`家族「${item?.name || familyId}」读不到（已从列表跳过）`, { partial: true });
                return null;
            }
            return family;
        } catch (e) {
            notes.note(`家族「${item?.name || familyId}」读取失败（已从列表跳过）：${e?.message || e}`, { partial: true });
            return null;
        }
    }

    async function readSession(ref) {
        const fallback = emptySession(ref);
        return await notes.scope(async () => notes.guard(`读取会话「${ref?.name || ref?.key}」`, fallback, async () => {
            // 群聊**不接管**（与文件源同一口径）：降级为空，不猜内容
            if (ref?.kind === 'group') {
                notes.note(`会话「${ref?.name || ref?.key}」是群聊（不接管），按空会话处理`, { partial: true });
                return fallback;
            }
            const family = await adapter.loadFamily({ chatKey: ref?.key });
            if (!family) {
                notes.note(`会话「${ref?.key}」不在库中（未入库或已删），按空会话处理`, { partial: true });
                return fallback;
            }
            const { floors } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: FLOOR_LIMIT });
            // 按键解析分支 = 单点（seam / mirror 同一套语义）；再按该分支 path 投影出行序列
            const branches = family.model?.branches || [];
            const branch = branches.find((b) => b.id === branchIdForKey(family, ref?.key)) || branches[0] || null;
            if (!branch) {
                notes.note(`会话「${ref?.key}」的家族没有分支结构（模型缺失），按空会话处理`, { partial: true });
                return { ref: { ...ref }, header: headerOf(family, ref?.key), messages: [], branches: branchModelOf(family) };
            }
            const expected = Object.keys(branch.path || {}).length; // 分支应有几层
            const projected = projectionOf(branch.path, floors);    // `projectionOf` 对坏行/缺行是**静默跳过**
            if (projected.length < expected) {
                // 本层自己记账（`core/patch-rows.js` 是既有单点，R8 不动它）：
                // 分支 path 说有几层、库里只投影出几行 → 差的那几条必须说出来，否则 `fidelity` 谎报 full
                notes.note(`会话「${ref?.key}」的库内行不齐：分支有 ${expected} 层、库里只读到 `
                    + `${projected.length} 行（缺行已跳过）`, { partial: true });
            }
            const messages = [];
            for (const line of projected) {
                const msg = normalizeMessage(line);
                if (msg) messages.push(msg);
                else notes.note(`会话「${ref?.key}」有 1 行不可解析（已跳过）`, { partial: true });
            }
            return {
                ref: { ...ref },
                header: headerOf(family, ref?.key),
                messages,
                branches: branchModelOf(family),
            };
        }));
    }

    async function graphInputs() {
        // 外层作用域：下面的 listSessions / readSession 是内层调用，不会把本次记录清掉
        return await notes.scope(async () => {
            const sessions = [];
            const branches = []; // 家族模型：每个家族一份（B2 建图骨架）
            for (const ref of await listSessions()) {
                const session = await readSession(ref);
                sessions.push(session);
                const b = session?.branches;
                if (b && !branches.some((x) => x.familyId === b.familyId)) branches.push(b);
            }
            return { sessions, branches };
        });
    }

    function describe() {
        return { tier: 'library', fidelity: notes.fidelity(), notes: notes.list() };
    }

    return { listSessions, readSession, graphInputs, describe };
}
