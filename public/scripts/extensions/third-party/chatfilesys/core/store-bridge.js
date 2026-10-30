/**
 * ChatFilesys — 存储桥接（store-bridge，design.md §8.2）
 *
 * 库模型（适配器 family 形态）⇄ 现有 UI 模型（chat_metadata.extensions.chatfilesys 形态）互转：
 * - 现有 UI（分叉/切换/树/徽章/标记）全部消费「现有模型 + ctx().chat」；seam 拼装 get 响应时
 *   经本模块把库形态装配成现有模型 → 全部 UI 零改动。
 * - gid ≡ variantId（design.md §8.1：库行 variantId 采用 gid 格式 g<序号>，纯映射无语义冲突）。
 *
 * 纯函数：无 DOM、无网络、无适配器依赖。
 */

import { nextIntegrity } from './integrity.js';
import { importLegacy } from './legacy-family-migration.js';

/**
 * 库 family + 楼层行 → 现有模型形态（含 groups 折叠组重建）。
 * @param {object} family 适配器 loadFamily 返回（branches/branchPaths/model）
 * @param {Array<{floorNo, variantId, seq, content, contentHash, sendDate}>} floors 活跃分支外的全部楼层行（含折叠组）
 * @returns 现有 chatfilesys 模型：{ active_branch, branches:[{id,name,is_default,fork_base,path}], groups }
 */
export function modelFromStore(family, floors) {
    const branches = (family.branches || []).map((b) => ({
        id: b.id,
        name: b.name,
        is_default: Boolean(b.is_default),
        fork_base: b.fork_floor ?? b.fork_base ?? 0,
        path: { ...(family.branchPaths?.[b.id] || {}) },
    }));
    const activeId = family.model?.active_branch
        ?? (branches.find((b) => b.is_default) || branches[0])?.id ?? null;
    const active = branches.find((b) => b.id === activeId);
    const activeGids = new Set(active ? Object.values(active.path) : []);

    // groups 重建：非活跃分支引用的变体折叠（同 floorNo 多行 = 多变体，floorNo→组）
    const byFloor = new Map();
    for (const f of floors || []) {
        if (activeGids.has(f.variantId)) continue; // 活跃分支行留在 body，不进 groups
        const g = byFloor.get(f.floorNo) || { floor: f.floorNo, variants: [], active: 0 };
        g.variants.push({
            ...JSON.parse(f.content),
            send_date: f.sendDate ?? null,
        });
        byFloor.set(f.floorNo, g);
    }
    const groups = {};
    for (const [floorNo, g] of byFloor) {
        // 组 id = 该 floorNo 上被非活跃分支引用的 variantId（首个）
        const gid = (floors.find((f) => f.floorNo === floorNo && !activeGids.has(f.variantId)) || {}).variantId
            || `g${floorNo}`;
        groups[gid] = g;
    }

    return { active_branch: activeId, branches, groups };
}

/**
 * 现有模型 → 库 family meta（隐藏容器/SQL families 表用）。
 * @param {object} model 现有 chatfilesys 模型
 * @param {{familyId, chatKey, characterId, name, integrity}} identity 家族身份
 * @returns 库 meta 形态（branches/branchPaths + 身份字段）
 */
export function storeFromModel(model, identity) {
    const branches = (model.branches || []).map((b) => ({
        id: b.id,
        name: b.name,
        is_default: Boolean(b.is_default),
        fork_floor: b.fork_base ?? 0,
        parent_branch_id: null, // M1 不维护显式父（树由 path 推断，同 tree.js inferParent）
    }));
    const branchPaths = {};
    for (const b of model.branches || []) branchPaths[b.id] = { ...b.path };
    return {
        familyId: identity.familyId,
        chatKey: identity.chatKey,
        characterId: identity.characterId,
        name: identity.name,
        integrity: identity.integrity ?? nextIntegrity(), // T1/N19：新建家族即拿字符串版本号
        branches,
        branchPaths,
    };
}

/**
 * 投影 ops → 库 applyOps 输入格式（RFC6902 语义桥）。
 * 现有写路径产生的 ops（planSwitch/planDeleteFloor）路径为 /<index>，与库侧 applyOps
 * 的数组重排语义一一对应——本函数在 M1 阶段为恒等透传，保留接缝供库侧格式演进
 * （无包袱铁律：格式演进时此层可破坏性重写）。
 * @param {Array<{op, path, value?}>} ops
 * @returns {Array<{op, path, value?}>}
 */
export function opsToStoreOps(ops) {
    return ops || [];
}

/**
 * v2 桥（family-operation-v2.md §2「旧数据映射」）：旧适配器形态 → **v2 Family**。
 *
 * 旧输入只**转发给迁移器**（`legacy-family-migration.js#importLegacy`），本函数只做形态装配：
 * · 旧 meta（branches/branchPaths/model.active_branch）→ 旧 model 形态（groups 留空 —— 行数据
 *   全在 floors 里，迁移器按 variantId 引用重建，**不按 floorNo 聚合**）；
 * · 活跃分支的行（variantId ∈ 活跃 path）按 path 楼层序 → body；其余行 → storedRows；
 * · header / keyBindings / familyId / characterId 原样透传。
 *
 * 与 `modelFromStore`（旧 UI 模型）**并存不互替**：现有 UI 继续走旧形态；
 * v2 消费方（计划层 / 备份 / 迁移审查）走本入口。迁移失败返回 `ok:false`，不碰源库。
 *
 * @param {object} storeFamily 适配器 loadFamily 返回（branches/branchPaths/model）
 * @param {Array<{floorNo, variantId, seq, content, contentHash, sendDate}>} floors 全部楼层行
 * @param {{header?:object, keyBindings?:object, libraryId?:string, familyId?:string,
 *          characterId?:string|null}} [opts]
 * @returns {{ok:true, family:object, warnings?:string[]}|{ok:false, code:string, paths:string[]}}
 */
export function familyFromStore(storeFamily, floors, opts = {}) {
    const branches = (storeFamily?.branches || []).map((b) => ({
        id: b.id,
        name: b.name,
        is_default: Boolean(b.is_default),
        fork_base: b.fork_floor ?? b.fork_base ?? 0,
        path: { ...(storeFamily?.branchPaths?.[b.id] || {}) },
    }));
    const model = {
        active_branch: storeFamily?.model?.active_branch ?? null,
        branches,
        groups: {}, // 行数据全在 floors；迁移器按 variantId 引用重建，不用旧 floorNo 折叠
    };
    const activeId = model.active_branch
        ?? (branches.find((b) => b.is_default) || branches[0])?.id ?? null;
    const activePath = branches.find((b) => b.id === activeId)?.path || {};
    const activeMax = Math.max(0, ...Object.keys(activePath).map(Number));
    const activeGids = new Set(Object.values(activePath));

    const byVariant = new Map();
    for (const f of floors || []) {
        if (!f || typeof f.content !== 'string') continue;
        if (!byVariant.has(f.variantId)) byVariant.set(f.variantId, []);
        byVariant.get(f.variantId).push(f);
    }
    // 活跃分支行 → body（按 path 楼层序；同 gid 多行取 seq 最小 = 旧写入顺序首行）
    const body = [];
    for (let f = 1; f <= activeMax; f += 1) {
        const rows = (byVariant.get(activePath[f]) || []).slice()
            .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
        body.push(rows.length ? JSON.parse(rows[0].content) : null);
    }
    // 其余行 → storedRows（楼号 + seq 稳定排序；迁移器按 variantId 引用重建）
    const storedRows = (floors || [])
        .filter((fl) => fl && typeof fl.content === 'string' && !activeGids.has(fl.variantId))
        .map((fl) => ({
            floorNo: fl.floorNo, variantId: fl.variantId, seq: fl.seq,
            content: fl.content, contentHash: fl.contentHash, sendDate: fl.sendDate,
        }))
        .sort((a, b) => (a.floorNo - b.floorNo) || ((Number(a.seq) || 0) - (Number(b.seq) || 0)));

    return importLegacy(
        { header: opts.header ?? {}, body, model, storedRows, keyBindings: opts.keyBindings ?? {} },
        {
            libraryId: opts.libraryId,
            familyId: opts.familyId ?? storeFamily?.familyId,
            characterId: opts.characterId ?? storeFamily?.characterId ?? null,
        },
    );
}
