/**
 * 智能家族合并单测：`core/family-align.js`
 *
 * 为什么这份测试特别长：本模块的**每个判据都曾经错过一次**，而且是「看起来很有道理」的那种错。
 * 所以夹具不是随手编的，逐条对应 `design.md` §5 的雷区清单（L1–L28），每条都钉住一个
 * **已在真实语料上复现过**的失效形态：
 *
 * · L22/L28 是互检 A 在 19503 个真实 pair 上跑出来的（前者假阳性通道、后者假阴性通道）
 * · L23 是原设计的**数学必然**错误（`gap == mismatch` ⇒ DP 全配退化 ⇒ 召回归零）
 * · L1/L10 是「宿主用 swipe 表达同层多版本」这一核心洞察的回归钉
 *
 * ⛔ **L20（跨语言 / 极短层）不测**：极短层无区分度，cost 0.0 只认过长度门槛的精确 hash，
 *    不存在误判路径；建夹具也测不出边界。这条按 `prd.md` R1.5 显式登记，而不是漏掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    planFamilyMerge, formatPlan, classify, buildDescriptors, align,
    sameFloor, matchBound, MIN_EVIDENCE_LEN, COST, LIMITS,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/family-align.js';

/* ---------------- 夹具 ---------------- */

const PAD = '正文正文正文正文正文正文正文正文正文正文';

/** 一行消息（默认带够长度，过 MIN_EVIDENCE_LEN 门槛） */
const row = (mes, extra = {}) => ({ name: '角色', is_user: false, mes, send_date: '2026-01-01T00:00:00.000Z', ...extra });

/** n 层互不相同的正文；`p` 换一个前缀就得到「另一条线」的正文 */
const floors = (n, p, { skip = [] } = {}) => Array.from({ length: n }, (_, i) => i + 1)
    .filter((k) => !skip.includes(k))
    .map((k) => row(`${p}-第${k}层-${PAD}${k}`));

const verdictOf = async (a, b) => (await planFamilyMerge({ aRows: a, bRows: b })).verdict;

/* ---------------- 基线三态 ---------------- */

test('完全相同 → same-family / identical', async () => {
    const a = floors(40, '甲');
    const p = await planFamilyMerge({ aRows: a, bRows: floors(40, '甲') });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.mode, 'identical');
    assert.equal(p.stats.n0, 40);
});

test('祖先后代（B = A + 尾部）→ same-family / ancestor', async () => {
    const a = floors(40, '甲');
    const b = [...floors(40, '甲'), ...floors(10, '甲').map((r, i) => row(`甲-续${41 + i}层-${PAD}`))];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.mode, 'ancestor');
    assert.equal(p.stats.n15, 0);
    assert.equal(p.stats.gaps, 10);
});

test('完全无关 → different（不得判同族）', async () => {
    assert.equal(await verdictOf(floors(40, '甲'), floors(40, '乙')), 'different');
});

/* ---------------- L1 / L10：宿主用 swipe 表达「同层多版本」 ---------------- */

test('L1：末尾层是 swipe 重生成（不是删层）→ 同层合并，n15 必须为 0', async () => {
    const a = floors(40, '甲');
    // B 的第 40 层被重新生成：当前正文是新的，旧版本原样留在 swipes 里（宿主真实形态）
    const old40 = a[39].mes;
    const b = [...floors(39, '甲'), row('乙-第40层-重新生成后的正文', {
        swipes: [old40, '乙-第40层-重新生成后的正文'], swipe_id: 1,
    })];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.stats.n15, 0, '旧版本在 swipes 里 ⇒ 应判同层，不该落进 two-groups');
    assert.equal(p.floors.at(-1).kind, 'swipe-merge');
    assert.equal(p.floors.at(-1).evidence.includes('swipe'), true, '解释里要说明是靠 swipe 候选集对上的');
});

test('L10：A 的当前版 == B 的旧 swipe → 只并一次，不多出一层', async () => {
    const a = floors(40, '甲');
    const old40 = a[39].mes;
    const b = [...floors(39, '甲'), row('乙-新正文', { swipes: [old40, '乙-新正文'], swipe_id: 1 })];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.floors.length, 40, '不能合成 41 层');
    assert.equal(p.stats.n0, 40);
});

test('D1 回归：A 的当前正文 == B 的 swipes[0] ⇒ 预筛不得误杀（改前会红）', async () => {
    // 互检 A 在真实语料上复现的假阴性：3 层、前 2 层全等、第 3 层 swipe 重生成，
    // 且 **A 的当前正文正是 B 的旧 swipe**。改前预筛只数「当前正文 hash 的多重集交集」=2，
    // 而 need=3 ⇒ 直接判 different（被误杀的正是核心场景：宿主用 swipe 表达同层多版本）。
    const a = floors(3, '甲');
    const old3 = a[2].mes;
    const b = [...floors(2, '甲'), row('乙-第3层-重生成', { swipes: [old3, '乙-第3层-重生成'], swipe_id: 1 })];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family', '必须判同族（改前 reason=prefilter 误杀）');
    assert.equal(p.stats.n0, 3, 'n0 应为 3（含 swipe 通道那一层）');
    assert.equal(p.stats.need, 3);
    assert.equal(p.floors.at(-1).kind, 'swipe-merge');
});

/* ---------------- L2 / L3：字段形态与时间戳都不可作判据 ---------------- */

test('L2：同一正文但字段集合完全不同（插件加字段）→ 仍判同层', async () => {
    const a = floors(10, '甲');
    const b = floors(10, '甲').map((r) => row(r.mes, {
        swipes: [r.mes], swipe_id: 0, variables: [{ x: 1 }], hash_sheets: [], is_system: false,
    }));
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.stats.n0, 10);
});

test('L3：send_date 变了不算差异（它只是当前 swipe 的时间）', async () => {
    const a = floors(10, '甲');
    const b = floors(10, '甲').map((r) => row(r.mes, { send_date: '2030-12-31T23:59:59.000Z' }));
    assert.equal(await verdictOf(a, b), 'same-family');
});

/* ---------------- L4 / L5 / L6 / L26：身份线索一律不进判据 ---------------- */

test('L4/L5/L6/L26：名称相同、附加元数据不同 —— 一律不改变判定', async () => {
    const a = floors(20, '甲');
    const b = floors(20, '乙'); // 与 a 无关
    const bWithMeta = b.map((r) => row(r.mes, {
        main_chat: '甲 - Branch #1', chat_id_hash: 123, // 若拿这些当判据就会误判
    }));
    assert.equal(await verdictOf(a, b), 'different');
    assert.equal(await verdictOf(a, bWithMeta), 'different', '附加元数据不得把无关的判成同族');
    // 反过来：内容相同但有误导性元数据，也不得被否掉
    const aMeta = floors(20, '甲').map((r) => row(r.mes, { main_chat: null, chat_id_hash: 999 }));
    assert.equal(await verdictOf(aMeta, floors(20, '甲')), 'same-family');
});

test('L26：main_chat 提示只作报告，不参与判定', async () => {
    const a = floors(20, '甲');
    const b = floors(20, '甲');
    // 同一段内容的两次导入：时间戳必然不同 ⇒ 提示 false。若提示参与判定，重导入副本反被罚。
    const p = await planFamilyMerge({
        aRows: a, bRows: b,
        aMainChat: '孤独摇滚 - 2026-03-31@00h31m36s439ms imported',
        bMainChat: '孤独摇滚 - 2026-07-19@23h05m21s834ms imported',
    });
    assert.equal(p.familyHint.matched, false, '时间戳不同 ⇒ 提示 false');
    assert.equal(p.verdict, 'same-family', '提示 false 不得影响判定');
    const q = await planFamilyMerge({ aRows: a, bRows: b, aMainChat: 'X - Branch #1', bMainChat: 'X - Branch #1' });
    assert.equal(q.familyHint.matched, true);
    assert.equal(q.verdict, 'same-family');
});

/* ---------------- L7 / L8 / L14：层增删与位置 ---------------- */

test('L7：中间删层 → 仍判同族，被删处是 only-* 而不是 two-groups', async () => {
    const a = floors(40, '甲');
    const b = floors(40, '甲', { skip: [5] });
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.stats.n15, 0);
    assert.equal(p.stats.gaps, 1);
    const onlyA = p.floors.filter((f) => f.kind === 'only-a');
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].aIdx, 4, '第 5 层（0 基 4）应被标为只有 A 有');
});

test('L8：整体平移（前面插一层）→ 仍判同族，位置不作锚', async () => {
    const a = floors(40, '甲');
    const b = [row(`甲-新插层-${PAD}`), ...floors(40, '甲')];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.stats.n0, 40);
    assert.equal(p.stats.n15, 0);
});

test('L14：单侧独有的中段层不得被猜成 swipe-merge', async () => {
    const a = floors(30, '甲');
    const b = [...floors(10, '甲'), ...floors(5, '乙'), ...floors(30, '甲').slice(10)];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    for (const f of p.floors) {
        if (f.kind === 'swipe-merge' || f.kind === 'two-groups') {
            assert.ok(f.aIdx !== null && f.bIdx !== null, `${f.kind} 必须两侧都有`);
        } else {
            assert.ok(f.aIdx === null || f.bIdx === null, `${f.kind} 必须只有一侧`);
        }
    }
});

/* ---------------- L9 / L19：配对单调 + 零丢失 ---------------- */

test('L9：正文重复出现时，配对仍单调不交叉', async () => {
    const dup = row(`甲-重复句-${PAD}`);
    const a = [dup, row(`甲-a1-${PAD}`), dup, row(`甲-a2-${PAD}`), dup];
    const b = [dup, row(`甲-a1-${PAD}`), dup, row(`甲-a2-${PAD}`), dup];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    const pairs = p.floors.filter((f) => f.aIdx !== null && f.bIdx !== null);
    for (let i = 1; i < pairs.length; i += 1) {
        assert.ok(pairs[i].aIdx > pairs[i - 1].aIdx, 'a 侧下标必须递增');
        assert.ok(pairs[i].bIdx > pairs[i - 1].bIdx, 'b 侧下标必须递增');
    }
});

test('L19：零丢失 —— 逐层方案必须能解释掉 A 与 B 的每一层', async () => {
    for (let round = 0; round < 40; round += 1) {
        // 随机同源改动：删若干层 + 改若干层 + 各自追加
        const base = floors(12 + (round % 7), '甲');
        const del = new Set([3, 5].filter(() => round % 3 === 0));
        const a = base.filter((_, i) => !del.has(i + 1));
        const b = base.filter((_, i) => !del.has(i + 1)).map((r, i) => (
            round % 2 === 0 && i === 2 ? row(`甲-改写层-${PAD}${round}`) : r));
        const p = await planFamilyMerge({ aRows: a, bRows: b });
        const mass = p.floors.reduce((acc, f) => acc + (f.kind === 'swipe-merge' || f.kind === 'two-groups' ? 2 : 1), 0);
        assert.equal(mass, a.length + b.length, `第 ${round} 轮：${formatPlan(p)}`);
    }
});

/* ---------------- L11 / L17 / L25：输入边界 ---------------- */

test('L11：非法行 / 缺 mes 的行被跳过，不影响对齐也不抛', async () => {
    const a = floors(10, '甲');
    const b = [null, { no_mes: 1 }, 42, ...floors(10, '甲')];
    assert.equal(await verdictOf(a, b), 'same-family');
    assert.doesNotThrow(() => matchBound([], []));
});

test('L17/L25：一方为空或过短 → uncertain，**绝不**判同族/祖先', async () => {
    for (const a of [[], [row(`甲-唯一层-${PAD}`)]]) {
        const p = await planFamilyMerge({ aRows: a, bRows: floors(200, '甲') });
        assert.equal(p.verdict, 'uncertain', '空/过短方必须走 uncertain（原设计 0 == 0 会误判祖先）');
        assert.equal(p.reason, 'floor-too-few');
    }
});

test('L25：只共享开场白（first_mes）不构成同族证据', async () => {
    const a = [row(`开场问候语（F1）`), ...floors(20, '甲')];
    const b = [row(`开场问候语（F1）`), ...floors(20, '乙')];
    assert.equal(await verdictOf(a, b), 'different');
});

/* ---------------- L18 / L21 / L22：编码与 hash 碰撞 ---------------- */

test('L18：BOM 与 CRLF 差异不影响判定', async () => {
    const a = floors(10, '甲');
    const b = a.map((r) => row(`﻿${r.mes.replace(/\n/g, '\r\n')}\r\n`));
    assert.equal(await verdictOf(a, b), 'same-family');
});

test('L21：首层恒等曾白送 CPL=1 —— 现在靠 n0 绝对下限挡住', async () => {
    const shared = row(`开场问候语（F1）`);
    const a = [shared, ...floors(30, '甲')];
    const b = [shared, ...floors(30, '乙')];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'different');
    assert.ok(p.stats.n0 < p.stats.need);
});

test('L22：空 swipe 碰撞（互检 A 的合成反例）→ 必须判不同', async () => {
    // 每行带一个空 swipe + 共享开场白，正文**全不同**。原设计下 swipeHashes 会因空串常量而假相交。
    const mk = (p) => [row(`开场问候语（F1）`, { swipes: [''], swipe_id: 0 }),
        ...Array.from({ length: 8 }, (_, i) => row(`${p}-独有-${i}-${PAD}`, { swipes: [''], swipe_id: 0 }))];
    assert.equal(await verdictOf(mk('E'), mk('F')), 'different');
});

test('L22b：短常量 swipe（跨文件的「开场问候语」那类）也不得造成假相交', async () => {
    const constSwipe = '开场问候语（F1）'; // 9 字，真实语料里跨 28 个文件出现
    const mk = (p) => Array.from({ length: 10 }, (_, i) => row(`${p}-正文-${i}-${PAD}`, {
        swipes: [constSwipe, `${p}-正文-${i}-${PAD}`], swipe_id: 1,
    }));
    assert.equal(await verdictOf(mk('甲'), mk('乙')), 'different');
});

test('D2 回归：每层带同一条常量 swipe 的两份无关聊天 ⇒ 不得判同族（改前会红）', async () => {
    // 互检 A 复现的假阳性方向。要点：常量 swipe 从不是任何一方的**当前正文**，
    // 故收紧后的 `classify` 必须判它不同层（改前「两侧 swipe 集有交集即同层」会判 cost 0.0）。
    //
    // ⚠️ 为什么这里必须**在 classify 层**断言，而不是只看 `verdict`：
    //   改前的 verdict 也会是 different —— 但那是**不严谨预筛意外挡住的**（预筛只数当前正文
    //   hash 交集，恰好为 0），design.md §3.1 D2 明写「换掉预筛它就塌」。
    //   只看 verdict 会让本用例在旧实现下**也绿**，从而测不出这条缺陷。
    const constSwipe = '继续，输出文字不少于7500tokens'; // 真实语料里跨 13 个文件的常量 swipe
    const [x, y] = await buildDescriptors([
        row(`甲-独有正文-${PAD}`, { swipes: [constSwipe], swipe_id: 0 }),
        row(`乙-独有正文-${PAD}`, { swipes: [constSwipe], swipe_id: 0 }),
    ]);
    assert.equal(classify(x, y).cost, COST.MISMATCH, '常量 swipe 不得让无关的两层同层（改前 cost=0）');
    const p = await planFamilyMerge({
        aRows: Array.from({ length: 10 }, (_, i) => row(`甲-独有正文-${i}-${PAD}`, { swipes: [constSwipe], swipe_id: 0 })),
        bRows: Array.from({ length: 10 }, (_, i) => row(`乙-独有正文-${i}-${PAD}`, { swipes: [constSwipe], swipe_id: 0 })),
    });
    assert.equal(p.verdict, 'different', '常量 swipe 不得把无关的两份判成同族');
    assert.equal(p.reason, 'prefilter', '走可靠上界预筛（常量既非 a 的当前正文也非 b 的当前正文 ⇒ 上界 0）');
    assert.equal(p.stats.sharedBound, 0, '上界应为 0');
});

/* ---------------- L23 / L28：判据方向（两端各错一次） ---------------- */

test('L23：中段很长也不得被一票否掉（gap < mismatch 的回归钉）', async () => {
    const common = floors(141, '甲');
    const a = [...common, ...floors(2, '甲尾')];
    const b = [...common, ...floors(144, '乙尾')];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family', '长中段不等于不同家族（原设计在此召回归零）');
    assert.ok(p.stats.n0 >= p.stats.need);
});

test('L28：同族但严重分叉 → 必须判同族（大 n15 是「分叉」，不是「无关」）', async () => {
    const a = [...floors(66, '共'), ...floors(86, '甲独')];
    const b = [...floors(66, '共'), ...floors(88, '乙独')];
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    assert.equal(p.verdict, 'same-family');
    assert.equal(p.stats.n0, 66);
    assert.ok(p.stats.n15 > 0, '不同的层应落进 two-groups');
    assert.equal(p.floors.filter((f) => f.kind === 'two-groups').length, Math.min(86, 88));
});

/* ---------------- L12 / L13 / L15 / L16 ---------------- */

test('L12：偏移极大（内容零重合）→ different，绝不硬并', async () => {
    assert.equal(await verdictOf(floors(60, '甲'), floors(60, '乙')), 'different');
});

test('L13：真祖先与兄弟分支可区分', async () => {
    const base = floors(30, '甲');
    const anc = await planFamilyMerge({ aRows: base, bRows: [...base, ...floors(5, '甲续')] });
    assert.equal(anc.mode, 'ancestor');
    const sib = await planFamilyMerge({ aRows: [...base, ...floors(5, '甲独')], bRows: [...base, ...floors(5, '乙独')] });
    assert.equal(sib.verdict, 'same-family');
    assert.equal(sib.mode, 'diverged');
    assert.equal(sib.stats.n15, 5);
});

test('L15：433×433 对齐 < 5s（性能护栏）', async () => {
    const a = floors(433, '甲');
    const b = floors(433, '甲').map((r, i) => (i === 200 ? row(`甲-第201层-被改写-${PAD}`) : r));
    const t0 = Date.now();
    const p = await planFamilyMerge({ aRows: a, bRows: b });
    const ms = Date.now() - t0;
    assert.equal(p.verdict, 'same-family');
    assert.ok(ms < 5000, `对齐耗时 ${ms}ms，超过 5s 护栏`);
});

test('L16：幂等 —— 同一对跑两次结果一致', async () => {
    const a = floors(20, '甲');
    const b = [...floors(20, '甲').slice(0, 15), ...floors(3, '乙')];
    const p1 = await planFamilyMerge({ aRows: a, bRows: b });
    const p2 = await planFamilyMerge({ aRows: a, bRows: b });
    assert.deepEqual(p1, p2);
});

/* ---------------- 单元级：判据本体 ---------------- */

test('classify：代价三档严格有序（MATCH < GAP < MISMATCH < 2×GAP）', async () => {
    assert.ok(COST.MATCH < COST.GAP);
    assert.ok(COST.GAP < COST.MISMATCH);
    assert.ok(COST.MISMATCH < 2 * COST.GAP, '否则 DP 宁配不删，匹配数类判据全部失效');
    const [x, y] = await buildDescriptors([row(`甲-层-${PAD}`), row(`乙-层-${PAD}`)]);
    assert.equal(classify(x, y).cost, COST.MISMATCH);
    assert.equal(sameFloor(x, x), true);
});

test('align：空输入不抛', () => {
    assert.deepEqual(align([], []).path, []);
    assert.equal(align([], []).gaps, 0);
});

test('LIMITS：与 design.md §7.1 的定案值一致（改一处必须改两处）', () => {
    // C1.3 起：`maxFloors: 2000` 硬护栏被工作量预算取代（design-v2 明令：不因 >2000 层降级，
    // 预算耗尽给 budget-exceeded 与分批入口）；其余四值不动（真实语料标定）。
    assert.deepEqual({ ...LIMITS }, {
        n0Ratio: 0.30, n0Floor: 3, minFloors: 3, minMaxRatio: 0.25, maxCells: 200000000,
    });
    assert.equal(MIN_EVIDENCE_LEN, 8);
});

test('formatPlan：给人看的一句话必须含证据数字（R1.3 可解释）', async () => {
    const p = await planFamilyMerge({ aRows: floors(10, '甲'), bRows: floors(10, '甲') });
    const s = formatPlan(p);
    assert.ok(s.includes('精确同层'), s);
    assert.ok(/\d/.test(s), '必须带数字，不能只有结论');
});
