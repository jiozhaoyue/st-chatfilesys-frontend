/**
 * ChatFilesys — 设置中枢：**全部可调项的单一事实源**
 *
 * ── 为什么要有这个文件 ──
 * 此前设置散在三处：`index.js#loadSettings` 写默认值、`extension_settings.chatfilesys.*` 存值、
 * `ui/popup.js` 手写 HTML 渲染。加一项要改三个地方，且**没有任何地方能回答「一共有哪些可调项」**
 * ——用户看不到、agent 也枚举不出。
 *
 * 现在：一张表（本文件）+ 两个纯函数（`readSetting` / `writeSetting`）+ 一个导出（`exportRegistry`）。
 *   · UI 由表生成（`ui/popup.js`）
 *   · 读写由表定义（`index.js`）——**不许在别处再写 `extension_settings.chatfilesys.xxx`**
 *   · `exportRegistry()` 给脚本/文档站/agent：可枚举、可审查
 *
 * ── 每一项都必须有 `why` ──
 * `why` = **为什么这个默认值 / 为什么它可调**。写不出来就说明它不该在这张表里
 * （内部时序常量、实现细节不暴露）。刻意不暴露的项在 `spec/frontend/settings.md` 里列清单与理由，
 * **不在这里静默留白**。
 *
 * ── `apply`：改完要发生什么 ──
 * 设置改了不是「存下就好」：换存储模式要重装接缝、改图阈值要让缓存失效。
 * `apply` 是**声明**，由 `index.js#applySetting` 执行；声明与执行分处两地，
 * 是为了让「改了没生效」这类缺陷在表上就能看出来（有 apply 而没人执行 = 缺陷）。
 *
 * 纯模块：零 DOM、零宿主依赖，可在 `node --test` 下直接测（`tests/branches/settings.test.mjs`）。
 */

/** 设置项的允许类型 */
export const TYPES = Object.freeze(['boolean', 'number', 'enum', 'text', 'string-list']);

/** 改完之后要做什么（由 `index.js#applySetting` 执行） */
export const APPLY = Object.freeze({
    NONE: 'none',         // 存下即可
    STORAGE: 'storage',   // 重装/卸载接缝与适配器
    GRAPH: 'graph',       // 让结构图的图缓存与坐标缓存失效
    UI: 'ui',             // 重绘弹窗
});

/**
 * 全部可调项。
 *
 * 顺序 = UI 上的显示顺序（分组内）。分组顺序由 `GROUP_ORDER` 决定。
 */
export const SETTINGS = Object.freeze([
    /* ---------------- 存储 ---------------- */
    {
        key: 'storage_mode',
        label: '存储模式',
        group: '存储',
        type: 'enum',
        values: ['off', 'pure', 'mirror'],
        valueLabels: { off: 'JSONL 增强（文件里）', pure: '纯数据库', mirror: '双写（库为准 + 留一份文件）' },
        default: 'off',
        describe: '决定聊天的内容存在哪里。增强模式住聊天文件本身；纯库模式只住数据库；双写两处都有。',
        why: '默认「增强模式」——它不动任何既有文件，最安全；库模式要用户主动把聊天「转库」，不能替用户决定。',
        apply: APPLY.STORAGE,
    },
    {
        key: 'mirror_sync_on_write',
        label: '双写：改动即落文件',
        group: '存储',
        type: 'boolean',
        default: true,
        describe: '双写模式下，库一被改动就把内容落到标准聊天文件（1.5 秒防抖）。关掉则只在手动「与库同步一次」时落。',
        why: '默认开——双写的意义就是让磁盘文件跟上；关掉是给「嫌频繁写盘」的人用的，那时文件会显示落后。',
        apply: APPLY.UI,
    },
    {
        key: 'auto_export',
        label: '保存后自动导出',
        group: '存储',
        type: 'boolean',
        default: false,
        describe: '每次聊天保存后，顺带导出一次当前分支的 JSONL（带下载，浏览器可能拦）。',
        why: '默认关——浏览器下载需要用户手势，自动触发常被拦截或堆积一堆下载；这是给有导出习惯的人的手动开关。',
        apply: APPLY.NONE,
    },

    /* ---------------- 入库 ---------------- */
    {
        key: 'import_prompt.never',
        label: '不再提醒入库',
        group: '入库',
        type: 'boolean',
        default: false,
        describe: '打开一个还没入库的聊天时，不再弹「要不要转库」的提醒。',
        why: '默认关——转了库的聊天才有分支能力，不提醒的话用户根本不知道有这个功能；嫌烦的人一键关掉。',
        apply: APPLY.NONE,
    },

    /* ---------------- 界面 ---------------- */
    {
        key: 'tree_direction',
        label: '结构树展开方向',
        group: '界面',
        type: 'enum',
        values: ['down', 'right'],
        valueLabels: { down: '向下（深度朝下）', right: '向右（深度朝右）' },
        default: 'down',
        describe: '分支结构树往哪边长。分支多而深时「向右」更省高度。',
        why: '两种布局各有适用场景（楼层深 vs 分支多），没有更优的一方，所以给用户选。',
        apply: APPLY.UI,
    },
    {
        key: 'ui.confirm_delete_branch',
        label: '删除分支前二次确认',
        group: '界面',
        type: 'boolean',
        default: true,
        describe: '删分支时先弹一个确认框，说清会回收哪些内容。',
        why: '默认开——删分支会连带回收它独占的楼层，是**破坏性操作**，误点一次就没了；这是最不该省的一道确认。',
        apply: APPLY.UI,
    },
    {
        key: 'ui.toast',
        label: '操作提示气泡',
        group: '界面',
        type: 'boolean',
        default: true,
        describe: '切换分支、导出、改名等操作完成后弹一个短提示。',
        why: '默认开——这些动作用户看不到即时反馈（聊天区可能没变化），没有提示会以为没生效。',
        apply: APPLY.NONE,
    },

    /* ---------------- 结构图 ---------------- */
    {
        key: 'graph.enabled',
        label: '显示结构图页签',
        group: '结构图',
        type: 'boolean',
        default: true,
        describe: '在弹窗里保留「结构图」页签。关掉后只看分支结构树，不建图（省内存与耗时）。',
        why: '图对长聊天有明显开销；把它做成可关的，用户才能在自己机器上权衡。',
        apply: APPLY.UI,
    },
    {
        key: 'graph.direction',
        label: '图的展开方向',
        group: '结构图',
        type: 'enum',
        values: ['TB', 'LR'],
        valueLabels: { TB: '上下（分层往下）', LR: '左右（分层往右）' },
        default: 'TB',
        describe: '结构图的分层方向。',
        why: '纵向适合长对话，横向适合屏幕宽而矮的场合——两种都有人要。',
        apply: APPLY.GRAPH,
    },
    {
        key: 'graph.minimap_budget',
        label: '小地图：节点数上限',
        group: '结构图',
        type: 'number',
        default: 400,
        min: 0,
        max: 5000,
        step: 50,
        describe: '节点数超过它就关掉小地图（小地图自己也要画几百个点）。',
        why: '阈值取决于设备；默认 400 是「小地图还看得清」的经验值，机器好的人可以调高。',
        apply: APPLY.GRAPH,
    },
    {
        key: 'graph.edge_label_budget',
        label: '边标签：节点数上限',
        group: '结构图',
        type: 'number',
        default: 200,
        min: 0,
        max: 5000,
        step: 50,
        describe: '节点数超过它就不画边上的文字标签（每个标签是一个 DOM 元素）。',
        why: '标签是 DOM 数量的大头；默认 200 之后图会明显变快，但小图仍保留标签以便读边。',
        apply: APPLY.GRAPH,
    },
    {
        key: 'graph.chunk_budget',
        label: '分片渲染：节点数上限',
        group: '结构图',
        type: 'number',
        default: 1200,
        min: 0,
        max: 20000,
        step: 100,
        describe: '节点数超过它改为分帧渲染（每帧画一批），避免一次性卡住弹窗。',
        why: '默认 1200 是「一次性画完还来不及卡」的量级；机器慢的人可以调低，让它更早开始分片。',
        apply: APPLY.GRAPH,
    },
    {
        key: 'graph.chunk_size',
        label: '分片渲染：每批节点数',
        group: '结构图',
        type: 'number',
        default: 240,
        min: 20,
        max: 5000,
        step: 20,
        describe: '分片渲染时每帧画多少个元素。太小人看到图一格格长出来，太大则卡帧。',
        why: '这是「流畅」与「快出图」之间的取舍，因机器而异；大图会自动放大这个值，用户也能固定它。',
        apply: APPLY.GRAPH,
    },
    {
        key: 'graph.force_minimal',
        label: '强制最小档（诊断用）',
        group: '结构图',
        type: 'boolean',
        default: false,
        describe: '无视节点数，一律按最小档渲染（关小地图、关标签、分片渲染）。',
        why: '用来**验证降级路径本身是好的**——不做成开关就只能靠改代码去测，那等于测不了。',
        apply: APPLY.GRAPH,
    },

    /* ---------------- 兼容 ---------------- */
    {
        key: 'compat.serve_chat_listing',
        label: '让「列出聊天」也看得到库里的聊天',
        group: '兼容',
        type: 'boolean',
        default: true,
        describe: '酒馆和别的插件在「列出这个角色有哪些聊天」时，把数据库里的聊天一并列出来。'
            + '关掉则只列磁盘上的文件。',
        why: '默认开——纯库模式下源文件已移入回收站，磁盘上一个聊天都没有；'
            + '不补这一步，聊天备份 / 聊天仓库 / 聊天合并这类**需要翻列表**的插件会「什么都找不到」，'
            + '而宿主的聊天列表也会显得空。实现上**只增不减**、出错即退回磁盘事实（不会弄坏列表）。',
        apply: APPLY.NONE,   // 接缝每次请求现取，不必重装
    },

    /* ---------------- 接管 ---------------- */
    {
        key: 'takeover.content_gate',
        label: '原生「创建分支/检查点」接管：内容闸门',
        group: '接管',
        type: 'enum',
        values: ['strict', 'fields', 'off'],
        valueLabels: {
            strict: '严格：整行完全相同才算（最保守）',
            fields: '只比正文/说话人：忽略插件补的字段（装了改写类插件选这个）',
            off: '不比内容：宿主说是分叉就照做（风险自负）',
        },
        default: 'strict',
        describe: '纯库 / 双写模式下，宿主的「创建分支 / 创建检查点」要不要被本插件接管进库，'
            + '取决于新聊天文件的内容能不能对上父分支。这一项决定「怎么算对得上」。',
        why: '默认「严格」是不擅自改变既有行为。但装了消息改写类插件（变量框架、模板引擎）时，'
            + '它们会在载入与写出之间给消息补字段，整行永远不全等 ⇒ **接管会失效**'
            + '（表现为「创建分支没反应」）。真机已实测到这个形态；那时应改成「只比正文/说话人」。',
        apply: APPLY.NONE,   // 接缝**每次判定时现取**，不需要重装
    },

    /* ---------------- AI ---------------- */    {
        key: 'ai.enabled',
        label: '启用 AI 功能',
        group: 'AI',
        type: 'boolean',
        default: true,
        describe: '允许「AI 总结分支」这类要调模型的功能。关掉后相关按钮隐藏。',
        why: '默认开（宿主有生成链路就用）；关掉是给「不想让插件花 token」的人——一次总结一次调用，费用是用户的。',
        apply: APPLY.UI,
    },
    {
        key: 'ai.max_chars',
        label: 'AI：正文总字数上限',
        group: 'AI',
        type: 'number',
        default: 4000,
        min: 200,
        max: 40000,
        step: 200,
        describe: '喂给模型的正文最多取多少字（超出从头截断）。',
        why: '直接决定开销与是否超上下文；默认 4000 够概括走向且便宜，长聊天想更准可以调高。',
        apply: APPLY.NONE,
    },
    {
        key: 'ai.chars_per_floor',
        label: 'AI：每层截断字数',
        group: 'AI',
        type: 'number',
        default: 200,
        min: 40,
        max: 4000,
        step: 20,
        describe: '每一层正文最多取多少字（避免某一层特别长就把预算吃光）。',
        why: '「总上限」管总量、「每层上限」管公平——没有后者时，一层长文就挤掉后面所有层。',
        apply: APPLY.NONE,
    },
    {
        key: 'ai.max_summary_len',
        label: 'AI：摘要长度上限',
        group: 'AI',
        type: 'number',
        default: 60,
        min: 10,
        max: 400,
        step: 5,
        describe: '生成的摘要最多保留多少字（超出截断）。',
        why: '摘要在结构树节点上是小字，太长会把节点撑开；默认 60 是「一眼读完」的长度。',
        apply: APPLY.NONE,
    },

    /* ---------------- 回收站 ---------------- */
    {
        key: 'trash.retention_days',
        label: '回收站保留天数',
        group: '回收站',
        type: 'number',
        default: 7,
        min: 1,
        max: 365,
        step: 1,
        describe: '删除聊天源文件时留的副本保留多少天，过期自动清理。',
        why: '默认 7 天——删除是**不可逆**的，7 天是「发现删错了还来得及」的兜底；嫌占地方的可以调小。',
        apply: APPLY.NONE,
    },

    /* ---------------- 诊断 ---------------- */
    {
        key: 'debug.verbose',
        label: '详细日志',
        group: '诊断',
        type: 'boolean',
        default: false,
        describe: '在浏览器控制台打印每次建图、选档、接缝命中的细节。',
        why: '默认关——平时刷屏没意义；排障时打开，用户把日志贴出来就能定位（比让用户复述现象强得多）。',
        apply: APPLY.NONE,
    },
]);

/** 分组显示顺序（表里没列到的分组排在最后，按名字） */
export const GROUP_ORDER = Object.freeze(['存储', '入库', '界面', '结构图', '兼容', '接管', 'AI', '回收站', '诊断']);

/** key → 定义（查表用；`SETTINGS` 本身仍是唯一事实源） */
export const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** 全部默认值（扁平 `{key: value}`，key 是**点分路径**） */
export function defaults() {
    const out = {};
    for (const s of SETTINGS) out[s.key] = s.default;
    return out;
}

/** 按分组归类（UI 用；组内保持表内顺序） */
export function grouped() {
    const map = new Map();
    for (const s of SETTINGS) {
        if (!map.has(s.group)) map.set(s.group, []);
        map.get(s.group).push(s);
    }
    const names = [...map.keys()].sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(a);
        const ib = GROUP_ORDER.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || (a < b ? -1 : a > b ? 1 : 0);
    });
    return names.map((name) => ({ name, items: map.get(name) }));
}

/** 点分路径读（`'graph.chunk_size'` → `store.graph.chunk_size`） */
function readPath(store, path) {
    let cur = store;
    for (const part of String(path).split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

/** 点分路径写（沿途缺的层自动建对象；返回是否**真的改变了**） */
function writePath(store, path, value) {
    const parts = String(path).split('.');
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
    }
    const last = parts[parts.length - 1];
    const changed = cur[last] !== value;
    cur[last] = value;
    return changed;
}

/**
 * 把一个值**规范化**成该设置允许的形状。非法输入一律回落默认值（**不抛**，L0-11）。
 *
 * 为什么必须规范而不是「原样存」：`extension_settings` 是用户能手改的 JSON，
 * 也可能被旧版本写进别的形状。不规范化的话，一个字符串 `"20"` 会让 `> 20` 的比较
 * 变成字符串比较（`"1200" > "20"` 是 false），阈值行为**静默错掉**。
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {{value: unknown, fixed: boolean}} `fixed:true` = 输入非法、已回落默认值
 */
export function normalize(key, raw) {
    const def = BY_KEY.get(key);
    if (!def) return { value: undefined, fixed: false };
    if (raw === undefined || raw === null) return { value: def.default, fixed: false };
    switch (def.type) {
        case 'boolean':
            if (typeof raw === 'boolean') return { value: raw, fixed: false };
            // 容忍字符串形态（老版本 / 手改的 JSON）
            if (raw === 'true') return { value: true, fixed: true };
            if (raw === 'false') return { value: false, fixed: true };
            return { value: def.default, fixed: true };
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return { value: def.default, fixed: true };
            const clamped = Math.min(def.max ?? Number.POSITIVE_INFINITY,
                Math.max(def.min ?? Number.NEGATIVE_INFINITY, n));
            // `typeof raw !== 'number'` 也算「纠正过」：值虽然等价（`'300'` → `300`），
            // 但**存进去的形状变了**。报出来才看得见「你的设置文件里这一项形状不对」，
            // 否则字符串形态会一直悄悄留在用户的 JSON 里。
            return { value: clamped, fixed: typeof raw !== 'number' || clamped !== n };
        }
        case 'enum':
            if (def.values.includes(raw)) return { value: raw, fixed: false };
            return { value: def.default, fixed: true };
        case 'text':
            return typeof raw === 'string' ? { value: raw, fixed: false } : { value: def.default, fixed: true };
        case 'string-list':
            if (Array.isArray(raw)) return { value: raw.map(String), fixed: false };
            return { value: [...def.default], fixed: true };
        default:
            return { value: def.default, fixed: true };
    }
}

/**
 * 读一项（**唯一读入口**）。值非法/缺失 → 默认值。
 * @param {object} store `extension_settings.chatfilesys` 那棵树
 * @param {string} key 点分路径
 */
export function readSetting(store, key) {
    const def = BY_KEY.get(key);
    if (!def) return undefined;
    const { value } = normalize(key, readPath(store, key));
    return value;
}

/**
 * 写一项（**唯一写入口**）。写入前规范化；返回是否真的发生了改变
 * （调用方据此决定要不要跑 `apply` —— 没变就不该触发重装接缝这种重活）。
 * @returns {{changed: boolean, value: unknown, fixed: boolean, apply: string}}
 */
export function writeSetting(store, key, raw) {
    const def = BY_KEY.get(key);
    if (!def) return { changed: false, value: undefined, fixed: false, apply: APPLY.NONE };
    if (!store || typeof store !== 'object') {
        return { changed: false, value: def.default, fixed: true, apply: def.apply };
    }
    const { value, fixed } = normalize(key, raw);
    const changed = writePath(store, key, value);
    return { changed, value, fixed, apply: changed ? def.apply : APPLY.NONE };
}

/**
 * 把整棵树按表补齐/纠正（启动时跑一次）。
 *
 * **它同时是「迁移」**：老版本的键名/形状会在这一步被纠正到当前表上——
 * 不需要单独写迁移脚本，也不会因为漏写迁移而留下一个半坏的设置。
 *
 * @returns {{fixed: string[]}} 被纠正过的键（非空即说明用户的 JSON 里有非法值/旧值）
 */
export function ensureAll(store, { log = () => {} } = {}) {
    const fixed = [];
    if (!store || typeof store !== 'object') return { fixed };
    for (const def of SETTINGS) {
        const got = normalize(def.key, readPath(store, def.key));
        if (got.fixed) fixed.push(def.key);
        // 即使没被纠正也写一遍：让缺失的项**真的落在存储里**，
        // 这样用户打开设置文件能看到全部可调项（而不是「只有我改过的几项」）
        writePath(store, def.key, got.value);
    }
    if (fixed.length) log(`[chatfilesys] 设置已纠正为合法值：${fixed.join(', ')}`);
    return { fixed };
}

/** 恢复某一项到默认 */
export function resetSetting(store, key) {
    return writeSetting(store, key, BY_KEY.get(key)?.default);
}

/** 恢复全部到默认（含 `import_prompt.mutedKeys` 这类列表） */
export function resetAll(store) {
    if (!store || typeof store !== 'object') return { changed: [] };
    const changed = [];
    for (const def of SETTINGS) {
        const r = writeSetting(store, def.key, def.default);
        if (r.changed) changed.push(def.key);
    }
    return { changed };
}

/**
 * **机器可读的导出**（agent 友好 / 文档站可自动生成）。
 *
 * 为什么要它：用户明确要求「该审查的审查、agent 友好」。有了它，一条命令就能拿到
 * 全部可调项及其类型、默认值、取值范围与理由——不必读代码，也不会漏项。
 *
 * @returns {object} `{version, groups, settings: [...]}`（可直接 `JSON.stringify`）
 */
export function exportRegistry() {
    return {
        version: 1,
        count: SETTINGS.length,
        groups: grouped().map((g) => ({ name: g.name, keys: g.items.map((i) => i.key) })),
        settings: SETTINGS.map((s) => ({
            key: s.key,
            label: s.label,
            group: s.group,
            type: s.type,
            default: s.default,
            ...(s.values ? { values: s.values } : {}),
            ...(s.valueLabels ? { valueLabels: s.valueLabels } : {}),
            ...(s.min !== undefined ? { min: s.min } : {}),
            ...(s.max !== undefined ? { max: s.max } : {}),
            ...(s.step !== undefined ? { step: s.step } : {}),
            describe: s.describe,
            why: s.why,
            apply: s.apply,
        })),
    };
}
