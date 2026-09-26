/**
 * ChatFilesys — 消息补丁应用器（T0b：宿主的 `chats/patch` ops 真正落库）
 *
 * 问题（真机证据，2026-09-25 探针 `tests/e2e/probe_patch_ops.py`）：宿主与第三方插件的
 * 消息写入走 `/api/chats/patch`，ops 的 path 是挂在**消息数组**上的 JSON Pointer，深度不限：
 *   - 插件直接改内存字段后保存 → `{op:'add', path:'/0/extra/third-party~1probe-row', value:{…}}`
 *   - 宿主编辑消息 / swipe 切换 → `test /N` + `replace /N`（整行）
 *   - 删消息 → `test /N` + `remove /N`
 * 旧实现（三档各写一份窄正则 `^\/?(?:chat\/)?(\d+)$`）只认整行 `/N`，
 * **字段级 `/N/field` 直接跳过** → 插件写进消息里的自定义内容在纯库模式下静默丢失。
 *
 * 关键不对齐：ops 打在**按活跃分支投影出来的 body 数组**上（宿主看到的那一份），
 * 而库内是**含非活跃变体的行表**（`floorNo × variantId`）——两者索引对不齐。
 * 本模块负责一次完整往返：`投影 → 应用 → 按键写回`。
 *
 * 语义（对齐宿主服务端 `src/endpoints/chats.js` 的 `/patch`）：
 * - ops 全程作用在**消息数组**上（元素级 `/N` 与字段级 `/N/…` 混排），失败即整批不写
 * - `test` 不通过 → `test-failed`（seam 映射为 409，宿主走它自己的冲突重放）
 * - 楼层消失 = **全局删层**（与 `deleteFloorEverywhere` 同语义：所有分支失去该层、后续前移）
 * - 中间插入新楼层 = 模型无法表达（其他分支在该位置无内容）→ 拒绝，宿主会自行回退全量保存
 * - 分支切换 = **重投影**：ops 结果与目标分支逐位对齐时不做任何结构删除（其他分支原样保留）
 *
 * 纯函数：无 DOM、无网络、无适配器依赖（行/模型由调用方送进来，结果由调用方落库）。
 */

import { applyOpsToObject, parsePointer, joinPointer, deepEqual } from './ops-apply.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** 行内容字符串 → 对象（不可解析视为库不自洽） */
function parseRowContent(row) {
    try {
        return JSON.parse(row.content);
    } catch {
        return undefined;
    }
}

/** 分支 path（{floorNo: variantId}）→ 升序楼层号数组 */
export function pathFloors(path) {
    return Object.keys(path || {}).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

/**
 * 模型 → 指定分支的 path（宿主那份 body 的投影基准；无模型返回 {}）。
 * T1：默认取活跃分支；原生分支/检查点键要传**该键所在分支**（`branchId`），
 * 否则在分支聊天里改消息会按父分支的下标投影 → 写错行。
 */
export function activePathOf(model, branchId) {
    const id = branchId ?? model?.active_branch;
    const b = model?.branches?.find((x) => x.id === id);
    return b?.path || {};
}

/**
 * 按分支 path 从行表投影出**有序消息行**（宿主 body 的那一份）。
 * 读路径（seam）与双写落盘（mirror）共用同一份投影，保证「库里看到的」与「文件里写下的」
 * 永远是同一序列。
 * @param {object} path 分支 path（{floorNo: variantId}）
 * @param {Array<{floorNo:number, variantId:string, content:string}>} rows 家族全部行
 * @returns {Array<object>} 解析后的消息行（缺行/不可解析的行跳过——库不自洽时宁缺不崩）
 */
export function projectionOf(path, rows) {
    const byKey = new Map((rows || []).map((r) => [`${r.floorNo}#${r.variantId}`, r]));
    const out = [];
    for (const f of pathFloors(path)) {
        const row = byKey.get(`${f}#${path[f]}`);
        if (!row) continue;
        try {
            out.push(JSON.parse(row.content));
        } catch { /* 不可解析行跳过 */ }
    }
    return out;
}

/**
 * 行表写回：按 (floorNo, variantId) upsert，再按键删除。
 * @param {Array} rows 库内现有行
 * @param {Array} upserts planBodyPatch 产出的行
 * @param {Array<{floorNo:number, variantId:string}>} deletes
 */
export function applyRowWrites(rows, upserts, deletes) {
    const byKey = new Map((rows || []).map((r) => [`${r.floorNo}#${r.variantId}`, r]));
    for (const d of deletes || []) byKey.delete(`${d.floorNo}#${d.variantId}`);
    for (const u of upserts || []) byKey.set(`${u.floorNo}#${u.variantId}`, u);
    return [...byKey.values()].sort((a, b) => a.floorNo - b.floorNo || (a.seq ?? 0) - (b.seq ?? 0) || String(a.variantId).localeCompare(String(b.variantId)));
}

/** 元素级路径头：`/N` / `/-` → 下标（`-` = 追加位）；非数组下标形态返回 null */
function elementIndex(token, len) {
    if (token === '-') return len;
    return /^(0|[1-9]\d*)$/.test(String(token)) ? Number(token) : null;
}

/**
 * 应用一批消息补丁到「活跃分支投影」上，并按键写回行表。
 *
 * **两个分支要分清（W6 修复，2026-09-26）**：
 *   · `branchId` = **投影基准**：ops 的下标是对着它的 body 算的。原生分支/检查点键各有各的
 *     body，必须按**该键所在分支**投影；切分支时 ops 是对着**切换前**的 body 算的。
 *   · `targetBranchId` = **结构收敛目标**：补丁应用完之后 body 应当等于它的投影；被改写的
 *     path 也是它。切分支时 = 目标分支；不切换时两条相同。
 * 把两者合成一个参数会坏两件事：拿目标当投影基准 → 下标对不上（真机实录
 * `projection-incomplete｜楼层 1 的变体 g1 在库中无行`、`test-failed｜/3`）；拿基准当收敛目标 →
 * 切分支被误判成「删层」、目标分支的 path 不更新。
 *
 * @param {object} args
 * @param {Array<{floorNo:number, variantId:string, content:string, sendDate?:any}>} args.rows 家族全部行
 * @param {object} args.path 投影基准分支的 path（{floorNo: variantId}）——宿主那份 body 的投影基准
 * @param {Array<{op:string, path:string, value?:any, from?:string}>} args.ops 宿主 ops
 * @param {string} [args.branchId] 投影基准分支；未传 = 入向模型的 active_branch
 * @param {string} [args.targetBranchId] 结构收敛目标分支；未传 = 投影基准分支
 * @param {object|null} [args.model] 入向模型（含目标分支 path；用于「换变体/追加」的变体身份判定）
 * @param {Function} [args.allocateGid] 新变体号分配器（入参 = 已占用 gid 集合）
 * @returns {{ok:true, rows:Array, deletes:Array<{floorNo:number,variantId:string}>, path:object, model:object|null, stats:object}
 *          | {ok:false, reason:string, detail?:string}}
 */
export function planBodyPatch({ rows, path, ops, model = null, branchId = null, targetBranchId = null, allocateGid }) {
    const basisId = branchId ?? model?.active_branch ?? null;
    const convergeId = targetBranchId ?? basisId;
    const allRows = Array.isArray(rows) ? rows : [];
    const rowAt = new Map();
    for (const r of allRows) rowAt.set(`${r.floorNo}#${r.variantId}`, r);

    /* ── 1. 投影：活跃分支 path → 有序元素（每个元素带变体身份） ── */
    const baseFloors = pathFloors(path);
    const items = []; // [{ gid, line }]，下标 i ↔ 楼层 i+1
    for (const f of baseFloors) {
        const gid = path[f];
        const row = rowAt.get(`${f}#${gid}`);
        if (!row) return { ok: false, reason: 'projection-incomplete', detail: `楼层 ${f} 的变体 ${gid} 在库中无行` };
        const line = parseRowContent(row);
        if (line === undefined) return { ok: false, reason: 'row-content-unparsable', detail: `${f}#${gid}` };
        items.push({ gid, line });
    }
    // origins[i] = 新位置 i 来自旧投影的哪个下标（null = 本次新插入）
    const origins = items.map((_, i) => i);
    const oldLen = items.length;
    let midInsert = false; // 中间插入真新行（无既有变体可对应）

    /* ── 2. 逐条应用 ops ── */
    for (const raw of ops || []) {
        if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid-op', detail: String(raw) };
        const op = String(raw.op || '').trim().toLowerCase();
        let tokens;
        try {
            tokens = parsePointer(raw.path);
        } catch (e) {
            return { ok: false, reason: 'invalid-path', detail: String(e?.message || e) };
        }
        if (!tokens.length) return { ok: false, reason: 'root-path-unsupported', detail: String(raw.path) };
        const idx = elementIndex(tokens[0], items.length);
        if (idx === null) return { ok: false, reason: 'non-index-path', detail: String(raw.path) };

        if (tokens.length === 1) {
            /* 元素级：整行增删改与 test */
            if (op === 'test') {
                if (idx >= items.length || !deepEqual(items[idx].line, raw.value)) {
                    return { ok: false, reason: 'test-failed', detail: String(raw.path) };
                }
            } else if (op === 'remove') {
                if (idx >= items.length) return { ok: false, reason: 'index-out-of-range', detail: String(raw.path) };
                items.splice(idx, 1);
                origins.splice(idx, 1);
            } else if (op === 'add') {
                if (idx > items.length) return { ok: false, reason: 'index-out-of-range', detail: String(raw.path) };
                if (idx < items.length) midInsert = true; // 尾部追加（idx === 长度）才是支持的插入
                items.splice(idx, 0, { gid: null, line: clone(raw.value) });
                origins.splice(idx, 0, null);
            } else if (op === 'replace') {
                if (idx >= items.length) return { ok: false, reason: 'index-out-of-range', detail: String(raw.path) };
                const holder = { el: items[idx].line };
                try {
                    applyOpsToObject(holder, [{ op: 'replace', path: '/el', value: clone(raw.value) }]);
                    items[idx].line = holder.el;
                } catch (e) {
                    return { ok: false, reason: 'apply-failed', detail: String(e?.message || e) };
                }
            } else if (op === 'move' || op === 'copy') {
                const srcTokens = (() => {
                    try { return parsePointer(raw.from); } catch { return []; }
                })();
                const sidx = srcTokens.length === 1 ? elementIndex(srcTokens[0], items.length) : null;
                if (sidx === null || sidx >= items.length) {
                    return { ok: false, reason: 'unsupported-op', detail: `${op} from=${raw.from}` };
                }
                if (idx > items.length) return { ok: false, reason: 'index-out-of-range', detail: String(raw.path) };
                const moving = clone(items[sidx].line);
                const movingOrigin = origins[sidx];
                if (op === 'move') {
                    items.splice(sidx, 1);
                    origins.splice(sidx, 1);
                }
                items.splice(idx, 0, { gid: null, line: moving });
                origins.splice(idx, 0, movingOrigin);
                if (idx < items.length - 1) midInsert = true;
            } else {
                return { ok: false, reason: 'unsupported-op', detail: op };
            }
        } else {
            /* 字段级（含更深嵌套）：把路径头剥掉，作用于该元素本体 */
            if (idx >= items.length) return { ok: false, reason: 'index-out-of-range', detail: String(raw.path) };
            const holder = { el: items[idx].line };
            try {
                applyOpsToObject(holder, [{ ...raw, path: '/el/' + joinPointer(tokens.slice(1)) }]);
                items[idx].line = holder.el;
            } catch (e) {
                const msg = String(e?.message || e);
                return { ok: false, reason: /test 不通过/.test(msg) ? 'test-failed' : 'apply-failed', detail: msg };
            }
        }
    }

    /* ── 3. 变体身份判定：插入/换变体的位置优先沿用目标分支声明的变体 ── */
    const targetPath = model?.branches?.find((b) => b.id === convergeId)?.path || null;
    const candAt = (floor) => (targetPath ? targetPath[floor] : undefined);
    const rowContentMatches = (floor, gid, line) => {
        const row = rowAt.get(`${floor}#${gid}`);
        if (!row) return 'absent'; // 目标声明了该变体但库里还没有行 → 本次补丁创建它
        return deepEqual(parseRowContent(row), line) ? 'match' : 'differs';
    };
    let allocated = null;
    const nextGid = () => {
        if (!allocated) {
            const used = new Set(allRows.map((r) => r.variantId));
            for (const it of items) if (it.gid) used.add(it.gid);
            for (const gid of Object.keys(model?.groups || {})) used.add(gid); // 折叠组的号也要避开
            for (const b of model?.branches || []) for (const gid of Object.values(b.path || {})) used.add(gid);
            allocated = typeof allocateGid === 'function' ? allocateGid(used) : defaultAllocateGid(used);
        }
        const g = allocated;
        allocated = incrementGid(allocated);
        return g;
    };
    for (let i = 0; i < items.length; i++) {
        const floor = i + 1;
        const oldGid = origins[i] === null ? null : path[origins[i] + 1];
        const cand = candAt(floor);
        if (oldGid === null) {
            // 新插入位置：目标分支已声明该层变体 → 沿用（分支切换 / 追加登记）
            if (cand && rowContentMatches(floor, cand, items[i].line) !== 'differs') items[i].gid = cand;
            else items[i].gid = nextGid();
        } else if (cand && cand !== oldGid && rowContentMatches(floor, cand, items[i].line) === 'match') {
            // 同一位置换了变体（重投影以 replace 形态表达时）→ 采用目标分支的变体
            items[i].gid = cand;
        } else {
            items[i].gid = oldGid;
        }
    }
    const resolvedPath = {};
    for (let i = 0; i < items.length; i++) resolvedPath[i + 1] = items[i].gid;

    /* ── 4. 结构语义：重投影 / 删层 / 追加 ── */
    const newLen = items.length;
    const sameAsTarget = targetPath !== null && pathFloors(targetPath).length === newLen
        && pathFloors(targetPath).every((f) => targetPath[f] === resolvedPath[f]);
    let nextModel = model ? clone(model) : null;
    const nextPathForBranch = resolvedPath;
    // 本次补丁是不是「切分支」：投影基准与收敛目标不同 —— 切分支时**不得**走全局删层语义
    // （那会把来源分支的历史按目标分支的长度截断）。来源分支的 path 原样保留，只是它的行
    // 不再出现在 body 里（折叠），这正是分支语义。
    const switching = Boolean(basisId) && convergeId !== basisId;

    if (!sameAsTarget && !switching && newLen < oldLen) {
        // 全局删层：所有分支失去被删楼层、后续楼层前移（与 deleteFloorEverywhere 同语义）
        const keptOld = new Set(origins.filter((o) => o !== null));
        const gone = new Set(baseFloors.filter((_, i) => !keptOld.has(i)));
        const remap = (p) => {
            const np = {};
            for (let i = 0; i < origins.length; i++) {
                const o = origins[i];
                if (o === null) continue; // 该新位置由收敛目标独占（切分支），其他分支不占位
                const gid = p[o + 1];
                if (gid !== undefined) np[i + 1] = gid;
            }
            return np;
        };
        if (nextModel) {
            nextModel.branches = (nextModel.branches || []).map((b) => (
                b.id === convergeId ? { ...b, path: nextPathForBranch } : { ...b, path: remap(b.path || {}) }
            ));
            // 折叠组的楼层号随全局删层前移；落在被删楼层的组丢弃
            const groups = {};
            for (const [gid, g] of Object.entries(nextModel.groups || {})) {
                if (gone.has(g.floor)) continue;
                const below = [...gone].filter((f) => f < g.floor).length;
                groups[gid] = { ...g, floor: g.floor - below };
            }
            nextModel.groups = groups;
        }
    } else if (!sameAsTarget && newLen > oldLen) {
        if (midInsert) return { ok: false, reason: 'mid-insert-unsupported', detail: `插入位置 <${oldLen}` };
        if (nextModel) {
            nextModel.branches = (nextModel.branches || []).map((b) => (b.id === convergeId ? { ...b, path: nextPathForBranch } : b));
        }
    } else if (nextModel) {
        // 重投影 / 同长编辑 / 切分支：只把收敛目标分支的 path 收敛到解析结果（其他分支原样保留）
        nextModel.branches = (nextModel.branches || []).map((b) => (b.id === convergeId ? { ...b, path: nextPathForBranch } : b));
    }

    /* ── 5. 行表写回：被引用的行 upsert，已无任何分支在「该楼层」引用的旧行删除 ── */
    // 行 (F, G) 存活判据 = 某分支的 path 把楼层 F 指向 G。变体换层后旧键行必须删掉
    // （只按「变体是否还被引用」判断会留下 (旧楼层, 同一变体) 的孤儿行）。
    const liveKeys = new Set();
    const refSource = nextModel?.branches?.length ? nextModel.branches.map((b) => b.path || {}) : [nextPathForBranch];
    for (const p of refSource) {
        for (const [f, gid] of Object.entries(p || {})) liveKeys.add(`${Number(f)}#${gid}`);
    }
    for (const [f, gid] of Object.entries(nextPathForBranch)) liveKeys.add(`${Number(f)}#${gid}`);

    const upserts = items.map((it, i) => {
        const prev = rowAt.get(`${i + 1}#${it.gid}`);
        return {
            floorNo: i + 1,
            variantId: it.gid,
            seq: prev?.seq ?? 0,
            content: JSON.stringify(it.line),
            contentHash: null,
            sendDate: it.line?.send_date ?? null,
        };
    });
    // 全局删层会改变**其他分支**的楼层号：这些行必须按新键重写，否则会被下面的存活判据删掉
    // （只按活跃投影 upsert 的写法会让非活跃分支的 path 指向不存在的行）。
    const covered = new Set(upserts.map((u) => `${u.floorNo}#${u.variantId}`));
    const byVariant = new Map();
    for (const r of allRows) if (!byVariant.has(r.variantId)) byVariant.set(r.variantId, r);
    const splitKey = (k) => {
        const i = k.indexOf('#');
        return [Number(k.slice(0, i)), k.slice(i + 1)];
    };
    for (const key of liveKeys) {
        if (covered.has(key)) continue;
        const [floorNo, variantId] = splitKey(key);
        const src = rowAt.get(key) || byVariant.get(variantId);
        if (!src) continue; // 无源行（新变体，理应已由活跃投影覆盖）：不凭空造行
        upserts.push({
            floorNo, variantId, seq: src.seq ?? 0, content: src.content,
            contentHash: src.contentHash ?? null, sendDate: src.sendDate ?? null,
        });
    }

    const deletes = allRows
        .filter((r) => !liveKeys.has(`${r.floorNo}#${r.variantId}`))
        .map((r) => ({ floorNo: r.floorNo, variantId: r.variantId }));

    return {
        ok: true,
        rows: upserts,
        deletes,
        path: nextPathForBranch,
        model: nextModel,
        // 供上层日志/断言：投影重排的规模
        stats: { oldLen, newLen, remapped: remapCount(origins), deletes: deletes.length },
    };
}

/** origins 中「位置发生变化」的计数（诊断用） */
function remapCount(origins) {
    let n = 0;
    for (let i = 0; i < origins.length; i++) if (origins[i] !== i) n++;
    return n;
}

/** 默认变体号分配：g<n> 递增（与 branches.nextGroupId 同形） */
function defaultAllocateGid(used) {
    let max = 0;
    for (const gid of used) {
        const m = /^g(\d+)$/.exec(String(gid));
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `g${max + 1}`;
}

/** 分配器自增（`g7` → `g8`；非 g<n> 形态则退回默认分配） */
function incrementGid(gid) {
    const m = /^g(\d+)$/.exec(String(gid));
    return m ? `g${Number(m[1]) + 1}` : gid;
}
