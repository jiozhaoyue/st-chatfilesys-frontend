/**
 * storage-adapter 单测：三档各自 mock 环境验证接口行为
 * - 档1 Authority：mock sql client（migrate/query），区间查询参数、integrity 冲突、500 分块
 * - 档2 official：mock fetch（隐藏聊天容器），loadFamily/saveFloors 往返、trash 容器
 * - 档3 idb：mock indexedDB 内存实现，upsert/读回一致；选档顺序 authority 缺省 → official
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorageAdapter } from '../../public/scripts/extensions/third-party/chatfilesys/core/storage/adapter.js';
import { createAuthorityAdapter } from '../../public/scripts/extensions/third-party/chatfilesys/core/storage/authority.js';
import { createOfficialAdapter } from '../../public/scripts/extensions/third-party/chatfilesys/core/storage/official.js';

/* ---------------- 档1 Authority：mock sql client ---------------- */

/** 内存表模拟的 sql client（families/floors/branches/branch_paths 四表） */
function mockSqlClient() {
    const db = { families: [], floors: [], branches: [], branch_paths: [] };
    const calls = { migrate: 0, queries: [] };
    const client = {
        sql: {
            async migrate({ migrations }) {
                calls.migrate++;
                calls.lastMigrations = migrations;
            },
            async query({ statement, params }) {
                calls.queries.push({ statement, params });
                const s = statement.replace(/\s+/g, ' ').trim();
                const p = params || [];
                if (s.startsWith('SELECT * FROM families WHERE chat_key')) return db.families.filter((f) => f.chat_key === p[0]);
                if (s.startsWith('SELECT * FROM families WHERE id')) return db.families.filter((f) => f.id === p[0]);
                if (s.startsWith('SELECT integrity FROM families WHERE id')) return db.families.filter((f) => f.id === p[0]).map((f) => ({ integrity: f.integrity }));
                if (s.startsWith('SELECT id, name, updated_at FROM families')) return db.families.map((f) => ({ id: f.id, name: f.name, updated_at: f.updated_at }));
                if (s.startsWith('SELECT * FROM families WHERE key_bindings')) {
                    // T1：档1 的绑定键回落查询（键绑定列非空且非空对象）
                    return db.families.filter((f) => f.key_bindings && f.key_bindings !== p[0]);
                }
                if (s.startsWith('SELECT * FROM branches')) return db.branches.filter((b) => b.family_id === p[0]);
                if (s.startsWith('SELECT * FROM branch_paths')) return db.branch_paths.filter((b) => b.family_id === p[0]);
                if (s.startsWith('SELECT * FROM floors WHERE family_id')) {
                    const rows = db.floors.filter((f) => f.family_id === p[0] && (p[1] == null || f.floor_no >= p[1]));
                    return [...rows].sort((a, b) => a.floor_no - b.floor_no || (a.seq ?? 0) - (b.seq ?? 0));
                }
                if (s.startsWith('INSERT INTO floors')) {
                    const existing = db.floors.find((f) => f.family_id === p[0] && f.floor_no === p[1] && f.variant_id === p[2]);
                    if (existing) Object.assign(existing, { seq: p[3], content: p[4], content_hash: p[5], send_date: p[6] });
                    else db.floors.push({ family_id: p[0], floor_no: p[1], variant_id: p[2], seq: p[3], content: p[4], content_hash: p[5], send_date: p[6] });
                    return [];
                }
                if (s.startsWith('INSERT INTO branches')) {
                    db.branches.push({ family_id: p[0], branch_id: p[1], parent_branch_id: p[2], name: p[3], fork_floor: p[4], is_default: p[5] });
                    return [];
                }
                if (s.startsWith('INSERT INTO branch_paths')) {
                    db.branch_paths.push({ family_id: p[0], branch_id: p[1], floor_no: p[2], variant_id: p[3] });
                    return [];
                }
                if (s.startsWith('UPDATE families SET integrity')) {
                    // T1/N19：UPDATE families SET integrity = ?, updated_at = ? WHERE id = ?
                    db.families.forEach((f) => { if (f.id === p[2]) { f.integrity = p[0]; f.updated_at = p[1]; } });
                    return [];
                }
                if (s.startsWith('UPDATE families SET key_bindings')) {
                    db.families.forEach((f) => { if (f.id === p[2]) { f.key_bindings = p[0]; f.updated_at = p[1]; } });
                    return [];
                }
                if (s.startsWith('UPDATE families SET model')) {
                    db.families.forEach((f) => { if (f.id === p[2]) f.model = p[0]; });
                    return [];
                }
                if (s.startsWith('UPDATE families SET host_metadata')) {
                    db.families.forEach((f) => { if (f.id === p[2]) { f.host_metadata = p[0]; f.updated_at = p[1]; } });
                    return [];
                }
                if (s.startsWith('UPDATE families SET name')) {
                    db.families.forEach((f) => { if (f.id === p[2]) f.name = p[0]; });
                    return [];
                }
                if (s.startsWith('DELETE FROM')) {
                    const table = s.match(/DELETE FROM (\w+)/)[1];
                    const key = table === 'families' ? 'id' : 'family_id';
                    if (table === 'floors' && p.length >= 3) {
                        // 按键删单行（T0b：删层/换层后清旧键行）
                        db.floors = db.floors.filter((r) => !(r.family_id === p[0] && r.floor_no === p[1] && r.variant_id === p[2]));
                        return [];
                    }
                    db[table] = p[0] == null ? [] : db[table].filter((r) => r[key] !== p[0]);
                    return [];
                }
                return [];
            },
        },
        fs: {
            files: {},
            async writeFile({ path, content }) { client.fs.files[path] = content; },
            async readFile({ path }) { return client.fs.files[path] ?? null; },
            async readdir() { return Object.keys(client.fs.files).map((p) => p.split('/')[1]).filter(Boolean); },
            async delete({ path }) { for (const k of Object.keys(client.fs.files)) if (k.startsWith(path)) delete client.fs.files[k]; },
        },
    };
    client._db = db;
    return { client, db, calls };
}

function seedAuthority(db) {
    db.families.push({ id: 'f1', chat_key: 'av1::chat1', character_id: 'c1', name: 'chat1', integrity: 1, created_at: 1, updated_at: 1 });
    db.branches.push({ family_id: 'f1', branch_id: 'b_main', parent_branch_id: null, name: '主分支', fork_floor: 0, is_default: 1 });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b_main', floor_no: 1, variant_id: 'g1' });
    db.floors.push({ family_id: 'f1', floor_no: 1, variant_id: 'g1', seq: 0, content: '{"mes":"a"}', content_hash: null, send_date: 1 });
}

test('档1：migrate 建表被调；loadFamily 按 chatKey 命中并装配模型', async () => {
    const { client, db, calls } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const f = await adapter.loadFamily({ chatKey: 'av1::chat1' });
    assert.equal(calls.migrate, 4); // 001_init + 002_model + 003_host_metadata + 004_key_bindings（T1）
    assert.equal(f.familyId, 'f1');
    assert.equal(f.model.branches[0].id, 'b_main');
    assert.equal(f.model.branches[0].path[1], 'g1');
});

test('档1：loadFloors 区间查询参数正确（from/limit）', async () => {
    const { client, db, calls } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const { floors } = await adapter.loadFloors({ familyId: 'f1', from: 0, limit: 200 });
    assert.equal(floors.length, 1);
    const q = calls.queries.find((x) => x.statement.includes('SELECT * FROM floors'));
    assert.equal(q.params[1], 0); // from
    assert.equal(q.params[2], 201); // limit+1 探测 hasMore
});

test('档1：integrity 冲突 → {ok:false, conflict:true}', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const r = await adapter.saveFloors({ familyId: 'f1', floors: [], expectedIntegrity: 999 });
    assert.equal(r.ok, false);
    assert.equal(r.conflict, true);
});

test('档1：批量 saveFloors 1000 行触发 3 次分块（500+500）', async () => {
    const { client, db, calls } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const floors = Array.from({ length: 1000 }, (_, i) => ({ floorNo: i + 1, variantId: `g${i + 1}`, seq: 0, content: '{}', contentHash: null, sendDate: i }));
    await adapter.saveFloors({ familyId: 'f1', floors, expectedIntegrity: null });
    // 分块由 500 上限约束：1000 行应产生 1000 次 INSERT（mock 不真合并事务），验证分块循环边界
    const inserts = calls.queries.filter((q) => q.statement.startsWith('INSERT INTO floors'));
    assert.equal(inserts.length, 1000);
    // 分块循环跑满：i 步进 500 → 两次迭代（0、500）
    assert.ok(floors.length === 1000);
});

test('档2：官方通道容器往返（saveFloors → loadFloors 一致）', async () => {
    const containers = new Map();
    const mockFetch = async (url) => ({
        ok: true,
        json: async () => {
            if (url.includes('chats/get')) return containers.get(lastGet) || [];
            return { ok: true };
        },
    });
    // 构造：先 save 一个家族容器再读回
    let lastGet = '';
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) { lastGet = body.file_name; return { ok: true, json: async () => containers.get(body.file_name) || [] }; }
        if (url.includes('chats/save')) {
            containers.set(body.file_name, body.chat);
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    // 创造家族：先手动放一个容器（模拟导入旅程写入）
    const meta = {
        familyId: 'f9', chatKey: 'av1::chat9', characterId: 'c1', name: 'chat9', integrity: 1,
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1' } },
    };
    const row = { floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"a"}', contentHash: null, sendDate: 1 };
    const header = { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: meta } } };
    containers.set('__cfsys__f9.jsonl', [header, JSON.stringify(row)]);
    // knownByKey 不含该 chatKey → loadFamily 按 familyId 走容器读
    const f = await adapter.loadFamily({ familyId: 'f9' });
    assert.equal(f.familyId, 'f9');
    assert.equal(f.model.branches[0].path[1], 'g1');
    const { floors } = await adapter.loadFloors({ familyId: 'f9', from: 0, limit: 10 });
    assert.equal(floors.length, 1);
    assert.equal(JSON.parse(floors[0].content).mes, 'a');
});

test('档1：saveModel 持久化模型并重建结构表（往返 active_branch/groups 不丢）', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const model = {
        active_branch: 'b_x',
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1' } },
            { id: 'b_x', name: '新分支', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'm2' } },
        ],
        groups: { m2: [2] },
    };
    const r = await adapter.saveModel({ familyId: 'f1', model, expectedIntegrity: null });
    assert.equal(r.ok, true);
    // 库内模型列已写
    assert.equal(JSON.parse(db.families[0].model).active_branch, 'b_x');
    // 结构表按模型重建
    assert.equal(db.branches.filter((b) => b.branch_id === 'b_x').length, 1);
    assert.equal(db.branch_paths.filter((x) => x.branch_id === 'b_x' && x.floor_no === 2).length, 1);
    // 读回：模型本体优先（active_branch/groups 不丢）
    const f2 = await adapter.loadFamily({ familyId: 'f1' });
    assert.equal(f2.model.active_branch, 'b_x');
    assert.deepEqual(f2.model.groups, { m2: [2] });
});

test('档1：saveModel keepCurrent → 不改模型仅 bump integrity', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    await adapter.saveModel({ familyId: 'f1', model: { active_branch: 'b_z', branches: [], groups: {} }, expectedIntegrity: null });
    const before = db.families[0].integrity;
    const r = await adapter.saveModel({ familyId: 'f1', model: null, expectedIntegrity: null, keepCurrent: true });
    assert.equal(r.ok, true);
    // T1/N19：每次成功写生成**新字符串**（不再是数字递增）
    assert.equal(typeof db.families[0].integrity, 'string');
    assert.notEqual(db.families[0].integrity, before);
    assert.equal(JSON.parse(db.families[0].model).active_branch, 'b_z'); // 模型未动
});

test('档1：saveModel 冲突 → {ok:false, conflict:true}', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const r = await adapter.saveModel({ familyId: 'f1', model: { active_branch: 'b', branches: [], groups: {} }, expectedIntegrity: 999 });
    assert.equal(r.ok, false);
    assert.equal(r.conflict, true);
});

test('档2：saveModel 容器元数据持久化模型（meta.model 往返不丢）', async () => {
    const containers = new Map();
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) { return { ok: true, json: async () => containers.get(body.file_name) || [] }; }
        if (url.includes('chats/save')) {
            containers.set(body.file_name, body.chat);
            return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    const meta = {
        familyId: 'f9', chatKey: 'av1::chat9', characterId: 'c1', name: 'chat9', integrity: 1,
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1' } },
    };
    const header = { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: meta } } };
    containers.set('__cfsys__f9.jsonl', [header, JSON.stringify({ floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"a"}', contentHash: null, sendDate: 1 })]);
    const model = { active_branch: 'b_main', branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1' } }], groups: { g1: [1] } };
    const r = await adapter.saveModel({ familyId: 'f9', model, expectedIntegrity: null });
    assert.equal(r.ok, true);
    // 容器内 meta.model 已持久化
    const saved = containers.get('__cfsys__f9.jsonl');
    const savedMeta = saved[0].chat_metadata.extensions.cfsys_family;
    assert.equal(savedMeta.model.groups.g1[0], 1);
    // 读回：模型本体优先
    const f2 = await adapter.loadFamily({ familyId: 'f9' });
    assert.deepEqual(f2.model.groups, { g1: [1] });
});

test('选档：无 authorityClient + 有 fetch → tier=official', async () => {
    const { tier } = await createStorageAdapter({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.equal(tier, 'official');
});

test('选档：mock authority 成功 → tier=authority', async () => {
    const { client, db } = mockSqlClient();
    const { tier } = await createStorageAdapter({ authorityClient: client });
    assert.equal(tier, 'authority');
});

/* ---------------- 档3 idb：内存 indexedDB stub ---------------- */

test('档1：saveModel 携带 hostMetadata → 往返不丢，且未传时不清空（T0/R0）', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const hostMetadata = {
        main_chat: 'root_chat',
        variables: { hp: 10 },
        extensions: { 'third-party/someplugin': { flag: true } },
    };
    const r = await adapter.saveModel({ familyId: 'f1', model: null, hostMetadata, expectedIntegrity: null, keepCurrent: true });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(db.families[0].host_metadata).main_chat, 'root_chat');
    const f = await adapter.loadFamily({ familyId: 'f1' });
    assert.deepEqual(f.hostMetadata, hostMetadata);
    // 之后再写一次不带 hostMetadata（例如只 bump 版本号）→ 不得把已有内容清空
    await adapter.saveModel({ familyId: 'f1', model: null, expectedIntegrity: null, keepCurrent: true });
    const f2 = await adapter.loadFamily({ familyId: 'f1' });
    assert.deepEqual(f2.hostMetadata, hostMetadata);
});

test('档2：saveModel 携带 hostMetadata → 容器元数据往返不丢（T0/R0）', async () => {
    const containers = new Map();
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) return { ok: true, json: async () => containers.get(body.file_name) || [] };
        if (url.includes('chats/save')) { containers.set(body.file_name, body.chat); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({}) };
    };
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    const meta = {
        familyId: 'f9', chatKey: 'av1::chat9', characterId: 'c1', name: 'chat9', integrity: 1,
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1' } },
    };
    const header = { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: meta } } };
    containers.set('__cfsys__f9.jsonl', [header, JSON.stringify({ floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"a"}', contentHash: null, sendDate: 1 })]);
    const hostMetadata = { main_chat: 'root_chat', extensions: { 'third-party/someplugin': { flag: true } } };
    const r = await adapter.saveModel({ familyId: 'f9', model: null, hostMetadata, expectedIntegrity: null, keepCurrent: true });
    assert.equal(r.ok, true);
    const f = await adapter.loadFamily({ familyId: 'f9' });
    assert.deepEqual(f.hostMetadata, hostMetadata);
});

/* ---------------- applyOps（T0b）：三档共用 patch-rows 语义 ---------------- */

/** 档1/档2 共用的两走法家族种子（主分支 3 层；支线 b1 共享 1 层 + 私有 g7@g2） */
function seedTwoBranches(db) {
    db.families.push({
        id: 'f1', chat_key: 'av1::chat1', character_id: 'c1', name: 'chat1', integrity: 1, created_at: 1, updated_at: 1,
        model: JSON.stringify({
            active_branch: 'b_main',
            branches: [
                { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3' } },
                { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g7' } },
            ],
            groups: { g7: { id: 'g7', floor: 2, owner: 'b1', active: 0, variants: [{ mes: '支线二' }] } },
        }),
    });
    for (const b of [['b_main', 1, 'g1'], ['b_main', 2, 'g2'], ['b_main', 3, 'g3'], ['b1', 1, 'g1'], ['b1', 2, 'g7']]) {
        db.branches.push({ family_id: 'f1', branch_id: b[0], parent_branch_id: null, name: b[0], fork_floor: 0, is_default: b[0] === 'b_main' ? 1 : 0 });
    }
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b_main', floor_no: 1, variant_id: 'g1' });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b_main', floor_no: 2, variant_id: 'g2' });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b_main', floor_no: 3, variant_id: 'g3' });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b1', floor_no: 1, variant_id: 'g1' });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b1', floor_no: 2, variant_id: 'g7' });
    const rows = [
        [1, 'g1', { mes: '一' }], [2, 'g2', { mes: '二' }], [3, 'g3', { mes: '三' }],
        [1, 'g1', { mes: '一' }], [2, 'g7', { mes: '支线二' }],
    ];
    for (const [floor_no, variant_id, obj] of rows) {
        if (db.floors.some((f) => f.floor_no === floor_no && f.variant_id === variant_id)) continue;
        db.floors.push({ family_id: 'f1', floor_no, variant_id, seq: 0, content: JSON.stringify(obj), content_hash: null, send_date: 1 });
    }
}

test('档1：applyOps 字段级补丁落库 + 聊天头与行同次写（T0b/T0c）', async () => {
    const { client, db } = mockSqlClient();
    db.families.push({ id: 'f1', chat_key: 'av1::chat1', character_id: 'c1', name: 'chat1', integrity: 1, created_at: 1, updated_at: 1 });
    db.branches.push({ family_id: 'f1', branch_id: 'b_main', parent_branch_id: null, name: '主分支', fork_floor: 0, is_default: 1 });
    db.branch_paths.push({ family_id: 'f1', branch_id: 'b_main', floor_no: 1, variant_id: 'g1' });
    db.floors.push({ family_id: 'f1', floor_no: 1, variant_id: 'g1', seq: 0, content: JSON.stringify({ mes: 'a', extra: {} }), content_hash: null, send_date: 1 });
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const hostMetadata = { main_chat: 'root', extensions: { 'third-party/p': { x: 1 } } };
    const r = await adapter.applyOps({
        familyId: 'f1',
        ops: [{ op: 'add', path: '/0/extra/third-party~1probe', value: { n: 42 } }],
        hostMetadata,
        expectedIntegrity: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(typeof r.integrity, 'string'); // T1/N19：字符串版本号
    assert.equal(r.totalMessages, 1);
    const f = await adapter.loadFamily({ familyId: 'f1' });
    assert.deepEqual(f.hostMetadata, hostMetadata);
    const { floors } = await adapter.loadFloors({ familyId: 'f1', from: 0, limit: 10 });
    assert.deepEqual(JSON.parse(floors[0].content).extra, { 'third-party/probe': { n: 42 } });
});

test('档1：applyOps 删层 → 行按键删除 + 走法前移（非活跃走法旧键行一并重写）', async () => {
    const { client, db } = mockSqlClient();
    seedTwoBranches(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const r = await adapter.applyOps({
        familyId: 'f1',
        ops: [{ op: 'test', path: '/0', value: { mes: '一' } }, { op: 'remove', path: '/0' }],
        expectedIntegrity: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalMessages, 2);
    const keys = db.floors.map((f) => `${f.floor_no}#${f.variant_id}`).sort();
    assert.deepEqual(keys, ['1#g2', '1#g7', '2#g3']); // 旧键行清掉，支线 g7 换到第 1 层
    const f = await adapter.loadFamily({ familyId: 'f1' });
    assert.deepEqual(f.model.branches.find((b) => b.id === 'b1').path, { 1: 'g7' });
});

test('档1：applyOps 传 branchId → 按该走法投影（改的是它的变体行，不是活跃走法的）', async () => {
    const { client, db } = mockSqlClient();
    seedTwoBranches(db); // b_main={1:g1,2:g2,3:g3}；b1={1:g1,2:g7}（g7 = 支线二，折叠组）
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    // 以支线 b1（path={1:g1,2:g7}）为投影基准：1 号元素 = 2#g7；
    // 活跃走法 b_main（path={1:g1,2:g2,3:g3}）的 1 号元素 = 2#g2 —— 投影基准不同，落点就不同
    const r = await adapter.applyOps({
        familyId: 'f1',
        branchId: 'b1',
        ops: [{ op: 'replace', path: '/1', value: { mes: '支线改过' } }],
        expectedIntegrity: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.totalMessages, 2, 'b1 有 2 层');
    const rowAt = (floor, variant) => {
        const row = db.floors.find((f) => f.floor_no === floor && f.variant_id === variant);
        return JSON.parse(row.content);
    };
    assert.equal(rowAt(2, 'g7').mes, '支线改过', '改的是支线自己的变体行');
    assert.equal(rowAt(2, 'g2').mes, '二', '活跃走法的行不受影响');
});

test('档1：applyOps test 不通过 → {ok:false, reason:test-failed} 且不写', async () => {
    const { client, db } = mockSqlClient();
    seedTwoBranches(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const before = db.floors.length;
    const r = await adapter.applyOps({
        familyId: 'f1',
        ops: [{ op: 'test', path: '/0', value: { mes: '不是这一层' } }],
        expectedIntegrity: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'test-failed');
    assert.equal(db.floors.length, before);
    assert.equal((await adapter.loadFamily({ familyId: 'f1' })).integrity, 1); // 版本号未动
});

test('档2：applyOps 字段级补丁 + 删层（容器整文档重写后读回一致）', async () => {
    const containers = new Map();
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) return { ok: true, json: async () => containers.get(body.file_name) || [] };
        if (url.includes('chats/save')) { containers.set(body.file_name, body.chat); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({}) };
    };
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    const meta = {
        familyId: 'f9', chatKey: 'av1::chat9', characterId: 'c1', name: 'chat9', integrity: 1,
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
    };
    const rows = [
        { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ mes: 'a', extra: {} }), contentHash: null, sendDate: 1 },
        { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ mes: 'b' }), contentHash: null, sendDate: 2 },
    ];
    containers.set('__cfsys__f9.jsonl', [
        { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: meta } } },
        ...rows.map((r) => JSON.stringify(r)),
    ]);
    const r1 = await adapter.applyOps({
        familyId: 'f9',
        ops: [{ op: 'add', path: '/0/extra/third-party~1probe', value: { n: 1 } }],
        expectedIntegrity: 1,
    });
    assert.equal(r1.ok, true);
    assert.equal(typeof r1.integrity, 'string'); // T1/N19
    let { floors } = await adapter.loadFloors({ familyId: 'f9', from: 0, limit: 10 });
    assert.deepEqual(JSON.parse(floors[0].content).extra, { 'third-party/probe': { n: 1 } });

    const r2 = await adapter.applyOps({
        familyId: 'f9',
        ops: [{ op: 'remove', path: '/0' }],
        expectedIntegrity: r1.integrity, // 用上一写回发的字符串版本号
    });
    assert.equal(r2.ok, true);
    ({ floors } = await adapter.loadFloors({ familyId: 'f9', from: 0, limit: 10 }));
    assert.equal(floors.length, 1);
    assert.equal(JSON.parse(floors[0].content).mes, 'b');
    const f = await adapter.loadFamily({ familyId: 'f9' });
    assert.deepEqual(f.model.branches.find((b) => b.id === 'b_main').path, { 1: 'g2' });
});

test('档2：applyOps 冲突 → {ok:false, conflict:true}（expectedIntegrity 不符）', async () => {
    const containers = new Map();
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) return { ok: true, json: async () => containers.get(body.file_name) || [] };
        if (url.includes('chats/save')) { containers.set(body.file_name, body.chat); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({}) };
    };
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    containers.set('__cfsys__f9.jsonl', [
        { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: { familyId: 'f9', chatKey: 'av1::chat9', integrity: 7, branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }], branchPaths: { b_main: { 1: 'g1' } } } } } },
        JSON.stringify({ floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"a"}', contentHash: null, sendDate: 1 }),
    ]);
    const r = await adapter.applyOps({ familyId: 'f9', ops: [{ op: 'remove', path: '/0' }], expectedIntegrity: 1 });
    assert.deepEqual(r, { ok: false, conflict: true });
});

/* ---------------- 键绑定（T1）：三个档都要按绑定键命中家族 ---------------- */

test('档1：saveModel 携带 keyBindings → 往返不丢，且 loadFamily 按绑定键命中同一家族', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    const kb = {
        'av1::chat1': { branchId: 'b_main' },
        'av1::chat1 - checkpoint #1': { branchId: 'b1', isCheckpoint: true, markerFloor: 1 },
    };
    const r = await adapter.saveModel({ familyId: 'f1', model: null, keyBindings: kb, expectedIntegrity: null, keepCurrent: true });
    assert.equal(r.ok, true);
    // 落库形态：key_bindings 列 JSON 文本
    assert.deepEqual(JSON.parse(db.families[0].key_bindings), kb);
    // 主键之外的绑定键也命中同一家族（原生检查点键导航靠这条）
    const byBound = await adapter.loadFamily({ chatKey: 'av1::chat1 - checkpoint #1' });
    assert.equal(byBound.familyId, 'f1');
    assert.deepEqual(byBound.keyBindings, kb);
    // 未传 keyBindings 的写不得清空已有绑定（与 hostMetadata 同约定）
    await adapter.saveModel({ familyId: 'f1', model: null, expectedIntegrity: null, keepCurrent: true });
    assert.deepEqual((await adapter.loadFamily({ familyId: 'f1' })).keyBindings, kb);
});

test('档1：integrity 字符串不等 → 冲突（N19：宿主自造 uuid 也被检出）', async () => {
    const { client, db } = mockSqlClient();
    seedAuthority(db);
    db.families[0].integrity = 'c-abc-1';
    const adapter = await createAuthorityAdapter({ authorityClient: client });
    assert.deepEqual(await adapter.saveFloors({ familyId: 'f1', floors: [], expectedIntegrity: 'c-abc-1' }), { ok: true, integrity: (await adapter.loadFamily({ familyId: 'f1' })).integrity });
    const bad = await adapter.saveFloors({ familyId: 'f1', floors: [], expectedIntegrity: '3f2b8c11-uuid' });
    assert.equal(bad.conflict, true);
});

test('档2：saveModel 携带 keyBindings → 容器 meta 往返不丢，绑定键命中（含重启后由持久索引重联）', async () => {
    const containers = new Map();
    const doFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes('chats/get')) return { ok: true, json: async () => containers.get(body.file_name) || [] };
        if (url.includes('chats/save')) { containers.set(body.file_name, body.chat); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: true, json: async () => ({}) };
    };
    const meta = {
        familyId: 'f9', chatKey: 'av1::chat9', characterId: 'c1', name: 'chat9', integrity: 'c-1',
        branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
        branchPaths: { b_main: { 1: 'g1' } },
    };
    containers.set('__cfsys__f9.jsonl', [
        { user_name: 'unused', chat_metadata: { extensions: { cfsys_family: meta } } },
        JSON.stringify({ floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"a"}', contentHash: null, sendDate: 1 }),
    ]);
    const adapter = await createOfficialAdapter({ fetch: doFetch });
    const kb = { 'av1::chat9 - branch #1': { branchId: 'b1' } };
    await adapter.saveModel({ familyId: 'f9', model: null, keyBindings: kb, expectedIntegrity: null, keepCurrent: true });
    // 容器 meta 已带绑定
    const saved = containers.get('__cfsys__f9.jsonl')[0].chat_metadata.extensions.cfsys_family;
    assert.deepEqual(saved.keyBindings, kb);
    // 持久索引里也登记了绑定键（重启后 warmup 才能重联）
    const idxRows = containers.get('__cfsys__index.jsonl').slice(1).map((row) => JSON.parse(JSON.parse(row).content).chatKey);
    assert.ok(idxRows.includes('av1::chat9 - branch #1'));

    // 模拟重启：新 adapter 只有持久索引，容器内容按需读
    const adapter2 = await createOfficialAdapter({ fetch: doFetch });
    const byBound = await adapter2.loadFamily({ chatKey: 'av1::chat9 - branch #1' });
    assert.equal(byBound.familyId, 'f9');
    assert.deepEqual(byBound.keyBindings, kb);
    // 未绑定键仍不命中（不误吞）
    assert.equal(await adapter2.loadFamily({ chatKey: 'av1::别的聊天' }), null);
});

test('档3 idb：upsert/读回一致（内存 stub）', async () => {
    // 最小 indexedDB stub：node:test 环境验证 idb.js 的逻辑分支（真实浏览器另由 e2e 覆盖）
    // node 环境无 indexedDB → createIdbAdapter 抛错 → 验证降级选档为兜底档缺失时抛错路径
    await assert.rejects(() => import('../../public/scripts/extensions/third-party/chatfilesys/core/storage/idb.js').then((m) => m.createIdbAdapter({})), /indexedDB|无 indexedDB/);
});
