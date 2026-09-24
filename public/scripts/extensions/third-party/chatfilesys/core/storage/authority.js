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
        migrated = true;
    }

    const q = (statement, params = []) => client.sql.query({ database: DB, statement, params });

    async function bumpIntegrity(familyId) {
        await q('UPDATE families SET integrity = integrity + 1, updated_at = ? WHERE id = ?', [Date.now(), familyId]);
        const rows = await q('SELECT integrity FROM families WHERE id = ?', [familyId]);
        return rows?.[0]?.integrity ?? 1;
    }

    async function checkIntegrity(familyId, expected) {
        if (expected == null) return null;
        const rows = await q('SELECT integrity FROM families WHERE id = ?', [familyId]);
        const cur = rows?.[0]?.integrity;
        if (cur !== expected) return jsonResponse409; // 哨兵：冲突标记
        return null;
    }

    const jsonResponse409 = { conflict: true };

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
        return {
            familyId: f.id, chatKey: f.chat_key, characterId: f.character_id,
            name: f.name, integrity: f.integrity,
            branches, branchPaths, model,
        };
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
            await q(
                'INSERT INTO families (id, chat_key, character_id, name, integrity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [family.familyId, family.chatKey ?? '', family.characterId ?? '', family.name ?? '', 1, now, now],
            );
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
            return { ok: true, familyId: family.familyId, integrity: 1 };
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

        async applyOps({ familyId, ops, expectedIntegrity }) {
            await ensureMigrated();
            const conflict = await checkIntegrity(familyId, expectedIntegrity);
            if (conflict) return { ok: false, conflict: true };
            for (const op of ops || []) {
                const m = /^\/?(?:chat\/)?(\d+)$/.exec(String(op.path || ''));
                const idx = m ? Number(m[1]) : null;
                if (op.op === 'remove' && idx != null) {
                    // remove：删该行起、后续行整体前移（RFC6902 数组语义）
                    await q('DELETE FROM floors WHERE family_id = ? AND floor_no = ?', [familyId, idx + 1]);
                    await q(
                        'UPDATE floors SET floor_no = floor_no - 1 WHERE family_id = ? AND floor_no > ?',
                        [familyId, idx + 1],
                    );
                } else if (op.op === 'add' && idx != null && op.value != null) {
                    await q(
                        'UPDATE floors SET floor_no = floor_no + 1 WHERE family_id = ? AND floor_no >= ?',
                        [familyId, idx + 1],
                    );
                    await q(
                        `INSERT INTO floors (family_id, floor_no, variant_id, seq, content, content_hash, send_date)
                         VALUES (?, ?, ?, 0, ?, NULL, ?)`,
                        [familyId, idx + 1, `g${idx + 1}`, JSON.stringify(op.value), op.value?.send_date ?? null],
                    );
                    // 路径引用同步前移（与楼层重编号一致）
                    await q(
                        'UPDATE branch_paths SET floor_no = floor_no + 1 WHERE family_id = ? AND floor_no >= ?',
                        [familyId, idx + 1],
                    );
                } else if (op.op === 'replace' && idx != null && op.value != null) {
                    await q(
                        'UPDATE floors SET content = ?, send_date = ? WHERE family_id = ? AND floor_no = ?',
                        [JSON.stringify(op.value), op.value?.send_date ?? null, familyId, idx + 1],
                    );
                }
                // 其他 op 形态（test 等）：忽略（消息 API 不产生）
            }
            const integrity = await bumpIntegrity(familyId);
            return { ok: true, integrity };
        },

        async saveModel({ familyId, model, expectedIntegrity, keepCurrent }) {
            await ensureMigrated();
            const conflict = await checkIntegrity(familyId, expectedIntegrity);
            if (conflict) return { ok: false, conflict: true };
            const f = await loadFamilyRow(familyId);
            if (!f) return { ok: false, reason: 'family-not-found' };
            let stored = null;
            try { stored = f.model ? JSON.parse(f.model) : null; } catch { stored = null; }
            const nextModel = keepCurrent ? stored : model;
            if (!keepCurrent && nextModel) {
                // 模型本体持久化（active_branch/groups 往返不丢）
                await q('UPDATE families SET model = ?, updated_at = ? WHERE id = ?', [JSON.stringify(nextModel), Date.now(), familyId]);
                // 同步重建结构表（parent_branch_id 尽量保留现值）
                const existing = await q('SELECT branch_id, parent_branch_id FROM branches WHERE family_id = ?', [familyId]);
                const parentOf = new Map(existing.map((b) => [b.branch_id, b.parent_branch_id ?? null]));
                await q('DELETE FROM branches WHERE family_id = ?', [familyId]);
                await q('DELETE FROM branch_paths WHERE family_id = ?', [familyId]);
                for (const b of nextModel.branches || []) {
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
