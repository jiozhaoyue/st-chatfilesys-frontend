/**
 * ChatFilesys — 旧家族隔离迁移（**纯函数**，不碰源库）
 *
 * 契约：`.trellis/spec/frontend/family-operation-v2.md` §2「旧数据映射」+ design-v2.md「迁移顺序」。
 * 输入 = 旧家族完整快照 `{header, body, model, storedRows, keyBindings}`；
 * 输出 = v2 Family（或 `{ok:false, code, paths}` 路径报告）。**任何失败都不产生半个家族**。
 *
 * ── 迁移纪律（改代码前先读）──
 * · **按 gid / variantId 引用逐分支重建，不按 floorNo 聚合**——旧 store-bridge 把同 floorNo
 *   的多行折叠成一个组是**已知缺陷**（spec §1 现状证据）；三个私有组同 floorNo 必须成为
 *   三个不同消息。共享 gid（跨分支 path 引用同一 gid）⇒ 同一 messageId（身份共享的正确来源）；
 * · 每个旧 gid → 新 messageId（`m_<gid>`）；组内每个完整 raw → versionId（`v_<gid>_<k>`）；
 *   旧 `swipe_id` / 组 `active` → 该分支 selected。**旧结构共享选择时不虚构历史**：
 *   同 gid 各分支 selected 一致（旧模型本就共享一行）；
 * · 三件套行（swipes.length>1）→ 逐 swipe 拆版本；**每条 swipeInfo 未知字段进 version.swipeInfo
 *   原样保全**（不走 `groupFromLine`——它只留 send_date/extra，会丢未知字段）；
 *   组折叠形态（model.groups）→ 复用 `lineFromGroup` 单点还原原生行；
 * · 无 `mes` 的合法 JSON 行 → **opaque 原样保留**（message 记 `opaque:true`），不吞行；
 * · 缺引用（path 引用的 gid 无任何数据 / body 行数不足）→ `missing-reference` + 路径定位，
 *   **不造空行凑数**；
 * · keyBindings 逐项保全；检查点 `markerFloor` → `markerMessageId`（按**目标分支** path 映射，
 *   不按活跃分支猜）；无法映射 → null + warning，不猜；
 * · 收尾自检：`validateFamily` 不 ok → 整体 `migrated-invalid` 失败，不发布。
 */

import { lineFromGroup } from './projection.js';
import { validateFamily } from './family-state.js';

const TRIPLET_KEYS = ['swipes', 'swipe_info', 'swipe_id'];

const bad = (code, paths) => ({ ok: false, code, paths });
const maxFloorOf = (path) => Math.max(0, ...Object.keys(path || {}).map(Number));

/** 三件套行 → 版本数组（逐 swipe 拆；swipeInfo 未知字段保全）；否则单版本。 */
function decomposeRow(gid, row) {
    if (Array.isArray(row?.swipes) && row.swipes.length > 1) {
        const info = Array.isArray(row.swipe_info) ? row.swipe_info : [];
        const base = { ...structuredClone(row) };
        for (const k of TRIPLET_KEYS) delete base[k];
        const versions = row.swipes.map((mes, k) => ({
            raw: {
                ...structuredClone(base),
                mes,
                send_date: info[k]?.send_date !== undefined ? info[k].send_date : row.send_date,
                extra: info[k]?.extra !== undefined ? structuredClone(info[k].extra) : structuredClone(row.extra),
            },
            swipeInfo: info[k] ? structuredClone(info[k]) : null,
            sourceRefs: [`legacy:gid:${gid}#${k}`],
        }));
        const selectedIdx = Number.isInteger(row.swipe_id) && row.swipe_id >= 0 && row.swipe_id < versions.length
            ? row.swipe_id : 0;
        return { versions, selectedIdx };
    }
    return {
        versions: [{ raw: structuredClone(row), swipeInfo: null, sourceRefs: [`legacy:gid:${gid}`] }],
        selectedIdx: 0,
    };
}

/**
 * 旧家族 → v2 Family（隔离迁移）。
 * @param {{header:object, body:Array, model:object, storedRows:Array, keyBindings?:object}} input
 * @param {{libraryId?:string, familyId?:string, revision?:string, characterId?:string|null}} [opts]
 * @returns {{ok:true, family:object, warnings?:string[]}
 *          |{ok:false, code:string, paths:string[]}}
 */
export function importLegacy(input, opts = {}) {
    const warnings = [];
    const header = input?.header;
    if (!header || typeof header !== 'object') return bad('legacy-header', ['$.header']);
    const model = input?.model;
    const branches = Array.isArray(model?.branches) ? model.branches : [];
    if (!model || typeof model !== 'object' || branches.length === 0) return bad('legacy-model', ['$.model.branches']);
    const body = Array.isArray(input?.body) ? input.body : [];
    const storedRows = Array.isArray(input?.storedRows) ? input.storedRows : [];
    const groups = (model.groups && typeof model.groups === 'object') ? model.groups : {};
    const branchIds = new Set(branches.map((b) => b?.id));

    const activeBranch = branches.find((b) => b?.id === model.active_branch)
        || branches.find((b) => b?.is_default) || branches[0];
    const activePath = activeBranch?.path || {};
    const activeMax = maxFloorOf(activePath);
    if (body.length < activeMax) {
        return bad('missing-reference', [`$.body（${body.length} 行 < 活跃分支 ${activeMax} 楼）`]);
    }

    // ── 引用登记：被任何分支 path 引用的 gid（含活跃）；storedRows 的行身份 ──
    const referencedGids = new Set();
    for (const b of branches) for (const gid of Object.values(b?.path || {})) referencedGids.add(gid);

    // ── ① 收集每个 gid 的 canonical 原生行（先活跃 body，再 groups，再 storedRows） ──
    const gidRow = new Map();      // gid → canonical 原生行
    const gidExtra = new Map();    // gid → [同楼孤儿行]（variantId 无分支引用，但同 floorNo 有归属）
    const miss = [];

    for (let f = 1; f <= activeMax; f += 1) {
        const gid = activePath[f];
        if (!gid) continue;
        const row = body[f - 1];
        if (!row || typeof row !== 'object') { miss.push(`$.body[${f - 1}]:gid:${gid}`); continue; }
        gidRow.set(gid, row);
    }
    // storedRows：被引用的 variantId → canonical；未被引用 → 同楼孤儿
    for (const sr of storedRows) {
        if (!sr || typeof sr.content !== 'string') continue;
        let row;
        try {
            row = JSON.parse(sr.content);
        } catch {
            miss.push(`$.storedRows[variantId:${sr.variantId}]（内容非合法 JSON）`);
            continue;
        }
        if (!row || typeof row !== 'object') continue;
        if (referencedGids.has(sr.variantId)) {
            if (!gidRow.has(sr.variantId)) gidRow.set(sr.variantId, row);
        } else if (!gidExtra.has(sr.variantId)) {
            gidExtra.set(sr.variantId, row); // 先登记为孤儿，稍后按 floorNo 找归属
        }
    }
    // groups（内存折叠态）：仍是孤儿的 gid → lineFromGroup 还原原生行
    for (const [gid, g] of Object.entries(groups)) {
        if (referencedGids.has(gid) && !gidRow.has(gid)) gidRow.set(gid, lineFromGroup(g));
    }
    // 其余被引用但尚无数据的 gid → 逐分支定位报缺
    for (const b of branches) {
        const path = b?.path || {};
        for (const [f, gid] of Object.entries(path)) {
            if (!gidRow.has(gid)) miss.push(`branches.${b.id}.floor.${f}:gid:${gid}`);
        }
    }
    if (miss.length) return bad('missing-reference', miss);

    // 孤儿行按 floorNo 归属：挂在「该 floorNo 上被引用的那个 gid」名下作额外版本（不吞数据）
    for (const [orphanId, row] of gidExtra) {
        const floor = Number(storedRows.find((sr) => sr?.variantId === orphanId)?.floorNo);
        let attached = false;
        if (Number.isInteger(floor) && floor >= 1) {
            for (const b of branches) {
                const gid = b?.path?.[floor];
                if (gid && gidRow.has(gid)) {
                    if (!gidExtra.has(gid)) gidExtra.set(gid, []);
                    gidExtra.get(gid).push(row);
                    attached = true;
                    break;
                }
            }
        }
        if (!attached) warnings.push(`storedRows 孤儿行 ${orphanId}（floor ${floor}）无归属分支，未迁入家族`);
    }

    // ── ② gid → 消息 / 版本（每个 gid 一个 messageId；每个 raw 一个 versionId） ──
    const messages = {};
    const rawRows = {};
    const gidVersions = new Map(); // gid → {ids:[versionId], selectedIdx}
    for (const [gid, row] of gidRow) {
        const { versions, selectedIdx } = decomposeRow(gid, row);
        const ids = [];
        const versionMap = {};
        versions.forEach((v, k) => {
            const vid = `v_${gid}_${k}`;
            ids.push(vid);
            versionMap[vid] = v;
        });
        for (const extra of gidExtra.get(gid) || []) {
            const k = ids.length;
            const vid = `v_${gid}_${k}`;
            ids.push(vid);
            versionMap[vid] = { raw: structuredClone(extra), swipeInfo: null, sourceRefs: [`legacy:orphan:${gid}#${k}`] };
        }
        const rec = { versions: versionMap };
        if (typeof row.mes !== 'string') rec.opaque = true; // 无 mes 的合法 JSON 行：原样保留，不吞
        messages[`m_${gid}`] = rec;
        rawRows[`rw_${gid}`] = structuredClone(row);
        gidVersions.set(gid, { ids, selectedIdx });
    }

    // ── ③ 逐分支建 entries（共享 gid ⇒ 同 messageId / 同版本集 / 同 selected —— 不虚构历史） ──
    const branchRecords = {};
    for (const b of branches) {
        const path = b?.path || {};
        const entries = [];
        for (let f = 1; f <= maxFloorOf(path); f += 1) {
            const gid = path[f];
            const vd = gidVersions.get(gid);
            if (!vd) continue; // 已在上面 miss 收口，不会到这
            entries.push({
                messageId: `m_${gid}`,
                visibleVersionIds: vd.ids,
                selectedVersionId: vd.ids[vd.selectedIdx] ?? vd.ids[0],
                rawRowRef: `rw_${gid}`,
                dirty: false,
            });
        }
        branchRecords[b.id] = {
            name: typeof b.name === 'string' ? b.name : String(b.id),
            isDefault: Boolean(b.is_default),
            header: structuredClone(header), // 旧模型一份 header 全家族共享 → 各分支各持克隆（逐项保全）
            entries,
            extensions: {},
        };
    }

    // ── ④ keyBindings 保全 + markerFloor → markerMessageId（按目标分支 path 映射，不猜） ──
    const keyBindings = {};
    for (const [key, kb] of Object.entries(input?.keyBindings || {})) {
        const out = {
            branchId: kb?.branchId ?? null,
            isCheckpoint: Boolean(kb?.isCheckpoint),
            markerMessageId: null,
        };
        if (out.isCheckpoint && kb?.markerFloor != null) {
            const target = branches.find((b) => b?.id === kb.branchId);
            const gid = target?.path?.[kb.markerFloor];
            if (gid && gidVersions.has(gid)) out.markerMessageId = `m_${gid}`;
            else warnings.push(`keyBindings.${key}：markerFloor ${kb.markerFloor} 在分支 ${kb.branchId} 无法映射，置 null`);
        }
        keyBindings[key] = out;
    }

    const family = {
        schemaVersion: 2,
        libraryId: opts.libraryId ?? 'lib-local',
        familyId: opts.familyId ?? 'fam-legacy',
        revision: opts.revision ?? 'rev-m0',
        activeBranchId: activeBranch.id,
        characterId: opts.characterId ?? null,
        branches: branchRecords,
        messages,
        rawRows,
        relations: [], // 旧模型无显式父（树由 fork_base/path 推断）——derived 关系由后续操作产生，不在此虚构
        keyBindings,
        extensions: {},
    };

    // ── 收尾自检：结构不合法 = 迁移失败（不发布半个家族） ──
    const v = validateFamily(family);
    if (!v.ok) return bad('migrated-invalid', v.paths);
    return warnings.length ? { ok: true, family, warnings } : { ok: true, family };
}
