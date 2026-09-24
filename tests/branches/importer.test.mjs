/**
 * importer.js 单测：导入旅程编排（planImport/buildFamily/mergeIntoFamily/attachMergedFork/runImport）
 * 依赖全 mock（adapter/trash/api），验证建档/合并/删除源顺序（PARDON）/失败不阻断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, buildFamilyFromJsonl, mergeIntoFamily, attachMergedFork, runImport } from '../../public/scripts/extensions/third-party/chatfilesys/core/importer.js';

const msg = (mes, i, name = '我', isUser = true) => JSON.stringify({ name, is_user: isUser, mes, send_date: 1000 + i });

function jsonlLines(...msgs) {
    return [
        JSON.stringify({ user_name: 'u', chat_metadata: {} }),
        ...msgs,
    ];
}

/* ---------------- planImport ---------------- */

test('planImport：过滤隐容器与当前聊天', () => {
    const plan = planImport([
        { file_name: 'chat1.jsonl' },
        { file_name: 'chat2.jsonl' },
        { file_name: '__cfsys__f1.jsonl' },
        { file_name: '__cfsys__trash__t1.jsonl' },
        { file_name: 'chat3.jsonl' },
    ], { currentFileName: 'chat2' });
    assert.deepEqual(plan.candidates.map((c) => c.fileName), ['chat1', 'chat3']);
    assert.deepEqual(plan.skipped.hidden, ['__cfsys__f1', '__cfsys__trash__t1']);
    assert.deepEqual(plan.skipped.current, ['chat2']);
});

test('planImport：空列表/无当前', () => {
    assert.deepEqual(planImport([], {}).candidates, []);
    const plan = planImport([{ file_name: 'x.jsonl' }], {});
    assert.equal(plan.candidates.length, 1);
});

/* ---------------- buildFamilyFromJsonl ---------------- */

test('buildFamilyFromJsonl：建档 family+floors+主分支全楼层', async () => {
    const lines = jsonlLines(msg('a', 0), msg('b', 1, 'AI', false));
    const { family, floors, stats } = await buildFamilyFromJsonl(lines, {
        familyId: 'f1', chatKey: 'av::chat1', characterId: 'c1', name: 'chat1',
    });
    assert.equal(family.familyId, 'f1');
    assert.equal(family.branches.length, 1);
    assert.equal(family.branches[0].is_default, true);
    assert.equal(family.branchPaths[family.branches[0].id][1], 'g1');
    assert.equal(family.branchPaths[family.branches[0].id][2], 'g2');
    assert.equal(floors.length, 2);
    assert.equal(floors[0].floorNo, 1);
    assert.equal(floors[0].variantId, 'g1');
    assert.ok(floors[0].contentHash); // sha256 指纹已算
    assert.equal(JSON.parse(floors[1].content).mes, 'b');
    assert.equal(stats.skipped, 0);
});

test('buildFamilyFromJsonl：header 行跳过不计楼层', async () => {
    const lines = [JSON.stringify({ user_name: 'u', chat_metadata: { extensions: { chatfilesys: {} } } }), msg('a', 0)];
    const { floors, stats } = await buildFamilyFromJsonl(lines, { familyId: 'f', chatKey: 'k', characterId: 'c', name: 'n' });
    assert.equal(floors.length, 1);
    assert.equal(stats.skipped, 0); // header 是合法跳过（非损坏）
});

/* ---------------- mergeIntoFamily + attachMergedFork ---------------- */

test('mergeIntoFamily：完全相同 → 幂等去重无 ops', async () => {
    const existing = [{ hash: 'h1', sendDate: 1000, sender: '我' }, { hash: 'h2', sendDate: 1001, sender: 'AI' }];
    const incoming = jsonlLines(msg('a', 0), msg('b', 1, 'AI', false));
    const { floors, stats } = await mergeIntoFamily(existing, incoming);
    // 真实 hash 由 computeHash 产生，与 h1/h2 伪造值不同 → 走 LCP 分叉路径
    // 本用例断言 LCP=0 → 全部为新增行
    assert.equal(stats.merged, 2);
    assert.equal(floors.length, 2);
    assert.equal(floors[0].floorNo, null); // 旁挂语义：楼层号待分配
    assert.equal(floors[0].variantId, 'm1');
});

test('mergeIntoFamily：LCP 相同段去重，剩余段旁挂', async () => {
    // 库内行 = prepareRows 产物（真 hash）→ 同内容 LCP 命中
    const incomingA = jsonlLines(msg('a', 0), msg('b', 1, 'AI', false));
    const prepared = await mergeIntoFamily([], incomingA);
    // 现有 = 空库 → LCP=0 全旁挂——用于构造「库内已有 a,b」
    // 构造既有行（带真 hash）：
    const { rows } = await import('../../public/scripts/extensions/third-party/chatfilesys/core/merge.js').then((m) => m.prepareRows(incomingA));
    // 新导入文件 = a, b, c（a,b 同库）
    const incomingB = jsonlLines(msg('a', 0), msg('b', 1, 'AI', false), msg('c', 2));
    const { floors, stats, forkFloor } = await mergeIntoFamily(rows, incomingB);
    assert.equal(forkFloor, 2); // LCP = 2
    assert.equal(stats.deduped, 2);
    assert.equal(stats.merged, 1); // 只剩 c
    assert.equal(floors.length, 1);
    assert.equal(floors[0].variantId, 'm1');
});

test('attachMergedFork：旁挂变体分配楼层 + 登记子分支', () => {
    const model = {
        active_branch: 'b1',
        branches: [{ id: 'b1', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } }],
        groups: {},
    };
    const mergeFloors = [
        { variantId: 'm1', content: '{}', contentHash: 'x', sendDate: 1 },
        { variantId: 'm2', content: '{}', contentHash: 'y', sendDate: 2 },
    ];
    const { floors, branchId } = attachMergedFork(model, mergeFloors, 2, '导入·chat2');
    assert.equal(branchId, 'b2');
    assert.equal(model.branches.length, 2);
    const nb = model.branches[1];
    assert.equal(nb.path[1], 'g1'); // 共享前缀
    assert.equal(nb.path[2], 'g2');
    assert.equal(nb.path[3], 'm1'); // 新段
    assert.equal(nb.path[4], 'm2');
    assert.equal(nb.fork_base, 2);
    assert.deepEqual(floors.map((f) => f.floorNo), [3, 4]);
});

test('attachMergedFork：forkFloor 超宿主范围抛错', () => {
    const model = { branches: [{ id: 'b1', is_default: true, path: { 1: 'g1' } }] };
    assert.throws(() => attachMergedFork(model, [{ variantId: 'm1' }], 5, 'x'), /超出宿主分支范围/);
});

/* ---------------- runImport（编排全链路） ---------------- */

/** mock adapter（内存）+ mock api + mock trash */
function mockWorld() {
    const db = { families: {}, floorsByFamily: {}, deleted: [], trash: [] };
    /** 契约形态装配：family 含派生 model（真实三档 assembleFamily 同语义） */
    const assemble = (fam) => {
        const branches = (fam.branches || []).map((b) => ({
            id: b.id, name: b.name, is_default: Boolean(b.is_default),
            fork_base: b.fork_floor ?? b.fork_base ?? 0, path: { ...(fam.branchPaths?.[b.id] || {}) },
        }));
        const active = branches.find((b) => b.is_default) || branches[0];
        return {
            ...fam,
            branches: fam.branches,
            model: fam.model || {
                active_branch: active?.id ?? null,
                branches,
                groups: {},
            },
        };
    };
    const adapter = {
        async loadFamily({ chatKey, familyId }) {
            if (familyId != null) {
                const fam = Object.values(db.families).find((f) => f.familyId === familyId);
                return fam ? assemble(fam) : null;
            }
            const fam = db.families[chatKey];
            return fam ? assemble(fam) : null;
        },
        async loadFloors({ familyId }) {
            return { floors: db.floorsByFamily[familyId] || [], hasMore: false };
        },
        async createFamily({ family }) {
            if (db.families[family.chatKey]) return { ok: false, reason: 'chatKey-exists' };
            db.families[family.chatKey] = family;
            db.floorsByFamily[family.familyId] = [];
            return { ok: true, familyId: family.familyId, integrity: 1 };
        },
        async saveFloors({ familyId, floors }) {
            db.floorsByFamily[familyId].push(...floors);
            return { ok: true, integrity: 2 };
        },
        async saveModel({ familyId, model }) {
            const fam = Object.values(db.families).find((f) => f.familyId === familyId);
            fam.model = model;
            return { ok: true, integrity: 3 };
        },
    };
    const api = {
        files: {
            chat1: jsonlLines(msg('a', 0), msg('b', 1, 'AI', false)),
            chat2: jsonlLines(msg('a', 0), msg('c', 2)),
            broken: ['{invalid json', msg('z', 9)],
        },
        async searchChats() {
            return [
                { file_name: 'chat1.jsonl' },
                { file_name: 'chat2.jsonl' },
                { file_name: '__cfsys__f1.jsonl' }, // 隐容器跳过
                { file_name: 'cur.jsonl' }, // 当前聊天跳过
            ];
        },
        async readChatFile(name) {
            const lines = this.files[name];
            return lines ? { header: lines[0], lines: lines.slice(1), raw: lines.join('\n') } : null;
        },
        async deleteChatFile(name) {
            db.deleted.push(name);
            return { ok: true };
        },
    };
    const trash = {
        async snapshotAndMove({ source, content }) {
            db.trash.push({ source, content });
            return { ok: true, trashId: 't1' };
        },
    };
    return { adapter, api, trash, db };
}

test('runImport：建档+合并+删源（回收站先快照后删）', async () => {
    const world = mockWorld();
    const progressCalls = [];
    const result = await runImport({
        adapter: world.api ? world.adapter : world.adapter,
        trash: world.trash,
        api: world.api,
        confirm: async () => true,
        progress: (p) => progressCalls.push(p),
    }, { currentFileName: 'cur', deleteSources: true, characterId: 'c1', avatarUrl: 'av1' });

    assert.equal(result.totalFiles, 2);
    assert.equal(result.importedFiles, 2);
    assert.equal(result.families.length, 1); // chat2 合并入 chat1 家族（同 chatKey 角色同头像）
    // chat1 建档 2 行 + chat2 合并 1 行（LCP=1: a 去重, c 新增）
    assert.equal(result.totalMerged, 3);
    assert.deepEqual(world.db.deleted, ['chat1', 'chat2']); // 源已删
    assert.equal(world.db.trash.length, 2); // 回收站快照先于删除
    // 分支：chat2 挂为子分支
    const fam = Object.values(world.db.families)[0];
    assert.equal(fam.model.branches.length, 2);
    const sub = fam.model.branches.find((b) => !b.is_default);
    assert.equal(sub.name, 'chat2');
    assert.equal(sub.path[1], 'g1'); // 共享前缀 a
    assert.equal(sub.path[2], 'm1'); // c 新段
    // 进度事件序列
    assert.ok(progressCalls.some((p) => p.phase === 'detected'));
    assert.ok(progressCalls.some((p) => p.phase === 'importing'));
});

test('runImport：confirm=false 中止（零写入零删除）', async () => {
    const world = mockWorld();
    const result = await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => false,
    }, { deleteSources: false });
    assert.equal(result.importedFiles, 0);
    assert.equal(Object.keys(world.db.families).length, 0);
    assert.deepEqual(world.db.deleted, []);
});

test('runImport：单文件失败不阻断其余', async () => {
    const world = mockWorld();
    // chat1 读失败（返回 null）
    world.api.files.chat1 = null;
    const result = await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true,
    }, { currentFileName: 'cur', deleteSources: false });
    assert.equal(result.importedFiles, 1); // chat2 仍导入
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].fileName, 'chat1');
});
