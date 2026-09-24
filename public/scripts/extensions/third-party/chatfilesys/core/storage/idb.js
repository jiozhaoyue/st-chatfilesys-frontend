/**
 * ChatFilesys — 档3：IndexedDB 缓存适配器（design.md §3.2）
 *
 * 仅缓存投影、非事实源（JSDoc 契约同 adapter.js）。无服务端场景的会话级兜底：
 * seam 降到本档时只服务会话内读写，UI 提示「当前仅本地缓存」。
 */

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

/** 组装 family（含现有 UI 模型形态；groups 由波次2 桥接填充） */
function assembleFamily(meta) {
    const branches = (meta.branches || []).map((b) => ({
        id: b.id, name: b.name, is_default: Boolean(b.is_default),
        fork_floor: b.fork_floor ?? b.fork_base ?? 0, parent_branch_id: b.parent_branch_id ?? null,
    }));
    const branchPaths = meta.branchPaths || {};
    const active = branches.find((b) => b.is_default) || branches[0];
    const model = {
        active_branch: active?.id ?? null,
        branches: branches.map((b) => ({
            id: b.id, name: b.name, is_default: b.is_default,
            fork_base: b.fork_floor ?? b.fork_base ?? 0, path: branchPaths[b.id] || {},
        })),
        groups: {},
    };
    return {
        familyId: meta.familyId, chatKey: meta.chatKey, characterId: meta.characterId,
        name: meta.name, integrity: meta.integrity ?? 1,
        branches, branchPaths, model,
    };
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

        async applyOps({ familyId, ops, expectedIntegrity }) {
            const meta = await loadMeta(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== (meta.integrity ?? 1)) {
                return { ok: false, conflict: true };
            }
            const rows = (await floorsOf(familyId)).map((r) => ({ ...r }));
            const arr = [...rows];
            for (const op of ops || []) {
                const m = /^\/?(?:chat\/)?(\d+)$/.exec(String(op.path || ''));
                if (!m) continue;
                const idx = Number(m[1]);
                if (op.op === 'remove') arr.splice(idx, 1);
                else if (op.op === 'add' && op.value != null) {
                    arr.splice(idx, 0, {
                        familyId, floorNo: idx + 1, variantId: `g${idx + 1}`, seq: 0,
                        content: JSON.stringify(op.value), contentHash: null, sendDate: op.value?.send_date ?? null,
                    });
                } else if (op.op === 'replace' && op.value != null && arr[idx]) {
                    arr[idx] = { ...arr[idx], content: JSON.stringify(op.value), sendDate: op.value?.send_date ?? null };
                }
            }
            const renumbered = arr.map((r, i) => ({ ...r, floorNo: i + 1 }));
            await putFloors(renumbered);
            // 删掉被 splice 移除的旧行（key 含旧 floorNo）
            const keep = new Set(renumbered.map((r) => `${r.floorNo}#${r.variantId}`));
            const store = tx(db, 'floors', 'readwrite');
            for (const old of rows) {
                if (!keep.has(`${old.floorNo}#${old.variantId}`)) store.delete([old.familyId, old.floorNo, old.variantId]);
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
