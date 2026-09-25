/**
 * ChatFilesys — 档3：IndexedDB 缓存适配器（design.md §3.2）
 *
 * 仅缓存投影、非事实源（JSDoc 契约同 adapter.js）。无服务端场景的会话级兜底：
 * seam 降到本档时只服务会话内读写，UI 提示「当前仅本地缓存」。
 */

import { planBodyPatch, activePathOf, applyRowWrites, pathFloors } from '../patch-rows.js';

const DB_NAME = 'cfsys-cache';
const DB_VERSION = 1;

/** 打开/升级 IndexedDB（有界等待：open 不挂死，L1-MR-7） */
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('families')) {
                db.createObjectStore('families', { keyPath: 'familyId' });
            }
            if (!db.objectStoreNames.contains('floors')) {
                db.createObjectStore('floors', { keyPath: ['familyId', 'floorNo', 'variantId'] });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('indexeddb blocked'));
    });
}

function tx(db, store, mode) {
    return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** 组装 family（含现有 UI 模型形态；模型本体优先取 meta.model） */
function assembleFamily(meta) {
    const branches = (meta.branches || []).map((b) => ({
        id: b.id, name: b.name, is_default: Boolean(b.is_default),
        fork_floor: b.fork_floor ?? b.fork_base ?? 0, parent_branch_id: b.parent_branch_id ?? null,
    }));
    const branchPaths = meta.branchPaths || {};
    const model = meta.model || (() => {
        const active = branches.find((b) => b.is_default) || branches[0];
        return {
            active_branch: active?.id ?? null,
            branches: branches.map((b) => ({
                id: b.id, name: b.name, is_default: b.is_default,
                fork_base: b.fork_floor ?? b.fork_base ?? 0, path: branchPaths[b.id] || {},
            })),
            groups: {},
        };
    })();
    return {
        familyId: meta.familyId, chatKey: meta.chatKey, characterId: meta.characterId,
        name: meta.name, integrity: meta.integrity ?? 1,
        // T0/R0：聊天头保留面（宿主与其他插件写入的内容），读时由 seam 整份回显
        hostMetadata: meta.hostMetadata ?? null,
        branches, branchPaths, model,
    };
}

/** 模型写进 meta：本体 + 结构视图（branches/branchPaths 由模型派生，保持读路径一致） */
function applyModelToMeta(meta, model) {
    meta.model = model;
    meta.branches = (model.branches || []).map((b) => ({
        id: b.id, name: b.name, is_default: Boolean(b.is_default),
        fork_floor: b.fork_base ?? 0, parent_branch_id: null,
    }));
    const branchPaths = {};
    for (const b of model.branches || []) branchPaths[b.id] = b.path || {};
    meta.branchPaths = branchPaths;
    return meta;
}

/**
 * @param {{log?: Function}} ctx
 * @returns {Promise<StorageAdapterAPI>}
 */
export async function createIdbAdapter(ctx = {}) {
    if (typeof indexedDB === 'undefined') throw new Error('当前环境无 indexedDB');
    const db = await openDb();

    async function loadMeta(familyId) {
        return (await reqAsPromise(tx(db, 'families', 'readonly').get(familyId))) || null;
    }

    async function putMeta(family) {
        await reqAsPromise(tx(db, 'families', 'readwrite').put(family));
    }

    async function floorsOf(familyId) {
        const all = await reqAsPromise(tx(db, 'floors', 'readonly').getAll());
        return all.filter((r) => r.familyId === familyId).sort((a, b) => a.floorNo - b.floorNo || a.seq - b.seq);
    }

    async function putFloors(list) {
        const store = tx(db, 'floors', 'readwrite');
        await Promise.all(list.map((r) => reqAsPromise(store.put(r))));
    }

    return {
        async listFamilies({ characterId }) {
            const all = await reqAsPromise(tx(db, 'families', 'readonly').getAll());
            return all.filter((f) => !characterId || f.characterId === characterId)
                .map((f) => ({ familyId: f.familyId, name: f.name, updatedAt: f.updatedAt }));
        },

        async loadFamily({ familyId, chatKey }) {
            let meta = null;
            if (familyId != null) meta = await loadMeta(familyId);
            else if (chatKey != null) {
                const all = await reqAsPromise(tx(db, 'families', 'readonly').getAll());
                meta = all.find((f) => f.chatKey === chatKey) || null;
            }
            if (!meta) return null;
            return assembleFamily(meta);
        },

        async createFamily({ family }) {
            const existing = await loadMeta(family.familyId);
            if (existing) return { ok: false, reason: 'familyId-exists' };
            if (family.chatKey != null) {
                const all = await reqAsPromise(tx(db, 'families', 'readonly').getAll());
                if (all.some((f) => f.chatKey === family.chatKey)) return { ok: false, reason: 'chatKey-exists' };
            }
            const meta = {
                familyId: family.familyId, chatKey: family.chatKey ?? null,
                characterId: family.characterId ?? '', name: family.name ?? '',
                integrity: family.integrity ?? 1, updatedAt: Date.now(),
                hostMetadata: family.hostMetadata ?? null, // T0/R0：聊天头保留面
                branches: family.branches || [], branchPaths: family.branchPaths || {},
            };
            await putMeta(meta);
            return { ok: true, familyId: family.familyId, integrity: meta.integrity };
        },

        async bindChatKey({ familyId, chatKey }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            meta.chatKey = chatKey;
            meta.updatedAt = Date.now();
            await putMeta(meta);
            return { ok: true };
        },

        async renameFamily({ familyId, newName }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            meta.name = newName;
            meta.integrity = (meta.integrity ?? 1) + 1;
            meta.updatedAt = Date.now();
            await putMeta(meta);
            return { ok: true, integrity: meta.integrity };
        },

        async deleteFamily({ familyId }) {
            const store = tx(db, 'floors', 'readwrite');
            for (const r of await floorsOf(familyId)) store.delete([r.familyId, r.floorNo, r.variantId]);
            await reqAsPromise(tx(db, 'families', 'readwrite').delete(familyId));
            return { ok: true };
        },

        async loadFloors({ familyId, from = 0, limit = 200 }) {
            const rows = (await floorsOf(familyId)).filter((r) => r.floorNo >= from);
            return { floors: rows.slice(0, limit), hasMore: rows.length > limit };
        },

        async saveFloors({ familyId, floors, expectedIntegrity }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, authorityReason: undefined, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== (meta.integrity ?? 1)) {
                return { ok: false, conflict: true };
            }
            const merged = new Map((await floorsOf(familyId)).map((r) => [`${r.floorNo}#${r.variantId}`, r]));
            for (const f of floors || []) {
                merged.set(`${f.floorNo}#${f.variantId}`, {
                    familyId, floorNo: f.floorNo, variantId: f.variantId, seq: f.seq ?? 0,
                    content: f.content, contentHash: f.contentHash ?? null, sendDate: f.sendDate ?? null,
                });
            }
            await putFloors([...merged.values()]);
            meta.integrity = (meta.integrity ?? 1) + 1;
            meta.updatedAt = Date.now();
            await putMeta(meta);
            return { ok: true, integrity: meta.integrity };
        },

        /**
         * 消息补丁（T0b）：投影 → 应用 → 按键写回（详见 `core/patch-rows.js`）。
         * model / hostMetadata 与行同一次提交（宿主 patch 请求体带整份 chat_metadata，T0c）。
         */
        async applyOps({ familyId, ops, expectedIntegrity, model, hostMetadata }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== (meta.integrity ?? 1)) {
                return { ok: false, conflict: true };
            }
            const current = assembleFamily(meta);
            const plan = planBodyPatch({
                rows: await floorsOf(familyId),
                path: activePathOf(current.model),
                ops,
                model: model || current.model,
            });
            if (!plan.ok) return { ok: false, reason: plan.reason, detail: plan.detail };
            const rows = applyRowWrites(await floorsOf(familyId), plan.rows, plan.deletes);
            // 先删后写：按键删除不再被引用的旧行（key 含旧 floorNo，upsert 覆盖不到）
            const store = tx(db, 'floors', 'readwrite');
            for (const d of plan.deletes) store.delete([familyId, d.floorNo, d.variantId]);
            await putFloors(rows.map((r) => ({ ...r, familyId })));
            if (hostMetadata !== undefined) meta.hostMetadata = hostMetadata;
            if (plan.model) {
                meta.model = plan.model;
                meta.branches = (plan.model.branches || []).map((b) => ({
                    id: b.id, name: b.name, is_default: Boolean(b.is_default),
                    fork_floor: b.fork_base ?? 0, parent_branch_id: null,
                }));
                const branchPaths = {};
                for (const b of plan.model.branches || []) branchPaths[b.id] = b.path || {};
                meta.branchPaths = branchPaths;
            }
            meta.integrity = (meta.integrity ?? 1) + 1;
            meta.updatedAt = Date.now();
            await putMeta(meta);
            return { ok: true, integrity: meta.integrity, totalMessages: pathFloors(plan.path).length };
        },

        async saveModel({ familyId, model, hostMetadata, expectedIntegrity, keepCurrent }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== (meta.integrity ?? 1)) {
                return { ok: false, conflict: true };
            }
            // T0/R0：聊天头保留面落库（undefined = 本次不动它）
            if (hostMetadata !== undefined) meta.hostMetadata = hostMetadata;
            if (!keepCurrent && model) {
                applyModelToMeta(meta, model);
            }
            meta.integrity = (meta.integrity ?? 1) + 1;
            meta.updatedAt = Date.now();
            await putMeta(meta);
            return { ok: true, integrity: meta.integrity };
        },

        // 档3 无事实源：不承诺回收站
        async moveToTrash() { return { ok: false, reason: 'idb-tier-no-trash' }; },
        async listTrash() { return []; },
        async restoreFromTrash() { return { ok: false, reason: 'idb-tier-no-trash' }; },
        async deleteFromTrash() { return { ok: false, reason: 'idb-tier-no-trash' }; },

        dispose() { db.close(); },
    };
}
