/**
 * ChatFilesys — 分支合并（**纯函数**：吃模型 + 两个分支 id，吐一个新分支的 path）
 *
 * ── 语义（一句话）──
 * 把两条分支**逐层取并集**，合成第三条新分支；同层两边内容不同处 = **冲突**，
 * 由用户逐层选择用哪一边。
 *
 * ── 三条硬性质（每一条都是「不做会出事」的）──
 * 1. **绝不原地改 A 或 B**。结果是**新分支**——于是「撤销」天然存在（删掉新分支即可），
 *    且用户不会因为一次合并丢掉任何一边的历史。
 * 2. **公共前缀一段不动**。前缀相同处是两条分支**共享同一个组**（不是「内容一样的两份」），
 *    照抄即可；把它们重建成新组会让共享前缀失去零复制，并让别的分支的引用统计错乱。
 * 3. **只处理「层」不处理「组」**。本模块产出的是 `{floor: gid}`，**不新建组**——
 *    新建组意味着复制正文，那是另一件事（「把一个版本复制成独立的组」），不在合并语义里。
 *
 * ── 冲突的「可读」口径 ──
 * 冲突列表里**不带正文全文**（弹窗铁律：不逐层列举内容）。带的是：
 * 层号 + 两侧各自的**字数**（由调用方注入的 `charsOf` 给，因为正文本体在宿主 body /
 * `model.groups` 两处，纯函数层不该知道去哪取）。用户据此判断「哪边更长 / 该留哪边」，
 * 想看全文再按需展开（那是展示层的事）。
 *
 * ── 为什么合并要用「新分支」而不是「接上去」──
 * 「把 B 接到 A 的末尾」在两条分支有分叉时**没有定义**（A 的第 7 层和 B 的第 7 层是两份内容，
 * 接上去就丢了一份）。逐层取并集 + 冲突可判，是这个数据结构上唯一诚实的做法。
 */

/** 一条分支的最大层号（模型不变量：path 的键是 1..N 连续） */
const maxFloorOf = (b) => Math.max(0, ...Object.keys(b?.path || {}).map(Number));

/**
 * 公共前缀长度（**连续**从第 1 层起，两边组 id 相同的最长前缀）。
 *
 * 为什么要求「连续」而不是「逐层比对相同就取」：模型不变量是 path 从 1 连续，
 * 中间出现一次不同就说明此后是两条独立的线，再往下就算某层恰好用回同一个组，
 * 也不该算公共前缀（那是巧合，不是共同祖先）。
 */
export function commonPrefixLength(a, b) {
    const maxA = maxFloorOf(a);
    const maxB = maxFloorOf(b);
    let n = 0;
    while (n + 1 <= Math.min(maxA, maxB)) {
        const ga = a.path[n + 1];
        const gb = b.path[n + 1];
        if (!ga || !gb || ga !== gb) break;
        n += 1;
    }
    return n;
}

/**
 * 规划一次合并。
 *
 * @param {object} model 家族模型（`{branches, groups, active_branch}`）
 * @param {{aId: string, bId: string, choices?: Object<number, 'a'|'b'>,
 *          charsOf?: (floor: number, gid: string) => number,
 *          defaultSide?: 'a'|'b'}} opts
 *   `choices` = 用户对冲突层的选择（层号 → 'a' | 'b'）；未给的冲突层用 `defaultSide`（缺省 'a'）
 * @returns {{ok: boolean, reason?: string, aId, bId, commonFloor: number,
 *            conflicts: Array<{floor, aGid, bGid, aChars, bChars, picked}>,
 *            path?: Object<number, string>, steps?: Array<{floor, side, gid}>,
 *            stats: {floors, shared, fromA, fromB, conflicts, unresolved}}}
 */
export function planMerge(model, { aId, bId, choices = {}, charsOf = null, defaultSide = 'a' } = {}) {
    const empty = { ok: false, aId, bId, commonFloor: 0, conflicts: [],
        stats: { floors: 0, shared: 0, fromA: 0, fromB: 0, conflicts: 0, unresolved: 0 } };
    if (!model || !Array.isArray(model.branches)) return { ...empty, reason: '模型不可用' };
    if (String(aId) === String(bId)) return { ...empty, reason: '同一分支不能与自己合并' };
    const a = model.branches.find((x) => x.id === aId);
    const b = model.branches.find((x) => x.id === bId);
    if (!a) return { ...empty, reason: `找不到分支 ${aId}` };
    if (!b) return { ...empty, reason: `找不到分支 ${bId}` };

    const chars = typeof charsOf === 'function' ? charsOf : () => 0;
    const commonFloor = commonPrefixLength(a, b);
    const top = Math.max(maxFloorOf(a), maxFloorOf(b));

    const path = {};
    const steps = [];
    const conflicts = [];
    let fromA = 0, fromB = 0;

    for (let f = 1; f <= commonFloor; f++) {
        path[f] = a.path[f];              // 共享前缀：同一个组，直接抄（不新建组）
        steps.push({ floor: f, side: 'shared', gid: a.path[f] });
    }

    for (let f = commonFloor + 1; f <= top; f++) {
        const ga = a.path?.[f] ?? null;
        const gb = b.path?.[f] ?? null;
        let gid; let side;
        if (ga && gb && ga !== gb) {
            // 冲突：两边都有、且是两份内容。用户选过就用选的，没选过用默认侧
            const picked = choices[f] === 'a' || choices[f] === 'b' ? choices[f] : defaultSide;
            gid = picked === 'b' ? gb : ga;
            side = picked === 'b' ? 'b' : 'a';
            conflicts.push({
                floor: f, aGid: ga, bGid: gb,
                aChars: Number(chars(f, ga)) || 0,
                bChars: Number(chars(f, gb)) || 0,
                picked,
            });
        } else if (ga && gb) {
            gid = ga; side = 'shared';     // 同组（前缀之后又合上了）
        } else if (gb) {
            gid = gb; side = 'b';          // 只有 B 有 → 这就是「把 B 的尾部接过来」
        } else {
            gid = ga; side = 'a';          // 只有 A 有 → 保留
        }
        path[f] = gid;
        steps.push({ floor: f, side, gid });
        if (side === 'a') fromA += 1;
        else if (side === 'b') fromB += 1;
    }

    const unresolved = conflicts.filter((c) => choices[c.floor] !== 'a' && choices[c.floor] !== 'b').length;

    return {
        ok: true,
        aId, bId, commonFloor, conflicts, path, steps,
        stats: {
            floors: Object.keys(path).length,
            shared: commonFloor,
            fromA, fromB,
            conflicts: conflicts.length,
            unresolved,
        },
    };
}

/**
 * 合并结果的可读摘要（**给用户看的一行话**；也是 e2e 的断言点）。
 * 空分支（一点内容都没有）要说出来，而不是给一句「合并成功」。
 */
export function describeMerge(plan) {
    if (!plan?.ok) return `无法合并：${plan?.reason || '未知原因'}`;
    const s = plan.stats;
    if (!s.floors) return '两条分支都没有内容，合并结果为空。';
    const bits = [`共 ${s.floors} 层`];
    if (s.shared) bits.push(`前 ${s.shared} 层共享`);
    if (s.fromA) bits.push(`取目标分支 ${s.fromA} 层`);
    if (s.fromB) bits.push(`取另一分支 ${s.fromB} 层`);
    if (s.conflicts) bits.push(`${s.conflicts} 处冲突已按选择处理`);
    return bits.join(' · ');
}

/**
 * 合并结果的默认名字（用户可改；名字只是标签，不参与任何判定）。
 * 用 `A+B` 而不是 `合并`——分支多起来时，名字里带来源比带「合并」两个字有用得多。
 */
export function defaultMergeName(a, b) {
    const shorten = (x) => {
        const n = String(x?.name || '').trim();
        if (!n) return '?';
        return n.length > 8 ? `${n.slice(0, 8)}…` : n;
    };
    return `合并·${shorten(a)}+${shorten(b)}`;
}
