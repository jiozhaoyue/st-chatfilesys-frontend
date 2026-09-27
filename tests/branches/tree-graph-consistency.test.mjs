/**
 * 树 ↔ 图 一致性单测（R2/AC3 的最后一条）
 *
 * ── 为什么值得单独测 ──
 * 「结构树」与「结构图」是**两种粒度**：
 *   · 树 = 分支级（节点 = 一条分支）—— 数据直出家族模型（`ui/common.js#detectForkFloors`）
 *   · 图 = 消息级（节点 = 一条消息）—— 数据走 B1 数据源 → B2 图引擎（`core/graph/*`）
 * 两者**同源但不同路**。设计上声称「同一份内容，两张视图分叉在哪是一致的」——
 * 这句话只有被断言过才算数（否则哪天有人只改了一边，界面上会给出**互相矛盾的结构**，
 * 而这种不一致极难在真机上发现：两边看起来各自都「对」）。
 *
 * ── 判据：**单向蕴含**，不是集合相等（这一点是本用例实测出来的）──
 * 夹具（主分支 4 层；b1 自层 2 分叉、自带 3/4 层；b2 自层 4 分叉、自带层 5）实测：
 *   · 树认的分叉层 = **[3, 4]**
 *   · 图认的分叉层 = **[2]**
 * 差一层不是 bug，**是两者回答的问题不同**：
 *   · 树问「哪些层上存在多于一个被引用的组」——层 3 有 g3/g5、层 4 有 g4/g6 ⇒ 两层都算；
 *   · 图问「哪个节点有多于一个后继」——层 2 的那个节点同时接向层 3 的 g3 与 g5 ⇒ 只有它算。
 *     层 4 的分歧**是层 2 那次分叉的下游后果**（层 3 上那两个节点各自只有一个后继），
 *     故图不再记一次——这正是「分支级 vs 消息级」两种粒度的差别本身。
 *
 * 于是断言**图上每个分叉点的下一层必在树的分叉层里**（图 ⊂ 树的推论）；
 * **反向不成立且不应成立**（下游后果不该被图重复记账）。
 * 设计文档里「两者分叉点判定应当一致」这句**不够精确**，本文件是它的精确化。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enableForChat, createBranch } from '../../public/scripts/extensions/third-party/chatfilesys/core/branches.js';
import { detectForkFloors, assembleBranchLines, getActiveBranch } from '../../public/scripts/extensions/third-party/chatfilesys/ui/common.js';
import {
    buildGraph, forkPoints, floorOfNodeId,
} from '../../public/scripts/extensions/third-party/chatfilesys/core/graph/graph.js';

/** 一行 */
const line = (who, mes, is_user = false) => ({ name: who, is_user, mes, send_date: 1 });

/**
 * 夹具：主分支 4 层；b1 在第 2 层分叉（自带 3、4 层）；
 * b2 在第 4 层分叉（自带第 5 层）⇒ 分叉层应当是 {2, 4}。
 */
function fixture() {
    const body = [
        line('我', '开场', true),
        line('A', '第一层回复'),
        line('我', '第二层提问', true),
        line('A', '第三层回复'),
    ];
    const model = enableForChat(body);
    const b1 = createBranch(model, { name: 'B1', forkFloor: 2, activate: false });
    model.groups.g5 = { id: 'g5', floor: 3, owner: b1.id, active: 0, variants: [line('A', 'B1 的第三层')] };
    model.groups.g6 = { id: 'g6', floor: 4, owner: b1.id, active: 0, variants: [line('我', 'B1 的第四层', true)] };
    b1.path[3] = 'g5';
    b1.path[4] = 'g6';
    const b2 = createBranch(model, { name: 'B2', forkFloor: 4, activate: false });
    model.groups.g7 = { id: 'g7', floor: 5, owner: b2.id, active: 0, variants: [line('A', 'B2 的第五层')] };
    b2.path[5] = 'g7';
    return { model, body };
}

/** 家族模型 → 图输入（模拟 B1 数据源在库模式下给出的会话序列） */
function graphInputsOf(model, body) {
    const active = getActiveBranch(model)?.id || null;
    const sessions = model.branches.map((b) => ({
        ref: { id: b.id, key: b.id, name: b.name, kind: 'family-member', origin: 'library' },
        header: {},
        messages: assembleBranchLines(model, body, b, active),
    }));
    return { sessions };
}

/** 图上的分叉**层号**集合 */
const graphForkFloors = (graph) => new Set(forkPoints(graph).map((id) => floorOfNodeId(id)));

test('一致性：**图上每个分叉点的下一层**必在树的分叉层里（图 ⊂ 树）', async () => {
    const { model, body } = fixture();
    const treeForks = detectForkFloors(model);
    const { graph } = await buildGraph(graphInputsOf(model, body));
    const graphForks = graphForkFloors(graph);

    // 夹具的实测值钉住（防某天一边被改坏却被「关系仍成立」掩盖）
    assert.deepEqual([...treeForks].sort((a, b) => a - b), [3, 4],
        `树的分叉层应当恰为 3 与 4，实际 ${[...treeForks]}`);
    assert.deepEqual([...graphForks].sort((a, b) => a - b), [2],
        `图的分叉层应当恰为 2（分叉**起点**），实际 ${[...graphForks]}`);

    // 单向蕴含：图的每个分叉点，其**下一层**必是树认的分叉层
    for (const f of graphForks) {
        assert.ok(treeForks.has(f + 1),
            `图报分叉于层 ${f}，但树不认为层 ${f + 1} 有分歧——两张视图矛盾了`);
    }
    // 反向**不成立**，且这是对的：树的层 4 是层 2 那次分叉的下游后果
    const reverse = [...treeForks].filter((f) => graphForks.has(f - 1));
    assert.ok(reverse.length < treeForks.size,
        '反向若也全部成立，说明夹具没覆盖到「下游后果」的情形（用例失去区分力）');
});

test('一致性：无分叉的聊天，两边都认「没有分叉」（防「总有分叉」的恒真判据）', async () => {
    const body = [line('我', '一问', true), line('A', '一答')];
    const model = enableForChat(body);
    const treeForks = detectForkFloors(model);
    const { graph } = await buildGraph(graphInputsOf(model, body));
    assert.equal(treeForks.size, 0, '单线聊天不该有分叉层');
    assert.equal(graphForkFloors(graph).size, 0, '单线聊天的图不该有分叉点');
});

test('一致性：两条分支内容**只有在分叉层起**才不同（前缀同 ⇒ 图上共享节点）', async () => {
    const { model, body } = fixture();
    const { graph } = await buildGraph(graphInputsOf(model, body));
    // 第 1、2 层的节点应当被多条会话共享（分叉点之前是共享前缀）
    const shared = graph.nodes.filter((n) => (n.sessions || []).length > 1).map((n) => n.floor);
    assert.ok(shared.includes(1) && shared.includes(2),
        `分叉点之前的层应当共享，实际共享层=${[...new Set(shared)].sort()}`);
    // 而分叉层之后的私有层不该被共享
    const privateAfter = graph.nodes.filter((n) => n.floor > 2 && (n.sessions || []).length === 1).length;
    assert.ok(privateAfter >= 2, `分叉之后的私有层应当存在（实际 ${privateAfter} 个）`);
});
