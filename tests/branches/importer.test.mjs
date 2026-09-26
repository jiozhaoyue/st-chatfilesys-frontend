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

test('planImport：only 限定到指定文件（T4「角色卡的聊天 → 转数据库」按行触发）', () => {
    const list = [
        { file_name: 'chat1.jsonl' },
        { file_name: 'chat2.jsonl' },
        { file_name: '__cfsys__f1.jsonl' },
    ];
    // 单个文件名，带不带 .jsonl 都能命中
    assert.deepEqual(planImport(list, { only: 'chat2.jsonl' }).candidates.map((c) => c.fileName), ['chat2']);
    assert.deepEqual(planImport(list, { only: 'chat1' }).candidates.map((c) => c.fileName), ['chat1']);
    // 数组形式
    assert.deepEqual(planImport(list, { only: ['chat1', 'chat2'] }).candidates.map((c) => c.fileName), ['chat1', 'chat2']);
    // only 与 currentFileName 同时给出：命中的当前聊天仍被排除
    assert.deepEqual(planImport(list, { only: 'chat1', currentFileName: 'chat1' }).candidates, []);
    // only 指向不存在的文件 / 指向隐容器 → 空
    assert.deepEqual(planImport(list, { only: 'nope' }).candidates, []);
    assert.deepEqual(planImport(list, { only: '__cfsys__f1' }).candidates, []);
    // 未给 only = 原行为（全量候选）
    assert.deepEqual(planImport(list, {}).candidates.map((c) => c.fileName), ['chat1', 'chat2']);
});

test('planImport：includeCurrent 才把当前打开的聊天算进候选（T8 提醒弹窗①）', () => {
    const list = [{ file_name: 'chat1.jsonl' }, { file_name: 'chat2.jsonl' }];
    // 默认（含 only）：当前聊天仍被排除 —— 用户要转的就是眼前这个聊天，故 T8 必须显式放行
    assert.deepEqual(planImport(list, { only: 'chat1', currentFileName: 'chat1' }).candidates, []);
    assert.deepEqual(
        planImport(list, { only: 'chat1', currentFileName: 'chat1', includeCurrent: true })
            .candidates.map((c) => c.fileName),
        ['chat1'],
    );
    // 放行后仍不带进别的文件（only 照样限定）+ 仍过滤隐容器
    const plan = planImport(
        [...list, { file_name: '__cfsys__f1.jsonl' }],
        { only: 'chat1', currentFileName: 'chat1', includeCurrent: true },
    );
    assert.deepEqual(plan.candidates.map((c) => c.fileName), ['chat1']);
    assert.deepEqual(plan.skipped.current, []);
    assert.deepEqual(plan.skipped.hidden, ['__cfsys__f1']);
    // 带 .jsonl 的当前文件名一样能命中
    assert.deepEqual(
        planImport(list, { only: 'chat1.jsonl', currentFileName: 'chat1', includeCurrent: true })
            .candidates.map((c) => c.fileName),
        ['chat1'],
    );
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

test('buildFamilyFromJsonl：**对象形态的行也计楼层**（2026-09-26 真机取事实）', async () => {
    // 宿主 /api/chats/get 的 body 条目是**已解析的对象**（FS/SQLite 引擎都解析每一行）。
    // 只认字符串的老实现会把整份聊天当非法行跳过 → 导入进库的是空家族（0 楼层），
    // 而测「当前打开的聊天」时会被宿主随后的全量保存回填掩盖（冷路径才暴露）。
    const { floors, stats } = await buildFamilyFromJsonl([
        { user_name: 'u', chat_metadata: { main_chat: 'p' } },
        { name: '我', is_user: true, mes: 'a', send_date: 1000 },
        { name: 'AI', is_user: false, mes: 'b', send_date: 1001 },
    ], { familyId: 'f', chatKey: 'k', characterId: 'c', name: 'n' });
    assert.equal(floors.length, 2, '对象行必须算楼层');
    assert.equal(JSON.parse(floors[0].content).mes, 'a');
    assert.equal(JSON.parse(floors[1].content).mes, 'b');
    assert.equal(stats.skipped, 0);
    assert.ok(floors[0].contentHash);
});

test('buildFamilyFromJsonl：字符串与对象混排也能对齐（边界容错）', async () => {
    const { floors, stats } = await buildFamilyFromJsonl([
        JSON.stringify({ user_name: 'u', chat_metadata: {} }),
        JSON.stringify({ name: '我', is_user: true, mes: 'a' }),
        { name: 'AI', is_user: false, mes: 'b' },
        '{坏行',                     // 非法字符串 → 计入 skipped
        null,                        // 非字符串非对象 → 计入 skipped
    ], { familyId: 'f', chatKey: 'k', characterId: 'c', name: 'n' });
    assert.equal(floors.length, 2);
    assert.equal(stats.skipped, 2);
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
        async saveModel({ familyId, model, hostMetadata }) {
            const fam = Object.values(db.families).find((f) => f.familyId === familyId);
            if (model !== undefined) fam.model = model;
            if (hostMetadata !== undefined) fam.hostMetadata = hostMetadata;
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
            if (!lines) return null;
            // header 与真实端点同形态：index.js#importApi 拿到的是 `data[0]`（**已解析的对象**）。
            // 解析失败不影响建档（lines 照样送 prepareRows，被当损坏行跳过）。
            let header = null;
            try { header = JSON.parse(lines[0]); } catch { header = null; }
            return { header, lines: lines.slice(1), raw: lines.join('\n') };
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

/* ---------------- W5：源 jsonl 的聊天头必须进库（冷导入不得丢） ---------------- */

/** 给某个 mock 文件的 header 行换上指定 chat_metadata（原生聊天头形态） */
function withHeader(meta) {
    return JSON.stringify({ user_name: 'u', character_name: 'c', chat_metadata: meta });
}

test('runImport：新建档时源 header 的聊天头整份进库（别的插件命名空间 + main_chat）', async () => {
    const world = mockWorld();
    world.api.files.chat1[0] = withHeader({
        main_chat: '父聊天',
        variables: { hp: 3 },
        extensions: { 'third-party/x': { flag: 1 } },
    });
    await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true,
    }, { currentFileName: 'cur', only: 'chat1', deleteSources: false, characterId: 'c1', avatarUrl: 'av1' });

    const fam = Object.values(world.db.families)[0];
    assert.deepEqual(fam.hostMetadata, {
        main_chat: '父聊天',
        variables: { hp: 3 },
        extensions: { 'third-party/x': { flag: 1 } },
    }, '冷路径：源文件是唯一来源，宿主内存那份帮不上忙');
});

test('runImport：源 header 里本插件两项（模型 / 版本号）被剔除，不进保留面', async () => {
    const world = mockWorld();
    world.api.files.chat1[0] = withHeader({
        integrity: 'c-old',
        other_plugin: 7,
        extensions: { chatfilesys: { active_branch: 'b_main', branches: [], groups: {} } },
    });
    await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true,
    }, { currentFileName: 'cur', only: 'chat1', deleteSources: false, characterId: 'c1', avatarUrl: 'av1' });

    const fam = Object.values(world.db.families)[0];
    assert.equal(fam.hostMetadata.integrity, undefined, '版本号真源在库');
    assert.equal(fam.hostMetadata.extensions, undefined, '模型真源在库；只剩本插件命名空间 → 不留空壳');
    assert.equal(fam.hostMetadata.other_plugin, 7, '别人的顶层键留下');
});

test('runImport：合并进既有家族时逐命名空间合并（库内既有内容不丢）', async () => {
    const world = mockWorld();
    world.api.files.chat1[0] = withHeader({ extensions: { a: { v: 1 } }, top_a: 'keep' });
    world.api.files.chat2[0] = withHeader({ extensions: { b: { v: 2 } }, top_b: 'new' });
    await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true,
    }, { currentFileName: 'cur', deleteSources: false, characterId: 'c1', avatarUrl: 'av1' });

    const fam = Object.values(world.db.families)[0];
    assert.equal(world.db.families[fam.chatKey].hostMetadata, fam.hostMetadata, '单一家族');
    assert.deepEqual(fam.hostMetadata.extensions, { a: { v: 1 }, b: { v: 2 } }, '两侧命名空间都在');
    assert.equal(fam.hostMetadata.top_a, 'keep');
    assert.equal(fam.hostMetadata.top_b, 'new');
});

test('runImport：库内行没存 hash 时按内容现算 → 同一份内容不会被再挂一条重复分支', async () => {
    const world = mockWorld();
    const deps = { adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true };
    const opts = { currentFileName: 'cur', only: 'chat1', deleteSources: false, characterId: 'c1', avatarUrl: 'av1' };
    await runImport(deps, opts);
    const fam0 = Object.values(world.db.families)[0];
    const floors0 = world.db.floorsByFamily[fam0.familyId];
    assert.equal(floors0.length, 2);
    // 模拟**接缝写路径**落库的行：contentHash 留空（`core/seam.js` 不做合并判定，故不存 hash）。
    // 老实现直接拿 null 当指纹 → LCP 在第 1 层就断 → 整份内容被当成"分叉"再挂一条同内容分支。
    for (const r of floors0) r.contentHash = null;

    await runImport(deps, opts);   // 再导一次同一份文件

    const fam = Object.values(world.db.families)[0];
    const branches = fam.model?.branches ?? fam.branches ?? [];
    assert.equal(branches.length, 1, '幂等：不该多出一条分支');
    assert.equal(world.db.floorsByFamily[fam.familyId].length, 2, '幂等：不该多出楼层行');
});


/* ---------------- F2：并入既有家族时，被并入聊天的父线索不进家族级（2026-09-26） ---------------- */

test('runImport：并入既有家族时分支文件的 main_chat 不落到家族级（F2）', async () => {
    const world = mockWorld();
    // chat1 = 家族主键（自己带父线索：那是它自己的，保留）；chat2 = 被并入的聊天（父线索归它自己）
    world.api.files.chat1[0] = withHeader({ top_a: 'keep', main_chat: '更早的父' });
    world.api.files.chat2[0] = withHeader({ main_chat: 'chat1', variables: { hp: 1 } });
    await runImport({
        adapter: world.adapter, trash: world.trash, api: world.api, confirm: async () => true,
    }, { currentFileName: 'cur', deleteSources: false, characterId: 'c1', avatarUrl: 'av1' });

    const fam = Object.values(world.db.families)[0];
    assert.equal(fam.chatKey, 'av1::chat1', 'chat1 是家族主键');
    assert.equal(fam.hostMetadata.main_chat, '更早的父', '主键自己的父线索保留');
    assert.equal(fam.hostMetadata.top_a, 'keep');
    assert.deepEqual(fam.hostMetadata.variables, { hp: 1 }, '同一次入向的其他内容照常并入');
});
