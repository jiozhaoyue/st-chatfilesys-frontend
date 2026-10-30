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

/**
 * 对齐代价三档（**整数** 0/2/3 —— C1.3 起；乘 2 避免浮点累加误差，比例关系不变）。
 * **必须严格有序**：MATCH < GAP < MISMATCH < 2×GAP（见文件头第 3 条）。
 */
export const COST = Object.freeze({ MATCH: 0, GAP: 2, MISMATCH: 3 });

/** 判据阈值。数值来源见 `design.md` §7.1（真实语料标定，不是拍的）。 */
export const LIMITS = Object.freeze({
    n0Ratio: 0.30,     // (1) 精确同层数 ≥ 30% × 较短一方
    n0Floor: 3,        // (1) 且不少于 3 层
    minFloors: 3,      // (2) 双方各 ≥ 3 层
    minMaxRatio: 0.25, // (2) 长度比不足则降级 uncertain（不是 different）
    // 工作量预算（C1.3 起取代旧 `maxFloors: 2000` 硬护栏）：超过则 budget-exceeded，
    // **不截断、不假装合并**（spec §4）。旧护栏把 >2000 层直接降成 independent 是 design-v2
    // 明令移除的行为（R1.7：超过旧 2000 层护栏也纳入错位对齐验收）。
    // 10000×10000 = 1e8 cells（含歧义第二趟 ≈ 2e8 次行内操作）在该预算内。
    maxCells: 200000000,
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
 * 全局对齐 —— **旧全矩阵实现，只作 oracle**（implement-v2 C1.3：短序列保留旧 DP 作为独立 oracle）。
 * 生产路径走 `align` / `alignEx`（线性空间）。内存 O(n·m)，别拿它跑长聊天。
 *
 * 统计量天然包含公共前/后缀 —— 这一点是纠错：原设计把统计量的分母取自「去掉公共前后缀之后
 * 的中段」，而中段按定义就是**不匹配**的部分，要求它 30% 精确匹配是结构性自相矛盾
 * （互检 A · H1 实测：真同族的 291 层全等对被一票否掉）。
 *
 * @param {Array<object>} a
 * @param {Array<object>} b
 * @returns {{n0:number, n15:number, gaps:number, path:Array<object>}}
 */
export function alignFull(a, b) {
    const n = a.length;
    const m = b.length;
    // dp[i][j] = 对齐 a[i..] 与 b[j..] 的最小代价；ptr 记选择：0=配对 1=a 空位 2=b 空位
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    const ptr = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    for (let j = m - 1; j >= 0; j -= 1) { dp[n][j] = dp[n][j + 1] + COST.GAP; ptr[n][j] = 2; }
    for (let i = n - 1; i >= 0; i -= 1) { dp[i][m] = dp[i + 1][m] + COST.GAP; ptr[i][m] = 1; }
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            let best = pairCost(a[i], b[j]) + dp[i + 1][j + 1];
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

/* ---------------- 线性空间对齐（Hirschberg 分治，整数代价） ----------------
 *
 * design-v2「对齐机制与复杂度」：大序列用线性空间分治回溯（Hirschberg 式）和相同 tie-break；
 * 不因 >2000 层降级；每个批次检查 abort 与预算。
 *
 * 实现要点（改前先读）：
 * · **稀疏零代价矩阵**：cost(i,j)=0 只发生在 classify 的三种 MATCH 情形（hash 等值 /
 *   一侧当前正文在另一侧版本集）。先用倒排索引收集每行的零位（`zeros`），DP 行内其余格
 *   直接填 MISMATCH —— 把每格一次 Set.has 换成行内几次 O(1) 命中，1e8 格才跑得动；
 *   零位集合与 `classify` 的三种情形一一对应（含 `b.swipeHashes.has(a.hash)` 的反向通道），
 *   **不剪枝、不改最优路径**（design-v2：任何剪枝须证明不误杀——这里没有剪枝）。
 * · **同一份分治内核，两种驱动**：内核是生成器（`hirschbergGen`），在行块边界 `yield`；
 *   同步驱动（`align`/`alignEx`，测试与小输入）与异步驱动（`alignLinearAsync`，带
 *   12ms 门限的让出调度 + 取消检查）共用同一份逻辑，不维护两份实现。
 * · **tie-break 与旧 DP 相同**：候选顺序 [配对, a空位, b空位] + 严格 `<`。歧义第二趟
 *   反转候选顺序；两条同分路径的配对差异 ⇒ 对应楼层标 `ambig`（不伪造唯一对应）。
 */

/** 配对代价（与 `classify` 同判据；零位矩阵的权威口径） */
function pairCost(da, db) {
    return classify(da, db).cost;
}

/**
 * 稀疏零位矩阵：`zeros[i]` = 与 a[i] 可能构成 MATCH 的 b 下标集合。
 * 覆盖 classify 的全部三条 MATCH 通道；**是超集的精确化**（有些零位在最优路径上未必用上，
 * 但每个 MATCH 都在其中 ⇒ DP 结果与逐格 classify 完全一致）。
 */
function buildZeros(a, b) {
    const posB = new Map(); // b 的当前正文 hash → [j]
    b.forEach((d, j) => {
        let l = posB.get(d.hash);
        if (!l) posB.set(d.hash, l = []);
        l.push(j);
    });
    const swipeB = new Map(); // b 的版本集成员 hash → [j]（反向通道：b.swipeHashes.has(a.hash)）
    b.forEach((d, j) => {
        for (const h of d.swipeHashes) {
            let l = swipeB.get(h);
            if (!l) swipeB.set(h, l = []);
            l.push(j);
        }
    });
    const zeros = [];
    for (const d of a) {
        const js = new Set();
        if (d.len >= MIN_EVIDENCE_LEN) {
            for (const j of posB.get(d.hash) || []) js.add(j); // 通道①：双方当前正文等值
        }
        for (const h of d.swipeHashes) {
            for (const j of posB.get(h) || []) js.add(j);      // 通道②：a 的版本集含 b 的当前
        }
        for (const j of swipeB.get(d.hash) || []) js.add(j);   // 通道③：b 的版本集含 a 的当前
        zeros.push(js);
    }
    return zeros;
}

/** 取消检查器（每行调用一次；抛 {code:'aborted'} 由 planFamilyMerge 接住转 uncertain）。
 *  预算不在行级判定 —— Hirschberg 的行会被分治层级重访，行级计数不等于总工作量；
 *  预算在 `planFamilyMerge` 进入 DP 前按 `cells = n*m` 一次性判定（宁可多算一档）。 */
function makeChecker(opts) {
    return (i) => {
        if (opts.abortFlag?.aborted) {
            const e = new Error('[aborted] 对齐被取消');
            e.code = 'aborted';
            throw e;
        }
        void i;
    };
}

/** 子矩形 [i0,i1)×[j0,j1) 的完整 DP + 回溯（小矩形基例；内存 O(n·m)，n≤2 或 m≤2 才进来） */
function smallSolve(a, b, zeros, i0, i1, j0, j1, prefer) {
    const n = i1 - i0;
    const m = j1 - j0;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    const ptr = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    for (let j = m - 1; j >= 0; j -= 1) { dp[n][j] = dp[n][j + 1] + COST.GAP; ptr[n][j] = 2; }
    for (let i = n - 1; i >= 0; i -= 1) { dp[i][m] = dp[i + 1][m] + COST.GAP; ptr[i][m] = 1; }
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            const c = zeros[i0 + i].has(j0 + j) ? COST.MATCH : COST.MISMATCH;
            const cands = prefer === 'inverted'
                ? [[COST.GAP + dp[i][j + 1], 2], [COST.GAP + dp[i + 1][j], 1], [c + dp[i + 1][j + 1], 0]]
                : [[c + dp[i + 1][j + 1], 0], [COST.GAP + dp[i + 1][j], 1], [COST.GAP + dp[i][j + 1], 2]];
            let best = cands[0][0];
            let p = cands[0][1];
            for (const [v, pp] of cands) if (v < best) { best = v; p = pp; }
            dp[i][j] = best;
            ptr[i][j] = p;
        }
    }
    const path = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const p = ptr[i][j];
        if (p === 0) {
            const c = classify(a[i0 + i], b[j0 + j]);
            path.push({ ai: i0 + i, bj: j0 + j, cost: c.cost, why: c.why });
            i += 1; j += 1;
        } else if (p === 1) {
            path.push({ ai: i0 + i, bj: null, cost: COST.GAP, why: 'gap' }); i += 1;
        } else {
            path.push({ ai: null, bj: j0 + j, cost: COST.GAP, why: 'gap' }); j += 1;
        }
    }
    while (i < n) { path.push({ ai: i0 + i, bj: null, cost: COST.GAP, why: 'gap' }); i += 1; }
    while (j < m) { path.push({ ai: null, bj: j0 + j, cost: COST.GAP, why: 'gap' }); j += 1; }
    return path;
}

/**
 * Hirschberg 分治内核（生成器；行块边界 yield，由驱动决定是否让出调度）。
 * 缓冲池按分治深度各备一对行缓冲 → 内存 O((log n)·m)，零分配churn。
 */
function* hirschbergGen(a, b, zeros, i0, i1, j0, j1, opts, depth) {
    const n = i1 - i0;
    const m = j1 - j0;
    if (n === 0) {
        const out = [];
        for (let j = j0; j < j1; j += 1) out.push({ ai: null, bj: j, cost: COST.GAP, why: 'gap' });
        return out;
    }
    if (m === 0) {
        const out = [];
        for (let i = i0; i < i1; i += 1) out.push({ ai: i, bj: null, cost: COST.GAP, why: 'gap' });
        return out;
    }
    if (n <= 2 || m <= 2) return smallSolve(a, b, zeros, i0, i1, j0, j1, opts.prefer);

    const mid = i0 + (n >> 1);
    const check = makeChecker({ ...opts, width: m });
    // 前向行：i0 → mid（F(mid, j0..j1)）
    const W = m + 1;
    let bufA = opts.pool.get(depth * 2) || null;
    let bufB = opts.pool.get(depth * 2 + 1) || null;
    if (!bufA) { bufA = new Int32Array(W); bufB = new Int32Array(W); opts.pool.set(depth * 2, bufA); opts.pool.set(depth * 2 + 1, bufB); }
    let prev = bufA;
    let cur = bufB;
    for (let j = 0; j <= m; j += 1) prev[j] = COST.GAP * j; // F(i0, ·) 边界
    let since = 0;
    for (let i = i0 + 1; i <= mid; i += 1) {
        cur[0] = prev[0] + COST.GAP;
        const zrow = zeros[i - 1];
        for (let jj = 1; jj <= m; jj += 1) {
            const c = zrow.has(j0 + jj - 1) ? COST.MATCH : COST.MISMATCH;
            let best = c + prev[jj - 1];
            const up = COST.GAP + prev[jj];
            if (up < best) best = up;
            const left = COST.GAP + cur[jj - 1];
            if (left < best) best = left;
            cur[jj] = best;
        }
        const t = prev; prev = cur; cur = t;
        check(i);
        if (++since >= opts.yieldEvery) { since = 0; yield; }
    }
    const fRow = prev;
    // 后向行：i1 → mid（B(mid, j0..j1)）；descend 用另一对缓冲（depth*2+4/+5）
    let gPrev = opts.pool.get(depth * 2 + 4) || null;
    let gCur = opts.pool.get(depth * 2 + 5) || null;
    if (!gPrev) { gPrev = new Int32Array(W); gCur = new Int32Array(W); opts.pool.set(depth * 2 + 4, gPrev); opts.pool.set(depth * 2 + 5, gCur); }
    for (let j = 0; j <= m; j += 1) gPrev[j] = COST.GAP * (m - j); // B(i1, ·) 边界
    since = 0;
    for (let i = i1 - 1; i >= mid; i -= 1) {
        // gCur[j] = min(c(i,j)+gPrev[j+1], GAP+gPrev[j], GAP+gCur[j+1])，j 从 m-1 降到 0
        gCur[m] = COST.GAP * (i1 - i);
        const zrow = zeros[i];
        for (let jj = m - 1; jj >= 0; jj -= 1) {
            const c = zrow.has(j0 + jj) ? COST.MATCH : COST.MISMATCH;
            let best = c + gPrev[jj + 1];
            const up = COST.GAP + gPrev[jj];
            if (up < best) best = up;
            const left = COST.GAP + gCur[jj + 1];
            if (left < best) best = left;
            gCur[jj] = best;
        }
        const t = gPrev; gPrev = gCur; gCur = t;
        check(i);
        if (++since >= opts.yieldEvery) { since = 0; yield; }
    }
    const gRow = gPrev;
    // 分割点：k* = argmin_j F(mid, j) + B(mid, j)；tie 由 prefer 决定（primary 取最小 j）
    let bestK = 0;
    let bestV = Number.POSITIVE_INFINITY;
    for (let jj = 0; jj <= m; jj += 1) {
        const v = fRow[jj] + gRow[jj];
        if (v < bestV || (opts.prefer === 'inverted' && v === bestV)) { bestV = v; bestK = jj; }
    }
    const k = j0 + bestK;
    const head = yield* hirschbergGen(a, b, zeros, i0, mid, j0, k, opts, depth + 1);
    const tail = yield* hirschbergGen(a, b, zeros, mid, i1, k, j1, opts, depth + 1);
    return head.concat(tail);
}

function* alignGen(a, b, opts) {
    return yield* hirschbergGen(a, b, buildZeros(a, b), 0, a.length, 0, b.length, opts, 0);
}

function summarize(path) {
    let n0 = 0;
    let n15 = 0;
    let gaps = 0;
    for (const p of path) {
        if (p.cost === COST.MATCH) n0 += 1;
        else if (p.cost === COST.MISMATCH) n15 += 1;
        else gaps += 1;
    }
    return { n0, n15, gaps };
}

/**
 * 主/副两趟路径的配对差异 → 歧义集合。
 * `ambiguousCount` 按**主路径楼层**计（与 planFamilyMerge 的 `ambig` 旗标同一谓词）：
 * 该层涉及的下标在两趟里配对不一致（或一侧配了另一侧空位）即歧义。
 */
function ambiguityOf(path, alt) {
    const pm = new Map();
    const sm = new Map();
    const pmB = new Map();
    const smB = new Map();
    for (const p of path) if (p.ai !== null && p.bj !== null) { pm.set(p.ai, p.bj); pmB.set(p.bj, p.ai); }
    for (const p of alt) if (p.ai !== null && p.bj !== null) { sm.set(p.ai, p.bj); smB.set(p.bj, p.ai); }
    const ambigA = new Set();
    const ambigB = new Set();
    for (const [ai, bj] of pm) if (sm.get(ai) !== bj) ambigA.add(ai);
    for (const [ai, bj] of sm) if (pm.get(ai) !== bj) ambigA.add(ai);
    for (const [bj, ai] of pmB) if (smB.get(bj) !== ai) ambigB.add(bj);
    for (const [bj, ai] of smB) if (pmB.get(bj) !== ai) ambigB.add(bj);
    const ambiguousCount = path.filter((p) => (p.ai !== null && ambigA.has(p.ai)) || (p.bj !== null && ambigB.has(p.bj))).length;
    return { ambigA, ambigB, ambiguousCount };
}

function driveSync(genFactory) {
    const it = genFactory();
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
}

/**
 * 异步驱动：行块之间让出调度（12ms 门限），取消/预算有界（每行还有同步 check）。
 * 主线程降级路径用这个 —— UI 不被一次长 DP 卡死（design-v2：主线程分片让出调度）。
 */
async function driveAsync(genFactory, { abortFlag, yieldMs = 12 } = {}) {
    const it = genFactory();
    let r = it.next();
    let last = Date.now();
    while (!r.done) {
        if (abortFlag?.aborted) {
            const e = new Error('[aborted] 对齐被取消');
            e.code = 'aborted';
            throw e;
        }
        if (Date.now() - last >= yieldMs) {
            await new Promise((res) => setTimeout(res, 0));
            last = Date.now();
        }
        r = it.next();
    }
    return r.value;
}

/**
 * 全局对齐（线性空间，同步入口）—— 旧 `align` 的等价替换：同 tie-break、同统计口径。
 * 空输入不抛（旧用例钉住的行为）。
 */
export function align(a, b) {
    const path = driveSync(() => alignGen(a, b, { prefer: 'primary', yieldEvery: 4096, pool: new Map() }));
    return { ...summarize(path), path };
}

/**
 * 带歧义检测的对齐：第二趟反转 tie-break；两条同分路径的配对差异 ⇒ 歧义。
 * @returns {{n0,n15,gaps, path, ambiguousCount:number,
 *            ambigA:Set<number>, ambigB:Set<number>}}
 */
export function alignEx(a, b, opts = {}) {
    const mk = (prefer) => () => alignGen(a, b, {
        prefer, yieldEvery: opts.yieldEvery ?? 4096,
        pool: new Map(), abortFlag: opts.abortFlag, maxCells: opts.maxCells,
    });
    const path = driveSync(mk('primary'));
    const alt = driveSync(mk('inverted'));
    return { ...summarize(path), path, ...ambiguityOf(path, alt) };
}

/** 异步版（让出调度 + 取消）；`planFamilyMerge` 的生产入口。 */
export async function alignLinearAsync(a, b, opts = {}) {
    const { abortFlag, onProgress, yieldEvery = 256 } = opts;
    const path = await driveAsync(
        () => alignGen(a, b, { prefer: 'primary', yieldEvery, pool: new Map(), abortFlag, maxCells: null }),
        { abortFlag },
    );
    onProgress?.({ phase: 'align-primary', done: path.length });
    // 歧义第二趟（同规模、同预算内 —— 预算按主趟 cells 在 planFamilyMerge 前置判定）
    const alt = await driveAsync(
        () => alignGen(a, b, { prefer: 'inverted', yieldEvery, pool: new Map(), abortFlag, maxCells: null }),
        { abortFlag },
    );
    onProgress?.({ phase: 'align-ambiguity', done: path.length });
    return { ...summarize(path), path, ...ambiguityOf(path, alt) };
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
 *          aMainChat?: string|null, bMainChat?: string|null, log?: Function,
 *          maxCells?: number, abortFlag?: {aborted:boolean},
 *          onProgress?: Function, yieldEvery?: number}} args
 *   `aMainChat`/`bMainChat` 只用来填报告的 `familyHint`，**不参与判定**；
 *   `maxCells` = 工作量预算（n·m 格数，缺省 `LIMITS.maxCells`），超限 → `uncertain/budget-exceeded`
 *   （不截断、不假装合并，spec §4）；`abortFlag` = 可变取消旗标（**不是** AbortSignal ——
 *   它不能 postMessage，跨 Worker 只传这个普通对象等价物）；`onProgress` = 进度回调
 *   （UI 层自行 rAF 合帧，`L1-MR-9`）。
 * @returns {Promise<object>} MergePlan
 */
export async function planFamilyMerge({ aRows, bRows, aMainChat = null, bMainChat = null, log = () => {},
    maxCells = null, abortFlag = null, onProgress = null, yieldEvery = 256 } = {}) {
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
    // 工作量预算（C1.3 取代旧 2000 层硬护栏）：cells 超限 → budget-exceeded，不截断不假装。
    const cells = n * m;
    if (cells > (maxCells ?? LIMITS.maxCells)) {
        return plan('uncertain', 'budget-exceeded', {
            stats: { n0: 0, n15: 0, gaps: 0, minLen: n, maxLen: m, cells },
        });
    }

    const need = needOf(n, m);
    const bound = matchBound(a, b);
    const base = { need, minLen: Math.min(n, m), maxLen: Math.max(n, m), sharedBound: bound };
    if (bound < need) {
        // 廉价的**必要条件**预筛：`n0` 的可靠上界都不够，不必跑对齐（见 matchBound 的正确性说明）
        return plan('different', 'prefilter', { stats: { n0: 0, n15: 0, gaps: 0, ...base } });
    }

    let al;
    try {
        al = await alignLinearAsync(a, b, {
            abortFlag, yieldEvery,
            onProgress: (p) => onProgress?.(p),
        });
    } catch (e) {
        if (e?.code === 'aborted') {
            return plan('uncertain', 'aborted', { stats: { n0: 0, n15: 0, gaps: 0, ...base, cells } });
        }
        if (e?.code === 'budget-exceeded') {
            return plan('uncertain', 'budget-exceeded', { stats: { n0: 0, n15: 0, gaps: 0, ...base, cells } });
        }
        log(`对齐失败：${e?.message || e}`);
        return plan('uncertain', 'align-failed');
    }
    const stats = { n0: al.n0, n15: al.n15, gaps: al.gaps, ambiguousCount: al.ambiguousCount, ...base, cells };

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
        // 歧义（同分多解）：对应关系不唯一 ⇒ 不硬并（design-v2：歧义路径保留独立对应和说明）
        const ambig = (p.ai !== null && al.ambigA.has(p.ai)) || (p.bj !== null && al.ambigB.has(p.bj));
        if (p.cost === COST.MATCH) {
            if (ambig) {
                return {
                    floorNo, kind: 'two-groups', cost: p.cost, ambig: true,
                    evidence: '同分多解：该层存在并列最优对应（配给哪一侧同价）⇒ 不硬并，两份都留',
                    aIdx: p.ai, bIdx: p.bj,
                };
            }
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
                floorNo, kind: 'two-groups', cost: p.cost, ...(ambig ? { ambig: true } : {}),
                evidence: '同位置但正文不同 ⇒ 该层两个组，交用户选（两份都留）',
                aIdx: p.ai, bIdx: p.bj,
            };
        }
        if (p.bj === null) {
            return { floorNo, kind: 'only-a', cost: p.cost, ...(ambig ? { ambig: true } : {}), evidence: '只有 A 有这一层', aIdx: p.ai, bIdx: null };
        }
        return { floorNo, kind: 'only-b', cost: p.cost, ...(ambig ? { ambig: true } : {}), evidence: '只有 B 有这一层', aIdx: null, bIdx: p.bj };
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
