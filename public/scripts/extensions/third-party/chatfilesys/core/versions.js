/**
 * ChatFilesys — 该层版本清单 + 组内版本的下标规则（T7 / R5 末段，纯函数，无 DOM）
 *
 * 术语（design.md §5.1，全仓统一）：
 *   · **swipe** = 宿主原生左右箭头所切的东西（同一条消息的多次生成变体）
 *   · **组 / swipe 组** = 某楼层的一份**内容**；**该层 swipe 组数 > 1 = 该层就是分叉点**
 *   · **分支（branch）** = swipe 组的归属（`path = {楼层 → 组}`）
 *
 * 「该层全部版本」= **组 × 组内版本** 的展平（design.md §5.4）：
 *   · **当前组**（本聊天键所在分支在该层引用的组）→ 内容在 body 行（`chat[F-1]`），组内版本 = `swipes[]`
 *   · **别的组** → 折叠在 `model.groups[gid]`，组内版本 = `variants[]`
 *
 * 存法（design.md §5.5A 的裁定，用户判据：最优 / 原有 jsonl 功能全正常 / 导出映射正确）：
 * **用库内既有形态承载**（宿主原生三件套 `swipes` / `swipe_info` / `swipe_id`），
 * **不另造行形态**——`core/projection.js` 的 `groupFromLine` / `lineFromGroup` 已是唯一映射出入口。
 *
 * 交互设计**参考** `qianzhuowo/SillyTavernSwipePreviewer`（研究留档
 * `.trellis/tasks/09-25-three-modes/research/07-swipe-previewer-internalize.md`，仅作语义参考），
 * **未引入其任何代码**（design.md §5.5：无第三方声明义务）。
 * 其四条数据层语义原样保留，逐条落在下面的函数里（design.md §5.5A 末段）：
 *   ① 写前先对当前版本做**快照**——「活的正文才是真身」（`snapshotActive`）
 *   ② 切换版本时**不合并** `extra`（防媒体/推理/计数字段跨版本泄漏）（`activateVariant`）
 *   ③ 删除时**至少保留一个**；删掉当前项取**下一个**、末尾则取**前一个**（`deleteVariants`）
 *   ④ 删除按**降序逐条**执行、每步发一次删除事件（`deletionOrder` + 调用方逐步落盘）
 */

import { getBranch, deriveOwner } from './branches.js';

/** 深拷贝（消息行是纯 JSON 数据；`undefined` 在 JSON 里本不存在） */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------------- 版本清单（展平：组 × 组内版本） ---------------- */

/**
 * 版本正文的文本形态。
 * `mes` 可能是字符串，也可能是**分段数组**（多模态 / 流式形态，宿主容忍这种写法）——
 * 数组形态取各段 `text` 拼接，取不到就是空串，**不抛**。
 * @param {*} mes
 * @returns {string}
 */
export function variantText(mes) {
    if (Array.isArray(mes)) {
        return mes.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text ?? '') : '')).join('');
    }
    return mes === undefined || mes === null ? '' : String(mes);
}

/**
 * 当前版本下标：`swipe_id` **夹进** `[0, n-1]`（宿主不夹；越界/非整数一律当 0）。
 * 没有 `swipes` 数组的行恒为 0（那里的「版本」就是 `mes` 本身）。
 * @param {object|null} line
 * @returns {number}
 */
export function currentVariantIndex(line) {
    const n = Array.isArray(line?.swipes) ? line.swipes.length : 0;
    const raw = Number.isInteger(line?.swipe_id) ? line.swipe_id : 0;
    return Math.min(Math.max(raw, 0), Math.max(0, n - 1));
}

/**
 * 一「行」的版本视图（只读，不改行）。
 *
 * 两个关键事实：
 *  · 有 `swipes` 数组 → 版本 = `swipes[k]`；**当前那一项要用活的 `mes`**
 *    （宿主原生编辑会改 `mes` 而 `swipes[active]` 滞后——「活的正文才是真身」）
 *  · 没有 `swipes` 数组 → 只有一个版本，正文 = `mes`
 *
 * @param {object|null} line 宿主 native 行（`mes` / `swipes` / `swipe_id` / `swipe_info`）
 * @returns {{count: number, active: number, texts: string[], sendDates: Array}}
 */
export function lineVariants(line) {
    const swipes = Array.isArray(line?.swipes) ? line.swipes : [];
    if (!swipes.length) {
        return { count: 1, active: 0, texts: [variantText(line?.mes)], sendDates: [line?.send_date] };
    }
    const active = currentVariantIndex(line);
    const info = Array.isArray(line.swipe_info) ? line.swipe_info : [];
    return {
        count: swipes.length,
        active,
        texts: swipes.map((s, k) => variantText(k === active ? (line.mes ?? s) : s)),
        sendDates: swipes.map((_, k) => (k === active ? line.send_date : info[k]?.send_date)),
    };
}

/**
 * 折叠组（`model.groups[gid]`）的版本视图。
 *
 * 两种折叠形态都要认（库内历史数据两种都有）：
 *  · 单变体且该变体自带 `swipes`（`core/store-bridge.js#modelFromStore` 直接从楼层行折叠出来的形态）
 *    → 按行展开（版本 = 组内 swipe）
 *  · 多变体（`core/projection.js#groupFromLine` 的规范形态）→ 版本 = `variants[k]`
 * @param {object|null} g
 * @returns {{count: number, active: number, texts: string[], sendDates: Array}}
 */
function groupVariants(g) {
    const vs = Array.isArray(g?.variants) ? g.variants.filter((v) => v && typeof v === 'object') : [];
    if (!vs.length) return { count: 1, active: 0, texts: [''], sendDates: [undefined] };
    if (vs.length === 1) return lineVariants(vs[0]);
    const active = Math.min(Math.max(Number.isInteger(g.active) ? g.active : 0, 0), vs.length - 1);
    return {
        count: vs.length,
        active,
        texts: vs.map((v) => variantText(v.mes)),
        sendDates: vs.map((v) => v.send_date),
    };
}

/**
 * 某个组在**该楼层**的目标分支（「切到别的组」时要切到哪条分支）。
 *
 * 判据（design.md §5.4 / research §G.2）：
 *  · 该组就是**当前分支**的组 → `null`（当前组内的版本 = 纯 swipe 切换，不切分支）
 *  · 组可被**多条分支共享** → 先挑一条：优先 `deriveOwner`（共享组 → null，私有组 → 它唯一的主人），
 *    再退回「非默认分支」，最后退回声明序第一。挑中的分支会显示在弹窗上，用户看得见要切去哪。
 * @param {object} model
 * @param {string} gid
 * @param {number} floor
 * @param {string|null} [currentBranchId] 本聊天键绑定的分支（W3）
 * @returns {string|null} 目标分支 id；无分支可切时 null
 */
export function targetBranchForGroup(model, gid, floor, currentBranchId = null) {
    const f = Number(floor);
    const curId = currentBranchId || model?.active_branch || null;
    const cur = getBranch(model, curId) || model?.branches?.[0] || null;
    if (cur && cur.path?.[f] === gid) return null; // 当前组：不切分支
    const refs = (model?.branches || []).filter((b) => b.path?.[f] === gid);
    if (!refs.length) return null;
    const owner = deriveOwner(model, gid);
    const pick = refs.find((b) => b.id === owner) || refs.find((b) => !b.is_default) || refs[0];
    return pick?.id ?? null;
}

/**
 * **该层版本清单**（版本按钮与版本弹窗的唯一数据源）。
 *
 * @param {object|null} model 家族模型
 * @param {number} floor 楼层号（从 1 起）
 * @param {Array<object>} [chat] 当前 body（`ctx.chat`）——当前组的组内 swipe 只在这里
 * @param {string|null} [currentBranchId] 本聊天键绑定的分支（W3：绑定键上 ≠ 家族活跃分支）
 * @returns {{floor: number, currentGid: string|null, currentKey: string|null,
 *            groups: Array<{gid, floor, branchIds: string[], isCurrent: boolean, variantCount: number,
 *                           active: number, targetBranchId: string|null,
 *                           items: Array<object>}>,
 *            items: Array<{key, gid, groupIndex, variantIndex, variantCount, isCurrentGroup,
 *                          isCurrent, text, sendDate}>}}
 *          `key` = `gid#组内下标`（稳定标识，供选中与多选）；无模型/楼层非法 → 空清单
 */
export function versionsAt(model, floor, chat = [], branchId = null) {
    const f = Number(floor);
    const out = { floor: f, currentGid: null, currentKey: null, groups: [], items: [] };
    if (!model || !Array.isArray(model.branches) || !Number.isInteger(f) || f < 1) return out;
    const cur = getBranch(model, branchId || model.active_branch) || model.branches[0] || null;
    out.currentGid = cur?.path?.[f] ?? null;

    for (const b of model.branches) {
        const gid = b.path?.[f];
        if (!gid) continue;
        let g = out.groups.find((x) => x.gid === gid);
        if (!g) {
            g = {
                gid,
                floor: f,
                branchIds: [],
                isCurrent: gid === out.currentGid,
                variantCount: 1,
                active: 0,
                targetBranchId: null,
                items: [],
            };
            out.groups.push(g);
        }
        g.branchIds.push(b.id);
    }

    for (let gi = 0; gi < out.groups.length; gi++) {
        const g = out.groups[gi];
        const line = chat?.[f - 1];
        // 当前组的正文在 body 行里；body 短于该层（库不自洽/投影不全）时退回折叠面，**不抛**
        const src = g.isCurrent && line ? lineVariants(line) : groupVariants(model.groups?.[g.gid]);
        g.variantCount = src.count;
        g.active = src.active;
        if (!g.isCurrent) g.targetBranchId = targetBranchForGroup(model, g.gid, f, branchId);
        for (let k = 0; k < src.count; k++) {
            const item = {
                key: `${g.gid}#${k}`,
                gid: g.gid,
                groupIndex: gi,
                variantIndex: k,
                variantCount: src.count,
                isCurrentGroup: g.isCurrent,
                isCurrent: g.isCurrent && k === src.active,
                text: src.texts[k] ?? '',
                sendDate: src.sendDates[k],
            };
            g.items.push(item);
            out.items.push(item);
            if (item.isCurrent) out.currentKey = item.key;
        }
    }
    return out;
}

/* ---------------- 组内版本操作（作用于宿主 native 行的三件套） ----------------
 * 调用约定：只用于**当前组**（其内容就是 body 行）。别的组的内容折叠在 model.groups 里、
 * 且对应一行的 variantId 就是那个组号——改它要同时改行表，属另一条写路径（见 design.md §5.4）。 */

/** 版本操作的前提校验：拿得到这一行的 `swipes` 数组 */
function requireSwipes(line, min = 1) {
    if (!line || typeof line !== 'object') throw new Error('版本操作：消息行不存在');
    const n = Array.isArray(line.swipes) ? line.swipes.length : 0;
    if (n < min) throw new Error(`版本操作：这一层只有 ${n} 个版本（需要 ≥ ${min}）`);
    return n;
}

/**
 * ① **写前快照**：把「活的正文」落进当前版本的副本。
 *
 * 语义来源：引用研究 §A.2（`prepareSwipes` / 宿主 `syncMesToSwipe`）——内存里被编辑或生成过的
 * `mes` / 时间戳 / `extra` 才是真身，`swipes[active]` / `swipe_info[active]` 可能滞后。
 * 任何会改动 `swipes` / `swipe_info` 的操作**都必须先跑这一步**。
 *
 * 边界（与引用实现的两处收敛，理由都是 R0「消息行零改动」）：
 *  · 没有 `swipes` 数组的行**原样不动**——本插件不得给消息行**补默认字段**
 *  · `swipe_info` 缺失/偏短/该项非对象 → 按位补齐为 `{ send_date, extra }`（宿主会直接放弃的场景）
 *
 * @param {object} line 就地修改并返回同一引用
 * @returns {object} 同一引用
 */
export function snapshotActive(line) {
    if (!line || typeof line !== 'object') throw new Error('版本操作：消息行不存在');
    if (!Array.isArray(line.swipes) || !line.swipes.length) return line;
    const i = currentVariantIndex(line);
    line.swipe_id = i;
    if (line.mes !== undefined && line.mes !== null) line.swipes[i] = line.mes; // 活的正文才是真身
    const prev = Array.isArray(line.swipe_info) ? line.swipe_info : [];
    const list = line.swipes.map((_, k) => {
        const it = prev[k];
        return it && typeof it === 'object' ? clone(it) : { send_date: line.send_date, extra: clone(line.extra ?? {}) };
    });
    const at = list[i];
    at.send_date = line.send_date;
    if (line.gen_started !== undefined) at.gen_started = line.gen_started;
    if (line.gen_finished !== undefined) at.gen_finished = line.gen_finished;
    at.extra = clone(line.extra ?? {});
    line.swipe_info = list;
    return line;
}

/**
 * ② **切换版本**：把某一版变成「当前可见内容」。
 *
 * 语义来源：引用研究 §A.3（`activateSwipe` / 宿主 `syncSwipeToMes`）——`swipe_id` 指过去，
 * 并把该版本的时间戳与 `extra` **整份搬**（`extra` 是替换而非合并：旧版本的媒体 / 推理 /
 * 计数字段**不得**泄漏到新版本上。这就是语义②）。
 *
 * 调用方必须先 `snapshotActive`（否则 `swipe_info` 不完整，搬过来的元数据是空的）。
 * @param {object} line
 * @param {number} k 目标版本下标
 * @returns {object} 同一引用
 */
export function activateVariant(line, k) {
    const n = requireSwipes(line);
    if (!Number.isInteger(k) || k < 0 || k >= n) throw new Error(`目标版本 ${k} 不存在（该层有 ${n} 个版本）`);
    line.swipe_id = k;
    line.mes = line.swipes[k];
    const swipeInfo = Array.isArray(line.swipe_info) ? line.swipe_info[k] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        // 三个元数据字段**无条件整份搬**（与宿主 `syncSwipeToMes` / 引用实现一致）：
        // 「按条删」与「批量删」的结果必须逐字段相同，条件赋值会让中途某一步把顶层
        // 字段留成上一个版本的值（值缺失 = undefined，JSON 落库时本就等于不存在）。
        line.send_date = swipeInfo.send_date;
        line.gen_started = swipeInfo.gen_started;
        line.gen_finished = swipeInfo.gen_finished;
        line.extra = clone(swipeInfo.extra ?? {}); // ② 不合并
    }
    return line;
}

/**
 * ④ 删除的**执行顺序**：把多选化成「降序逐条」的序列。
 *
 * 为什么要降序逐条（design.md §5.5A 语义④）：每删一条就落一次盘、发一次原生
 * `MESSAGE_SWIPE_DELETED` 事件，第三方扩展按该事件维护的**下标**才跟得上真实中间态；
 * 一次批量删会让它们看到「跳变」的下标。去重 + 降序（每步的下标都是当前数组里的真下标）。
 * @param {Array<number>} indices
 * @returns {number[]}
 */
export function deletionOrder(indices) {
    return [...new Set(Array.isArray(indices) ? indices : [])]
        .filter((i) => Number.isInteger(i) && i >= 0)
        .sort((a, b) => b - a);
}

/**
 * ③ **删除组内版本**：至少保留一个；删掉当前项取**下一个**幸存者、末尾则取**前一个**。
 *
 * 语义来源：引用研究 §A.4（`deleteSwipes`）与宿主 `deleteSwipe`（`newSwipeId = min(swipeId, n-1)`）。
 * 参数非法时**不改行**（校验先于快照）。
 *
 * 与引用实现的一处刻意差异：**不删 `swipe_info[k].extra.token_count`**。R0（消息行零改动、
 * 本插件不得裁别人的字段）优先，且 design.md §5.5A 要求保留的四条语义里不含它。
 *
 * @param {object} line
 * @param {Array<number>|number} indices 要删的版本下标（多条时按降序逐条语义等价，见 `deletionOrder`）
 * @returns {{line: object, removed: number[], kept: number[], active: number}}
 */
export function deleteVariants(line, indices) {
    const n = requireSwipes(line, 2);
    const removed = [...new Set(Array.isArray(indices) ? indices : [indices])].sort((a, b) => a - b);
    if (!removed.length) throw new Error('请先选择要删除的版本');
    if (removed.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw new Error('目标版本不存在');
    if (removed.length >= n) throw new Error('至少要保留一个版本');

    snapshotActive(line); // ① 先快照（被删的当前版本也要先落进副本，第三方读到的是真实中间态）
    const oldActive = line.swipe_id;
    const gone = new Set(removed);
    const kept = line.swipes.map((_, i) => i).filter((i) => !gone.has(i));
    // ③ 当前项被删 → 下一个幸存者；没有下一个（末尾）→ 最后一个幸存者
    const nextOld = kept.includes(oldActive) ? oldActive : (kept.find((i) => i > oldActive) ?? kept[kept.length - 1]);
    const info = Array.isArray(line.swipe_info) ? line.swipe_info : kept.map(() => ({}));
    line.swipes = kept.map((i) => line.swipes[i]);
    line.swipe_info = kept.map((i) => info[i] ?? {});
    activateVariant(line, kept.indexOf(nextOld)); // ② 切换时不合并 extra
    return { line, removed, kept, active: line.swipe_id };
}

/**
 * **重排版本**：交换两个版本的位置（正文与元数据一起搬），
 * 「当前可见内容」跟着它**所属的那一份**走（不是跟着下标走）。
 * 语义来源：引用研究 §A.5（`moveSwipe`）；宿主没有等价 API。
 * @param {object} line
 * @param {number} from
 * @param {number} to
 * @returns {object} 同一引用
 */
export function moveVariant(line, from, to) {
    const n = requireSwipes(line);
    if (![from, to].every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw new Error('目标版本下标越界');
    snapshotActive(line);
    const cur = line.swipe_id;
    for (const arr of [line.swipes, line.swipe_info]) {
        const t = arr[from];
        arr[from] = arr[to];
        arr[to] = t;
    }
    return activateVariant(line, cur === from ? to : cur === to ? from : cur);
}

/**
 * **编辑版本正文**。
 *  · 被编辑的是当前版本 → 活的正文（`mes`）一起改，否则界面看到的还是旧文本
 *  · 没有 `swipes` 数组的行（单版本）→ 只改 `mes`，**不**顺手造出 `swipes`（R0：不补字段）
 * @param {object} line
 * @param {number} k 版本下标
 * @param {string} text 新正文
 * @returns {object} 同一引用
 */
export function editVariantText(line, k, text) {
    if (!line || typeof line !== 'object') throw new Error('版本操作：消息行不存在');
    const hasSwipes = Array.isArray(line.swipes) && line.swipes.length > 0;
    if (!hasSwipes) {
        if (k !== 0) throw new Error(`目标版本 ${k} 不存在（该层只有 1 个版本）`);
        line.mes = String(text ?? '');
        return line;
    }
    const n = requireSwipes(line);
    if (!Number.isInteger(k) || k < 0 || k >= n) throw new Error(`目标版本 ${k} 不存在（该层有 ${n} 个版本）`);
    snapshotActive(line);
    line.swipes[k] = String(text ?? '');
    if (k === line.swipe_id) line.mes = line.swipes[k];
    return line;
}
