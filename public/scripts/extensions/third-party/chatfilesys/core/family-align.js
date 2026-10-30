/**
 * ChatFilesys — 智能家族合并（**纯函数层**）
 *
 * 一句话：吃两份聊天的行序列，判「是不是同一段历史」，并在是的时候产出**逐层可解释**的归并方案。
 *
 * ── 本模块只出方案，不写任何状态 ──
 * 不 import 适配器 / store / DOM / 网络（`L1-MR-6` 的同构要求，可 100% 单测）。
 * 落库由既有链路走（`branch-merge.js` 出 path → `index.js` 的 `createBranchWithPath`）。
 *
 * ── 判据的每一条都有真实语料支撑，改动前先读设计 ──
 * `.trellis/tasks/09-29-fuzzy-family-merge/design.md`（§3 代价表 / §4 管线 / §5 雷区 L1–L28 /
 * §7 标定结果）。标定工具：`tests/e2e/calibrate_family_align.py` —— **改判据必须同步改它**，
 * 否则标定数字与实现会静默漂移。
 *
 * ── 三条「不许」（实测得来，违反即已证伪的错） ──
 * 1. **不许整行全等**比两层：同一层在不同快照里字段集合完全不同。
 * 2. **不许用 `send_date` / 文件名 / `chat_id_hash` / 名称相似度**当身份（逐条实测失败）。
 * 3. **`gap` 必须严格小于 `mismatch` 的两倍**：否则 DP 宁配不删，任何「匹配数上限」类判据
 *    都会退化成「中段有多长」（互检 A · H1：原设计在 19503 个真实 pair 上 recall = 0）。
 */

import { computeHash, normalizeText } from './merge.js';

/** cost 0.0 要求的最小归一化长度。挡 `''` / `'…'` / `'*沉默*'` 这类无区分度短行。 */
export const MIN_EVIDENCE_LEN = 8;

/** 对齐代价三档。**必须严格有序**：MATCH < GAP < MISMATCH < 2×GAP（见文件头第 3 条）。 */
export const COST = Object.freeze({ MATCH: 0, GAP: 1, MISMATCH: 1.5 });

/** 判据阈值。数值来源见 `design.md` §7.1（真实语料标定，不是拍的）。 */
export const LIMITS = Object.freeze({
    n0Ratio: 0.30,     // (1) 精确同层数 ≥ 30% × 较短一方
    n0Floor: 3,        // (1) 且不少于 3 层
    minFloors: 3,      // (2) 双方各 ≥ 3 层
    minMaxRatio: 0.25, // (2) 长度比不足则降级 uncertain（不是 different）
    maxFloors: 2000,   // 性能护栏：超过则判 uncertain，不做 O(n·m) 对齐
});

/** 该 hash 是否够格当证据（长度门槛只对**行正文**施加；swipe 条目在构造时已各自施过） */
const strong = (d) => d.len >= MIN_EVIDENCE_LEN;

/**
 * 两层的关系。
 *
 * 判据是**集合运算**（不是相似度打分）。三条前置条件缺一不可：
 * ① `hash` 相等那条要过长度门槛；② `swipeHashes` 构造时排除空与短条目；
 * ③ **swipe 通道必须有一方是「当前正文」**（见下）。
 *
 * ⚠️ **swipe 通道已收紧（2026-09-29，用户裁定 D1+D2 一并修；`design.md` §3.1 更正记录）**：
 * 改前是「两侧 `swipeHashes` **有交集**即判同层」，实测两处都错，且二者互相掩盖：
 * · **D1 假阴性**：预筛只数**当前正文** hash 的多重集交集，而 `n0` 还计 swipe 通道的命中
 *   ⇒ 「预筛是 `n0` 的上界」这条不变式**不成立**。真实形态「A 的当前正文 == B 的旧 swipe」
 *   （宿主用 swipe 表达同层多版本，正是本功能存在的理由）被它**误杀成 `different`**。
 * · **D2 假阳性**：`MIN_EVIDENCE_LEN=8` 挡不住 9 字的常量 swipe（如 `'开场问候语（F1）'`），
 *   常量让两个**无关**的层「交集非空」得 cost 0.0。改前这点被上面那个不严谨预筛**意外挡住** ——
 *   即 L22b 宣称的那道防线实际并非长度门所提供的。
 * 改成「共享的那份**至少是一方的当前正文**」后两条同时消解：真实形态是
 * 「A 的当前 == B 的旧 swipe」，而**常量** swipe 永远不是任何一方的当前正文，故被自然排除。
 * 代价（如实登记）：**放弃**「双方当前版各不相同、只共有一个旧版本」那类同层证据 ——
 * 那更接近「有共同祖先」而非「同一层」。
 *
 * @param {object} a 描述符
 * @param {object} b 描述符
 * @returns {{cost: number, why: 'hash'|'swipe'|'differ'}}
 */
export function classify(a, b) {
    if (strong(a) && strong(b) && a.hash === b.hash) return { cost: COST.MATCH, why: 'hash' };
    // 收紧口径：只有「a 的当前正文 ∈ b 的版本集」或「b 的当前正文 ∈ a 的版本集」才算同层。
    // 注意 `swipeHashes` 里的条目都已各自过过长度门槛，故这里不必再判长度。
    if (a.swipeHashes.has(b.hash) || b.swipeHashes.has(a.hash)) return { cost: COST.MATCH, why: 'swipe' };
    return { cost: COST.MISMATCH, why: 'differ' };
}

/** 两层是否是「同一层」（cost 0.0） */
export const sameFloor = (a, b) => classify(a, b).cost === COST.MATCH;

/**
 * 行序列 → 描述符序列。
 *
 * `swipes` 的候选集**排除**①空/纯空白 ②短于 `MIN_EVIDENCE_LEN` 的条目——
 * 实例里装着的 `SillyTavernSwipePreviewer`（`swipes.splice` / 赋值）与 `LittleWhiteBox`
 * （赋值）会改写 `swipes`，而真实语料里存在跨文件的常量 swipe 文本（如
 * `'开场问候语（F1）'` 出现在 28 个文件），不排除就会让无关的层假相交。
 *
 * @param {Array<object>} rows 宿主消息行（对象）
 * @returns {Promise<Array<object>>} 描述符
 */
export async function buildDescriptors(rows) {
    const out = [];
    const list = Array.isArray(rows) ? rows : [];
    for (let idx = 0; idx < list.length; idx += 1) {
        const row = list[idx];
        // 只收「有 mes 字符串」的行 —— 与标定脚本同一口径。
        // 宿主 jsonl 里可能出现缺 mes 的行；若放进来会变成一条空正文，凭空制造一层。
        if (!row || typeof row !== 'object' || typeof row.mes !== 'string') continue;
        const hash = await computeHash(row);
        const len = normalizeText(row.mes).length;
        // 「该层的全部版本」= 当前正文 ∪ swipes 候选 —— **必须含当前正文自己**。
        // 为什么必须含：`matchBound` 的 eligible 判据是「a 的当前 ∈ b 的版本集」或
        // 「a 的版本集 ∩ b 的当前」，若版本集漏了当前正文，**正文逐字相等**那种配对
        // （`classify` 的 hash 分支）就数不进 eligible ⇒ 上界塌成 0，两份**完全相同**的聊天
        // 会被预筛误判成 different（假阴性）。它同时支撑「一侧没 swipes、另一侧 swipes 里正装着它」
        // 那一类（宿主用 swipe 表达同层多版本，本模块的核心场景；见 family-align.test.mjs 的 L1/L10）。
        const swipeHashes = new Set();
        if (len >= MIN_EVIDENCE_LEN) swipeHashes.add(hash);
        if (Array.isArray(row.swipes)) {
            for (const s of row.swipes) {
                if (normalizeText(s).length < MIN_EVIDENCE_LEN) continue;
                swipeHashes.add(await computeHash({ name: row.name, is_user: row.is_user, mes: s }));
            }
        }
        out.push({
            idx,
            isUser: Boolean(row.is_user),
            name: row.name ?? null,
            hash,
            len,
            swipeHashes,
            swipeId: Number.isInteger(row.swipe_id) ? row.swipe_id : null,
        });
    }
    return out;
}

/**
 * `n0`（精确同层配对数）的**可靠上界** —— 廉价必要条件预筛。
 *
 * **为什么不是「当前正文 hash 的多重集交集」**（改前口径，`design.md` §3.1 更正记录 D1）：
 * `n0` 还计入 swipe 通道的命中，故那个交集**不是** `n0` 的上界 —— 注释里原有的不变式是错的。
 * 被它误杀的恰是核心场景「A 的当前正文 == B 的旧 swipe」（宿主用 swipe 表达同层多版本）。
 *
 * **可靠上界**（`E(d) = d.swipeHashes`；`HashesX` = 各 `x.hash` 的**多重集**；`AllE(Y) = ∪_y E(y)`）：
 *   eligibleA(i) = (a_i.hash ∈ AllE(B)) || (E(a_i) ∩ HashesB ≠ ∅)
 *   eligibleB(j) = (b_j.hash ∈ AllE(A)) || (E(b_j) ∩ HashesA ≠ ∅)
 *   bound = min(|{i: eligibleA(i)}|, |{j: eligibleB(j)}|)
 *
 * 正确性：任一 MATCH 配对 (i,j) 由 `classify` 只会因三种情形成立 ——
 * hash 相等（此时 `a_i.hash ∈ E(b_j)`）、`a_i.hash ∈ E(b_j)`、或 `b_j.hash ∈ E(a_i)`；
 * 三者都蕴含 `eligibleA(i)` 为真（前两种直接落进 `a_i.hash ∈ AllE(B)`，第三种落进
 * `E(a_i) ∩ HashesB ≠ ∅`）。故「被配对的 a」必是被 eligible 的那些，`#配对 ≤ #eligibleA`；
 * 对 b 同理 ⇒ 取 min 仍为上界。判据 `bound < need ⇒ different` 不变。
 *
 * **附带效果**：常量 swipe（从不是任何一方的当前正文）⇒ `eligibleA ≡ false` ⇒ 上界 0
 * ⇒ 「每层带同一条常量 swipe 的两份无关聊天」被挡在 DP 之外（`design.md` §3.1 更正记录 D2）。
 *
 * @param {Array<object>} a
 * @param {Array<object>} b
 * @returns {number}
 */
export function matchBound(a, b) {
    const hashesA = new Set();
    const hashesB = new Set();
    const allEA = new Set();
    const allEB = new Set();
    for (const d of a) { hashesA.add(d.hash); for (const h of d.swipeHashes) allEA.add(h); }
    for (const d of b) { hashesB.add(d.hash); for (const h of d.swipeHashes) allEB.add(h); }
    let eligibleA = 0;
    for (const d of a) {
        if (allEB.has(d.hash)) { eligibleA += 1; continue; }
        for (const h of d.swipeHashes) { if (hashesB.has(h)) { eligibleA += 1; break; } }
    }
    let eligibleB = 0;
    for (const d of b) {
        if (allEA.has(d.hash)) { eligibleB += 1; continue; }
        for (const h of d.swipeHashes) { if (hashesA.has(h)) { eligibleB += 1; break; } }
    }
    return Math.min(eligibleA, eligibleB);
}

/**
 * 全局对齐（Needleman–Wunsch 变体），跑在**整条序列**上。
 *
 * 统计量天然包含公共前/后缀 —— 这一点是纠错：原设计把统计量的分母取自「去掉公共前后缀之后
 * 的中段」，而中段按定义就是**不匹配**的部分，要求它 30% 精确匹配是结构性自相矛盾
 * （互检 A · H1 实测：真同族的 291 层全等对被一票否掉）。
 *
 * @param {Array<object>} a
 * @param {Array<object>} b
 * @returns {{n0:number, n15:number, gaps:number, path:Array<object>}}
 */
export function align(a, b) {
    const n = a.length;
    const m = b.length;
    const INF = Number.POSITIVE_INFINITY;
    // dp[i][j] = 对齐 a[i..] 与 b[j..] 的最小代价；ptr 记选择：0=配对 1=a 空位 2=b 空位
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
    const ptr = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    dp[n][m] = 0;
    for (let j = m - 1; j >= 0; j -= 1) { dp[n][j] = dp[n][j + 1] + COST.GAP; ptr[n][j] = 2; }
    for (let i = n - 1; i >= 0; i -= 1) { dp[i][m] = dp[i + 1][m] + COST.GAP; ptr[i][m] = 1; }
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            let best = classify(a[i], b[j]).cost + dp[i + 1][j + 1];
            let p = 0;
            const up = COST.GAP + dp[i + 1][j];
            const left = COST.GAP + dp[i][j + 1];
            if (up < best) { best = up; p = 1; }
            if (left < best) { best = left; p = 2; }
            dp[i][j] = best;
            ptr[i][j] = p;
        }
    }
    let i = 0;
    let j = 0;
    let n0 = 0;
    let n15 = 0;
    let gaps = 0;
    const path = [];
    while (i < n && j < m) {
        const p = ptr[i][j];
        if (p === 0) {
            const c = classify(a[i], b[j]);
            if (c.cost === COST.MATCH) n0 += 1; else n15 += 1;
            path.push({ ai: i, bj: j, cost: c.cost, why: c.why });
            i += 1; j += 1;
        } else if (p === 1) {
            gaps += 1; path.push({ ai: i, bj: null, cost: COST.GAP, why: 'gap' }); i += 1;
        } else {
            gaps += 1; path.push({ ai: null, bj: j, cost: COST.GAP, why: 'gap' }); j += 1;
        }
    }
    while (i < n) { gaps += 1; path.push({ ai: i, bj: null, cost: COST.GAP, why: 'gap' }); i += 1; }
    while (j < m) { gaps += 1; path.push({ ai: null, bj: j, cost: COST.GAP, why: 'gap' }); j += 1; }
    return { n0, n15, gaps, path };
}

/** 精确（正文相等且过长度门槛）的连续公共前缀长度 —— 只作报告与祖先证据，不参与判定 */
function commonPrefix(a, b) {
    let k = 0;
    while (k < Math.min(a.length, b.length) && strong(a[k]) && strong(b[k]) && a[k].hash === b[k].hash) k += 1;
    return k;
}

/** 精确的连续公共后缀长度 */
function commonSuffix(a, b) {
    let k = 0;
    while (k < Math.min(a.length, b.length)) {
        const x = a[a.length - 1 - k];
        const y = b[b.length - 1 - k];
        if (!(strong(x) && strong(y) && x.hash === y.hash)) break;
        k += 1;
    }
    return k;
}

/**
 * 装配一份**只读**的归并方案。
 * @param {string} verdict 'same-family' | 'different' | 'uncertain'
 * @param {string|null} reason 判定理由（机器可读短码）
 * @param {object} extra
 */
function buildPlan(verdict, reason, extra = {}) {
    return {
        verdict,
        reason,
        mode: extra.mode ?? null,        // ancestor | identical | diverged
        commonPrefix: extra.commonPrefix ?? 0,
        commonSuffix: extra.commonSuffix ?? 0,
        floors: extra.floors ?? [],
        stats: extra.stats ?? {},
        /** 不可判定时给用户看的候选线索（R1.4：不硬猜，交用户点） */
        candidates: extra.candidates ?? [],
    };
}

/**
 * `main_chat` 的归一化：只去多余空白 + 收尾。
 *
 * **保留时间戳段**（`C5`）：两个不同的导入副本会得到不同的 `main_chat`（各带自己的时间戳），
 * 只取前缀会把不同聊天混为一谈。
 *
 * ⚠️ **结果只作报告，不参与任何判定**（互检 A · M2）：若拿它收紧阈值，「重导入副本」
 * （时间戳必然不同 ⇒ 提示 false）反而会被罚——而那正是 R1.1 要服务的人群。
 */
export function normalizeMainChat(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 判定所需的最小精确同层数 */
const needOf = (n, m) => Math.max(LIMITS.n0Floor, Math.ceil(LIMITS.n0Ratio * Math.min(n, m)));

/**
 * 主入口：判两份聊天是否同族，并产出逐层方案。
 *
 * **任何异常都不抛、不写库**：判不出来就返回 `uncertain` + 理由（`L0-11` 静默降级的精神）。
 *
 * @param {{aRows: Array<object>, bRows: Array<object>,
 *          aMainChat?: string|null, bMainChat?: string|null, log?: Function}} args
 *   `aMainChat`/`bMainChat` 只用来填报告的 `familyHint`，**不参与判定**。
 * @returns {Promise<object>} MergePlan
 */
export async function planFamilyMerge({ aRows, bRows, aMainChat = null, bMainChat = null, log = () => {} } = {}) {
    const nmA = normalizeMainChat(aMainChat);
    const nmB = normalizeMainChat(bMainChat);
    const familyHint = {
        a: nmA || null,
        b: nmB || null,
        matched: Boolean(nmA && nmB && nmA === nmB),
    };
    /** 统一挂上 familyHint（它是**报告字段**，不参与判定；见 normalizeMainChat 的注释） */
    const plan = (verdict, reason, extra = {}) => ({ ...buildPlan(verdict, reason, extra), familyHint });
    let a;
    let b;
    try {
        a = await buildDescriptors(aRows);
        b = await buildDescriptors(bRows);
    } catch (e) {
        log(`描述符构造失败：${e?.message || e}`);
        return plan('uncertain', 'descriptor-failed');
    }
    const n = a.length;
    const m = b.length;

    // (2) 可判性下限：层数太少 / 长度悬殊 ⇒ 交用户，不硬判。
    // 空聊天必须走这里 —— 原设计「CPL == min」在 0 层时会得到 0 == 0 而判成祖先（互检 A · M1）。
    if (n < LIMITS.minFloors || m < LIMITS.minFloors) {
        return plan('uncertain', 'floor-too-few', { stats: { n0: 0, n15: 0, gaps: 0, minLen: Math.min(n, m), maxLen: Math.max(n, m) } });
    }
    if (Math.min(n, m) / Math.max(n, m) < LIMITS.minMaxRatio) {
        return plan('uncertain', 'length-ratio', { stats: { n0: 0, n15: 0, gaps: 0, minLen: Math.min(n, m), maxLen: Math.max(n, m) } });
    }
    if (Math.max(n, m) > LIMITS.maxFloors) {
        return plan('uncertain', 'too-large', { stats: { n0: 0, n15: 0, gaps: 0, minLen: n, maxLen: m } });
    }

    const need = needOf(n, m);
    const bound = matchBound(a, b);
    const base = { need, minLen: Math.min(n, m), maxLen: Math.max(n, m), sharedBound: bound };
    if (bound < need) {
        // 廉价的**必要条件**预筛：`n0` 的可靠上界都不够，不必跑对齐（见 matchBound 的正确性说明）
        return plan('different', 'prefilter', { stats: { n0: 0, n15: 0, gaps: 0, ...base } });
    }

    const al = align(a, b);
    const stats = { n0: al.n0, n15: al.n15, gaps: al.gaps, ...base };

    // (1) 绝对证据下限 —— 挡住「偏移极大」「只共享开场白」「空/短 swipe 碰撞」三类假阳性
    if (al.n0 < need) {
        return plan('different', 'n0-below-floor', {
            stats,
            candidates: al.path.filter((p) => p.cost === COST.MATCH).slice(0, 20),
        });
    }

    const cpl = commonPrefix(a, b);
    const cps = commonSuffix(a, b);
    let mode = 'diverged';
    if (al.n15 === 0 && al.gaps === 0 && n === m) mode = 'identical';
    else if (al.n15 === 0 && al.gaps === Math.abs(n - m) && cpl >= 3) mode = 'ancestor';

    const floors = al.path.map((p, k) => {
        const floorNo = k + 1;
        if (p.cost === COST.MATCH) {
            return {
                floorNo, kind: 'swipe-merge', cost: p.cost,
                evidence: p.why === 'swipe'
                    ? '一侧的当前正文是另一侧的某个旧版本（swipe 集）⇒ 同一层的两个版本'
                    : '两侧正文逐字相同',
                aIdx: p.ai, bIdx: p.bj,
            };
        }
        if (p.cost === COST.MISMATCH) {
            return {
                floorNo, kind: 'two-groups', cost: p.cost,
                evidence: '同位置但正文不同 ⇒ 该层两个组，交用户选（两份都留）',
                aIdx: p.ai, bIdx: p.bj,
            };
        }
        if (p.bj === null) {
            return { floorNo, kind: 'only-a', cost: p.cost, evidence: '只有 A 有这一层', aIdx: p.ai, bIdx: null };
        }
        return { floorNo, kind: 'only-b', cost: p.cost, evidence: '只有 B 有这一层', aIdx: null, bIdx: p.bj };
    });

    return plan('same-family', null, { mode, commonPrefix: cpl, commonSuffix: cps, floors, stats });
}

/**
 * 把方案说成人话（R1.3：判定必须可解释，不得只给结论）。
 * @param {object} plan
 * @returns {string}
 */
export function formatPlan(plan) {
    if (!plan) return '（无方案）';
    const s = plan.stats || {};
    const head = {
        'same-family': '判为**同一家族**',
        different: '判为**不同家族**',
        uncertain: '**判不出来**（不合并，列候选）',
    }[plan.verdict] || plan.verdict;
    const why = plan.reason ? `（理由：${plan.reason}）` : '';
    const dist = plan.floors.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] || 0) + 1; return acc; }, {});
    const kv = Object.entries(dist).map(([k, v]) => `${k}×${v}`).join(' ');
    return `${head}${why} A=${s.minLen ?? '?'}~${s.maxLen ?? '?'} 层 ·`
        + ` 精确同层 ${s.n0 ?? 0}（需 ≥ ${s.need ?? '?'}）· 同位置不同文 ${s.n15 ?? 0} · 空位 ${s.gaps ?? 0}`
        + (plan.mode ? ` · 关系=${plan.mode}` : '')
        + (kv ? ` · 逐层：${kv}` : '');
}
