/**
 * v2 只读计划层单测：`core/family-plan.js`（implement-v2 C1.4）
 *
 * 契约（family-operation-v2.md §2 Plan + design-v2「计划与动作」）：
 * · **精确全部语义重复 → noop**：header、未知元数据、选择与关系**均无变化**才 noop；
 *   只有正文相同但 header/extra 不同 **不是 noop**（原始字段精确比较；指纹只配当候选召回）；
 * · **预览零写**：计划层不接任何存储依赖（结构性保证），且对输入零改动（deepFreeze 后可运行）；
 * · **operationId 计划阶段生成且稳定**（同输入重计划 → 同 id，幂等键）；
 * · **import-as-branch 与 merge-to-new-branch 显式区分**；共享被证实的 message/versions；
 * · **stale-plan**：来源（family.revision 或来源行）变化 → 旧计划拒绝，不自动套新数据；
 * · **歧义/坏行不装作完整合并**：歧义层不共享身份且 plan.warnings 如实登记；坏行原样保留不吞。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    planOperation, planImport, verifyPlan,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/family-plan.js';
import { projectBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-codec.js';
import { validateFamily } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-state.js';
import { planFamilyMerge } from '../../public/scripts/extensions/third-party/chatfilesys/core/family-align.js';
import { twoBranches } from './fixtures-v2.mjs';

const deepFreeze = (v) => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const k of Object.keys(v)) deepFreeze(v[k]);
    }
    return v;
};

/** 给 twoBranches 的 A/B 追加 n 层**共享**消息（两分支各持 entry、各自 rawRow）——
 *  对齐判据要求双方各 ≥3 层，fixtures-v2 的两分支只有 2 层 */
function extendShared(family, n) {
    for (let k = 0; k < n; k += 1) {
        const mid = `m_ext${k}`;
        const vid = `v_${mid}`;
        const mes = `扩展共享层 ${k}：八字节以上的证据文本。`;
        const raw = { name: 'Seraphina', is_user: false, mes, send_date: `2026-01-0${k + 3}T00:00:00.000Z` };
        family.messages[mid] = { versions: { [vid]: { raw: structuredClone(raw), swipeInfo: { send_date: raw.send_date }, sourceRefs: ['src:ext'] } } };
        for (const bid of ['A', 'B']) {
            const ref = `rw-${bid}-${mid}`;
            family.rawRows[ref] = structuredClone(raw);
            family.branches[bid].entries.push({
                messageId: mid, visibleVersionIds: [vid], selectedVersionId: vid, rawRowRef: ref, dirty: false,
            });
        }
    }
    return family;
}

/* ---------------- planOperation：状态意图（spec §6 契约断言的原形） ---------------- */

test('select-version 计划：nextFamily A 变、B 投影逐值不变、原对象一字不改', () => {
    const family = twoBranches();
    const beforeB = projectBranch(family, 'B');
    const plan = planOperation(family, {
        action: 'select-version', branchIds: ['A'], arguments: { messageId: 'm1', versionId: 'v2' },
    });
    assert.deepEqual(projectBranch(plan.nextFamily, 'B'), beforeB); // B 不动
    assert.equal(plan.nextFamily.branches.A.entries[0].selectedVersionId, 'v2');
    assert.equal(family.branches.A.entries[0].selectedVersionId, 'v1'); // 原对象不改
    assert.deepEqual(validateFamily(plan.nextFamily), { ok: true, paths: [] });
    // Plan 形态（spec §2）
    assert.equal(typeof plan.operationId, 'string');
    assert.equal(plan.familyId, 'fam-two');
    assert.equal(plan.baseRevision, 'rev-1');
    assert.equal(plan.intent.action, 'select-version');
    assert.deepEqual(plan.sourceDigests.base, 'rev-1');
    assert.ok(Array.isArray(plan.evidence) && plan.evidence.length >= 1);
    assert.deepEqual(plan.warnings, []);
});

test('operationId 稳定：同输入重计划两次 → 同一个 id（幂等键）；不同意图 → 不同 id', () => {
    const family = twoBranches();
    const intent = { action: 'select-version', branchIds: ['A'], arguments: { messageId: 'm1', versionId: 'v2' } };
    const p1 = planOperation(family, intent);
    const p2 = planOperation(family, intent);
    assert.equal(p1.operationId, p2.operationId);
    const other = planOperation(family, { ...intent, arguments: { messageId: 'm1', versionId: 'v1' } });
    assert.notEqual(p1.operationId, other.operationId);
});

test('非法意图（分支/版本不存在）→ rejected，不产计划', () => {
    const family = twoBranches();
    assert.throws(
        () => planOperation(family, { action: 'select-version', branchIds: ['Z'], arguments: { messageId: 'm1', versionId: 'v1' } }),
        (e) => e.code === 'invalid-reference',
    );
});

/* ---------------- planImport：noop 判定（原始字段精确比较） ---------------- */

test('精确全同重复导入 → noop：nextFamily 与原家族逐值一致，不新建分支', async () => {
    const family = twoBranches();
    const header = structuredClone(family.branches.A.header);
    const rows = [structuredClone(family.rawRows['rw-a1']), structuredClone(family.rawRows['rw-a2'])];
    const plan = await planImport(family, { header, rows, branchName: '再来一次' });
    assert.equal(plan.intent.action, 'import-noop');
    assert.deepEqual(plan.nextFamily, family); // 一字不变
    assert.equal(plan.evidence[0].kind, 'noop');
    assert.equal(plan.evidence[0].branchId, 'A'); // 与既有 A 分支全同
});

test('只有 mes 相同但 header 不同 → **不是** noop（新建分支）', async () => {
    const family = twoBranches();
    const header = { ...structuredClone(family.branches.A.header), unknown_a_field: { keep: 2 } }; // 元数据变了
    const rows = [structuredClone(family.rawRows['rw-a1']), structuredClone(family.rawRows['rw-a2'])];
    const plan = await planImport(family, { header, rows, branchName: '元数据不同' });
    assert.notEqual(plan.intent.action, 'import-noop');
    assert.equal(plan.evidence[0].kind, 'branch-created'); // 走新建分支，不是 noop 也不是静默折叠
});

test('mes 相同但行内 extra 不同 → 不是 noop（原始字段比较，指纹只配召回）', async () => {
    const family = twoBranches();
    const header = structuredClone(family.branches.A.header);
    const row = structuredClone(family.rawRows['rw-a2']);
    row.extra = { note: '导入时被插件加了个字段' }; // 元数据变化
    const plan = await planImport(family, { header, rows: [structuredClone(family.rawRows['rw-a1']), row], branchName: 'extra 不同' });
    assert.notEqual(plan.intent.action, 'import-noop');
});

/* ---------------- 预览零写与冻结安全 ---------------- */

test('deepFreeze 输入后可运行：planOperation / planImport 均不改冻结的家族与行', async () => {
    const family = deepFreeze(twoBranches());
    const header = deepFreeze(structuredClone(family.branches.A.header));
    const rows = deepFreeze([structuredClone(family.rawRows['rw-a1']), structuredClone(family.rawRows['rw-a2'])]);
    const plan1 = planOperation(family, {
        action: 'select-version', branchIds: ['A'], arguments: { messageId: 'm1', versionId: 'v2' },
    });
    assert.equal(plan1.nextFamily.branches.A.entries[0].selectedVersionId, 'v2');
    const plan2 = await planImport(family, { header, rows: structuredClone(rows), branchName: '冻结测试' });
    assert.ok(plan2.nextFamily); // 冻结输入也能出计划
    assert.deepEqual(plan2.nextFamily.branches.A, family.branches.A); // 原家族分支未被改
});

/* ---------------- import-as-branch：对齐结果 → 计划装配 ---------------- */

test('import-as-branch：被证实的层共享 messageId，其余层新建消息；validateFamily 通过', async () => {
    const family = extendShared(twoBranches(), 2); // A/B 各 4 层（m1、m2、m_ext0、m_ext1）
    const aRows = projectBranch(family, 'A').slice(1); // 描述符口径 = 不含 header
    // B 导入副本：1/2/4 层与 A 全同（共享），第 3 层改写（two-groups），末尾追加一层新楼（only-b）
    const bRows = [
        structuredClone(family.rawRows['rw-a1']),
        structuredClone(family.rawRows['rw-a2']),
        { name: 'Seraphina', is_user: false, mes: '改写后的第三层，八字节以上的证据文本。', send_date: '2026-02-01T00:00:00.000Z' },
        structuredClone(family.rawRows['rw-A-m_ext0']),
        { name: 'Seraphina', is_user: false, mes: 'B 副本独有的新楼层，同样足够长。', send_date: '2026-02-02T00:00:00.000Z' },
    ];
    const align = await planFamilyMerge({ aRows, bRows });
    assert.equal(align.verdict, 'same-family', JSON.stringify(align.stats));
    const plan = await planImport(family, {
        header: { user_name: 'User', character_name: 'Seraphina', unknown_new: 'b 专属头' },
        rows: bRows, branchName: 'B 副本', alignPlan: align, mode: 'import-as-branch',
    });
    assert.equal(plan.intent.action, 'import-as-branch');
    assert.equal(plan.baseRevision, 'rev-1');
    const next = plan.nextFamily;
    assert.deepEqual(validateFamily(next), { ok: true, paths: [] }, JSON.stringify(validateFamily(next)));
    const newId = plan.evidence.find((e) => e.kind === 'branch-created')?.branchId;
    assert.ok(newId && next.branches[newId], '应有新建分支');
    // 共享：第 1 层与 A 的 m1 同一身份；A 原分支不动
    assert.equal(next.branches[newId].entries[0].messageId, next.branches.A.entries[0].messageId);
    assert.equal(next.branches.A.entries[0].selectedVersionId, 'v1');
    // 新分支自己的 rawRows 原样入库（含专属 header 未知字段）
    assert.equal(next.branches[newId].header.unknown_new, 'b 专属头');
    // 改写层/新楼层 = 新消息（不与任何既有身份合并）
    assert.notEqual(next.branches[newId].entries[2].messageId, next.branches.A.entries[2].messageId);
    assert.notEqual(next.branches[newId].entries[4].messageId, next.branches.A.entries[3].messageId);
    assert.equal(next.branches[newId].entries.length, 5);
});

test('merge-to-new-branch 与 import-as-branch 的 intent 显式可辨', async () => {
    const family = extendShared(twoBranches(), 2);
    const bRows = [
        structuredClone(family.rawRows['rw-a1']),
        structuredClone(family.rawRows['rw-a2']),
        structuredClone(family.rawRows['rw-A-m_ext0']),
        structuredClone(family.rawRows['rw-A-m_ext1']),
    ];
    const aRows = projectBranch(family, 'A').slice(1);
    const align = await planFamilyMerge({ aRows, bRows });
    assert.equal(align.verdict, 'same-family');
    const p1 = await planImport(family, { header: { user_name: 'U' }, rows: bRows, branchName: 'x', alignPlan: align, mode: 'import-as-branch' });
    const p2 = await planImport(family, { header: { user_name: 'U' }, rows: bRows, branchName: 'x', alignPlan: align, mode: 'merge-to-new-branch' });
    assert.equal(p1.intent.action, 'import-as-branch');
    assert.equal(p2.intent.action, 'merge-to-new-branch');
});

test('歧义层不共享身份（两份都留）且 plan.warnings 如实登记', async () => {
    const family = twoBranches();
    // 合成 alignPlan：唯一一层 swipe-merge 但带 ambig（并列最优，对应关系不唯一）
    const alignPlan = {
        verdict: 'same-family', mode: 'diverged', commonPrefix: 0, commonSuffix: 0,
        floors: [{ floorNo: 1, kind: 'swipe-merge', cost: 0, ambig: true, aIdx: 0, bIdx: 0, evidence: '同分多解' }],
        stats: { n0: 1, n15: 0, gaps: 0, ambiguousCount: 1 },
    };
    const plan = await planImport(family, {
        header: { user_name: 'U' },
        rows: [structuredClone(family.rawRows['rw-a1'])],
        branchName: '歧义导入', alignPlan, mode: 'import-as-branch',
    });
    assert.ok(plan.warnings.some((w) => w.includes('歧义')), JSON.stringify(plan.warnings));
    const newId = plan.evidence.find((e) => e.kind === 'branch-created')?.branchId;
    assert.notEqual(plan.nextFamily.branches[newId].entries[0].messageId, 'm1'); // 不共享身份
});

test('非 same-family 的 alignPlan 拒绝装配（不装作完整合并）', async () => {
    const family = twoBranches();
    await assert.rejects(
        () => planImport(family, {
            header: { user_name: 'U' }, rows: [{ name: 'x', is_user: false, mes: 'y' }],
            branchName: 'z', alignPlan: { verdict: 'uncertain', floors: [], stats: {} }, mode: 'import-as-branch',
        }),
        (e) => e.code === 'invalid-plan',
    );
});

test('坏行（无 mes 的合法 JSON 行）→ opaque 原样保留，不吞行', async () => {
    const family = twoBranches();
    const bad = { note: '这不是消息行', unknown: 1 };
    const plan = await planImport(family, {
        header: { user_name: 'U' },
        rows: [structuredClone(family.rawRows['rw-a1']), bad],
        branchName: '含坏行', mode: 'import-as-branch', // 无 alignPlan → 全新消息
    });
    const newId = plan.evidence.find((e) => e.kind === 'branch-created')?.branchId;
    const entries = plan.nextFamily.branches[newId].entries;
    assert.equal(entries.length, 2);
    const proj = projectBranch(plan.nextFamily, newId);
    assert.deepEqual(proj[2], bad); // 原样带出
    assert.equal(plan.nextFamily.messages[entries[1].messageId].opaque, true);
});

/* ---------------- stale-plan：来源变化拒绝旧计划 ---------------- */

test('verifyPlan：family.revision 变了 → stale-plan；来源行变了 → stale-plan；全同 → ok', async () => {
    const family = twoBranches();
    const header = structuredClone(family.branches.A.header);
    const rows = [structuredClone(family.rawRows['rw-a1']), structuredClone(family.rawRows['rw-a2'])];
    const plan = await planImport(family, { header, rows, branchName: '校验' });
    // 全同 → ok
    assert.deepEqual(await verifyPlan(plan, family, { header, rows }), { ok: true });
    // revision 变了 → stale
    const changed = structuredClone(family);
    changed.revision = 'rev-2';
    const r1 = await verifyPlan(plan, changed, { header, rows });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'stale-plan');
    // 来源行变了 → stale
    const rows2 = structuredClone(rows);
    rows2[1].mes = '被改过的第二层内容，八字节以上。';
    const r2 = await verifyPlan(plan, family, { header, rows: rows2 });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'stale-plan');
});
