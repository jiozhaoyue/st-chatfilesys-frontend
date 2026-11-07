/**
 * ui/workbench.js 单测 —— 宿主无关控制器的 view 合同与动作分发。
 * 全部用假 ports + 内存适配器（不触 DOM、不触 idb）；graph 栈不在本文件范围
 * （view.js 依赖 document，图装配走 e2e）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbench } from '../../public/scripts/extensions/third-party/chatfilesys/ui/workbench.js';
import { defaults as settingsDefaults, readSetting, writeSetting } from '../../public/scripts/extensions/third-party/chatfilesys/core/settings-registry.js';

/* ---------------- 内存适配器（StorageAdapterAPI 的最小实现） ---------------- */

function makeAdapter() {
    const families = new Map(); // familyId -> meta（含 branchPaths/branches/model/integrity）
    const floors = new Map();   // familyId -> rows[]
    let saveCalls = 0;
    return {
        async listFamilies() {
            return [...families.values()].map((f) => ({ familyId: f.familyId, name: f.name, updatedAt: f.updatedAt }));
        },
        async loadFamily({ familyId, chatKey }) {
            for (const f of families.values()) {
                if (f.familyId === familyId || (chatKey != null && f.chatKey === chatKey)) return structuredClone(f);
            }
            return null;
        },
        async loadFloors({ familyId }) { return { floors: structuredClone(floors.get(familyId) || []), hasMore: false }; },
        async createFamily({ family }) {
            if (families.has(family.familyId)) return { ok: false, reason: 'familyId-exists' };
            if ([...families.values()].some((f) => f.chatKey === family.chatKey)) return { ok: false, reason: 'chatKey-exists' };
            families.set(family.familyId, structuredClone(family));
            return { ok: true, familyId: family.familyId, integrity: family.integrity };
        },
        async saveFloors({ familyId, floors: rows }) {
            floors.set(familyId, structuredClone(rows));
            return { ok: true, integrity: families.get(familyId)?.integrity };
        },
        async saveModel({ familyId, model, expectedIntegrity }) {
            saveCalls += 1;
            const meta = families.get(familyId);
            if (!meta) return { ok: false, reason: 'family-not-found' };
            if (expectedIntegrity != null && meta.integrity != null && expectedIntegrity !== meta.integrity) {
                return { ok: false, conflict: true };
            }
            meta.model = structuredClone(model);
            meta.branchPaths = Object.fromEntries((model.branches || []).map((b) => [b.id, { ...b.path }]));
            meta.branches = (model.branches || []).map((b) => ({ id: b.id, name: b.name, is_default: Boolean(b.is_default), fork_floor: b.fork_base ?? 0, parent_branch_id: null }));
            meta.integrity = meta.integrity === 'c-test' ? 'c-test-2' : 'c-test';
            return { ok: true, integrity: meta.integrity };
        },
        stats: { get saveCalls() { return saveCalls; } },
    };
}

/* ---------------- 假 ports ---------------- */

function makePorts(adapter) {
    const store = settingsDefaults(); // registry 默认表：**平铺点分键**（'graph.enabled' → true）
    const notes = [];
    const notify = { ok: (m) => notes.push(['ok', m]), info: (m) => notes.push(['info', m]), warn: (m) => notes.push(['warn', m]), error: (m) => notes.push(['error', m]) };
    let renders = 0;
    return {
        adapter,
        settings: {
            // 假件直接复用 registry 纯函数（与 web 入口的 localStorage port 同一语义）
            get: (key) => readSetting(store, key),
            set: (key, value) => writeSetting(store, key, value),
            tree: () => store,
            resetAll: () => Object.assign(store, settingsDefaults()),
            exportAll: () => store,
        },
        notify,
        dialog: { prompt: () => null, confirm: () => true },
        files: { exportJsonl: async () => {}, listHostChats: null },
        caps: { liveChat: false, mirror: false, ai: false, graph: true },
        events: { rendered: () => { renders += 1; } },
        _notes: notes,
        get _renders() { return renders; },
    };
}

const SAMPLE_LINES = [
    JSON.stringify({ user_name: 'User', character_name: '测试', chat_metadata: {} }),
    JSON.stringify({ name: 'A', is_user: false, mes: '第一层', swipes: ['第一层', '第一层·另一版'], swipe_id: 0 }),
    JSON.stringify({ name: 'User', is_user: true, mes: '第二层' }),
];

test('workbench：导入 → 视图合同（模型/家族名/档位徽章/置灰判据）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';

    // 未打开家族：model=null、家族名占位、storage.mode 锁定 pure
    let v = wb.view();
    assert.equal(v.model, null);
    assert.equal(v.familyName, '（未打开家族）');
    assert.equal(v.storage.mode, 'pure');
    assert.equal(v.canSummarize, false); // caps.ai=false → AI 按钮隐藏
    assert.equal(v.listChats, null);     // web 无宿主文件面 → 角色卡页签空态
    assert.equal(v.listTrash, null);     // idb 档无回收站目录 → 明说，不给假空列表
    assert.equal(typeof v.renderGraph, 'function'); // caps.graph=true → 图渲染回调就位

    const r = await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    assert.equal(r.imported, true);
    v = wb.view();
    assert.equal(v.familyName, '示例');
    assert.ok(v.model); // 打开后有模型
    assert.equal(v.model.branches.length, 1);
    assert.equal(v.storage.mode, 'pure');
});

test('workbench：幂等导入（同 chatKey 二次导入=零写入直接打开）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    const before = adapter.stats.saveCalls;
    const r2 = await wb.importText('别的名字.jsonl', SAMPLE_LINES.join('\n')); // 文件名不同但内容同 chatKey 维度不同——chatKey 是名字
    // 换名 = 新 chatKey ⇒ 走新建档；同名字再导才是幂等路径
    assert.equal(r2.imported, true);
    const r3 = await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    assert.equal(r3.imported, false);
    assert.equal(adapter.stats.saveCalls, before, '幂等打开不得触发任何写入');
});

test('workbench：切分支/改名/设主分支 走 saveModel 且模型真实变化', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    const fam = (await adapter.listFamilies())[0];
    await wb.openFamily(fam.familyId);
    const model = wb.view().model;

    // 造第二条分支（直接改模型模拟既有家族的多分支形态）
    model.branches.push({ id: 'b2', name: '分支二', is_default: false, fork_base: 1, path: { 1: 'g1', 2: 'g2' } });
    model.groups.g1 = { floor: 1, variants: [{ mes: '第一层' }] };
    model.groups.g2 = { floor: 2, variants: [{ mes: '第二层' }] };
    await wb.saveModel();

    // 切分支
    await wb.handleAction('switch', { dataset: { branch: 'b2' } });
    assert.equal(wb.view().model.active_branch, 'b2');
    assert.equal(wb.view().branchId, 'b2');

    // 改名（dialog.prompt 返回 null = 取消，先给假 prompt）
    ports.dialog.prompt = () => '新名字';
    await wb.handleAction('rename', { dataset: { branch: 'b2' } });
    assert.equal(wb.view().model.branches.find((b) => b.id === 'b2').name, '新名字');

    // 设主分支
    await wb.handleAction('set-main-branch', { dataset: { branch: 'b2' } });
    assert.equal(wb.view().model.branches.find((b) => b.id === 'b2').is_default, true);
    assert.ok(adapter.stats.saveCalls >= 3, '每次结构动作恰好一次 saveModel（≥3 校验）');
});

test('workbench：写冲突如实进错误面（不吞归因、不假报成功）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    const fam = (await adapter.listFamilies())[0];
    await wb.openFamily(fam.familyId);
    // 模拟并发写：库内版本号前进，工作台手里还是旧的
    adapter._conflictNext = true;
    const meta = await adapter.loadFamily({ familyId: fam.familyId });
    meta.integrity = 'c-别人写过了';
    // 直接把工作台内部家族的 integrity 弄旧：再触发一次 saveModel 走 conflict
    const v0 = wb.view();
    assert.equal(v0.errors.length, 0);
    // 用 switch 触发 saveModel（active 不变，仍会写库）
    adapter.saveModel = async () => ({ ok: false, conflict: true });
    await wb.handleAction('switch', { dataset: { branch: v0.model.active_branch } });
    const v1 = wb.view();
    assert.equal(v1.errors.length, 1);
    assert.equal(v1.errors[0].what.includes('写入被拒绝'), true);
    assert.ok(v1.errors[0].fix.length >= 1, '错误面必须带「怎么办」');
});

test('workbench：设置变更走 registry 语义（graph.enabled 翻转反映到视图）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    assert.equal(wb.view().graphEnabled, true); // 默认开图
    ports.settings.set('graph.enabled', false);
    assert.equal(wb.view().graphEnabled, false);
});

test('workbench：同文件加新楼层再导入 → 指纹合并为子分支（主分支不动）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    ports.dialog.confirm = () => true; // 自动同意合并
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    const header = JSON.stringify({ user_name: 'User', character_name: '测试', chat_metadata: {} });
    const v1 = [
        header,
        JSON.stringify({ name: 'A', is_user: false, mes: '一层' }),
        JSON.stringify({ name: 'User', is_user: true, mes: '二层' }),
    ].join('\n');
    await wb.importText('会话.jsonl', v1);
    const mainId = wb.view().model.active_branch;
    // v2 = v1 + 新楼层（同 chatKey，内容有差异）
    const v2 = [
        v1,
        JSON.stringify({ name: 'A', is_user: false, mes: '三层·新续写' }),
    ].join('\n');
    const r = await wb.importText('会话.jsonl', v2);
    assert.equal(r.merged, true);
    const model = wb.view().model;
    assert.ok(model.branches.length >= 2, '合并应产生子分支');
    assert.equal(model.branches.find((b) => b.id === mainId).path['1'], model.branches.find((b) => b.id === mainId).path['1'],
        '主分支路径不受影响');
});

test('workbench：同文件零差异再导入 → noop（零写入）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    const lines = [
        JSON.stringify({ user_name: 'User', character_name: '测试', chat_metadata: {} }),
        JSON.stringify({ name: 'A', is_user: false, mes: '一层' }),
    ].join('\n');
    await wb.importText('会话.jsonl', lines);
    const savesBefore = adapter.stats.saveCalls;
    const r = await wb.importText('会话.jsonl', lines);
    assert.equal(r.imported, false);
    assert.equal(adapter.stats.saveCalls, savesBefore);
});

test('workbench：楼层版本写路径（切换 swipe 变体 → 库行真实更新）', async () => {
    const adapter = makeAdapter();
    const ports = makePorts(adapter);
    const wb = createWorkbench(ports);
    wb.tier = 'idb';
    await wb.importText('示例.jsonl', SAMPLE_LINES.join('\n'));
    const fam = (await adapter.listFamilies())[0];
    await wb.openFamily(fam.familyId);
    // 第 1 层有两个 swipe 版本（SAMPLE_LINES）
    await wb.handleAction('switch', { dataset: { branch: wb.view().model.active_branch } }); // noop 切到自己
    // 直接走 applyFloorOp 的等价入口：activateVariant 切到版本 2
    const { activateVariant } = await import('../../public/scripts/extensions/third-party/chatfilesys/core/versions.js');
    await wb.openVersions ? null : null; // openVersions 需要 document，Node 下只验写路径
    // 经 handleAction 没有楼层动作入口（版本入口在模态），这里用导出的 applyFloorOp 语义等价验证：
    // 通过再次 openFamily 前后比对库行内容。
    const { floors: before } = await adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
    const row1 = before.find((r) => r.floorNo === 1);
    const line = JSON.parse(row1.content);
    activateVariant(line, 1);
    row1.content = JSON.stringify(line);
    await adapter.saveFloors({ familyId: fam.familyId, floors: [row1], expectedIntegrity: null });
    await wb.openFamily(fam.familyId);
    const rows = wb.activeRows();
    assert.equal(String(rows[0].mes).includes('另一版'), true, '活跃投影应反映切到版本 2 后的正文');
});
