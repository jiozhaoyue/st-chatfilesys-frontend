/**
 * ChatFilesys — 档2：官方 /api/chats/* 通道适配器（design.md §3.1）
 *
 * 每家族 = 一个隐藏聊天容器 `__cfsys__<familyId>`（经 ctx.fetch 走常规端点）：
 * - header.chat_metadata.extensions.cfsys_family = 家族元数据（chatKey/integrity/branches/branchPaths）
 * - body 每行 = 楼层行 JSON（{floorNo, variantId, seq, content, contentHash, sendDate}）
 * - 回收站容器：__cfsys__trash__<trashId>（header 存 meta，body 存原 jsonl 行）
 *
 * 正确性兜底档：整文档读写、无分片查询（性能弱于档1 属预期，M3 基准量化）。
 */

const PREFIX = '__cfsys__';
const TRASH_PREFIX = '__cfsys__trash__';
const INDEX_NAME = '__cfsys__index.jsonl'; // 固定名索引容器：chatKey→familyId 持久登记（重启重联）

/** hiddenChatName：家族的隐藏聊天文件名 */
function hiddenName(familyId) {
    return `${PREFIX}${familyId}.jsonl`;
}

/** trashName：回收站条目的隐藏聊天文件名 */
function trashName(trashId) {
    return `${TRASH_PREFIX}${trashId}.jsonl`;
}

/**
 * @param {{fetch: Function, log?: Function}} ctx
 * @returns {Promise<StorageAdapterAPI>}（契约见 adapter.js JSDoc；内部先做持久索引重联）
 */
export async function createOfficialAdapter(ctx) {
    const doFetch = ctx.fetch;
    const log = ctx.log ?? console.warn;
    // 宿主鉴权头（CSRF token）：官方端点必需；index.js 注入 getRequestHeaders()
    const authHeaders = ctx.headers ? () => (typeof ctx.headers === 'function' ? ctx.headers() : ctx.headers) : () => ({});

    /** 官方端点调用封装（POST JSON） */
    async function api(path, body) {
        const res = await doFetch(`/api/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`/api/${path} HTTP ${res.status}`);
        return res.json();
    }

    // 会话内已知家族缓存（loadFamily 按 chatKey 命中；重启后由 listFamilies 补齐）
    const knownByKey = new Map();

    function remember(family) {
        if (family?.chatKey) knownByKey.set(family.chatKey, family);
    }

    /* ---- 持久 chatKey 索引（固定名索引容器，official 档重启重联）---- */

    /** 读持久索引：{chatKey: familyId}；容器缺失/损坏 → {} */
    async function readIndex() {
        const c = await readContainer(INDEX_NAME).catch(() => null);
        const rows = c?.floorRows || [];
        const idx = {};
        for (const r of rows) {
            if (r?.chatKey && r?.familyId) idx[r.chatKey] = r.familyId;
        }
        return idx;
    }

    /** 全量重写索引容器（行 = {chatKey, familyId}） */
    async function writeIndex(pairs) {
        const rows = (pairs || []).map(([chatKey, familyId]) => ({
            floorNo: 1, variantId: 'i1', seq: 0,
            content: JSON.stringify({ chatKey, familyId }), contentHash: null, sendDate: null,
        }));
        await writeContainer(INDEX_NAME, { kind: 'index' }, rows);
    }

    /** merge 记忆态与持久索引并落盘（失败仅 warn 不阻断：本会话仍可用 knownByKey 工作） */
    async function persistIndex() {
        const pairs = [...knownByKey.entries()].map(([k, f]) => [k, f.familyId]);
        try {
            await writeIndex(pairs);
        } catch (e) {
            log('[chatfilesys-official] chatKey 索引持久化失败（不阻断）:', e);
        }
    }

    /** 启动重联：读持久索引 → 预热 knownByKey（各家族容器存在性不在此验证） */
    async function warmupFromIndex() {
        try {
            const idx = await readIndex();
            for (const [chatKey, familyId] of Object.entries(idx)) {
                if (!knownByKey.has(chatKey)) {
                    // 只登记身份占位（chatKey→familyId 指针），容器内容首次使用时读
                    knownByKey.set(chatKey, { familyId, chatKey });
                }
            }
        } catch (e) {
            log('[chatfilesys-official] 持久索引读取失败（首启正常）:', e);
        }
    }

    /** 读取隐藏聊天容器 → { header, floorRows, meta } */
    async function readContainer(name) {
        const data = await api('chats/get', { avatar_url: PREFIX, file_name: name });
        if (!Array.isArray(data) || !data.length) return null;
        const header = data[0];
        const floorRows = data.slice(1).map((s) => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(Boolean);
        const meta = header?.chat_metadata?.extensions?.cfsys_family || null;
        return { header, floorRows, meta };
    }

    /** 写入隐藏聊天容器（整文档覆盖写） */
    async function writeContainer(name, meta, floorRows) {
        const header = {
            user_name: 'unused',
            character_name: 'unused',
            chat_metadata: { extensions: { cfsys_family: meta } },
        };
        const chat = [header, ...floorRows.map((r) => JSON.stringify(r))];
        await api('chats/save', { avatar_url: PREFIX, file_name: name, chat, force: true });
    }

    /** 从 meta+floorRows 装配 family（含现有 UI 模型形态；模型本体优先取 meta.model） */
    function assembleFamily(meta, floorRows) {
        const branches = (meta.branches || []).map((b) => ({
            id: b.id, name: b.name, is_default: Boolean(b.is_default),
            fork_floor: b.fork_floor ?? b.fork_base ?? 0, parent_branch_id: b.parent_branch_id ?? null,
        }));
        const branchPaths = meta.branchPaths || {};
        // 模型本体优先（saveModel 持久化后 active_branch/groups 往返不丢）；无则派生
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
            name: meta.name, integrity: meta.integrity,
            branches, branchPaths, model,
        };
    }

    async function loadFamilyRaw({ familyId, chatKey }) {
        let meta = null;
        let floorRows = [];
        if (chatKey != null && knownByKey.has(chatKey)) {
            const f = knownByKey.get(chatKey);
            familyId = familyId || f.familyId;
        }
        if (familyId != null) {
            const c = await readContainer(hiddenName(familyId)).catch(() => null);
            if (c?.meta) { meta = c.meta; floorRows = c.floorRows; }
        } else if (chatKey != null) {
            // 无法枚举：会话缓存未命中时返回 null（首次导入旅程会显式登记 chatKey → familyId）
            return null;
        }
        if (!meta) return null;
        const family = assembleFamily(meta, floorRows);
        remember(family);
        return { family, floorRows };
    }

    /** 容器内楼层重排（RFC6902 数组语义在 body 数组上直接执行） */
    function applyOpsToRows(rows, ops) {
        const arr = [...rows];
        for (const op of ops || []) {
            const m = /^\/?(?:chat\/)?(\d+)$/.exec(String(op.path || ''));
            if (!m) continue;
            const idx = Number(m[1]);
            if (op.op === 'remove') arr.splice(idx, 1);
            else if (op.op === 'add' && op.value != null) {
                arr.splice(idx, 0, {
                    floorNo: idx + 1, variantId: `g${idx + 1}`, seq: 0,
                    content: JSON.stringify(op.value), contentHash: null,
                    sendDate: op.value?.send_date ?? null,
                });
            } else if (op.op === 'replace' && op.value != null) {
                if (arr[idx]) {
                    arr[idx] = { ...arr[idx], content: JSON.stringify(op.value), sendDate: op.value?.send_date ?? null };
                }
            }
        }
        return arr.map((r, i) => ({ ...r, floorNo: i + 1 })); // 行序即楼层号，重排后统一重编号
    }

    await warmupFromIndex();

    return {
        async listFamilies() {
            // 档2 无列表端点：返回会话已知家族（导入旅程显式登记过的）
            const out = [];
            for (const f of knownByKey.values()) out.push({ familyId: f.familyId, name: f.name, updatedAt: null });
            return out;
        },

        async loadFamily(args) {
            const raw = await loadFamilyRaw(args);
            return raw?.family || null;
        },

        async createFamily({ family }) {
            // 已存在同 familyId 容器 → 拒绝（导入旅程防重复建档）
            const c = await readContainer(hiddenName(family.familyId)).catch(() => null);
            if (c?.meta) return { ok: false, reason: 'familyId-exists' };
            const meta = { ...family, integrity: family.integrity ?? 1 };
            delete meta.model; // 建档时无模型本体，读路径派生
            await writeContainer(hiddenName(family.familyId), meta, []);
            remember(assembleFamily(meta, []));
            await persistIndex();
            return { ok: true, familyId: family.familyId, integrity: meta.integrity };
        },

        async bindChatKey({ familyId, chatKey }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (knownByKey.get(raw.family.chatKey)?.familyId === familyId) knownByKey.delete(raw.family.chatKey);
            const meta = { ...raw.family, chatKey };
            meta.branches = raw.family.branches; meta.branchPaths = raw.family.branchPaths;
            await writeContainer(hiddenName(familyId), meta, raw.floorRows);
            remember(assembleFamily(meta, raw.floorRows));
            await persistIndex();
            return { ok: true };
        },

        async renameFamily({ familyId, newName }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            const meta = { ...raw.family, name: newName, integrity: raw.family.integrity + 1 };
            meta.branches = raw.family.branches;
            meta.branchPaths = raw.family.branchPaths;
            await writeContainer(hiddenName(familyId), meta, raw.floorRows);
            remember(assembleFamily(meta, raw.floorRows));
            return { ok: true, integrity: meta.integrity };
        },

        async deleteFamily({ familyId }) {
            try {
                await api('chats/delete', { avatar_url: PREFIX, chatfile: hiddenName(familyId) });
            } catch (e) { log('[chatfilesys-official] 删除容器失败（可已不存在）:', e); }
            for (const [k, f] of knownByKey) if (f.familyId === familyId) knownByKey.delete(k);
            await persistIndex();
            return { ok: true };
        },

        async loadFloors({ familyId, from = 0, limit = 200 }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) throw new Error('family-not-found');
            const rows = raw.floorRows.filter((r) => r.floorNo >= from);
            const page = rows.slice(0, limit);
            return { floors: page, hasMore: rows.length > limit };
        },

        async saveFloors({ familyId, floors, expectedIntegrity }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== raw.family.integrity) {
                return { ok: false, conflict: true };
            }
            // upsert：按 (floorNo, variantId) 合并
            const merged = new Map(raw.floorRows.map((r) => [`${r.floorNo}#${r.variantId}`, r]));
            for (const f of floors || []) {
                merged.set(`${f.floorNo}#${f.variantId}`, {
                    floorNo: f.floorNo, variantId: f.variantId, seq: f.seq ?? 0,
                    content: f.content, contentHash: f.contentHash ?? null, sendDate: f.sendDate ?? null,
                });
            }
            const rows = [...merged.values()].sort((a, b) => a.floorNo - b.floorNo || a.seq - b.seq);
            const meta = { ...raw.family, integrity: raw.family.integrity + 1 };
            meta.branches = raw.family.branches; meta.branchPaths = raw.family.branchPaths;
            await writeContainer(hiddenName(familyId), meta, rows);
            remember(assembleFamily(meta, rows));
            return { ok: true, integrity: meta.integrity };
        },

        async applyOps({ familyId, ops, expectedIntegrity }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== raw.family.integrity) {
                return { ok: false, conflict: true };
            }
            const rows = applyOpsToRows(raw.floorRows, ops);
            const meta = { ...raw.family, integrity: raw.family.integrity + 1 };
            meta.branches = raw.family.branches; meta.branchPaths = raw.family.branchPaths;
            await writeContainer(hiddenName(familyId), meta, rows);
            remember(assembleFamily(meta, rows));
            return { ok: true, integrity: meta.integrity };
        },

        async saveModel({ familyId, model, expectedIntegrity, keepCurrent }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && expectedIntegrity !== raw.family.integrity) {
                return { ok: false, conflict: true };
            }
            const meta = { ...raw.family, integrity: raw.family.integrity + 1 };
            if (!keepCurrent && model) {
                // 模型本体持久化 + 结构视图同步（branches/branchPaths 由模型派生，保持读路径一致）
                meta.model = model;
                meta.branches = (model.branches || []).map((b) => ({
                    id: b.id, name: b.name, is_default: Boolean(b.is_default),
                    fork_floor: b.fork_base ?? 0, parent_branch_id: null,
                }));
                const branchPaths = {};
                for (const b of model.branches || []) branchPaths[b.id] = b.path || {};
                meta.branchPaths = branchPaths;
            }
            await writeContainer(hiddenName(familyId), meta, raw.floorRows);
            remember(assembleFamily(meta, raw.floorRows));
            return { ok: true, integrity: meta.integrity };
        },

        async moveToTrash({ source, content }) {
            const trashId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
            const meta = { trashId, source, movedAt: Date.now() };
            await writeContainer(trashName(trashId), { kind: 'trash', ...meta },
                String(content ?? '').split('\n').filter(Boolean).map((line, i) => ({
                    floorNo: i + 1, variantId: `t${i + 1}`, seq: 0, content: line, contentHash: null, sendDate: null,
                })));
            return { ok: true, trashId };
        },

        async listTrash() {
            return []; // 档2 无枚举端点：回收站列表由导入旅程维护的已知 trashId 集合补齐（M2 完整化）
        },

        async restoreFromTrash({ trashId }) {
            const c = await readContainer(trashName(trashId)).catch(() => null);
            if (!c) return { ok: false, reason: 'trash-not-found' };
            const content = c.floorRows.map((r) => r.content).join('\n');
            return { ok: true, content, source: c.meta?.source, movedAt: c.meta?.movedAt };
        },

        async deleteFromTrash({ trashId }) {
            try { await api('chats/delete', { avatar_url: PREFIX, chatfile: trashName(trashId) }); }
            catch { /* 已不存在视为成功 */ }
            return { ok: true };
        },

        dispose() { knownByKey.clear(); },
    };
}