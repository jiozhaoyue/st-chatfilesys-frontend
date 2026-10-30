/**
 * ChatFilesys — 家族建模层（`MergePlan` → 家族模型；**纯函数**）
 *
 * 一句话：把 `family-align.js#planFamilyMerge` 产出的**只读方案**，装配成 chatfilesys 现有模型
 * （两条分支 + 组）与**待落库的行**。
 *
 * ── 本模块只出模型与行，不落库 ──
 * 落库由调用方（导入旅程 / 「从 jsonl 重建」）经适配器 `saveFloors` / `saveModel` 走。
 * 纯逻辑：无 DOM / 无网络 / 无适配器依赖（`L1-MR-6` 同构要求，可 100% 单测）。
 *
 * 依据 `.trellis/tasks/09-29-fuzzy-family-merge/design.md` **§10**（唯一实现契约）+ §4 step 4。
 *
 * ── 构造铁律（逐条有出处，别绕）──
 * 1. **「变为 swipe」= 把同层两版并进同一条行的 `swipes`**（展开态）—— 选它的理由是
 *    **零复制 + 转换单点已存在**，**不是**「多变体组不合法」：多变体组恰是 `groupFromLine` 的
 *    **规范形态**（`versions.js:92` 明写），`validate` 也只拒 **0 条** variant（`branches.js:145`）。
 *    真正的约束是**不变量 3**（`branches.js:131-133`）：**活跃分支引用的 gid 不得同时进 `model.groups`**
 *    ⇒ 活跃分支上的同层多版只能落成 body 行的 `swipes`。转换单点 = `projection.js#groupFromLine`
 *    / `#lineFromGroup`，本模块不另造（手写 `line.swipes.push` 会绕开唯一映射出入口）。
 * 2. **楼层号 = 各方自己的行序号**（A 用 A 的、B 用 B 的），**不是** alignment 位置 ——
 *    两条 path 因此天生 1..N 连续，无需补号。
 * 3. **A 侧绝不重编号**：`aRows` 是家族**活跃分支**的投影，家族里其它分支与 `groups[].floor`
 *    都对着它；动一下全坏（与 `branch-merge.js:11` 的「公共前缀共享同一个组」同一精神）。
 * 4. **A = 家族活跃分支，`active_branch` 原样不改**；只有「家族没有任何分支」时才新建主分支。
 *    动因：取默认分支并强改 `active_branch` 会在导入时**默默切换用户正看的分支**；且
 *    `ui/merge.js:121` 承诺「合并不改动原分支」⇒ **`swipe_id` 固定指向 A 的原版本**（A 的显示一字不变）。
 * 5. **A 侧只回写真正变了的行**（并出 ≥2 版的那几条）—— 避免写放大、不抹掉库里已存的 `contentHash`。
 * 6. **建分支走 `branches.js#createBranchWithPath`**：它是「path 必须 1..N 连续」与「引用的 gid
 *    必须已存在」两条不变量**唯一的运行点**（不满足即 throw；`validate` 生产代码从不调用）。
 *    故本模块先给 B 的新组建进 `model.groups`，再调它 —— 别自己 `model.branches.push`。
 * 7. **运行期守卫**：非活跃分支在同一层各持私有组 ⇒ 往返（`modelFromStore` 按 floorNo 归并）
 *    会丢组、切过去时 `planSwitch` 抛错 ⇒ **整体降级**（`store-bridge` 的根治另开任务）。
 */

import { groupFromLine, lineFromGroup } from './projection.js';
import { createBranchWithPath, nextGroupId, DEFAULT_BRANCH_ID } from './branches.js';
import { normalizeText } from './merge.js';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/** 「宿主消息行」的判定 —— 与 `family-align.js#buildDescriptors` 同一口径（无 `mes` 的行不算一层） */
const isMsgRow = (r) => Boolean(r) && typeof r === 'object' && typeof r.mes === 'string';

/** 只收有 `mes` 的行（描述符序列也是这么过滤的，故 aIdx/bIdx 直接索引过滤后的序列） */
const msgRows = (rows) => (Array.isArray(rows) ? rows : []).filter(isMsgRow);

/** 变体去重键：归一化后「角色 + 侧 + 正文」相同即同一条（避免同一版被 A、B 各记一次） */
const variantKey = (v) => `${normalizeText(v?.name)}|${Boolean(v?.is_user)}|${normalizeText(v?.mes)}`;

/**
 * `send_date` → 排序键；**缺失/空返回 `''`** —— 空串在字符串序里最小，故缺失者排到**最前**
 * （确定性排序；见 design.md §4 step 4 · M3：`active` 由 `swipe_id` 指，与排序无关）。
 */
const atOf = (v) => (v?.send_date === undefined || v?.send_date === null || v?.send_date === ''
    ? '' : String(v.send_date));

/** 待落库的一行（与 `patch-rows.js` / `importer.js` 的行形态一致） */
function rowOf(floorNo, variantId, row) {
    return {
        floorNo,
        variantId,
        seq: 0,
        content: JSON.stringify(row),
        // 同步纯函数不能 await Web Crypto；留空 → 导入路径按内容现算（importer.js:255 同形）
        contentHash: null,
        sendDate: row?.send_date ?? null,
    };
}

/** 两条 path 的连续共享前缀长度（= B 的 fork_base） */
function sharedPrefix(a, b) {
    let k = 0;
    while (a[k + 1] !== undefined && a[k + 1] === b[k + 1]) k += 1;
    return k;
}

/**
 * 合并同一楼层的两侧版本为**一条行**（组 ⇄ 行的转换单点见 `projection.js`）。
 *
 * 变体取两侧**并集**（去重）；列表顺序按 `send_date` 升序，**缺失者按空串排到最前**（确定性排序，
 * A 侧先、B 侧后）；**`active` 固定指向 A 的那一版**（A 的显示一字不变，见 design.md §10.3「复核后补定」）。
 *
 * @returns {{line: object, prov: Array<{src: 'a'|'b', srcIdx: number}>}}
 */
function mergeVariants(gid, floor, aRow, bRow) {
    const merged = [];
    const prov = [];
    const seen = new Set();
    const push = (src, variants) => {
        variants.forEach((v, srcIdx) => {
            const k = variantKey(v);
            if (seen.has(k)) return;
            seen.add(k);
            merged.push(v);
            prov.push({ src, srcIdx });
        });
    };
    const aGroup = groupFromLine('__a', floor, aRow);
    push('a', aGroup.variants);
    push('b', groupFromLine('__b', floor, bRow).variants);

    const order = merged.map((_, i) => i);
    order.sort((x, y) => {
        const kx = atOf(merged[x]);
        const ky = atOf(merged[y]);
        if (kx !== ky) return kx < ky ? -1 : 1;
        return x - y; // 同一 send_date（或缺 send_date 而都排最前）⇒ 按原下标稳定排序
    });
    const variants = order.map((i) => merged[i]);
    // active = **A 那一版**在排序后列表里的下标（用户 2026-09-29 裁定）：
    // A 的显示一字不变，B 的版本进同一 swipe 集、用户用箭头切过去。
    // 取「末位（= 较新）」会让 A 的正文当场变样，违 ui/merge.js:121 的承诺。
    const aTarget = aGroup.variants[aGroup.active] ?? aGroup.variants[0];
    const aMergedAt = merged.indexOf(aTarget);
    const active = order.indexOf(aMergedAt < 0 ? 0 : aMergedAt);
    const line = lineFromGroup({ id: gid, floor, active: active < 0 ? 0 : active, variants });
    return { line, prov: order.map((i) => prov[i]) };
}

/** 降级结果（边界输入一律走它，**不抛**）：模型原样带回，不产行 */
function degraded(family, reason, extra = {}) {
    const model = family && Array.isArray(family.branches)
        ? clone(family) : { active_branch: null, branches: [], groups: {} };
    if (!model.groups || typeof model.groups !== 'object') model.groups = {};
    if (!Array.isArray(model.branches)) model.branches = [];
    return {
        model,
        floors: [],
        stats: { ok: false, reason, shared: 0, newGroups: 0, branchId: null, ...extra },
    };
}

/**
 * 运行期守卫（design.md §10.3「复核后补定」第 4 条）。
 *
 * 取**非活跃分支** path 里、**且不在活跃分支 path 里**的 `(floor, gid)`（= 私有组），
 * 按 floor 分组；任一 floor 出现 **≥2 个不同 gid** ⇒ 说明 `modelFromStore`（按 `floorNo`
 * 归并、组 id 只取该层第一条非活跃行）会在往返后丢掉某条分支的组、切过去时 `planSwitch` 抛错。
 *
 * 这是那个**既有**缺陷（`store-bridge.js:34-50`）的运行期规避 —— 本轮不改 `store-bridge`，
 * 根治另开任务（用户 2026-09-29 裁定）。
 *
 * @returns {number|null} 冲突楼层号；无冲突返回 null
 */
function privateFloorCollision(model) {
    const active = model.branches.find((b) => b.id === model.active_branch) || null;
    const activeGids = new Set(active ? Object.values(active.path) : []);
    const byFloor = new Map(); // floor → Set<gid>
    for (const b of model.branches) {
        if (active && b.id === active.id) continue; // 只查非活跃分支
        for (const [f, gid] of Object.entries(b.path)) {
            if (activeGids.has(gid)) continue; // 活跃分支也引用的（共享组）不算私有
            const floor = Number(f);
            if (!byFloor.has(floor)) byFloor.set(floor, new Set());
            byFloor.get(floor).add(gid);
        }
    }
    for (const [floor, gids] of byFloor) if (gids.size >= 2) return floor;
    return null;
}

/**
 * `MergePlan` → 家族模型 + 待落库的行。
 *
 * @param {{plan: object, aRows: Array<object>, bRows: Array<object>,
 *          family?: object|null, branchName?: string|null}} args
 *   `plan` = `planFamilyMerge` 产物；`aRows`/`bRows` = 两侧**宿主消息行对象**数组；
 *   `family` = 既有家族模型（可选；无则从零建两分支）；`branchName` = 新分支名（缺省「导入分支」）。
 * @returns {{model: object, floors: Array<object>, stats: object}}
 *   `model` = `{active_branch, branches:[{id,name,is_default,fork_base,path}], groups}`；
 *   `floors` = `[{floorNo, variantId, seq, content, contentHash, sendDate}]`。
 */
export function modelFromPlan({ plan, aRows, bRows, family = null, branchName = null } = {}) {
    const aSeq = msgRows(aRows);
    const bSeq = msgRows(bRows);

    // 边界输入：不抛，返回可降级结果（design.md §8 的失败语义精神）
    if (!plan || !Array.isArray(plan.floors) || plan.floors.length === 0) return degraded(family, 'no-plan');
    if (plan.verdict && plan.verdict !== 'same-family') return degraded(family, `verdict-${plan.verdict}`);
    if (!aSeq.length) return degraded(family, 'no-a-rows');
    if (!bSeq.length) return degraded(family, 'no-b-rows');

    const model = family && Array.isArray(family.branches) && family.branches.length
        ? clone(family) : { active_branch: null, branches: [], groups: {} };
    if (!model.groups || typeof model.groups !== 'object') model.groups = {};
    if (!Array.isArray(model.branches)) model.branches = [];

    // A 侧 = 家族**活跃分支**（`aRows` 就是它的投影）；`active_branch` **原样不改**（铁律 4）
    let aBranch = model.branches.find((b) => b.id === model.active_branch) || null;
    if (!aBranch) {
        // 只有「家族没有任何分支」时才新建主分支（此时设 active_branch 无副作用）
        if (model.branches.length) return degraded(family, 'no-active-branch');
        aBranch = { id: DEFAULT_BRANCH_ID, name: '主分支', is_default: true, fork_base: 0, path: {} };
        for (let f = 1; f <= aSeq.length; f += 1) aBranch.path[f] = `g${f}`;
        model.branches.push(aBranch);
        model.active_branch = aBranch.id;
    }

    // gid 分配器：避开家族里已有的全部组 id
    let cursor = nextGroupId(model);
    const allocGid = () => {
        const g = cursor;
        const m = /^g(\d+)$/.exec(cursor);
        cursor = m ? `g${Number(m[1]) + 1}` : `${cursor}_`;
        return g;
    };

    // plan 的每一层 → 按 B 侧下标索引（只有 `bIdx` 非空的层覆盖到 B 的行）
    const entryByB = new Map();
    for (const f of plan.floors) if (f && Number.isInteger(f.bIdx)) entryByB.set(f.bIdx, f);

    const bPath = {};
    const bFloors = [];
    const provenance = [];
    const aMerged = new Map(); // A 侧楼层 → 合并后的行（含 swipes）
    let shared = 0;

    // 逐 B 行：同位置且判为同层 ⇒ 共享（零复制，把 B 那版并进 A 那行的 swipes）；
    // 其余（two-groups / 序号错位 / only-b）⇒ 新建一行 + 新组（序号错位即分叉，见 §10.3）。
    for (let j = 1; j <= bSeq.length; j += 1) {
        const entry = entryByB.get(j - 1) || null;
        const shareable = Boolean(entry) && entry.kind === 'swipe-merge'
            && entry.aIdx === j - 1 && aBranch.path[j] !== undefined;
        if (shareable) {
            bPath[j] = aBranch.path[j];
            shared += 1;
            const m = mergeVariants(aBranch.path[j], j, aSeq[j - 1], bSeq[j - 1]);
            aMerged.set(j, m);
            provenance.push({ floorNo: j, gid: aBranch.path[j], variants: m.prov });
        } else {
            const gid = allocGid();
            bPath[j] = gid;
            const g = groupFromLine(gid, j, bSeq[j - 1]);
            g.owner = undefined;
            model.groups[gid] = g; // 必须先建组：createBranchWithPath 会校验 path 引用的 gid 已存在
            bFloors.push(rowOf(j, gid, bSeq[j - 1]));
        }
    }
    // 用既有单点建分支（铁律 6）：path 必须 1..N 连续、引用的 gid 必须已存在，不满足即 throw。
    // **必须包起来**：它抛出的异常若冒泡到 `importOneFile` 会被 `runImport` 记成 `failed`，
    // 与 design.md §8「任何异常 → 返回 uncertain 且 reason，**不抛**」不符 ⇒ 降级返回（本层不写库）。
    let bBranch;
    try {
        bBranch = createBranchWithPath(model, {
            name: String(branchName || '导入分支'),
            path: bPath,
            activate: false, // A（活跃分支）不得被换掉（铁律 4）
            forkBase: sharedPrefix(aBranch.path, bPath),
        });
    } catch (e) {
        return degraded(family, 'branch-build-failed', { detail: String(e?.message || e) });
    }

    // 运行期守卫（铁律 7）：非活跃分支同一层各持私有组 ⇒ 往返丢组、切过去抛错 ⇒ 整体降级
    const collideFloor = privateFloorCollision(model);
    if (collideFloor !== null) return degraded(family, 'group-collision', { floor: collideFloor });

    // A 侧行：**只回写真正变了的行**（并出 ≥2 版的那几条）；只有一版的不写（铁律 5）
    const aFloors = [];
    for (const [f, m] of aMerged) {
        if (m.prov.length <= 1) continue;
        const gid = aBranch.path[f];
        if (gid === undefined) continue;
        aFloors.push(rowOf(f, gid, m.line));
    }

    return {
        model,
        floors: [...aFloors, ...bFloors],
        stats: {
            ok: true,
            reason: null,
            shared,
            newGroups: bFloors.length,
            a: aSeq.length,
            b: bSeq.length,
            branchId: bBranch.id,
            branchName: bBranch.name,
            activeBranchId: aBranch.id,
            provenance,
        },
    };
}
