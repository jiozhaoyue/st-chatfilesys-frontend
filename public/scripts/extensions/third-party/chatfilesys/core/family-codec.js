/**
 * ChatFilesys — v2 原始行 codec（**纯函数**）
 *
 * 契约：`.trellis/spec/frontend/family-operation-v2.md` §2 规则 3/4/5 + design-v2.md「模型与投影」。
 * 职责：Family 的逐分支投影（`projectBranch`）——v2 模型 → 原生聊天行（含 header）。
 *
 * ── 投影规则（改代码前先读）──
 * · **dirty=false → 直接克隆 `rawRows[rawRowRef]` 整行**：未知字段、原始三件套
 *   （swipes/swipe_info/swipe_id）、异常但可保留的元数据**一字不动**（未编辑投影保持原数组顺序）；
 * · **dirty=true → 按选中 ID 与可见集重组三件套**：主体 = 所选版本的 raw；
 *   `swipes` = 可见集各版本的 mes；`swipe_info` = **完整克隆每条 swipeInfo（未知字段全带）**；
 *   `swipe_id` = 所选 versionId 在可见集里的下标（**selected 用 versionId 映射，不存排序后下标**）；
 *   可见集只剩一版时不生成三件套（裸单行）；
 * · 分支 header（含未知字段）作为投影**首元素**返回；
 * · opaque 消息（无 `mes` 的合法 JSON 行）走 dirty=false 原样带出，**不吞行**；
 * · 引用损坏（rawRowRef 缺失 / 所选不在可见集）→ `invalid-reference`，**不静默造空行**。
 */

function fail(code, msg) {
    const e = new Error(`[${code}] ${msg}`);
    e.code = code;
    throw e;
}

/** 三件套键（与 `projection.js#groupFromLine` 同一组；重排时先剥后建） */
const TRIPLET_KEYS = ['swipes', 'swipe_info', 'swipe_id'];

/**
 * 单个 entry → 原生聊天行。
 * @param {object} family v2 Family
 * @param {object} Entry（family-operation-v2.md §2）
 * @returns {object} 原生行（新对象；不改输入）
 */
export function entryRow(family, entry) {
    if (!entry || typeof entry !== 'object') fail('invalid-reference', 'entry 非对象');
    if (entry.dirty !== true) {
        const rawRow = family?.rawRows?.[entry.rawRowRef];
        if (!rawRow || typeof rawRow !== 'object') {
            fail('invalid-reference', `rawRowRef 缺失：${entry.rawRowRef}`);
        }
        return structuredClone(rawRow);
    }
    // dirty=true：按选中 ID 与可见集重组
    const versions = family?.messages?.[entry.messageId]?.versions;
    if (!versions) fail('invalid-reference', `消息缺失：${entry.messageId}`);
    const vis = Array.isArray(entry.visibleVersionIds) ? entry.visibleVersionIds : [];
    const selected = entry.selectedVersionId;
    if (!versions[selected]) fail('invalid-reference', `所选版本不存在：${entry.messageId}.${selected}`);
    if (!vis.includes(selected)) fail('invalid-reference', `所选版本 ${selected} 不在可见集`);

    const base = structuredClone(versions[selected].raw ?? {});
    for (const k of TRIPLET_KEYS) delete base[k];
    if (vis.length <= 1) return base; // 单可见版本：裸单行

    const row = base;
    row.swipes = vis.map((id) => {
        const v = versions[id];
        if (!v) fail('invalid-reference', `可见版本不存在：${entry.messageId}.${id}`);
        return v.raw?.mes;
    });
    // 完整克隆每条 swipeInfo（未知字段全带）；版本自身无 swipeInfo 时回退 raw 的 send_date/extra
    row.swipe_info = vis.map((id) => {
        const v = versions[id];
        if (v.swipeInfo && typeof v.swipeInfo === 'object') return structuredClone(v.swipeInfo);
        const si = {};
        if (v.raw?.send_date !== undefined) si.send_date = v.raw.send_date;
        if (v.raw?.extra !== undefined) si.extra = structuredClone(v.raw.extra);
        return si;
    });
    row.swipe_id = vis.indexOf(selected);
    return row;
}

/**
 * 逐分支投影：`[header, ...各行]`（含 header，spec §2 `projectBranch` 签名）。
 * 纯读 —— 不改 family、rawRows；每次返回新对象。
 * @returns {Array<object>}
 */
export function projectBranch(family, branchId) {
    const branch = family?.branches?.[branchId];
    if (!branch) fail('invalid-reference', `分支不存在：${branchId}`);
    const out = [structuredClone(branch.header ?? {})];
    for (const entry of Array.isArray(branch.entries) ? branch.entries : []) {
        out.push(entryRow(family, entry));
    }
    return out;
}
