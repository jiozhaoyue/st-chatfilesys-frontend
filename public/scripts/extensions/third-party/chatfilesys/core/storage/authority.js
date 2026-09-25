/**
 * ChatFilesys — 档1：Authority SQL 适配器（design.md §3）
 *
 * Authority SDK API 事实（README，接入指导 backend-plugin-spec.md）：
 *   client.sql.migrate({ database, migrations: [{ id, statement }] })
 *   client.sql.query({ database, statement, params }) -> 行数组
 *
 * 查询纪律（Authority 接入指导 §3.2）：
 * - 禁止逐楼层查询：loadFloors 用 floor_no 区间查询
 * - 批量写按 500 行分块提交（防长持写锁）
 */

import { planBodyPatch, activePathOf, pathFloors } from '../patch-rows.js';
import { nextIntegrity, integrityConflict } from '../integrity.js';

const DB = 'chatfilesys';
const CHUNK = 500;

/** 楼层行：SQL 行 ⇄ API 行映射 */
function rowFromSql(r) {
    return {
        floorNo: r.floor_no,
        variantId: r.variant_id,
        seq: r.seq,
        content: r.content,
        contentHash: r.content_hash,
        sendDate: r.send_date,
    };
}

/**
 * @param {{authorityClient: object, log?: Function}} ctx
 * @returns {Promise<StorageAdapterAPI>}（见 adapter.js 契约 JSDoc）
 */
export async function createAuthorityAdapter(ctx) {
    const client = ctx.authorityClient;
    if (!client?.sql) throw new Error('authorityClient.sql 不可用');

    let migrated = false;
    async function ensureMigrated() {
        if (migrated) return;
        await client.sql.migrate({
            database: DB,
            migrations: [{ id: '001_init', statement: `
CREATE TABLE IF NOT EXISTS families (
    id TEXT PRIMARY KEY,
    chat_key TEXT NOT NULL,
    character_id TEXT NOT NULL,
    name TEXT NOT NULL,
    integrity INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS floors (
    family_id TEXT NOT NULL,
    floor_no INTEGER NOT NULL,
    variant_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT,
    send_date INTEGER,
    PRIMARY KEY (family_id, floor_no, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_floors_hash ON floors(family_id, content_hash);
CREATE TABLE IF NOT EXISTS branches (
    family_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    parent_branch_id TEXT,
    name TEXT NOT NULL,
    fork_floor INTEGER,
    is_default INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (family_id, branch_id)
);
CREATE TABLE IF NOT EXISTS branch_paths (
    family_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    floor_no INTEGER NOT NULL,
    variant_id TEXT NOT NULL,
    PRIMARY KEY (family_id, branch_id, floor_no)
);` }],
        });
        // 002：模型本体列（saveModel 持久化 active_branch/groups；重复迁移报列已存在 → 容错视为成功）
        try {
            await client.sql.migrate({
                database: DB,
                migrations: [{ id: '002_model', statement: 'ALTER TABLE families ADD COLUMN model TEXT;' }],
            });
        } catch { /* 列已存在 */ }
        // 003：聊天头保留列（T0/R0：宿主与其他插件写进聊天头的内容整份留库，读时回显）
        try {
            await client.sql.migrate({
                database: DB,
                migrations: [{ id: '003_host_metadata', statement: 'ALTER TABLE families ADD COLUMN host_metadata TEXT;' }],
            });
        } catch { /* 列已存在 */ }
        // 004：键绑定列（T1：原生分支/检查点键 → 走法；JSON 文本）
        // 版本号列形态说明：integrity 原为 INTEGER，N19 后写字符串。SQLite 动态类型按值存，
        // 非数字串（c-…）原样存为 TEXT，故不做列类型重建；早期数字行由 normIntegrity 归一后比较。
        try {
            await client.sql.migrate({
                database: DB,
                migrations: [{ id: '004_key_bindings', statement: 'ALTER TABLE families ADD COLUMN key_bindings TEXT;' }],
            });
        } catch { /* 列已存在 */ }
        migrated = true;
    }

    const q = (statement, params = []) => client.sql.query({ database: DB, statement, params });


    /** 写新版本号（N19：字符串形态，每次成功写一个新值） */
    async function bumpIntegrity(familyId) {
        const next = nextIntegrity();
        await q('UPDATE families SET integrity = ?, updated_at = ? WHERE id = ?', [next, Date.now(), familyId]);
        return next;
    }

    async function checkIntegrity(familyId, expected) {
        if (expected == null) return null;
        const rows = await q('SELECT integrity FROM families WHERE id = ?', [familyId]);
        const cur = rows?.[0]?.integrity;
        if (integrityConflict(expected, cur)) return jsonResponse409; // 哨兵：冲突标记
        return null;
    }

    const jsonResponse409 = { conflict: true };

    /** 键绑定落库（T1；undefined = 本次不动它，与 hostMetadata 同约定） */
    async function writeKeyBindings(familyId, keyBindings) {
        await q('UPDATE families SET key_bindings = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(keyBindings || {}), Date.now(), familyId]);
    }

    async function loadFamilyRow(familyId) {
        await ensureMigrated();
        const rows = await q('SELECT * FROM families WHERE id = ?', [familyId]);
        return rows?.[0] || null;
    }

    /** 从 branches/branch_paths 表装配 family（含 store-bridge 模型形态） */
    async function assembleFamily(f) {
        const brs = await q('SELECT * FROM branches WHERE family_id = ? ORDER BY fork_floor, branch_id', [f.id]);
        const paths = await q('SELECT * FROM branch_paths WHERE family_id = ?', [f.id]);
        const pathMap = new Map(paths.map((p) => [p.branch_id + '#' + p.floor_no, p.variant_id]));
        const branches = brs.map((b) => ({
            id: b.branch_id,
            name: b.name,
            is_default: Boolean(b.is_default),
            fork_floor: b.fork_floor ?? 0,
            parent_branch_id: b.parent_branch_id ?? null,
        }));
        const branchPaths = {};
        for (const b of branches) {
            branchPaths[b.id] = {};
            for (const p of paths.filter((x) => x.branch_id === b.id).sort((a, z) => a.floor_no - z.floor_no)) {
                branchPaths[b.id][p.floor_no] = p.variant_id;
            }
        }
        // 模型优先用存储本体（saveModel 持久化的 active_branch/groups 不丢）；无则派生（导入旅程初始建档）
        let model = null;
        try { model = f.model ? JSON.parse(f.model) : null; } catch { model = null; }
        if (!model) {
            const active = branches.find((b) => b.is_default) || branches[0];
            model = {
                active_branch: active?.id ?? null,
                branches: branches.map((b) => ({
                    id: b.id, name: b.name, is_default: b.is_default,
                    fork_base: b.fork_floor ?? 0,
                    path: branchPaths[b.id] || {},
                })),
                groups: {},
            };
        }
        // T0/R0：聊天头保留面（宿主与其他插件写入的内容），读时由 seam 整份回显
        let hostMetadata = null;
        try { hostMetadata = f.host_metadata ? JSON.parse(f.host_metadata) : null; } catch { hostMetadata = null; }
        // T1：聊天键 → 走法绑定
        let keyBindings = {};
        try { keyBindings = f.key_bindings ? JSON.parse(f.key_bindings) : {}; } catch { keyBindings = {}; }
        return {
            familyId: f.id, chatKey: f.chat_key, characterId: f.character_id,
            name: f.name, integrity: f.integrity,
            hostMetadata,
            keyBindings: keyBindings || {},
            branches, branchPaths, model,
        };
    }

    /** 模型本体 + 结构表一次写（branches/branch_paths 由模型派生；父分支关系尽量保留现值） */
    async function writeModel(familyId, model) {
        await q('UPDATE families SET model = ?, updated_at = ? WHERE id = ?', [JSON.stringify(model), Date.now(), familyId]);
        const existing = await q('SELECT branch_id, parent_branch_id FROM branches WHERE family_id = ?', [familyId]);
        const parentOf = new Map(existing.map((b) => [b.branch_id, b.parent_branch_id ?? null]));
        await q('DELETE FROM branches WHERE family_id = ?', [familyId]);
        await q('DELETE FROM branch_paths WHERE family_id = ?', [familyId]);
        for (const b of model.branches || []) {
            await q(
                'INSERT INTO branches (family_id, branch_id, parent_branch_id, name, fork_floor, is_default) VALUES (?, ?, ?, ?, ?, ?)',
                [familyId, b.id, parentOf.has(b.id) ? parentOf.get(b.id) : null, b.name ?? b.id, b.fork_base ?? 0, b.is_default ? 1 : 0],
            );
            for (const [floorNo, variantId] of Object.entries(b.path || {})) {
                await q(
                    'INSERT INTO branch_paths (family_id, branch_id, floor_no, variant_id) VALUES (?, ?, ?, ?)',
                    [familyId, b.id, Number(floorNo), variantId],
                );
            }
        }
    }

    return {
        async listFamilies({ characterId }) {
            await ensureMigrated();
            const rows = await q('SELECT id, name, updated_at FROM families WHERE character_id = ? ORDER BY updated_at DESC', [characterId]);
            return (rows || []).map((r) => ({ familyId: r.id, name: r.name, updatedAt: r.updated_at }));
        },

        async loadFamily({ familyId, chatKey }) {
            await ensureMigrated();
            let f = null;
            if (familyId != null) {
                f = await loadFamilyRow(familyId);
            } else if (chatKey != null) {
                const rows = await q('SELECT * FROM families WHERE chat_key = ?', [chatKey]);
                f = rows?.[0] || null;
                if (!f) {
                    // T1 回落：主键未命中 → 扫键绑定列（原生分支/检查点键 → 同一家族）。
                    // 键绑定是每家族个位数项的小表，全扫可接受；档1 真机量化在 T3。
                    const all = await q('SELECT * FROM families WHERE key_bindings IS NOT NULL AND key_bindings != ?', ['{}']);
                    f = (all || []).find((r) => {
                        try { return Boolean(JSON.parse(r.key_bindings || '{}')[chatKey]); } catch { return false; }
                    }) || null;
                }
            }
            if (!f) return null;
            return assembleFamily(f);
        },

        async createFamily({ family }) {
            await ensureMigrated();
            const existing = await loadFamilyRow(family.familyId);
            if (existing) return { ok: false, reason: 'familyId-exists' };
            if (family.chatKey != null) {
                const byKey = await q('SELECT id FROM families WHERE chat_key = ?', [family.chatKey]);
                if (byKey?.length) return { ok: false, reason: 'chatKey-exists' };
            }
            const now = Date.now();
            const integrity = family.integrity ?? nextIntegrity();
            await q(
                'INSERT INTO families (id, chat_key, character_id, name, integrity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [family.familyId, family.chatKey ?? '', family.characterId ?? '', family.name ?? '', integrity, now, now],
            );
            if (family.keyBindings && Object.keys(family.keyBindings).length) {
                await writeKeyBindings(family.familyId, family.keyBindings);
            }
            for (const b of family.branches || []) {
                await q(
                    'INSERT INTO branches (family_id, branch_id, parent_branch_id, name, fork_floor, is_default) VALUES (?, ?, ?, ?, ?, ?)',
                    [family.familyId, b.id, b.parent_branch_id ?? null, b.name ?? b.id, b.fork_floor ?? 0, b.is_default ? 1 : 0],
                );
                for (const [floorNo, variantId] of Object.entries(family.branchPaths?.[b.id] || {})) {
                    await q(
                        'INSERT INTO branch_paths (family_id, branch_id, floor_no, variant_id) VALUES (?, ?, ?, ?)',
                        [family.familyId, b.id, Number(floorNo), variantId],
                    );
                }
            }
            return { ok: true, familyId: family.familyId, integrity };
        },

        async bindChatKey({ familyId, chatKey }) {
            await ensureMigrated();
            await q('UPDATE families SET chat_key = ?, updated_at = ? WHERE id = ?', [chatKey, Date.now(), familyId]);
            return { ok: true };
        },

        async renameFamily({ familyId, newName }) {
            await ensureMigrated();
            await q('UPDATE families SET name = ?, updated_at = ? WHERE id = ?', [newName, Date.now(), familyId]);
            const integrity = await bumpIntegrity(familyId);
            return { ok: true, integrity };
        },

        async deleteFamily({ familyId }) {
            await ensureMigrated();
            await q('DELETE FROM branch_paths WHERE family_id = ?', [familyId]);
            await q('DELETE FROM branches WHERE family_id = ?', [familyId]);
            await q('DELETE FROM floors WHERE family_id = ?', [familyId]);
            await q('DELETE FROM families WHERE id = ?', [familyId]);
            return { ok: true };
        },

        async loadFloors({ familyId, from = 0, limit = 200 }) {
            await ensureMigrated();
            // 区间分页（禁逐楼层查询纪律）：多取 1 行探测 hasMore
            const rows = await q(
                'SELECT * FROM floors WHERE family_id = ? AND floor_no >= ? ORDER BY floor_no, seq LIMIT ?',
                [familyId, from, limit + 1],
            );
            const hasMore = rows.length > limit;
            return { floors: (hasMore ? rows.slice(0, limit) : rows).map(rowFromSql), hasMore };
        },

        async saveFloors({ familyId, floors, expectedIntegrity }) {
            await ensureMigrated();
            const conflict = await checkIntegrity(familyId, expectedIntegrity);
            if (conflict) return { ok: false, conflict: true };
            for (let i = 0; i < floors.length; i += CHUNK) {
                const chunk = floors.slice(i, i + CHUNK);
                for (const f of chunk) {
                    await q(
                        `INSERT INTO floors (family_id, floor_no, variant_id, seq, content, content_hash, send_date)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(family_id, floor_no, variant_id) DO UPDATE SET
                           seq = excluded.seq, content = excluded.content,
                           content_hash = excluded.content_hash, send_date = excluded.send_date`,
                        [familyId, f.floorNo, f.variantId, f.seq ?? 0, f.content, f.contentHash ?? null, f.sendDate ?? null],
                    );
                }
            }
            const integrity = await bumpIntegrity(familyId);
            return { ok: true, integrity };
        },

        /**
         * 消息补丁（T0b）：投影 → 应用 → 按键写回（详见 `core/patch-rows.js`）。
         * 结构与档2/档3 共用同一个纯函数，差异只在持久化手法（SQL 按 key 删 + upsert）。
         */
        async applyOps({ familyId, ops, expectedIntegrity, model, hostMetadata, keyBindings, branchId }) {
            await ensureMigrated();
            const conflict = await checkIntegrity(familyId, expectedIntegrity);
            if (conflict) return { ok: false, conflict: true };
            const f = await loadFamilyRow(familyId);
            if (!f) return { ok: false, reason: 'family-not-found' };
            const current = await assembleFamily(f);
            const rows = (await q(
                'SELECT * FROM floors WHERE family_id = ? ORDER BY floor_no, seq',
                [familyId],
            )).map(rowFromSql);
            const plan = planBodyPatch({
                rows,
                path: activePathOf(current.model, branchId),
                ops,
                model: model || current.model,
                branchId,
            });
            if (!plan.ok) return { ok: false, reason: plan.reason, detail: plan.detail };
            for (const d of plan.deletes) {
                await q('DELETE FROM floors WHERE family_id = ? AND floor_no = ? AND variant_id = ?', [familyId, d.floorNo, d.variantId]);
            }
            for (let i = 0; i < plan.rows.length; i += CHUNK) {
                for (const r of plan.rows.slice(i, i + CHUNK)) {
                    await q(
                        `INSERT INTO floors (family_id, floor_no, variant_id, seq, content, content_hash, send_date)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(family_id, floor_no, variant_id) DO UPDATE SET
                           seq = excluded.seq, content = excluded.content,
                           content_hash = excluded.content_hash, send_date = excluded.send_date`,
                        [familyId, r.floorNo, r.variantId, r.seq ?? 0, r.content, r.contentHash ?? null, r.sendDate ?? null],
                    );
                }
            }
            if (hostMetadata !== undefined) {
                await q('UPDATE families SET host_metadata = ?, updated_at = ? WHERE id = ?',
                    [JSON.stringify(hostMetadata), Date.now(), familyId]);
            }
            if (keyBindings !== undefined) await writeKeyBindings(familyId, keyBindings);
            if (plan.model) await writeModel(familyId, plan.model);
            const integrity = await bumpIntegrity(familyId);
            return { ok: true, integrity, totalMessages: pathFloors(plan.path).length };
        },

        async saveModel({ familyId, model, hostMetadata, keyBindings, expectedIntegrity, keepCurrent }) {
            await ensureMigrated();
            const conflict = await checkIntegrity(familyId, expectedIntegrity);
            if (conflict) return { ok: false, conflict: true };
            const f = await loadFamilyRow(familyId);
            if (!f) return { ok: false, reason: 'family-not-found' };
            if (keyBindings !== undefined) await writeKeyBindings(familyId, keyBindings);
            // T0/R0：聊天头保留面落库（undefined = 本次不动它）
            if (hostMetadata !== undefined) {
                await q('UPDATE families SET host_metadata = ?, updated_at = ? WHERE id = ?',
                    [JSON.stringify(hostMetadata), Date.now(), familyId]);
            }
            let stored = null;
            try { stored = f.model ? JSON.parse(f.model) : null; } catch { stored = null; }
            const nextModel = keepCurrent ? stored : model;
            if (!keepCurrent && nextModel) {
                await writeModel(familyId, nextModel); // 模型本体 + 结构表重建（active_branch/groups 往返不丢）
            }
            const integrity = await bumpIntegrity(familyId);
            return { ok: true, integrity };
        },

        async moveToTrash({ source, content }) {
            await ensureMigrated();
            const trashId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
            // 档1 回收站：Authority fs（trash/<trashId>/original.jsonl + meta.json）
            await client.fs.writeFile({ path: `trash/${trashId}/original.jsonl`, content: String(content ?? '') });
            await client.fs.writeFile({
                path: `trash/${trashId}/meta.json`,
                content: JSON.stringify({ source, movedAt: Date.now() }),
            });
            return { ok: true, trashId };
        },

        async listTrash() {
            await ensureMigrated();
            const entries = await client.fs.readdir?.('trash') || [];
            const out = [];
            for (const trashId of entries) {
                try {
                    const meta = await client.fs.readFile({ path: `trash/${trashId}/meta.json` });
                    const j = JSON.parse(meta.content ?? meta);
                    out.push({ trashId, source: j.source, movedAt: j.movedAt });
                } catch { /* 损坏条目跳过 */ }
            }
            return out;
        },

        async restoreFromTrash({ trashId }) {
            const meta = await client.fs.readFile({ path: `trash/${trashId}/meta.json` });
            const j = JSON.parse(meta.content ?? meta);
            const file = await client.fs.readFile({ path: `trash/${trashId}/original.jsonl` });
            // 还原 = 经官方通道写回宿主聊天（restoreTarget 由调用方给出）
            return { ok: true, content: file.content ?? file, source: j.source, movedAt: j.movedAt };
        },

        async deleteFromTrash({ trashId }) {
            await client.fs.delete?.({ path: `trash/${trashId}` });
            return { ok: true };
        },

        dispose() { migrated = false; },
    };
}
