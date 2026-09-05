/**
 * 分支树演示核心（两页共用）
 * - st-user-view.html     ：ST 用户视角（聊天界面 + 分支面板预留）
 * - branch-global-view.html：总体分支视角（树状全局图，ST 式操作）
 *
 * 仅状态机与数据编排，不含 DOM。落盘映射：
 *   活跃分支路径 = 主线性数组；非活跃组 = metadata.extensions.branches.groups
 */
(function (global) {
    'use strict';

    let GID = 0, BID = 0;
    const BR_COLORS = ['#58a6ff', '#f0883e', '#a371f7', '#db61a2', '#d29922', '#39c5cf'];
    const ME = { name: '我', isUser: true };
    const AI = { name: 'Seraphina', isUser: false };
    const AI_REPLIES = [
        '『她拨开垂落的枝叶，火光在她眼底晃动。』',
        '『风穿过塔缝，发出低低的呜咽——像是很久没有人来过。』',
        '『她停下脚步，侧耳听了片刻：「上面有声音。」』',
        '『石阶尽头，那扇门虚掩着。』',
        '『她回头看你一眼，把火把举高了些。』',
    ];

    const state = { branches: [], floors: [], groups: {}, activeBranch: null };
    const hooks = { explain: [], toast: [] };

    /* ---------- 内部工具 ---------- */
    function newGroup(floor, owner, variants) {
        const id = 'g' + (++GID);
        state.groups[id] = { id, floor, owner, variants, active: 0 };
        return id;
    }
    function ensureFloor(n) {
        let f = state.floors.find(x => x.number === n);
        if (!f) { f = { number: n, gids: [] }; state.floors.push(f); state.floors.sort((a, b) => a.number - b.number); }
        return f;
    }
    function newBranch(name, forkBase, copyFrom) {
        const b = { id: 'b' + (++BID), name, color: BR_COLORS[(BID - 1) % BR_COLORS.length], isDefault: false, forkBase: forkBase || 0, path: {} };
        if (copyFrom) for (const [f, g] of Object.entries(copyFrom.path)) if (+f <= forkBase) b.path[f] = g;
        state.branches.push(b);
        return b;
    }
    function branchMaxFloor(b) { return Math.max(0, ...Object.keys(b.path).map(Number)); }
    function branchMsgCount(b) { return Object.values(b.path).reduce((s, g) => s + state.groups[g].variants.length, 0); }
    function activeB() { return state.branches.find(x => x.id === state.activeBranch); }
    function nextWho() {
        const b = activeB(); const top = b.path[branchMaxFloor(b)];
        if (!top) return ME;
        const v = state.groups[top].variants[state.groups[top].active];
        return v.isUser ? AI : ME;
    }
    function emit(hook, msg) { hooks[hook].forEach(fn => { try { fn(msg); } catch (e) { /* 页面钩子异常不阻断演示 */ } }); }

    /* ---------- 初始剧情 ---------- */
    (function seed() {
        const main = newBranch('主分支', 0, null);
        main.isDefault = true;
        state.activeBranch = main.id;
        const script = [
            [ME, '我们出发吧，森林的北边有个废弃的哨塔。'],
            [AI, '夜色像湿苔一样贴上来。你确定要今晚走？'],
            [ME, '火把给我，你在前面探路。'],
            [AI, '『哨塔的石门虚掩着，门缝里渗出淡蓝色的光。』'],
            [AI, '『塔顶传来风铃般的声响——那里有东西在等我们。』'],
        ];
        script.forEach(([who, text], i) => {
            const gid = newGroup(i + 1, null, [{ ...who, mes: text }]);
            ensureFloor(i + 1).gids.push(gid);
            main.path[i + 1] = gid;
        });
        state.groups[main.path[2]].variants.push({ ...AI, mes: '『你握紧剑柄，摇了摇头：白天更安全。』' });
        state.groups[main.path[2]].active = 0;

        const b2 = newBranch('支线·塔顶', 4, main);
        const g5 = newGroup(5, b2.id, [{ ...AI, mes: '『你们攀上旋梯。塔顶的风铃是一个古老的警报器——它醒了。』' }]);
        ensureFloor(5).gids.push(g5); b2.path[5] = g5;
        const g6 = newGroup(6, b2.id, [{ ...ME, mes: '拔剑。先下手为强。' }]);
        ensureFloor(6).gids.push(g6); b2.path[6] = g6;

        newBranch('好奇线', 2, main);
    })();

    /* ---------- API ---------- */
    const api = {
        state, ME, AI,
        activeBranch: activeB,
        branchMaxFloor, branchMsgCount,
        group: gid => state.groups[gid],
        branch: id => state.branches.find(x => x.id === id),
        onExplain: fn => hooks.explain.push(fn),
        onToast: fn => hooks.toast.push(fn),

        /** 继续聊天：追加一条消息（who 缺省自动交替）；AI 回复由页面决定是否调用 */
        addMessage(opts) {
            const b = activeB();
            const n = branchMaxFloor(b) + 1;
            const who = (opts && opts.who) || nextWho();
            const text = (opts && opts.text) || `『……（第 ${n} 层）』`;
            const gid = newGroup(n, b.isDefault ? null : b.id, [{ ...who, mes: text }]);
            ensureFloor(n).gids.push(gid);
            b.path[n] = gid;
            const forked = state.floors.find(f => f.number === n).gids.length > 1;
            emit('explain', `<b>继续聊天</b>：楼层 ${n} 新建 Swipe 组，归属「${b.name}」${forked ? '——该层已有其他分支的组，成为<b style="color:var(--yellow)">分叉点 ⎇</b>' : ''}。落盘=主线性数组追加一行（当前分支活跃时）。`);
            return gid;
        },

        /** 给指定组加一个 swipe 变体并选中 */
        addVariant(gid, text) {
            const g = state.groups[gid];
            const base = g.variants[g.variants.length - 1];
            g.variants.push({ ...base, mes: text || base.mes.replace(/』$/, '』（另一版本）') });
            g.active = g.variants.length - 1;
            emit('explain', `<b>加 swipe</b>：楼层 ${g.floor} 新增变体并选中。落盘映射为该行 ST 原生 <code>swipes[]</code> + <code>swipe_id</code>。`);
            return g;
        },

        /** 切换 swipe 选择 */
        setVariant(gid, vi) {
            const g = state.groups[gid];
            g.active = vi;
            emit('explain', `swipe 选择：楼层 ${g.floor} 的 <code>swipe_id</code> → ${vi}（ST 原生字段）。`);
        },

        /** 在楼层 floorNum 之后分叉（≤floorNum 共享引用，零复制）并切到新分支 */
        forkAt(floorNum, name) {
            const from = activeB();
            const b = newBranch(name || `${from.name}·分叉`, floorNum, from);
            state.activeBranch = b.id;
            emit('explain', `<b style="color:var(--yellow)">分叉</b>：新分支「${b.name}」引用楼层 ≤${floorNum} 的同一批组（<b>文件一个字节都没变大</b>），分叉后的新楼层才归属新分支。`);
            emit('toast', `已分叉「${b.name}」：共享 ≤${floorNum} 层，已切换到新分支`);
            return b;
        },

        switchTo(id) {
            const from = activeB(), to = state.branches.find(x => x.id === id);
            if (!to || id === state.activeBranch) return to;
            state.activeBranch = id;
            emit('explain', `<b>切换分支</b>：「${from.name}」→「${to.name}」。原分支私有组<b style="color:var(--yellow)">折叠</b>进 metadata.branches，目标分支组<b style="color:var(--green)">展开</b>为主线性数组。纯内存重排 + 一次 ST 原生保存，零网络。`);
            emit('toast', `已切换到「${to.name}」`);
            return to;
        },

        renameBranch(id, name) {
            const b = state.branches.find(x => x.id === id);
            if (b && name && name.trim()) { b.name = name.trim(); emit('explain', `分支重命名 → metadata 内字段更新。`); }
            return b;
        },

        /** 删除分支：只移除其私有组与引用；共享组因仍被引用而保留 */
        deleteBranch(id) {
            const b = state.branches.find(x => x.id === id);
            if (!b || b.isDefault) return null;
            Object.values(b.path).forEach(g => { if (state.groups[g] && state.groups[g].owner === b.id) delete state.groups[g]; });
            state.floors.forEach(f => { f.gids = f.gids.filter(g => state.groups[g]); });
            state.branches = state.branches.filter(x => x.id !== id);
            if (state.activeBranch === id) state.activeBranch = state.branches[0].id;
            emit('explain', `<b>删除分支</b>：仅移除其<b>私有</b>组与分支引用；共享组仍被其他分支引用故保留（引用计数语义）。`);
            return b;
        },

        /** 删除一个组（楼层）：全局删除 + 楼层重编号（消息数组语义），分叉基点同步平移 */
        deleteGroup(gid) {
            const g = state.groups[gid];
            if (!g) return;
            const F = g.floor;
            delete state.groups[gid];
            state.floors.forEach(f => { f.gids = f.gids.filter(x => state.groups[x]); });
            // 重编号：>F 的楼层/组/路径/分叉基点全部 -1
            state.floors.forEach(f => { if (f.number > F) f.number--; });
            Object.values(state.groups).forEach(x => { if (x.floor > F) x.floor--; });
            state.branches.forEach(b => {
                const np = {};
                Object.entries(b.path).forEach(([f, gid2]) => { const fn = +f; if (fn !== F) np[fn > F ? fn - 1 : fn] = gid2; });
                b.path = np;
                if (b.forkBase > F) b.forkBase--;
            });
            state.floors = state.floors.filter(f => f.gids.length > 0);
            emit('explain', `<b>删除楼层 ${F}</b>：全局生效（与编辑共享楼层同理），后续楼层重编号，分支路径与分叉基点同步平移——这正是「楼层数组」与原生消息数组一致的语义。`);
        },

        /** 编辑变体文本（共享组=全局可见） */
        editVariant(gid, vi, text) {
            const g = state.groups[gid];
            g.variants[vi].mes = text;
            emit('explain', `<b>编辑</b>：楼层 ${g.floor} 的变体文本更新。${g.owner === null ? '该组为<b style="color:var(--green)">共享组</b>——所有引用它的分支同时可见（第一期语义：编辑共享=全局）。' : '仅该分支私有。'}`);
        },

        /** 模拟「收编」：原生书签产生整文件复制后，转为楼层分支（audit 决策：收编式） */
        adoptNativeCopy(floorNum, name) {
            const b = newBranch(name, floorNum, activeB());
            emit('explain', `<b style="color:var(--orange)">收编</b>：检测到原生书签复制文件（=分叉点截断），已转为楼层分支引用并删除复制文件。原生流程未被阻断，收编与否由用户在弹窗决定。`);
            emit('toast', `已收编原生分支「${b.name}」，复制文件已删除`);
            return b;
        },

        /** 落盘形态：活跃分支的主线性数组 */
        activeLines() {
            const b = activeB();
            const lines = [];
            for (const f of state.floors) {
                const gid = b.path[f.number];
                if (!gid) continue;
                const g = state.groups[gid];
                const v = g.variants[g.active];
                const line = { name: v.name, is_user: v.isUser, mes: v.mes, send_date: 1771009329448 + f.number * 1000 };
                if (g.variants.length > 1) { line.swipes = g.variants.map(x => x.mes); line.swipe_id = g.active; }
                lines.push({ floor: f.number, gid, line });
            }
            return lines;
        },

        /** 落盘形态：header.chat_metadata.extensions.branches */
        branchesData() {
            const b = activeB();
            const activeGids = new Set(Object.values(b.path));
            const groups = {};
            Object.values(state.groups).forEach(g => {
                if (!activeGids.has(g.id)) {
                    groups[g.id] = {
                        floor: g.floor, owner: g.owner, active: g.active,
                        variants: g.variants.map(v => ({ name: v.name, is_user: v.isUser, mes: v.mes })),
                    };
                }
            });
            return {
                active_branch: b.id,
                branches: state.branches.map(x => ({
                    id: x.id, name: x.name, is_default: x.isDefault,
                    fork_base: x.forkBase || undefined,
                    path: Object.keys(x.path).length ? Object.assign({}, x.path) : undefined,
                })),
                groups,
            };
        },
    };

    global.FloorDemo = api;
})(window);
