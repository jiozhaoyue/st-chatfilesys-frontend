/**
 * ChatFilesys — 错误目录与错误面（**纯逻辑，零 DOM**）
 *
 * ── 它解决什么 ──
 * 此前 23 处失败提示多为 `操作失败: ${e.message}`——用户看到的是宿主内部异常的字面文本，
 * **既看不出发生了什么，也不知道该做什么**；而且报错时无法检索、无法定位到代码。
 * 现在每条失败都有：
 *
 * ```
 * CFS-<域><号>   可检索的编号（用户报障只需给这个）
 * what           一句话：发生了什么（人话）
 * why            一句话：为什么（有证据才写，没有就写「未定位」——**不许编**）
 * fix            可点的下一步（重试 / 去改某个设置 / 复制诊断）
 * detail         原始错误文本（折叠，可复制）
 * ```
 *
 * ── 三条纪律 ──
 * 1. **编目而非拼接**：文案住这张表，调用点只给「编号 + 上下文」。这样措辞统一、
 *    可被审计（单测断言每个编号都有 what 与 fix），也能被文档站/agent 枚举。
 * 2. **人话优先**：`what` 里不出现 `undefined` / 栈帧 / 内部函数名。原始文本一律进 `detail`。
 * 3. **不编原因**：没有证据就不写 `why`（用 `why: null`），界面显示「未定位」——
 *    编一个像模像样的原因是**比不写更糟**的误导。
 */

/** 域（编号第二位）：给用户一眼看出「哪一块坏了」 */
export const DOMAINS = Object.freeze({
    G: '通用/环境',
    S: '存储',
    I: '导入',
    B: '分支',
    V: '版本',
    M: '合并',
    R: '回收站',
    A: 'AI',
    X: '导出',
    N: '结构图',
});

/**
 * 错误目录。每个编号必须有 `what` 与非空 `fix`（单测钉住）。
 * @type {Object<string, {what: string, why: string|null, fix: Array<{label: string, action?: string}|string>}>}
 */
export const ERROR_CATALOG = Object.freeze({
    /* ---------------- 通用 ---------------- */
    'CFS-G001': {
        what: '这个宿主没有弹窗 API，管理面板打不开。',
        why: '面板用的是宿主官方 Popup；本宿主（或当前版本）没提供它。',
        fix: ['换个宿主版本试试', '把这条编号报给作者'],
    },
    'CFS-G002': {
        what: '当前没有打开的聊天，或还没选中角色。',
        why: null,   // 未定位：可能是刚启动、可能是角色被卸载——不编
        fix: ['先打开一个聊天', '重试'],
    },
    'CFS-G003': {
        what: '操作没做完。',
        why: null,
        fix: ['重试', '复制诊断信息'],
    },

    /* ---------------- 存储 ---------------- */
    'CFS-S001': {
        what: '切换存储模式失败，已保持原模式（不会丢内容）。',
        why: '切库前要把内容先落到原处，这一步没成功——继续切会让内容失去来源，所以中止了。',
        fix: ['重试', '检查浏览器控制台里的完整错误'],
    },
    'CFS-S002': {
        what: '存储档位都没起来，聊天仍按原生方式工作。',
        why: '三档（Authority / 官方通道 / IndexedDB）都没通过可用性检查。',
        fix: ['重试启用库模式', '检查是否装了 Authority 后端'],
    },
    'CFS-S003': {
        what: '这个聊天还没入库。',
        why: '库模式只管理已经录进数据库的聊天。',
        fix: ['去「当前聊天 → 转库」录入'],
    },
    'CFS-S004': {
        what: '双写同步完成，但有家族没落成文件。',
        why: '库是事实源、内容没丢；只是磁盘上那份副本落后了。',
        fix: ['再点一次「与库同步一次」', '看看控制台里的逐条原因'],
    },

    /* ---------------- 导入 ---------------- */
    'CFS-I001': {
        what: '转库没有完成，原有文件没动。',
        why: null,
        fix: ['重试', '确认当前是库模式（纯库或双写）'],
    },
    'CFS-I002': {
        what: '拿不到当前聊天的文件名，导入没有开始。',
        why: '宿主还没把这个聊天挂到角色上（常见于刚新建、还没保存）。',
        fix: ['先发一条消息让它落盘', '重试'],
    },

    /* ---------------- 分支 ---------------- */
    'CFS-B001': {
        what: '切换分支失败，当前内容没有变。',
        why: null,
        fix: ['重试', '若反复失败，用「导出」先备份当前分支'],
    },
    'CFS-B002': {
        what: '改分支名失败。',
        why: null,
        fix: ['重试'],
    },
    'CFS-B003': {
        what: '删除分支失败，内容没有丢。',
        why: null,
        fix: ['重试'],
    },
    'CFS-B004': {
        what: '设为主分支失败。',
        why: null,
        fix: ['重试'],
    },

    /* ---------------- 合并 ---------------- */
    'CFS-M001': {
        what: '合并没有完成，两条原分支都没动。',
        why: null,
        fix: ['重试', '换一条分支试试'],
    },

    /* ---------------- 版本 ---------------- */
    'CFS-V001': {
        what: '版本弹窗打不开。',
        why: null,
        fix: ['重试', '看看控制台里的完整错误'],
    },
    'CFS-V002': {
        what: '切换这一层的版本失败，内容没有变。',
        why: null,
        fix: ['重试'],
    },

    /* ---------------- 回收站 ---------------- */
    'CFS-R001': {
        what: '回收站当前不可用。',
        why: '只有档1（Authority）能列目录；当前档位没有枚举端点。',
        fix: ['换用 Authority 档', '已快照的条目不会被自动删除'],
    },
    'CFS-R002': {
        what: '还原失败，回收站里的条目还在。',
        why: null,
        fix: ['重试', '确认这个文件名没有被别的聊天占用'],
    },
    'CFS-R003': {
        what: '清理失败，条目还在回收站里。',
        why: null,
        fix: ['重试'],
    },

    /* ---------------- AI ---------------- */
    'CFS-A001': {
        what: 'AI 总结失败，没有写入摘要。',
        why: '宿主没有可用的生成链路，或这次调用被模型端拒绝。',
        fix: ['检查连接与预设', '在设置里关掉「启用 AI 功能」就不再出现这条'],
    },
    'CFS-A002': {
        what: '当前宿主没有生成链路，AI 功能用不了。',
        why: null,
        fix: ['换一个宿主或配好连接'],
    },

    /* ---------------- 导出 ---------------- */
    'CFS-X001': {
        what: '导出失败。',
        why: null,
        fix: ['重试', '确认当前聊天有内容'],
    },
    'CFS-X002': {
        what: '自动导出失败，聊天本身没事。',
        why: '浏览器可能拦下了自动下载。',
        fix: ['手动点「导出当前分支」'],
    },

    /* ---------------- 结构图 ---------------- */
    'CFS-N001': {
        what: '结构图暂时画不出来。',
        why: null,   // 真原因由调用方带（数据源不可用 / 布局不可用 / 建图失败）
        fix: ['点「重算」', '换个聊天试试'],
    },
    'CFS-N002': {
        what: '结构图的数据源不可用。',
        why: '库模式还没启用，或者当前没有活动角色。',
        fix: ['先打开一个角色与聊天', '或在设置里把存储模式切到纯库/双写'],
    },
    'CFS-N003': {
        what: '结构图没算出坐标，只画出了节点位置。',
        why: '布局库没有加载成功（页面脚本未就绪或图为空）。',
        fix: ['点「重算」', '复制诊断信息'],
    },
    'CFS-N004': {
        what: '结构图一个节点都没读到，但当前聊天是有内容的。',
        why: '数据源这次没读出任何会话（枚举或读取失败），图于是是空的——'
             + '**空图不是「没有结构」，是「没读到」**，两者必须分开说。',
        fix: ['点「重算」', '确认存储模式（纯库模式下要先把聊天转库）', '复制诊断信息'],
    },
});

/** 编号是否在册 */
export const hasCode = (code) => Boolean(ERROR_CATALOG[code]);

/** 全部编号（文档站/审计用） */
export const allCodes = () => Object.keys(ERROR_CATALOG);

/** 编号里的域字母（`CFS-N001` → `N`）；识不出 → null */
export function domainOf(code) {
    const m = /^CFS-([A-Z])\d{3}$/.exec(String(code || ''));
    return m ? m[1] : null;
}

/**
 * 造一条「能给人看」的错误。
 *
 * @param {string} code 目录里的编号；不在册也能用（会得到一条通用文案 + 明确标注「未登记」，
 *   这样调用点写错编号时**看得见**，而不是静默变成空白）
 * @param {{detail?: string, why?: string}} [ctx]
 *   `detail` = 原始错误文本（进折叠区）；`why` = 调用点**有证据**的补充归因（覆盖目录里的 null）
 * @returns {{code, domain, domainLabel, what, why, fix: Array, detail: string, registered: boolean,
 *            headline: string, text: string}}
 *   `headline` = 一行可放 toast 的短文案（含编号）；`text` = 完整可复制文本
 */
export function makeError(code, ctx = {}) {
    const registered = hasCode(code);
    const def = ERROR_CATALOG[code] || {
        what: '操作失败。',
        why: null,
        fix: ['重试', '复制诊断信息'],
    };
    const domain = domainOf(code);
    const why = ctx.why !== undefined && ctx.why !== null && String(ctx.why).trim()
        ? String(ctx.why)
        : def.why;
    const detail = String(ctx.detail ?? '').trim();
    const fix = def.fix.map((f) => (typeof f === 'string' ? { label: f } : f));
    const headline = `[${code}] ${def.what}`;
    const lines = [
        `${headline}`,
        `域：${domainsLabelOf(domain)}`,
        `为什么：${why || '未定位（没有足够证据，不编原因）'}`,
        `怎么办：${fix.map((f) => f.label).join(' / ')}`,
    ];
    if (!registered) lines.push('（这个编号没有登记在错误目录里——请把它报给作者）');
    if (detail) lines.push(`原始信息：${detail}`);
    return {
        code, domain, domainLabel: domainsLabelOf(domain),
        what: def.what, why: why || null, fix, detail, registered,
        headline, text: lines.join('\n'),
    };
}

function domainsLabelOf(domain) {
    return DOMAINS[domain] || '未分类';
}

/**
 * 把任意异常收敛成一条错误（调用点最常用的形态）。
 * @param {unknown} e
 * @param {string} code
 */
export function fromException(e, code, extra = {}) {
    return makeError(code, {
        detail: e?.stack || e?.message || String(e ?? ''),
        ...extra,
    });
}

/**
 * 多条错误聚合（界面要「N 项失败」而不是刷屏）。
 * @param {Array<object>} errors makeError 的产物
 * @returns {{count: number, byDomain: Object<string, number>, headline: string}}
 */
export function summarize(errors) {
    const list = (Array.isArray(errors) ? errors : []).filter(Boolean);
    const byDomain = {};
    for (const e of list) {
        const k = e.domainLabel || '未分类';
        byDomain[k] = (byDomain[k] || 0) + 1;
    }
    const parts = Object.entries(byDomain).map(([k, v]) => `${k} ${v} 项`);
    return {
        count: list.length,
        byDomain,
        headline: list.length ? `${list.length} 项失败（${parts.join('、')}）` : '没有失败',
    };
}

/** 错误列表 → 可复制的诊断文本（用户贴给作者/agent 就够定位） */
export function diagnosisText(errors, meta = {}) {
    const list = (Array.isArray(errors) ? errors : []).filter(Boolean);
    const head = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n');
    return [head, '', ...list.map((e, i) => `--- 第 ${i + 1} 条 ---\n${e.text}`)].join('\n').trim();
}
