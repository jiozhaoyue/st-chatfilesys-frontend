/**
 * ChatFilesys — v2 只读计划层（**纯函数**，零存储依赖）
 *
 * 契约：`.trellis/spec/frontend/family-operation-v2.md` §2（Plan）+ design-v2「计划与动作」。
 * 依据 implement-v2 C1.4。本模块把「意图」装配成**可审、可重放、可拒绝**的 Plan：
 * · **预览零写**：不 import 任何适配器 / store / DOM（结构性保证）——计划层根本拿不到写通道；
 *   对输入零改动（先克隆再装配，deepFreeze 的输入照跑）；
 * · **noop 用原始字段精确比较**：canonical JSON 逐值一致才 noop；指纹只配当候选召回，
 *   **正文相同但 header/extra 不同不是 noop**（R1.10：不按相同正文静默折叠元数据差异）；
 * · **operationId 计划阶段生成且稳定**：同输入重计划 → 同 id（幂等键）。同步意图用确定性
 *   FNV 双散列，导入意图用来源摘要派生 —— 它是幂等键，**不是安全边界**（非加密）；
 * · **import-as-branch 与 merge-to-new-branch 显式区分**；被证实的层共享 message/versions
 *   （分支局部选择：新分支自选版本，不暗改别人）；A/B 本身不被覆盖；
 * · **stale-plan**：`verifyPlan` 复核 familyId / baseRevision / 来源行摘要；
 *   来源变了 → 拒绝旧计划，不自动套新数据（spec §4）；
 * · **歧义/坏行不装作完整合并**：歧义层不共享身份（两份都留）+ warnings 如实登记；
 *   无 mes 的合法 JSON 行按 opaque 原样保留（不吞行）。
 */

import { validateFamily, selectVersion, hideVersion, deleteMessage, setManualParent } from './family-state.js';
import { projectBranch } from './family-codec.js';

function fail(code, msg) {
    const e = new Error(`[${code}] ${msg}`);
    e.code = code;
    throw e;
}

/* ---------------- 摘要原语 ---------------- */

/** 规范 JSON：键排序、数组保序 —— 同语义必同串，noop 判定与摘要的单一比较口径 */
export function canonicalJson(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** SHA-256 hex（async；node ≥15 与浏览器都有 crypto.subtle —— core 无 Node 依赖） */
export async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 同步确定性散列（FNV-1a 双种子 64bit hex）—— 只作 operationId 幂等键，非加密 */
function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
const syncHash = (s) => fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01000193);

const PLAN_ACTIONS = Object.freeze(['select-version', 'hide-version', 'delete-message', 'set-manual-parent']);
const IMPORT_MODES = Object.freeze(['import-as-branch', 'merge-to-new-branch']);

/* ---------------- planOperation：状态意图（同步） ---------------- */

/**
 * 状态意图 → Plan（spec §6 契约断言的入口）。
 * @param {object} family
 * @param {{action:string, branchIds?:string[], arguments?:object}} intent
 *   支持动作：select-version / hide-version / delete-message / set-manual-parent
 *   （实义在 `family-state.js` —— 本层只做装配，不重写第二套状态机）。
 * @returns {Plan} nextFamily 已装配；**不写库**。
 */
export function planOperation(family, intent) {
    const v = validateFamily(family);
    if (!v.ok) fail('invalid-reference', `家族结构不合法：${v.paths.join('; ')}`);
    if (!intent || !PLAN_ACTIONS.includes(intent.action)) {
        fail('invalid-reference', `未知操作：${intent?.action}`);
    }
    const args = intent.arguments || {};
    const branchId = intent.branchIds?.[0];
    let nextFamily;
    switch (intent.action) {
        case 'select-version':
            nextFamily = selectVersion(family, branchId, args.messageId, args.versionId);
            break;
        case 'hide-version':
            nextFamily = hideVersion(family, branchId, args.messageId, args.versionId);
            break;
        case 'delete-message':
            nextFamily = deleteMessage(family, branchId, args.messageId);
            break;
        case 'set-manual-parent':
            nextFamily = setManualParent(family, branchId, args.parentBranchId);
            break;
        default:
            fail('invalid-reference', `未知操作：${intent.action}`);
    }
    const opKey = canonicalJson({
        familyId: family.familyId, baseRevision: family.revision,
        action: intent.action, branchIds: intent.branchIds ?? [], arguments: args,
    });
    return {
        operationId: `op-${syncHash(opKey)}`,
        familyId: family.familyId,
        baseRevision: family.revision,
        sourceDigests: { base: family.revision },
        intent: {
            action: intent.action,
            branchIds: [...(intent.branchIds ?? [])],
            arguments: structuredClone(args),
        },
        nextFamily,
        evidence: [{ kind: 'state-op', action: intent.action, branchId, arguments: structuredClone(args) }],
        warnings: [],
    };
}



/* ---------------- planImport：导入/合并意图（async，摘要派生） ---------------- */

/** 新分支 id：避开既有键；`b<max+1>` 风格（与旧模型沿用同一习惯，便于人读） */
function nextBranchIdOf(family) {
    let max = 0;
    for (const id of Object.keys(family.branches)) {
        const m = /^b(\d+)$/.exec(id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `b${max + 1}`;
}

/**
 * 导入意图 → Plan。
 * @param {object} family
 * @param {{header:object, rows:Array<object>, branchName:string,
 *          alignPlan?:object|null, mode?:'import-as-branch'|'merge-to-new-branch',
 *          baseBranchId?:string|null}} args
 *   `alignPlan` = `planFamilyMerge` 产物（verdict 必须 same-family）；缺省 = 不做对齐，
 *   全部行按新消息装配。`baseBranchId` = 对齐的 A 侧分支（缺省 = 活跃分支）。
 * @returns {Promise<Plan>}
 */
export async function planImport(family, {
    header, rows, branchName, alignPlan = null, mode = 'import-as-branch', baseBranchId = null,
} = {}) {
    const v = validateFamily(family);
    if (!v.ok) fail('invalid-reference', `家族结构不合法：${v.paths.join('; ')}`);
    if (!IMPORT_MODES.includes(mode)) fail('invalid-plan', `未知导入模式：${mode}`);
    if (!header || typeof header !== 'object' || !Array.isArray(rows)) {
        fail('invalid-plan', '导入需要 header 与 rows');
    }
    if (alignPlan && alignPlan.verdict !== 'same-family') {
        fail('invalid-plan', `alignPlan 判定为 ${alignPlan.verdict}，不得装配成合并计划`);
    }

    const headerDigest = await sha256Hex(canonicalJson(header));
    const rowsDigest = await sha256Hex(canonicalJson(rows));

    // ── noop 判定：原始字段精确比较（canonical JSON 逐值一致才算）──
    for (const [branchId] of Object.entries(family.branches)) {
        const proj = projectBranch(family, branchId);
        const same = canonicalJson(proj[0]) === canonicalJson(header)
            && proj.length === rows.length + 1
            && rows.every((r, i) => canonicalJson(proj[i + 1]) === canonicalJson(r));
        if (same) {
            return {
                operationId: `op-${syncHash(canonicalJson({
                    familyId: family.familyId, baseRevision: family.revision,
                    action: 'import-noop', headerDigest, rowsDigest, branchId,
                }))}`,
                familyId: family.familyId,
                baseRevision: family.revision,
                sourceDigests: { base: family.revision, header: headerDigest, rows: rowsDigest },
                intent: { action: 'import-noop', branchIds: [branchId], arguments: {} },
                nextFamily: structuredClone(family), // 一字不变
                evidence: [{ kind: 'noop', branchId, headerDigest, rowsDigest }],
                warnings: [],
            };
        }
    }

    // ── 装配：新建分支，被证实的层共享 message/versions ──
    const next = structuredClone(family);
    const newBranchId = nextBranchIdOf(next);
    const baseId = baseBranchId ?? next.activeBranchId
        ?? Object.keys(next.branches).find((id) => next.branches[id]?.isDefault) ?? null;
    const baseEntries = baseId && next.branches[baseId] ? next.branches[baseId].entries : null;
    // A 侧行序列（描述符 idx 的定位空间 = 投影行去 header；与 buildDescriptors 同口径）
    const baseRows = baseId ? projectBranch(family, baseId).slice(1) : [];

    const entries = [];
    const warnings = [];
    let sharedCount = 0;
    let newCount = 0;

    // 有 alignPlan：按 floors 装配；无：全部行按新消息（opaque 规则同口径）
    const floors = alignPlan?.floors ?? rows.map((r, i) => ({ floorNo: i + 1, kind: 'only-b', aIdx: null, bIdx: i }));

    for (const floor of floors) {
        const entryIdx = entries.length; // 新分支内该 entry 的下标（= 它的楼层号-1）
        const incoming = floor.bIdx != null ? rows[floor.bIdx] : null;
        if (floor.kind === 'swipe-merge' && !floor.ambig && floor.aIdx != null
            && baseEntries && baseEntries[floor.aIdx]) {
            // 被证实的同一层：共享 messageId 与版本集合；新分支自选自己的当前版本（分支局部）
            const sharedEntry = baseEntries[floor.aIdx];
            const messageId = sharedEntry.messageId;
            const versions = next.messages[messageId].versions;
            const rawRef = `rw_${newBranchId}_${entryIdx}`;
            next.rawRows[rawRef] = structuredClone(incoming ?? baseRows[floor.aIdx] ?? {});
            // 选版本：incoming 正文与哪个 version.raw 一致（canonical 比较）就选它；
            // 都不一致（理论上 hash/swipe 证据下不该发生）→ 新增版本，不虚构「曾存在」
            let selected = null;
            if (incoming) {
                const incCanon = canonicalJson(incoming);
                for (const [vid, ver] of Object.entries(versions)) {
                    if (canonicalJson(ver.raw) === incCanon) { selected = vid; break; }
                }
            }
            if (!selected) {
                const vid = `v_${messageId}_imp${Object.keys(versions).length}`;
                versions[vid] = {
                    raw: structuredClone(incoming ?? {}),
                    swipeInfo: null,
                    sourceRefs: [`plan:${newBranchId}#floor:${floor.floorNo}`],
                };
                selected = vid;
            }
            entries.push({
                messageId,
                visibleVersionIds: Object.keys(versions),
                selectedVersionId: selected,
                rawRowRef: rawRef,
                dirty: false,
            });
            sharedCount += 1;
            continue;
        }
        // two-groups / only-b / ambig / 无对齐信息：新消息（两份都留；不与既有身份合并）
        if (floor.ambig) {
            warnings.push(`楼层 ${floor.floorNo} 存在歧义（同分多解的并列最优对应），已保留为独立消息，不共享身份`);
        }
        const row = incoming ?? {};
        const mid = `m_${newBranchId}_${entryIdx}`;
        const vid = `v_${mid}_0`;
        next.messages[mid] = {
            versions: {
                [vid]: { raw: structuredClone(row), swipeInfo: null, sourceRefs: [`plan:${newBranchId}#floor:${floor.floorNo}`] },
            },
            ...(typeof row.mes !== 'string' ? { opaque: true } : {}),
        };
        const rawRef = `rw_${newBranchId}_${entryIdx}`;
        next.rawRows[rawRef] = structuredClone(row);
        entries.push({
            messageId: mid,
            visibleVersionIds: [vid],
            selectedVersionId: vid,
            rawRowRef: rawRef,
            dirty: false,
        });
        newCount += 1;
    }

    next.branches[newBranchId] = {
        name: String(branchName ?? newBranchId),
        isDefault: false,
        header: structuredClone(header), // 新分支自己的 header（含未知字段）
        entries,
        extensions: {},
    };
    // derived 谱系：导入副本/合并结果源自 base 分支（不覆盖 manual/inferred）
    if (baseId) {
        const ids = new Set((next.relations || []).map((r) => r?.id));
        let n = (next.relations || []).length + 1;
        let relId;
        do { relId = `rel-d${n}`; n += 1; } while (ids.has(relId));
        next.relations = [...(next.relations || []), {
            id: relId, fromBranchId: newBranchId, toBranchId: baseId,
            kind: 'derived', evidenceRefs: [`plan:${newBranchId}`],
        }];
    }

    const vv = validateFamily(next);
    if (!vv.ok) fail('migrated-invalid', `装配结果不合法：${vv.paths.join('; ')}`);

    const operationId = `op-${syncHash(canonicalJson({
        familyId: family.familyId, baseRevision: family.revision,
        action: mode, headerDigest, rowsDigest, branchName: String(branchName ?? ''),
    }))}`;

    return {
        operationId,
        familyId: family.familyId,
        baseRevision: family.revision,
        sourceDigests: { base: family.revision, header: headerDigest, rows: rowsDigest },
        intent: {
            action: mode,
            branchIds: [newBranchId],
            arguments: {
                branchName: String(branchName ?? ''),
                baseBranchId: baseId,
                alignStats: alignPlan?.stats ? structuredClone(alignPlan.stats) : null,
            },
        },
        nextFamily: next,
        evidence: [
            { kind: 'branch-created', branchId: newBranchId, baseBranchId: baseId },
            { kind: 'floor-assembly', shared: sharedCount, new: newCount },
        ],
        warnings,
    };
}

/* ---------------- verifyPlan ---------------- */

/**
 * 复核计划是否仍然适用于当前家族与来源（spec §4：来源或目标变化 → stale-plan）。
 * @param {Plan} plan
 * @param {object} family 当前家族
 * @param {{header?:object, rows?:Array<object>}} [source] 来源快照（提供则复核摘要）
 * @returns {Promise<{ok:true}|{ok:false, code:'stale-plan'}>}
 */
export async function verifyPlan(plan, family, source = null) {
    if (!plan || plan.familyId !== family?.familyId || plan.baseRevision !== family?.revision) {
        return { ok: false, code: 'stale-plan' };
    }
    if (source) {
        if (source.rows && plan.sourceDigests.rows !== undefined) {
            const d = await sha256Hex(canonicalJson(source.rows));
            if (d !== plan.sourceDigests.rows) return { ok: false, code: 'stale-plan' };
        }
        if (source.header && plan.sourceDigests.header !== undefined) {
            const d = await sha256Hex(canonicalJson(source.header));
            if (d !== plan.sourceDigests.header) return { ok: false, code: 'stale-plan' };
        }
    }
    return { ok: true };
}
