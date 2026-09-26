/**
 * ChatFilesys — branches 数据层（纯函数，无 DOM，可单测）
 *
 * branches = header.chat_metadata.extensions.chatfilesys
 * 不变量（validate 强制，见 design.md）：
 *   1. body 投影对齐：活跃分支 path 的楼层号升序 ↔ body 行一一对应
 *   2. 前缀连续：所有分支 path 都是 1..maxFloor 的连续前缀
 *   3. 组不重复存储：组要么在 body（活跃分支引用），要么在 model.groups，绝不同时在两处
 *   4. owner 为派生语义：引用数 >1 或唯一引用者为默认分支 → 共享（owner null）
 *
 * 约定：函数直接操作传入的 model（扩展持有的普通对象）并返回同一引用；
 *       所有产生「落盘差异」的操作配对返回 operations（由 projection/chat-writer 生成）。
 */

export const DEFAULT_BRANCH_ID = 'b_main';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/* ---------------- id 生成 ---------------- */

function maxNumericSuffix(ids, re) {
    let max = 0;
    for (const id of ids) {
        const m = re.exec(id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
}

/** 新组 id：扫描 path 引用与 groups 键，取最大数字后缀 +1 */
export function nextGroupId(model) {
    const gids = Object.keys(model.groups);
    for (const b of model.branches) gids.push(...Object.values(b.path));
    return 'g' + (maxNumericSuffix(gids, /^g(\d+)$/) + 1);
}

/** 新分支 id */
export function nextBranchId(model) {
    return 'b' + (maxNumericSuffix(model.branches.map((b) => b.id), /^b(\d+)$/) + 1);
}

/* ---------------- 基础查询 ---------------- */

export function getBranch(model, id) {
    return model.branches.find((b) => b.id === id) || null;
}

export function getActive(model) {
    const b = getBranch(model, model.active_branch);
    if (!b) throw new Error(`invariant: active_branch "${model.active_branch}" 不存在`);
    return b;
}

export function maxFloor(branch) {
    return Math.max(0, ...Object.keys(branch.path).map(Number));
}

/** 组被多少分支引用（in-body 与 folded 一视同仁，只看 path 引用） */
export function countRefs(model, gid) {
    return model.branches.filter((b) => Object.values(b.path).includes(gid)).length;
}

/** 派生 owner：引用数 >1 → 共享；唯一引用者为默认分支 → 共享；否则私有 */
export function deriveOwner(model, gid) {
    const refs = model.branches.filter((b) => Object.values(b.path).includes(gid));
    if (refs.length !== 1) return null;
    return refs[0].is_default ? null : refs[0].id;
}

/* ---------------- 创建 / 启用 ---------------- */

export function createBranchModel() {
    return { active_branch: null, branches: [], groups: {} };
}

/**
 * 将一个原生聊天（body = 消息行数组）启用为分支家族：
 * 每行一层一组一变体（组留在 body，不进 groups），建默认分支「主分支」。
 * 第 2 行起的原生平铺聊天没有分支概念，main 即全部历史。
 */
export function enableForChat(body) {
    const model = createBranchModel();
    const main = { id: DEFAULT_BRANCH_ID, name: '主分支', is_default: true, fork_base: 0, path: {} };
    body.forEach((_, i) => {
        main.path[i + 1] = `g${i + 1}`;
    });
    model.branches.push(main);
    model.active_branch = main.id;
    return model;
}

/* ---------------- 校验 ---------------- */

/**
 * 校验不变量。bodyLength = 当前 body 行数（活跃分支投影长度）。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(model, bodyLength) {
    const errors = [];
    const push = (msg) => errors.push(msg);

    if (!Array.isArray(model.branches) || model.branches.length === 0) push('branches 为空');
    if (!model.groups || typeof model.groups !== 'object') push('groups 缺失');
    if (errors.length) return { ok: false, errors };

    const defaults = model.branches.filter((b) => b.is_default);
    if (defaults.length !== 1) push(`is_default 分支数=${defaults.length}，应为 1`);
    const active = getBranch(model, model.active_branch);
    if (!active) push(`active_branch "${model.active_branch}" 不存在`);
    if (errors.length) return { ok: false, errors };

    const gidRe = /^g\d+$/;
    for (const b of model.branches) {
        const keys = Object.keys(b.path).map(Number).sort((x, y) => x - y);
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] !== i + 1) {
                push(`分支 "${b.name}" path 楼层号不连续（[${keys}] 应为 1..${keys.length}）`);
                break;
            }
        }
        const seen = new Set();
        for (const gid of Object.values(b.path)) {
            if (!gidRe.test(gid)) push(`分支 "${b.name}" 引用非法组 id "${gid}"`);
            if (seen.has(gid)) push(`分支 "${b.name}" 重复引用组 "${gid}"`);
            seen.add(gid);
        }
    }

    const activeGids = new Set(Object.values(active.path));
    // 不变量 3：活跃分支引用的组不得出现在 groups（它们就是 body 行）
    for (const gid of activeGids) {
        if (model.groups[gid]) push(`组 "${gid}" 被活跃分支引用却同时存在于 groups（重复存储）`);
    }
    // 非活跃分支引用的组必须折叠在 groups 中
    for (const b of model.branches) {
        if (b.id === active.id) continue;
        for (const gid of Object.values(b.path)) {
            if (!activeGids.has(gid) && !model.groups[gid]) {
                push(`非活跃分支 "${b.name}" 引用的组 "${gid}" 既不在 body 也不在 groups`);
            }
        }
    }
    // groups 记录自身合法性 + floor 与引用它的 path 键一致
    for (const [gid, g] of Object.entries(model.groups)) {
        if (!Array.isArray(g.variants) || g.variants.length === 0) push(`组 "${gid}" variants 为空`);
        else if (!(g.active >= 0 && g.active < g.variants.length)) push(`组 "${gid}" active=${g.active} 越界`);
        if (!Number.isInteger(g.floor) || g.floor < 1) push(`组 "${gid}" floor=${g.floor} 非法`);
        const refBranches = model.branches.filter((b) => b.path[g.floor] === gid);
        if (activeGids.has(gid)) continue; // 已在上面报过重复存储
        if (refBranches.length === 0) push(`组 "${gid}"（floor=${g.floor}）无任何分支在其 floor 位引用它`);
    }

    const activeMax = maxFloor(active);
    if (bodyLength !== activeMax) push(`body 行数 ${bodyLength} ≠ 活跃分支楼层数 ${activeMax}`);

    return { ok: errors.length === 0, errors };
}

/* ---------------- 结构操作（模型侧；落盘 ops 见 projection.js） ---------------- */

/**
 * 原生 append 追加了一行后登记：新增楼层 = bodyLength（body 已含新行）。
 * 组留在 body（不进 groups），只登记 path 引用。
 *
 * W3 修正（2026-09-26）：登记目标分支**可显式给出**。原生分支/检查点键上读到的 body 是
 * **该键所在分支**的投影（`core/takeover.js#branchIdForKey`），而家族活跃分支是另一条
 * （T1 接管刻意不改它，见 `core/takeover.js` 函数头）：按 `getActive` 登记会落到错的分支上并抛
 * 「新楼层 ≠ maxFloor+1」，于是该键的新楼层永远进不了模型——而库内 path 已被接缝扩好，
 * 之后任何一次 metadata 写都会把库里的 path 抹回旧版（消息从视图消失）。
 *
 * @param {object} model
 * @param {number} bodyLength 新楼层号（= body 行数）
 * @param {string|null} [branchId] 目标分支（缺省 = 家族活跃分支：off 模式与家族级路径的既有行为）
 * @returns {string} 新组 id
 */
export function registerAppendedGroup(model, bodyLength, branchId = null) {
    const b = branchId ? getBranch(model, branchId) : getActive(model);
    if (!b) throw new Error(`registerAppendedGroup: 分支 "${branchId}" 不存在`);
    const floor = bodyLength;
    if (floor !== maxFloor(b) + 1) {
        throw new Error(`registerAppendedGroup: 新楼层 ${floor} ≠ 分支 ${b.id} maxFloor+1（${maxFloor(b) + 1}）`);
    }
    const gid = nextGroupId(model);
    b.path[floor] = gid;
    return gid;
}

/**
 * 在 forkFloor 之后分叉：新分支 path 引用 ≤forkFloor 的同一批组（零复制）。
 * 分叉那一刻不产生任何 body 变化。
 * @returns 新分支对象
 */
export function createBranch(model, { name, forkFloor, activate = true }) {
    const cur = getActive(model);
    if (!Number.isInteger(forkFloor) || forkFloor < 0 || forkFloor > maxFloor(cur)) {
        throw new Error(`createBranch: forkFloor=${forkFloor} 超出活跃分支范围 0..${maxFloor(cur)}`);
    }
    const b = { id: nextBranchId(model), name: String(name), is_default: false, fork_base: forkFloor, path: {} };
    for (let f = 1; f <= forkFloor; f++) b.path[f] = cur.path[f];
    model.branches.push(b);
    if (activate) model.active_branch = b.id;
    return b;
}

export function renameBranch(model, id, name) {
    const b = getBranch(model, id);
    if (!b) throw new Error(`renameBranch: 分支 "${id}" 不存在`);
    b.name = String(name);
    return b;
}

/* ---------------- 主分支（T9 / R8.3：可更换） ---------------- */

/**
 * 迁移「主分支」标记到目标分支（校验目标存在）。
 *
 * 主分支 = **打开这个聊天时看到的那条分支**（R8.3）。它同时是删除的护城河：
 * `deleteBranch` 拒绝删除默认分支 → 要删主分支，先用 `setMainBranch` 换主分支。
 * 本函数只动 `is_default` 这一个字段（单一职责）；「打开看到的内容」由调用方
 * 连同家族活跃分支/键绑定一起改（见 `setMainBranch`）。
 *
 * @param {object} model
 * @param {string} id 目标分支 id
 * @returns {object} 目标分支（同一引用）
 */
export function setDefaultBranch(model, id) {
    const b = getBranch(model, id);
    if (!b) throw new Error(`setDefaultBranch: 分支 "${id}" 不存在`);
    for (const x of model.branches) x.is_default = x.id === b.id;
    return b;
}

/**
 * 「设为主分支」的完整模型侧动作：迁移 `is_default` + **家族活跃分支跟到同一条**。
 *
 * 为什么活跃分支也要跟：`active_branch` 是「库内家族打开时投影哪条分支」的兜底解析
 * （`core/takeover.js#branchIdForKey` 在键没有绑定、或绑定被删后回落到它）。换了主分支
 * 却不改它，会出现「点了设为主分支、打开却还是旧分支」，也会让旧主分支因为「仍是活跃分支」
 * 删不掉（`deleteBranch` 的两条既有校验）。两者一起指到目标，语义才自洽。
 *
 * 库内的键绑定（主键 → 主分支）不在本函数里改——那是存储面的事，由 `index.js` 用
 * `core/key-bindings.js#setBindingBranch` 与模型**同一次写入**落库。
 *
 * @param {object} model
 * @param {string} id
 * @returns {object} 目标分支
 */
export function setMainBranch(model, id) {
    const b = setDefaultBranch(model, id);
    model.active_branch = b.id;
    return b;
}

/**
 * 删除分支：仅 GC 其私有组（无其他分支引用）；共享组保留。
 * 活跃分支不可直接删（先切走）；默认分支不可删。
 */
export function deleteBranch(model, id) {
    const b = getBranch(model, id);
    if (!b) throw new Error(`deleteBranch: 分支 "${id}" 不存在`);
    if (b.is_default) throw new Error('默认分支不可删除');
    if (model.active_branch === id) throw new Error('不可删除当前活跃分支（先切换到其他分支）');

    model.branches = model.branches.filter((x) => x.id !== id);
    const ref = (gid) => model.branches.some((x) => Object.values(x.path).includes(gid));
    for (const gid of Object.values(b.path)) {
        const g = model.groups[gid];
        if (g && g.owner === b.id && !ref(gid)) delete model.groups[gid];
    }
    return b;
}

/**
 * 全局删除楼层 F（语义 = 原生「删除消息」：位置 F 从家族脊柱移除）：
 * 所有分支失去位置 F，>F 的楼层/组/fork_base 全部前移。
 * 活跃分支若含楼层 F，落盘 ops 由 projection.planDeleteFloor 配对生成。
 */
export function deleteFloorEverywhere(model, F) {
    const anyBranchMax = Math.max(0, ...model.branches.map(maxFloor));
    if (!Number.isInteger(F) || F < 1 || F > anyBranchMax) {
        throw new Error(`deleteFloorEverywhere: 楼层 ${F} 超出范围 1..${anyBranchMax}`);
    }
    for (const b of model.branches) {
        const np = {};
        for (const [k, gid] of Object.entries(b.path)) {
            const f = Number(k);
            if (f === F) continue;
            np[f > F ? f - 1 : f] = gid;
        }
        b.path = np;
        if (b.fork_base >= F) b.fork_base = Math.max(0, b.fork_base - 1);
    }
    for (const [gid, g] of Object.entries(model.groups)) {
        if (g.floor === F) delete model.groups[gid];
        else if (g.floor > F) g.floor -= 1;
    }
    return model;
}

/**
 * 收编原生书签复制文件（决策 #8）：复制文件 = 分叉点截断的完整前缀。
 * 严格校验 copiedLines 与当前活跃分支 body 前缀逐行一致；
 * 一致 → 建分支共享引用（零复制）；不一致 → 拒绝（调用方决定如何提示）。
 *
 * @returns {{ok: true, branch} | {ok: false, reason: string, firstDiff?: number}}
 */
export function adoptNativeCopy(model, { name, copiedLines, body }) {
    const forkFloor = copiedLines.length;
    const cur = getActive(model);
    if (forkFloor > maxFloor(cur)) {
        return { ok: false, reason: `复制文件行数 ${forkFloor} 超过当前分支楼层 ${maxFloor(cur)}` };
    }
    for (let i = 0; i < forkFloor; i++) {
        if (JSON.stringify(copiedLines[i]) !== JSON.stringify(body[i])) {
            return { ok: false, reason: `复制文件与当前分支在第 ${i + 1} 层不一致`, firstDiff: i };
        }
    }
    const branch = createBranch(model, { name, forkFloor, activate: false });
    return { ok: true, branch };
}
