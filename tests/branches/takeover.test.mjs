/**
 * T1 单测：版本号字符串形态（core/integrity.js）+ 原生分支/检查点接管判定（core/takeover.js）
 * 纯函数层——不依赖适配器、DOM、网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextIntegrity, normIntegrity, integrityConflict } from '../../public/scripts/extensions/third-party/chatfilesys/core/integrity.js';
import {
    classifyNewChat, checkPrefix, planTakeover, branchIdForKey, BRANCH_NAME_RE, CHECKPOINT_NAME_RE,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/takeover.js';

/* ---------------- 版本号（N19） ---------------- */

test('integrity：nextIntegrity 生成字符串且两次不同（时间戳+随机）', () => {
    const a = nextIntegrity();
    const b = nextIntegrity();
    assert.equal(typeof a, 'string');
    assert.match(a, /^c-[0-9a-z]+-[0-9a-z]+$/);
    assert.notEqual(a, b);
});

test('integrity：normIntegrity 空 → null；数字 → 字符串（兼容早期数字形态）', () => {
    assert.equal(normIntegrity(null), null);
    assert.equal(normIntegrity(undefined), null);
    assert.equal(normIntegrity(''), null);
    assert.equal(normIntegrity('  '), null);
    assert.equal(normIntegrity(5), '5');
    assert.equal(normIntegrity('c-abc-1'), 'c-abc-1');
});

test('integrity：冲突判定——未带版本号放行、库内为空放行首次写、不等即冲突', () => {
    assert.equal(integrityConflict(null, 'c-1'), false); // 调用方没带（宿主原生 saveChat 不带）
    assert.equal(integrityConflict(undefined, 'c-1'), false);
    assert.equal(integrityConflict('c-1', null), false); // 家族尚未写过 → 放行首次写
    assert.equal(integrityConflict('c-1', ''), false);
    assert.equal(integrityConflict('c-1', 'c-1'), false);
    assert.equal(integrityConflict('c-1', 'c-2'), true);
    // 宿主自造 uuid（混合状态）不再放行——这正是 N19 要修掉的静默覆盖
    assert.equal(integrityConflict('3f2b8c11-uuid', 'c-2'), true);
    // 数字/字符串混用（早期库内行）
    assert.equal(integrityConflict(5, '5'), false);
});

/* ---------------- 类型判定 ---------------- */

test('takeover：分支名由宿主自动生成（不可改）→ 命中即分支；其余即检查点', () => {
    assert.equal(classifyNewChat('我的聊天 - Branch #1'), 'branch');
    assert.equal(classifyNewChat('我的聊天 - Branch #12.jsonl'), 'branch');
    assert.equal(classifyNewChat('我的聊天 - Checkpoint #1'), 'checkpoint');
    // 检查点名用户可改（弹窗留空才自动生成）→ 自定义名必须仍判为检查点
    assert.equal(classifyNewChat('打斗之前'), 'checkpoint');
    assert.equal(classifyNewChat('我的聊天 - Checkpoint #3'), 'checkpoint');
    assert.equal(BRANCH_NAME_RE.test('x - branch #9'), true, '大小写不敏感（宿主大小写稳定但不必强依赖）');
    assert.equal(CHECKPOINT_NAME_RE.test('我的聊天 - Checkpoint #3'), true);
});

/* ---------------- 前缀闸门 ---------------- */

const P = (obj) => JSON.stringify(obj);

test('takeover：checkPrefix——逐行相同前缀通过；越界/内容不符拒绝', () => {
    const parent = [P({ mes: '一' }), P({ mes: '二' }), P({ mes: '三' })];
    assert.deepEqual(checkPrefix([{ mes: '一' }], parent), { ok: true });
    assert.deepEqual(checkPrefix([{ mes: '一' }, { mes: '二' }], parent), { ok: true });
    // 等长（在最后一层分叉）也算前缀
    assert.deepEqual(checkPrefix([{ mes: '一' }, { mes: '二' }, { mes: '三' }], parent), { ok: true });
    assert.equal(checkPrefix([], parent).ok, false);
    assert.equal(checkPrefix([{ mes: '一' }, { mes: '二' }, { mes: '三' }, { mes: '四' }], parent).ok, false);
    const bad = checkPrefix([{ mes: '一' }, { mes: '改过' }], parent);
    assert.equal(bad.ok, false);
    assert.equal(bad.firstDiff, 1);
});

/* ---------------- 接管计划 ---------------- */

/** 父家族：主分支 3 层（g1..g3），另有支线 b1（共享 1 层） */
function parentFamily() {
    return {
        familyId: 'f1', chatKey: 'av::main', integrity: 'c-1',
        keyBindings: {},
        model: {
            active_branch: 'b_main',
            branches: [
                { id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1', 2: 'g2', 3: 'g3' } },
                { id: 'b1', name: '支线', is_default: false, fork_base: 1, path: { 1: 'g1' } },
            ],
            groups: {},
        },
    };
}
const PARENT_CONTENTS = [P({ mes: '一' }), P({ mes: '二' }), P({ mes: '三' })];

test('takeover：分支——建走法（零复制、共享前缀）+ 键绑定两条（父键与新键）', () => {
    const plan = planTakeover({
        kind: 'branch',
        rows: [{ mes: '一' }, { mes: '二' }],
        parentContents: PARENT_CONTENTS,
        parentModel: parentFamily().model,
        parentBranchId: 'b_main',
        parentKey: 'av::main',
        newKey: 'av::main - branch #1',
        fileName: '我的聊天 - Branch #1',
        mainChat: 'chat1',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.forkFloor, 2);
    const added = plan.model.branches.find((b) => b.id === plan.branchId);
    assert.equal(added.name, '我的聊天 - Branch #1');
    assert.equal(added.fork_base, 2);
    assert.deepEqual(added.path, { 1: 'g1', 2: 'g2' }); // 共享前缀、零复制
    assert.equal(plan.model.groups.g1, undefined, '不得把父走法的组搬进 groups');
    // 关键取舍：接管不改 active_branch（否则父键投影会只剩截断前缀）
    assert.equal(plan.model.active_branch, 'b_main');
    // 只给新键建绑定：父键继续按 active_branch 解析（UI 的「切换走法」才不会被死绑定挡住）
    assert.deepEqual(plan.keyBindings, {
        'av::main - branch #1': { branchId: plan.branchId, mainChat: 'chat1' },
    });
    assert.equal(plan.keyBindings['av::main'], undefined);
});

test('takeover：检查点——同样建走法，但带旗标标记且不切换（父键仍指向原走法）', () => {
    const plan = planTakeover({
        kind: 'checkpoint',
        rows: [{ mes: '一' }],
        parentContents: PARENT_CONTENTS,
        parentModel: parentFamily().model,
        parentBranchId: 'b_main',
        parentKey: 'av::main',
        newKey: 'av::打斗之前',
        fileName: '打斗之前',
        mainChat: 'chat1',
    });
    assert.equal(plan.ok, true);
    const added = plan.model.branches.find((b) => b.id === plan.branchId);
    assert.equal(added.name, '打斗之前'); // 名字用用户输入的（AC2）
    assert.equal(added.is_checkpoint, true);
    assert.equal(added.marker_floor, 1);
    assert.equal(plan.model.active_branch, 'b_main');
    // mainChat 按键存：宿主靠它驱动「返回父聊天」（AC11），混进家族级会让根键也冒按钮
    assert.deepEqual(plan.keyBindings['av::打斗之前'],
        { branchId: plan.branchId, mainChat: 'chat1', isCheckpoint: true, markerFloor: 1 });
});

test('takeover：从「支线键」分叉时以该键所在走法为源（不误用 active_branch）', () => {
    const fam = parentFamily();
    fam.keyBindings = { 'av::b1key': { branchId: 'b1' } };
    const plan = planTakeover({
        kind: 'checkpoint',
        rows: [{ mes: '一' }], // b1 只有 1 层
        parentContents: [P({ mes: '一' })],
        parentModel: fam.model,
        parentBranchId: 'b1',
        parentKey: 'av::b1key',
        newKey: 'av::cp1',
        fileName: 'cp1',
        mainChat: 'b1 的键',
        parentBindings: fam.keyBindings,
    });
    assert.equal(plan.ok, true);
    const added = plan.model.branches.find((b) => b.id === plan.branchId);
    assert.equal(added.fork_base, 1);
    assert.deepEqual(added.path, { 1: 'g1' });
    assert.deepEqual(plan.keyBindings['av::b1key'], { branchId: 'b1' }, '已有绑定原样保留');
    assert.equal(plan.keyBindings['av::cp1'].mainChat, 'b1 的键');
});

test('takeover：内容不符 / 超长 → 拒绝（宁可不接管）', () => {
    const base = {
        kind: 'branch', parentContents: PARENT_CONTENTS, parentModel: parentFamily().model,
        parentBranchId: 'b_main', parentKey: 'av::main', newKey: 'k', fileName: 'x - Branch #1',
    };
    assert.equal(planTakeover({ ...base, rows: [{ mes: '不同' }] }).ok, false);
    assert.equal(planTakeover({ ...base, rows: [] }).ok, false);
    const tooLong = planTakeover({
        ...base, rows: [{ mes: '一' }, { mes: '二' }, { mes: '三' }, { mes: '四' }],
    });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.reason, /超过/);
});

test('takeover：planTakeover 不改动传入的父模型（纯函数）', () => {
    const fam = parentFamily();
    const snapshot = JSON.stringify(fam.model);
    planTakeover({
        kind: 'branch', rows: [{ mes: '一' }], parentContents: PARENT_CONTENTS, parentModel: fam.model,
        parentBranchId: 'b_main', parentKey: 'av::main', newKey: 'k', fileName: 'x - Branch #1',
    });
    assert.equal(JSON.stringify(fam.model), snapshot);
});

test('takeover：branchIdForKey——键绑定优先，无绑定回落活跃走法', () => {
    const fam = parentFamily();
    assert.equal(branchIdForKey(fam, 'av::main'), 'b_main'); // 无绑定 → active_branch
    fam.keyBindings = { 'av::main': { branchId: 'b1' } };
    assert.equal(branchIdForKey(fam, 'av::main'), 'b1');
    assert.equal(branchIdForKey(fam, 'av::未知键'), 'b_main');
    assert.equal(branchIdForKey({ model: { active_branch: 'bx' } }, 'k'), 'bx');
    assert.equal(branchIdForKey({}, 'k'), null);
});
