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

import { planBodyPatch, activePathOf, applyRowWrites, pathFloors } from '../patch-rows.js';
import { nextIntegrity, integrityConflict } from '../integrity.js';

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
    // T1：除主键外还登记**键绑定**（原生分支/检查点键 → 同一家族），否则那些键读不回库
    const knownByKey = new Map();

    /**
     * 家族键 → 家族 登记（T1：主键之外的绑定键也要登记）。
     *
     * W2 修复（2026-09-26）：登记前**先清掉该家族的旧键**——「删除绑定键」只解绑不删家族，
     * 若旧键留在表里，`loadFamily({chatKey: 旧键})` 仍会命中，且 `persistIndex` 会把它写回持久索引
     * （重启后旧键又活过来；宿主将来重用该文件名时会被误认成同一家族）＝映射断裂。
     */
    function remember(family) {
        if (!family) return;
        for (const [k, f] of knownByKey) if (f.familyId === family.familyId) knownByKey.delete(k);
        const keys = [family.chatKey, ...Object.keys(family.keyBindings || {})];
        for (const k of keys) if (k) knownByKey.set(k, family);
    }

    /* ---- 持久 chatKey 索引（固定名索引容器，official 档重启重联）---- */

    /** 读持久索引：{chatKey: familyId}；容器缺失/损坏 → {} */
    async function readIndex() {
        const c = await readContainer(INDEX_NAME).catch(() => null);
        const rows = c?.floorRows || [];
        const idx = {};
        for (const r of rows) {
            // 行形态 = 楼层行对象（配对 JSON 在 `content` 字段里）；兼容早期扁平写法
            let pair = r;
            if (!pair?.chatKey || !pair?.familyId) {
                try { pair = JSON.parse(r?.content ?? 'null'); } catch { pair = null; }
            }
            if (pair?.chatKey && pair?.familyId) idx[pair.chatKey] = pair.familyId;
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
                    // 只登记身份占位（chatKey→familyId 指针 + placeholder 标记），容器内容首次使用时读。
                    // 标记的用处：`listFamilies` 传 characterId 时需要真家族（占位没有角色）→ 按需补读，
                    // 否则重启后「角色卡的聊天」页签的库内一侧会被整段滤空（N5，2026-09-26）。
                    knownByKey.set(chatKey, { familyId, chatKey, placeholder: true });
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
            // T0/R0：聊天头保留面（宿主与其他插件写入的内容），读时由 seam 整份回显
            hostMetadata: meta.hostMetadata ?? null,
            // T1：聊天键 → 分支绑定（原生分支/检查点键各自代表一条分支）
            keyBindings: meta.keyBindings ?? {},
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

    /** 模型写进容器 meta：本体 + 结构视图（branches/branchPaths 由模型派生，保持读路径一致） */
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

    await warmupFromIndex();

    return {
        /**
         * 档2 无列表端点：返回会话已知家族（导入旅程显式登记过的）。
         *
         * N5（2026-09-26）：**按 characterId 过滤**——签名与过滤语义对齐档1/档3
         * （`authority.js` 的 `WHERE character_id = ?`、`idb.js` 的 `!characterId || f.characterId === characterId`）。
         * 不收角色会把别的角色的家族列进「角色卡的聊天」页签（点「结构树」必空）。
         *
         * 启动重联留下的占位（`warmupFromIndex`）没有 characterId，传了角色就会连带被滤掉
         * → 重启后页签的库内一侧全消失。故先按需补读一次容器，把占位换成真家族
         * （读不到 = 悬挂索引，直接丢掉）。
         */
        async listFamilies({ characterId } = {}) {
            for (const f of [...knownByKey.values()]) {
                if (!f.placeholder) continue;
                const raw = await loadFamilyRaw({ familyId: f.familyId }).catch(() => null);
                if (raw) continue; // 已由 loadFamilyRaw 里的 remember() 换成真家族
                for (const [k, v] of knownByKey) if (v.familyId === f.familyId) knownByKey.delete(k);
            }
            const out = new Map(); // 按 familyId 去重（一个家族的多个键共享同一对象）
            for (const f of knownByKey.values()) {
                if (f.placeholder) continue;                                // 补读失败后残留（容器已不在）
                if (characterId && f.characterId !== characterId) continue;  // 别的角色的家族
                out.set(f.familyId, { familyId: f.familyId, name: f.name, updatedAt: null });
            }
            return [...out.values()];
        },

        async loadFamily(args) {
            const raw = await loadFamilyRaw(args);
            return raw?.family || null;
        },

        async createFamily({ family }) {
            // 已存在同 familyId 容器 → 拒绝（导入旅程防重复建档）
            const c = await readContainer(hiddenName(family.familyId)).catch(() => null);
            if (c?.meta) return { ok: false, reason: 'familyId-exists' };
            const meta = { ...family, integrity: family.integrity ?? nextIntegrity() };
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
            const meta = { ...raw.family, name: newName, integrity: nextIntegrity() };
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
            if (integrityConflict(expectedIntegrity, raw.family.integrity)) {
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
            const meta = { ...raw.family, integrity: nextIntegrity() };
            meta.branches = raw.family.branches; meta.branchPaths = raw.family.branchPaths;
            await writeContainer(hiddenName(familyId), meta, rows);
            remember(assembleFamily(meta, rows));
            return { ok: true, integrity: meta.integrity };
        },

        /**
         * 消息补丁（T0b）：投影 → 应用 → 按键写回，详见 `core/patch-rows.js`。
         * model / hostMetadata 与行同一次写（宿主 patch 请求体里带的是整份 chat_metadata，
         * 其中的分支模型与外来命名空间都必须一起落地，T0c）。
         *
         * W6：`branchId`（投影基准：ops 下标对着它算）与 `targetBranchId`（结构收敛目标：
         * 切分支时 = 目标分支）分开传；不切换时后者缺省 = 前者。
         */
        async applyOps({ familyId, ops, expectedIntegrity, model, hostMetadata, keyBindings, branchId, targetBranchId }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (integrityConflict(expectedIntegrity, raw.family.integrity)) {
                return { ok: false, conflict: true };
            }
            const plan = planBodyPatch({
                rows: raw.floorRows,
                path: activePathOf(raw.family.model, branchId),
                ops,
                model: model || raw.family.model,
                branchId,
                targetBranchId,
            });
            if (!plan.ok) return { ok: false, reason: plan.reason, detail: plan.detail };
            const rows = applyRowWrites(raw.floorRows, plan.rows, plan.deletes);
            const meta = { ...raw.family, integrity: nextIntegrity() };
            if (hostMetadata !== undefined) meta.hostMetadata = hostMetadata;
            if (keyBindings !== undefined) meta.keyBindings = keyBindings;
            applyModelToMeta(meta, plan.model || raw.family.model);
            await writeContainer(hiddenName(familyId), meta, rows);
            remember(assembleFamily(meta, rows));
            if (keyBindings !== undefined) await persistIndex(); // T1：新键必须进持久索引，重启才重联
            return { ok: true, integrity: meta.integrity, totalMessages: pathFloors(plan.path).length };
        },

        async saveModel({ familyId, model, hostMetadata, keyBindings, expectedIntegrity, keepCurrent }) {
            const raw = await loadFamilyRaw({ familyId });
            if (!raw) return { ok: false, reason: 'family-not-found' };
            if (integrityConflict(expectedIntegrity, raw.family.integrity)) {
                return { ok: false, conflict: true };
            }
            const meta = { ...raw.family, integrity: nextIntegrity() };
            // T0/R0：聊天头保留面落库（undefined = 本次不动它）
            if (hostMetadata !== undefined) meta.hostMetadata = hostMetadata;
            if (keyBindings !== undefined) meta.keyBindings = keyBindings;
            if (!keepCurrent && model) {
                // 模型本体持久化 + 结构视图同步
                applyModelToMeta(meta, model);
            }
            await writeContainer(hiddenName(familyId), meta, raw.floorRows);
            remember(assembleFamily(meta, raw.floorRows));
            if (keyBindings !== undefined) await persistIndex(); // T1：新键必须进持久索引，重启才重联
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