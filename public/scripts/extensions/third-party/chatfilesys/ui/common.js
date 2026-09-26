/**
 * ChatFilesys — UI 公共渲染（纯 DOM 组装，不含业务编排）
 *
 * 术语（R5 2026-09-25 重裁定，全仓统一）：
 * - **swipe** = 宿主原生左右箭头所切的东西（`message.swipes[]`）
 * - **组 / swipe 组** = 某楼层的一份内容；**该层有多个 swipe 组 = 该层就是分叉点**
 * - **分支（branch）** = `path = {楼层 → 组}`，不变量要求是 1..N 连续前缀
 *
 * **当前分支由调用方显式传入**（W3，2026-09-26）：本聊天读到的 body 是**按该聊天键的键绑定**
 * 投影出来的（原生分支/检查点键各代表一条分支，`core/takeover.js#branchIdForKey`），
 * 而模型里的 `active_branch` 是**家族级**的——两者在绑定键上并不相同。
 * 故渲染函数一律收 `branchId` 参数（缺省才回落到 `model.active_branch`），
 * 不自己取全局状态（见 spec/frontend/component-guidelines.md）。
 *
 * 铁律：**弹窗内任何位置都不得逐层列举楼层**；结构树只显结构（序号 / 分支名 + 层数），
 * 不含任何消息内容。交互通过 data-action / data-branch 事件委托抛给 index.js。
 */

const BR_COLORS = ['#58a6ff', '#f0883e', '#a371f7', '#db61a2', '#d29922', '#39c5cf'];

export function esc(s) {
    const d = document.createElement('div');
    d.textContent = s === undefined || s === null ? '' : String(s);
    return d.innerHTML;
}

export function branchColor(model, branchId) {
    const idx = model.branches.findIndex((b) => b.id === branchId);
    return BR_COLORS[(idx < 0 ? 0 : idx) % BR_COLORS.length];
}

/** 分叉点集合：同层位置上存在 >1 个不同组（= `swipeGroupsAt` 组数 > 1 的楼层） */
export function detectForkFloors(model) {
    const byFloor = new Map();
    for (const b of model.branches) {
        for (const [f, gid] of Object.entries(b.path)) {
            const set = byFloor.get(Number(f)) || new Set();
            set.add(gid);
            byFloor.set(Number(f), set);
        }
    }
    const forks = new Set();
    for (const [f, set] of byFloor) if (set.size > 1) forks.add(f);
    return forks;
}

export function branchFloors(b) {
    return Object.keys(b.path).length;
}

export function branchMaxFloor(b) {
    return Math.max(0, ...Object.keys(b.path).map(Number));
}

/**
 * 本次聊天所在的分支。
 * @param {object} model
 * @param {string} [branchId] 当前聊天键绑定的分支（`null` = 无绑定 → 家族活跃分支）
 */
export function getActiveBranch(model, branchId = null) {
    const want = branchId || model?.active_branch;
    return model.branches.find((b) => b.id === want) || model.branches[0];
}

/* ---------------- 该层的 swipe 组（版本按钮与版本弹窗的唯一数据源） ---------------- */

/**
 * 给定 model + 楼层 → **该层的 swipe 组列表**。
 *
 * 组 = 该楼层的一份内容（术语见文件头）；组数 > 1 ⇔ 该层是分叉点（不变式 5）。
 * 组序 = 分支声明顺序（同一组被多条分支共享时只出现一次），故「第 k 组」稳定可复现。
 * 「当前组」= **传入的当前分支**在该层引用的组（不是家族级 `active_branch`，见文件头）。
 *
 * 组内 swipe 数：
 * - 当前分支在该层引用的组 → 内容就是 body 行，取 `line.swipes.length`（宿主原生 swipe）
 * - 其余组 → 折叠在 `model.groups[gid].variants`，取变体数
 *
 * @param {object|null} model
 * @param {number} floor
 * @param {Array<object>} [chat] 当前 body（ctx.chat），用于当前组读 swipe 数
 * @param {string} [branchId] 当前聊天键绑定的分支（缺省回落 `model.active_branch`）
 * @returns {Array<{gid: string, floor: number, branchIds: string[], isActive: boolean,
 *                  variantCount: number, activeVariant: number}>}
 */
export function swipeGroupsAt(model, floor, chat = [], branchId = null) {
    const f = Number(floor);
    if (!model || !Array.isArray(model.branches) || !Number.isInteger(f) || f < 1) return [];
    const activeGid = getActiveBranch(model, branchId)?.path?.[f] ?? null;
    const groups = [];
    const byGid = new Map();
    for (const b of model.branches) {
        const gid = b.path?.[f];
        if (!gid) continue;
        let g = byGid.get(gid);
        if (!g) {
            g = {
                gid,
                floor: f,
                branchIds: [],
                isActive: gid === activeGid,
                variantCount: 1,
                activeVariant: 0,
            };
            byGid.set(gid, g);
            groups.push(g);
        }
        g.branchIds.push(b.id);
    }
    for (const g of groups) {
        if (g.isActive) {
            const line = chat?.[f - 1];
            const n = Array.isArray(line?.swipes) ? line.swipes.length : 1;
            g.variantCount = Math.max(1, n);
            g.activeVariant = Number(line?.swipe_id ?? 0) || 0;
        } else {
            const folded = model.groups?.[g.gid];
            g.variantCount = Math.max(1, folded?.variants?.length ?? 1);
            g.activeVariant = Number(folded?.active ?? 0) || 0;
        }
    }
    return groups;
}

/**
 * 版本按钮的计数标签：分叉图标 + `当前组序号/组总数`（**不用左右箭头**——箭头形状归宿主原生 swipe）。
 * @returns {string} 组数 ≤ 1 时返回空串（该消息上零插件元素）
 */
export function versionButtonLabel(model, floor, chat = [], branchId = null) {
    const groups = swipeGroupsAt(model, floor, chat, branchId);
    if (groups.length <= 1) return '';
    const at = groups.findIndex((g) => g.isActive);
    return `⎇ ${(at < 0 ? 0 : at) + 1}/${groups.length}`;
}

/* ---------------- 分支标签与摘要（N5/N13） ---------------- */

/** 插件自动生成的名字（用户没改过）——树上默认只显示序号，省宽度 */
const AUTO_NAME_RE = /^(主分支|分支\d+|分叉·F\d+)$/;

/**
 * 分支显示标签：**默认自动序号**（`#N`，按 branches 顺序）；有自定义名时附在序号后。
 * @param {{name?: string}} b
 * @param {number} idx branches 里的下标
 */
export function nodeLabel(b, idx) {
    const name = String(b?.name ?? '').trim();
    const ordinal = `#${idx + 1}`;
    if (!name || AUTO_NAME_RE.test(name)) return ordinal;
    const short = name.length > 8 ? `${name.slice(0, 8)}…` : name;
    return `${ordinal} ${short}`;
}

/** 分支的 AI 摘要（N13：手动触发后才存在；空则无） */
export function branchSummaryOf(b) {
    const s = String(b?.summary ?? '').trim();
    if (!s) return '';
    return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/**
 * 拼出某条分支的消息行（N13：AI 总结的输入）。
 * 当前分支引用的组在 body（ctx.chat）；其余分支引用的组折在 model.groups 里。
 * @param {object} model
 * @param {Array} chat 当前 body（ctx.chat）
 * @param {object} branch 目标分支
 * @param {string} [branchId] 当前聊天键绑定的分支（决定「body 是哪条分支的内容」，见文件头）
 * @returns {Array<object>} 该分支的消息行（楼层升序）
 */
export function assembleBranchLines(model, chat, branch, branchId = null) {
    if (!model || !branch) return [];
    const activeGids = new Set(Object.values(getActiveBranch(model, branchId)?.path || {}));
    const out = [];
    const floors = Object.keys(branch.path || {}).map(Number).sort((a, b2) => a - b2);
    for (const f of floors) {
        const gid = branch.path[f];
        if (activeGids.has(gid)) {
            const line = chat?.[f - 1];
            if (line) out.push(line);
            continue;
        }
        const g = model.groups?.[gid];
        const variant = g?.variants?.[g.active ?? 0];
        if (variant) out.push(variant);
    }
    return out;
}

/** 未启用/群聊状态的弹窗内容（无 Tabs） */
export function renderInactiveContent(container, { isGroupChat = false, pureLike = false } = {}) {
    if (!container) return;
    if (isGroupChat) {
        container.innerHTML = '<div class="chatfilesys-note">群聊暂不支持分支（第一期仅单人聊天）。</div>';
        return;
    }
    const where = pureLike
        ? '启用后：<b>内容存进数据库</b>（磁盘上不再有该聊天的 jsonl），分支与 swipe 组由库统一管理。'
        : '启用后：<b>分支住在这个聊天文件体内</b>——共享前缀只存一份、切换分支零网络、原生环境打开数据无损。';
    container.innerHTML = `
        <div class="chatfilesys-note">此聊天尚未启用。${where}</div>
        <div class="chatfilesys-btnrow">
            <button class="menu_button" data-action="enable"><i class="fa-solid fa-layer-group"></i> 启用</button>
        </div>`;
}
