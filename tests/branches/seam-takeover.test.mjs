/**
 * T1 接缝层单测：原生「创建分支 / 创建检查点」接管 + 键绑定读写 + 字符串版本号冲突。
 *
 * 真机事实（`.history/.../01-branch-creation-flow`、`02-checkpoint-creation-flow`）：
 * 宿主两种操作都是「往一个**新键** POST /api/chats/save，正文首行 header 的
 * chat_metadata.main_chat = 当前聊天键」。接管就发生在这个「未命中家族」的分支里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSeam } from '../../public/scripts/extensions/third-party/chatfilesys/core/seam.js';

/**
 * mock adapter：父家族 = av1::chat1（主分支 2 层 g1/g2 + 支线 b_cp 共享第 1 层）。
 * @param {object} [over] 覆盖项（例如 family.keyBindings）
 */
function mockAdapter(over = {}) {
    const calls = { loadFamily: 0, saveFloors: 0, applyOps: 0, saveModel: 0, loadFloors: 0 };
    const family = {
        familyId: 'f1', chatKey: 'av1::chat1', characterId: 'c1', name: 'chat1', integrity: 'c-5',
        hostMetadata: { extensions: { 'third-party/p': { x: 1 } } },
        keyBindings: {},
        branches: [
            { id: 'b_main', name: '主分支', is_default: true, fork_floor: 0, parent_branch_id: null },
            { id: 'b_cp', name: '打斗之前', is_default: false, fork_floor: 1, parent_branch_id: null },
        ],
        branchPaths: { b_main: { 1: 'g1', 2: 'g2' }, b_cp: { 1: 'g1' } },
        model: {
            active_branch: 'b_main',
            branches: [
                { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2' } },
                { id: 'b_cp', name: '打斗之前', is_default: false, fork_base: 1, is_checkpoint: true, marker_floor: 1, path: { 1: 'g1' } },
            ],
            groups: {},
        },
        ...over,
    };
    const floors = [
        { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ name: '我', is_user: true, mes: '一' }), contentHash: null, sendDate: 1 },
        { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'AI', is_user: false, mes: '二' }), contentHash: null, sendDate: 2 },
    ];
    return {
        calls, family, floors,
        lastSaveModelArgs: null,
        lastSaveFloorsArgs: null,
        /** 键 → 家族：主键 + 绑定键都命中（三档 loadFamily 的语义） */
        async loadFamily({ chatKey }) {
            this.calls.loadFamily++;
            if (chatKey === family.chatKey) return family;
            if (family.keyBindings && family.keyBindings[chatKey]) return family;
            return null;
        },
        async loadFloors() { this.calls.loadFloors++; return { floors: this.floors, hasMore: false }; },
        async saveFloors(args) { this.calls.saveFloors++; this.lastSaveFloorsArgs = args; return { ok: true, integrity: 'c-6' }; },
        async applyOps(args) { this.calls.applyOps++; this.lastSaveModelArgs = args; return { ok: true, integrity: 'c-6', totalMessages: 1 }; },
        async saveModel(args) { this.calls.saveModel++; this.lastSaveModelArgs = args; return { ok: true, integrity: 'c-6' }; },
        async renameFamily() { return { ok: true, integrity: 'c-6' }; },
        async deleteFamily() { return { ok: true }; },
    };
}

/** 安装接缝并把原始 fetch 换成哨兵（验证「透传原生」与否） */
function setup(adapter) {
    let nativeCalls = 0;
    const original = async () => { nativeCalls++; return new Response('native', { status: 200 }); };
    globalThis.fetch = original;
    const seam = installSeam(adapter);
    return { seam, original, nativeCalls: () => nativeCalls };
}

/** 宿主原生「创建分支/检查点」的写请求体（研究档案 §6：chat = [header, ...快照]） */
function nativeSaveBody({ fileName, mainChat, rows }) {
    return JSON.stringify({
        ch_name: '角色', file_name: fileName, avatar_url: 'av1',
        chat: [{ user_name: 'unused', character_name: 'unused', chat_metadata: { main_chat: mainChat } }, ...rows],
    });
}

const ROWS = [{ name: '我', is_user: true, mes: '一' }, { name: 'AI', is_user: false, mes: '二' }];

test('seam/接管：原生分支 → 库内新分支 + 键绑定，且不落磁盘、不写楼层', async () => {
    const adapter = mockAdapter();
    const { seam, original, nativeCalls } = setup(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: nativeSaveBody({ fileName: 'chat1 - Branch #1', mainChat: 'chat1', rows: ROWS }),
        });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.integrity, 'c-6'); // 库内字符串版本号
        assert.equal(nativeCalls(), 0, '不得透传原生（磁盘零新 jsonl）');
        assert.equal(adapter.calls.saveFloors, 0, '快照行本就在库内（零复制），不写楼层');
        const args = adapter.lastSaveModelArgs;
        const added = args.model.branches.find((b) => b.name === 'chat1 - Branch #1');
        assert.ok(added, '应新增一条分支');
        assert.deepEqual(added.path, { 1: 'g1', 2: 'g2' });
        assert.equal(args.model.active_branch, 'b_main', '接管不改 active_branch（父键投影不能被截断）');
        // 只给新键建绑定（main_chat 按键存，供「返回父聊天」用）
        assert.deepEqual(args.keyBindings, {
            'av1::chat1 - branch #1': { branchId: added.id, mainChat: 'chat1' },
        });
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/接管：原生检查点（用户自定义名）→ 带旗标、不切换', async () => {
    const adapter = mockAdapter();
    const { seam, original, nativeCalls } = setup(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: nativeSaveBody({ fileName: '打斗之前', mainChat: 'chat1', rows: [ROWS[0]] }),
        });
        assert.equal((await res.json()).ok, true);
        assert.equal(nativeCalls(), 0);
        const args = adapter.lastSaveModelArgs;
        const added = args.model.branches.filter((b) => b.name === '打斗之前').at(-1); // 新加的那条（重名时取末尾）
        assert.equal(added.is_checkpoint, true);
        assert.equal(added.marker_floor, 1);
        assert.equal(args.model.active_branch, 'b_main');
        assert.equal(args.keyBindings['av1::打斗之前'].branchId, added.id);
        assert.equal(args.keyBindings['av1::打斗之前'].isCheckpoint, true);
        assert.equal(args.keyBindings['av1::打斗之前'].markerFloor, 1);
        assert.equal(args.keyBindings['av1::打斗之前'].mainChat, 'chat1');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/接管：内容不是父分支前缀 → 不接管，透传原生（保守闸门）', async () => {
    const adapter = mockAdapter();
    const { seam, original, nativeCalls } = setup(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: nativeSaveBody({ fileName: 'chat1 - Branch #2', mainChat: 'chat1', rows: [{ mes: '不是前缀' }] }),
        });
        assert.equal(await res.text(), 'native');
        assert.equal(nativeCalls(), 1);
        assert.equal(adapter.calls.saveModel, 0, '判定不通过不得写库');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/接管：无 main_chat 的陌生键（普通新聊天）→ 不接管，透传原生', async () => {
    const adapter = mockAdapter();
    const { seam, original, nativeCalls } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: JSON.stringify({ file_name: '全新聊天', avatar_url: 'av1', chat: [ROWS[0]] }),
        });
        assert.equal(nativeCalls(), 1);
        assert.equal(adapter.calls.saveModel + adapter.calls.saveFloors, 0);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/接管：父线索指向库外聊天（未导入）→ 不接管，透传原生', async () => {
    const adapter = mockAdapter();
    const { seam, original, nativeCalls } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/save', {
            method: 'POST',
            body: nativeSaveBody({ fileName: 'chat1 - Branch #1', mainChat: '不在库里的聊天', rows: ROWS }),
        });
        assert.equal(nativeCalls(), 1);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/键绑定：读投影按键决定——检查点键看到截断快照，父键看到完整内容', async () => {
    const adapter = mockAdapter({ keyBindings: { 'av1::打斗之前': { branchId: 'b_cp', isCheckpoint: true, markerFloor: 1 } } });
    const { seam, original } = setup(adapter);
    try {
        const cp = await (await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: '打斗之前' }),
        })).json();
        assert.equal(cp.length, 2, '[header, 第1层]'); // Q2=A：到该层为止的快照
        assert.equal(cp[1].mes, '一');
        const main = await (await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        })).json();
        assert.equal(main.length, 3, '父键仍是完整历史（返回父聊天可用）');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/键绑定：在某个键上切换分支 → 该键绑定跟随重指向', async () => {
    const adapter = mockAdapter({ keyBindings: { 'av1::chat1': { branchId: 'b_main' } } });
    const { seam, original } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/meta/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 'c-5',
                operations: [{ op: 'replace', path: '/extensions/chatfilesys/active_branch', value: 'b_cp' }],
            }),
        });
        assert.deepEqual(adapter.lastSaveModelArgs.keyBindings, { 'av1::chat1': { branchId: 'b_cp' } });
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/键绑定：append 在新键上 → 楼层续接该键所在分支（不是 active_branch）', async () => {
    const adapter = mockAdapter({ keyBindings: { 'av1::打斗之前': { branchId: 'b_cp' } } });
    const { seam, original } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/append', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: '打斗之前', integrity: 'c-5',
                messages: [{ name: 'AI', mes: '续写' }],
            }),
        });
        // b_cp 只有 1 层 → 新楼层 = 2（若误用 active_branch=b_main 会算成 3）
        assert.equal(adapter.lastSaveFloorsArgs.floors[0].floorNo, 2);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/版本号：入向与库内不等 → 409（N19：不再静默覆盖）', async () => {
    const adapter = mockAdapter();
    // 适配器按字符串相等判定；这里直接模拟适配器回冲突
    adapter.applyOps = async () => ({ ok: false, conflict: true });
    const { seam, original } = setup(adapter);
    try {
        const res = await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: '宿主自造-uuid',
                operations: [{ op: 'replace', path: '/0', value: { mes: '改' } }],
            }),
        });
        assert.equal(res.status, 409);
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});


test('seam/接管：main_chat 按键回显——分支键读到父名，根键读不到（AC11）', async () => {
    const adapter = mockAdapter({
        keyBindings: { 'av1::打斗之前': { branchId: 'b_cp', mainChat: 'chat1', isCheckpoint: true, markerFloor: 1 } },
    });
    const { seam, original } = setup(adapter);
    try {
        const cp = await (await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: '打斗之前' }),
        })).json();
        assert.equal(cp[0].chat_metadata.main_chat, 'chat1', '检查点键必须带 main_chat（宿主「返回父聊天」的驱动源）');
        const root = await (await globalThis.fetch('/api/chats/get', {
            method: 'POST', body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1' }),
        })).json();
        assert.equal(root[0].chat_metadata.main_chat, undefined, '根键不得冒出返回父聊天');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/接管：绑定键的写不得把 main_chat 混进家族级（根键按键仍干净）', async () => {
    const adapter = mockAdapter({
        keyBindings: { 'av1::打斗之前': { branchId: 'b_cp', mainChat: 'chat1' } },
    });
    const { seam, original } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/append', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: '打斗之前', integrity: 'c-5',
                messages: [{ mes: '续写' }],
                chat_metadata: { main_chat: 'chat1', extensions: { 'third-party/p': { y: 2 } } },
            }),
        });
        const saved = adapter.lastSaveModelArgs.hostMetadata;
        assert.equal('main_chat' in saved, false, '按键自管的 main_chat 不得进入家族级');
        assert.deepEqual(saved.extensions['third-party/p'], { y: 2 }, '其余命名空间照常并入');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/键绑定：patch 的投影基准 = 本次键所在分支（否则分支聊天里改消息会写错行）', async () => {
    const adapter = mockAdapter({ keyBindings: { 'av1::打斗之前': { branchId: 'b_cp' } } });
    const { seam, original } = setup(adapter);
    try {
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: '打斗之前', integrity: 'c-5',
                operations: [{ op: 'test', path: '/0', value: { mes: '一' } }, { op: 'replace', path: '/0', value: { mes: '改过' } }],
            }),
        });
        assert.equal(adapter.lastSaveModelArgs.branchId, 'b_cp', '投影基准必须是该键所在分支');
        // 根键（无绑定）→ 走活跃分支
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({ avatar_url: 'av1', file_name: 'chat1', integrity: 'c-5', operations: [{ op: 'remove', path: '/1' }] }),
        });
        assert.equal(adapter.lastSaveModelArgs.branchId, 'b_main');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});

test('seam/键绑定：绑定键上的分支切换不动家族 active_branch（根键投影不被带跑）', async () => {
    const adapter = mockAdapter({ keyBindings: { 'av1::打斗之前': { branchId: 'b_cp' } } });
    const { seam, original } = setup(adapter);
    const incoming = {
        active_branch: 'b_new',
        branches: [
            { id: 'b_main', path: { 1: 'g1', 2: 'g2' } },
            { id: 'b_cp', path: { 1: 'g1' } },
            { id: 'b_new', path: { 1: 'g1' } },
        ],
        groups: {},
    };
    try {
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: '打斗之前', integrity: 'c-5',
                operations: [{ op: 'replace', path: '/0', value: { mes: '改' } }],
                chat_metadata: { extensions: { chatfilesys: incoming } },
            }),
        });
        const args = adapter.lastSaveModelArgs;
        assert.equal(args.model.active_branch, 'b_main', '家族活跃分支不得被绑定键上的切换带跑');
        // W6：投影基准与结构收敛目标是**两件事**——ops 的下标是对着「切换前本键的 body」算的，
        // 故 `branchId` = 本键当前所在分支；`targetBranchId` = 入向声明的目标分支（结构按它收敛）。
        assert.equal(args.branchId, 'b_cp', '投影基准 = 本键当前所在分支（切换前那条）');
        assert.equal(args.targetBranchId, 'b_new', '结构收敛目标 = 入向模型声明的目标分支');
        assert.equal(args.keyBindings['av1::打斗之前'].branchId, 'b_new', '该键绑定跟随');

        // 对照：根键（无绑定）上的切换就是家族级切换，照旧改 active_branch
        adapter.lastSaveModelArgs = null;
        await globalThis.fetch('/api/chats/patch', {
            method: 'POST',
            body: JSON.stringify({
                avatar_url: 'av1', file_name: 'chat1', integrity: 'c-5',
                operations: [{ op: 'replace', path: '/0', value: { mes: '改' } }],
                chat_metadata: { extensions: { chatfilesys: incoming } },
            }),
        });
        assert.equal(adapter.lastSaveModelArgs.model.active_branch, 'b_new');
        assert.equal(adapter.lastSaveModelArgs.branchId, 'b_main', '根键的 body = 家族活跃分支的投影（切换前）');
        assert.equal(adapter.lastSaveModelArgs.targetBranchId, 'b_new');
    } finally {
        seam.dispose();
        globalThis.fetch = original;
    }
});
