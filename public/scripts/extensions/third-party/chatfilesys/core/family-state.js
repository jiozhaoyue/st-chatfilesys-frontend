/**
 * ChatFilesys — v2 家族状态层（**纯函数**）
 *
 * 契约：`.trellis/spec/frontend/family-operation-v2.md` §2（唯一 Family 结构与规则 1–9）。
 * 依据 implement-v2.md C1.1；本模块**无 I/O、无 DOM**（`L1-MR-6` 同构，可 100% 单测）。
 *
 * ── 核心不变量（改代码前先读）──
 * · **选择分支局部**（spec §2 规则 6）：select/hide 只动目标分支的 entry，A 切版本不暗改 B；
 * · **身份 ≠ 位置**（规则 2）：messageId 一经分配不复用，同正文两条消息是两个 messageId；
 *   楼层号 = entry 下标 + 1，纯派生量；
 * · **不可变**：所有操作先 `structuredClone` 再改，原对象一字不动（计划层要拿旧态做 digest）；
 * · **隐藏回退**（规则 6）：隐藏当前所选 → 展示序最近前项，无前项取后项；
 *   最后一版不许隐藏（`last-visible-version`，提示改用删除消息）；
 * · **展示序**（规则 4）：按 `swipe_info.send_date` 升序；缺失/不可解析者保原槽位，
 *   等日期按原下标 —— **selected 存 versionId，不存排序后下标**；
 * · manual 关系（规则 7）：一个分支至多一个 manual 父；禁自环/环；derived/inferred 不被覆盖。
 */

/** 带错误码抛错（错误矩阵见 spec §4；调用方按 code 分流，不解析中文消息） */
function fail(code, msg) {
    const e = new Error(`[${code}] ${msg}`);
    e.code = code;
    throw e;
}

/* ---------------- 日期与展示序（spec §2 规则 4） ---------------- */

/**
 * `swipeInfo.send_date` → 可比较键；数字直接用，字符串走 `Date.parse`；
 * 缺失 / 不可解析 ⇒ `null`（视同缺失，保原槽位）。
 */
function dateKeyOf(swipeInfo) {
    const d = swipeInfo?.send_date;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
    if (typeof d === 'string' && d.trim() !== '') {
        const t = Date.parse(d);
        if (!Number.isNaN(t)) return t;
    }
    return null;
}

/**
 * entry 的可见版本**展示序**（数组槽位 = `visibleVersionIds` 下标）：
 * 缺日期者钉在原槽位；有日期者在自己占用的槽位间按（日期，原下标）稳定升序重排。
 * 纯读函数 —— 不改任何输入。
 */
export function displayOrder(entry, family) {
    const versions = family?.messages?.[entry?.messageId]?.versions || {};
    const ids = Array.isArray(entry?.visibleVersionIds) ? entry.visibleVersionIds : [];
    const dated = [];
    ids.forEach((id, i) => {
        const t = dateKeyOf(versions[id]?.swipeInfo);
        if (t !== null) dated.push({ id, i, t });
    });
    const out = ids.slice();
    if (dated.length > 1) {
        const sorted = dated.slice().sort((a, b) => (a.t - b.t) || (a.i - b.i));
        dated.forEach((slot, k) => { out[slot.i] = sorted[k].id; });
    }
    return out;
}

/* ---------------- 定位守卫 ---------------- */

function requireBranchIds(family) {
    if (!family || typeof family !== 'object' || !family.branches || typeof family.branches !== 'object'
        || Array.isArray(family.branches)) {
        fail('invalid-reference', '家族缺少分支表');
    }
    return Object.keys(family.branches);
}

function requireBranch(family, branchId) {
    requireBranchIds(family);
    if (!(branchId in family.branches)) fail('invalid-reference', `分支不存在：${branchId}`);
    return family.branches[branchId];
}

function requireEntry(family, branchId, messageId) {
    const branch = requireBranch(family, branchId);
    if (!Array.isArray(branch.entries)) fail('invalid-reference', `分支 ${branchId} 的 entries 非数组`);
    const index = branch.entries.findIndex((e) => e?.messageId === messageId);
    if (index < 0) fail('invalid-reference', `分支 ${branchId} 未引用消息 ${messageId}`);
    return { branch, entry: branch.entries[index], index };
}

function requireVersion(family, messageId, versionId) {
    const versions = family?.messages?.[messageId]?.versions;
    if (!versions || !versions[versionId]) {
        fail('invalid-reference', `消息 ${messageId} 没有版本 ${versionId}`);
    }
    return versions[versionId];
}

/* ---------------- 校验（spec §2 / §4） ---------------- */

/**
 * 校验 Family 结构；不修改输入。
 * @returns {{ok:true, paths:[]} | {ok:false, code:string, paths:string[]}}
 *   `paths` 用 JSON-Path 风格定位（如 `$.branches.A.entries[0].selectedVersionId`）。
 */
export function validateFamily(family) {
    const paths = [];
    if (!family || typeof family !== 'object') return { ok: false, code: 'schema-version', paths: ['$'] };
    if (family.schemaVersion !== 2) paths.push('$.schemaVersion');

    const branchIds = (family.branches && typeof family.branches === 'object' && !Array.isArray(family.branches))
        ? Object.keys(family.branches) : [];
    if (branchIds.length === 0) paths.push('$.branches');
    if (!branchIds.includes(family.activeBranchId)) paths.push('$.activeBranchId');

    const defaults = branchIds.filter((id) => family.branches[id]?.isDefault === true);
    if (defaults.length > 1) paths.push('$.branches.isDefault');

    const messages = (family.messages && typeof family.messages === 'object') ? family.messages : {};
    const rawRows = (family.rawRows && typeof family.rawRows === 'object') ? family.rawRows : {};

    for (const bid of branchIds) {
        const b = family.branches[bid];
        if (!b || typeof b !== 'object') { paths.push(`$.branches.${bid}`); continue; }
        if (typeof b.name !== 'string') paths.push(`$.branches.${bid}.name`);
        if (!b.header || typeof b.header !== 'object' || Array.isArray(b.header)) paths.push(`$.branches.${bid}.header`);
        if (!Array.isArray(b.entries)) { paths.push(`$.branches.${bid}.entries`); continue; }
        b.entries.forEach((e, i) => {
            const at = `$.branches.${bid}.entries[${i}]`;
            if (!e || typeof e !== 'object') { paths.push(at); return; }
            const versions = messages[e.messageId]?.versions;
            if (!versions) { paths.push(`${at}.messageId`); return; }
            const vis = e.visibleVersionIds;
            if (!Array.isArray(vis) || vis.length === 0) {
                paths.push(`${at}.visibleVersionIds`); // 可见集非空（规则 2）
            } else {
                if (new Set(vis).size !== vis.length) paths.push(`${at}.visibleVersionIds`); // 无重复
                for (const vid of vis) if (!versions[vid]) paths.push(`${at}.visibleVersionIds`); // 版本存在
                if (!vis.includes(e.selectedVersionId)) paths.push(`${at}.selectedVersionId`); // selected ∈ 可见集
            }
            if (!rawRows[e.rawRowRef]) paths.push(`${at}.rawRowRef`);
        });
    }

    // keyBindings 的 branchId 必须存在（规则 9）
    const kb = (family.keyBindings && typeof family.keyBindings === 'object') ? family.keyBindings : {};
    for (const [k, v] of Object.entries(kb)) {
        if (!v || !branchIds.includes(v.branchId)) paths.push(`$.keyBindings.${k}`);
    }

    // relations：端点存在；manual 禁自环/多父/环（规则 7）
    const rels = Array.isArray(family.relations) ? family.relations : [];
    const manualParent = new Map(); // child → parent
    rels.forEach((r, i) => {
        const at = `$.relations[${i}]`;
        if (!r || typeof r !== 'object') { paths.push(at); return; }
        if (!['manual', 'inferred', 'derived'].includes(r.kind)) paths.push(`${at}.kind`);
        if (!branchIds.includes(r.fromBranchId) || !branchIds.includes(r.toBranchId)) { paths.push(at); return; }
        if (r.kind === 'manual') {
            if (r.fromBranchId === r.toBranchId) paths.push(`${at}.self`);
            else if (manualParent.has(r.fromBranchId)) paths.push(`${at}.multiple`);
            else manualParent.set(r.fromBranchId, r.toBranchId);
        }
    });
    for (const start of manualParent.keys()) {
        const seen = new Set([start]);
        let cur = manualParent.get(start);
        while (cur !== undefined) {
            if (seen.has(cur)) { paths.push(`$.relations.cycle:${start}`); break; }
            seen.add(cur);
            cur = manualParent.get(cur);
        }
    }

    return paths.length
        ? { ok: false, code: paths[0] === '$.schemaVersion' ? 'schema-version' : 'invalid-reference', paths }
        : { ok: true, paths: [] };
}

/* ---------------- 状态操作（全部克隆后修改，原对象不动） ---------------- */

/**
 * 切换分支对某消息的所选版本（spec §2 规则 6：分支局部）。
 * 只动目标分支的该 entry；版本必须存在且在可见集内。
 */
export function selectVersion(family, branchId, messageId, versionId) {
    const { index } = requireEntry(family, branchId, messageId);
    requireVersion(family, messageId, versionId);
    const entry = family.branches[branchId].entries[index];
    if (!entry.visibleVersionIds.includes(versionId)) {
        fail('version-not-visible', `版本 ${versionId} 不在分支 ${branchId} 楼层 ${messageId} 的可见集中`);
    }
    const next = structuredClone(family);
    next.branches[branchId].entries[index].selectedVersionId = versionId;
    return next;
}

/**
 * 从目标分支隐藏某版本（spec §2 规则 6）：只影响该分支；
 * 隐藏当前所选时回退到展示序最近前项（无前项取后项）；最后一版禁止隐藏。
 */
export function hideVersion(family, branchId, messageId, versionId) {
    const { index, entry } = requireEntry(family, branchId, messageId);
    requireVersion(family, messageId, versionId);
    if (!entry.visibleVersionIds.includes(versionId)) {
        fail('invalid-reference', `版本 ${versionId} 不在可见集中，无可隐藏`);
    }
    if (entry.visibleVersionIds.length <= 1) {
        fail('last-visible-version', '最后一版不许隐藏；要移除整层请用「删除消息」');
    }
    const preOrder = displayOrder(entry, family); // 移除前的展示序（含被隐藏者）
    const pos = preOrder.indexOf(versionId);
    const remaining = preOrder.filter((id) => id !== versionId);
    const next = structuredClone(family);
    const e = next.branches[branchId].entries[index];
    e.visibleVersionIds = remaining;
    if (e.selectedVersionId === versionId) {
        e.selectedVersionId = remaining[pos - 1] ?? remaining[pos] ?? remaining[0];
    }
    return next;
}

/**
 * 从目标分支删除消息（只删当前 entry；spec 规则 2：身份记录与仍引用它的分支不动；
 * 全引用清理 purge 归 C3）。
 */
export function deleteMessage(family, branchId, messageId) {
    requireEntry(family, branchId, messageId);
    const next = structuredClone(family);
    const entries = next.branches[branchId].entries;
    entries.splice(entries.findIndex((e) => e.messageId === messageId), 1);
    return next;
}

/**
 * 设人工谱系（spec §2 规则 7）：`childBranchId` 的 manual 父 = `parentBranchId`。
 * 至多一个 manual 父；禁自环与环；同父重复设置为幂等；derived/inferred 关系不受影响。
 */
export function setManualParent(family, childBranchId, parentBranchId) {
    requireBranch(family, childBranchId);
    requireBranch(family, parentBranchId);
    if (childBranchId === parentBranchId) fail('self-parent', '分支不能以自己为父');
    const relations = Array.isArray(family.relations) ? family.relations : [];
    const manualParent = new Map(); // child → parent（既有 manual 边）
    for (const r of relations) {
        if (r?.kind === 'manual') manualParent.set(r.fromBranchId, r.toBranchId);
    }
    if (manualParent.has(childBranchId)) {
        if (manualParent.get(childBranchId) === parentBranchId) return structuredClone(family); // 幂等
        fail('multiple-manual-parents', `分支 ${childBranchId} 已有 manual 父 ${manualParent.get(childBranchId)}`);
    }
    // 成环检测：从新父沿「父链」向上走，若回到 child 即环
    let cur = parentBranchId;
    const seen = new Set();
    while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        if (cur === childBranchId) fail('parent-cycle', `设父会成环：${childBranchId} → ${parentBranchId}`);
        cur = manualParent.get(cur);
    }
    // 分配唯一关系 id（创建后存入结果，重试复用由计划层保证；此处按现存数量编号并去重）
    const ids = new Set(relations.map((r) => r?.id));
    let n = relations.length + 1;
    let id;
    do { id = `rel-m${n}`; n += 1; } while (ids.has(id));
    const next = structuredClone(family);
    next.relations = [...(next.relations || []), {
        id, fromBranchId: childBranchId, toBranchId: parentBranchId,
        kind: 'manual', evidenceRefs: [],
    }];
    return next;
}
