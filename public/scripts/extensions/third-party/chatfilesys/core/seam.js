/**
 * ChatFilesys — fetch 拦截接缝层（seam，纯库模式核心）
 *
 * 职责（design.md §4，N6 裁定）：
 * - patch globalThis.fetch，拦截 /api/chats/* 的读/写请求：
 *   读（chats/get）→ 适配器分片读 → 拼装 [header, ...messages] 合规响应（伪装 jsonl）
 *   写（save/append/patch/rename/delete）→ 解包 → 适配器库写 → 伪造 {ok, integrity}
 * - 非聊天请求原样透传（headers/init 全量传递，不破坏其他插件）
 * - 冲突（integrity 乐观锁）→ 409，调用方按宿主语义重拉重放
 * - 任何异常 → console.warn + 透传原始 fetch（L0-11 静默降级，绝不阻断宿主）
 * - dispose 可恢复原始 fetch（ws-delivery installFetchProxy 先例模式）
 *
 * 适配器契约 = design.md §2 StorageAdapterAPI（duck-typed 参数注入，本模块不感知具体后端）。
 */

import { applyOpsToObject } from './ops-apply.js';
import { normIntegrity } from './integrity.js';
import { planTakeover, branchIdForKey, classifyNewChat } from './takeover.js';

/** 拦截的路由（URL 路径尾部匹配；meta 系 = 分支模型保存通道，get-delta = 原生分页读） */
const ROUTES = [
    'chats/get', 'chats/save', 'chats/append', 'chats/patch', 'chats/rename', 'chats/delete',
    'chats/meta', 'chats/meta/patch', 'chats/get-delta',
];

/**
 * 归一化宿主聊天键：avatar 与文件名小写、去首尾空白、剥 .jsonl 后缀。
 * 真机事实（2026-09-24 Dev 实例捕获）：宿主 get 请求 file_name 不带 .jsonl、
 * avatar_url 带 .png；导入侧建档带 .jsonl——两侧统一剥后缀保证键一致。
 * @param {string} avatarUrl
 * @param {string} fileName
 * @returns {string} chatKey
 */
export function normalizeChatKey(avatarUrl, fileName) {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.jsonl$/i, '');
    return `${norm(avatarUrl)}::${norm(fileName)}`;
}

/**
 * 入向版本号（T1/N19：字符串形态，不再做数字⇄slug 桥接）。
 * `force` = 宿主显式覆盖信号 → 不锁版本号。
 * 其余情形原样交给适配器做字符串相等判定；调用方未带版本号（宿主原生 saveChat 不带
 * integrity）时返回 null = 不锁。
 * @returns {string|null}
 */
function expectedIntegrityOf(body) {
    if (body?.force) return null;
    return normIntegrity(body?.integrity);
}

/** 解析 Request 的 URL 路径（支持字符串与 Request 对象；无 location 环境（node:test）用占位基准） */
function urlOf(input) {
    const base = typeof location !== 'undefined' && location?.href ? location.href : 'http://local.invalid/';
    if (typeof input === 'string') return new URL(input, base);
    if (input && typeof input.url === 'string') return new URL(input.url, base);
    return null;
}

/** 从 fetch(input, init) 提取 JSON body（容错：解析失败返回 null） */
async function bodyOf(input, init) {
    try {
        if (init?.body) return JSON.parse(String(init.body));
        if (input instanceof Request) return await input.clone().json();
        return null;
    } catch {
        return null;
    }
}

/** 伪造合规 JSON Response（伪装宿主端点响应形态） */
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 本插件在聊天头里自管的两个位置：extensions.chatfilesys（走法模型）与 integrity（版本号） */
const OWN_EXTENSION_KEY = 'chatfilesys';

/**
 * 合成完整 chat_metadata（读响应用，T0/R0：聊天记录零丢失）。
 * 宿主与其他插件写进聊天头的内容**整份回显**；本插件两项覆盖在各自位置。
 * `extensions` 是**合并**而不是覆盖——其他插件也把命名空间挂在 extensions 下。
 *
 * T1：`main_chat` 是**按键**的——分支/检查点键各有各的父，家族级的 hostMetadata 是所有键
 * 共用的（混进去会让根聊天也冒出「返回父聊天」）。故按键绑定的 `mainChat` 覆盖回显。
 * @param {{hostMetadata?: object, model?: object, integrity?: any, keyBindings?: object}} family
 * @param {string} [chatKey] 本次请求的聊天键（决定 main_chat 覆盖）
 */
function composeChatMetadata(family, chatKey) {
    const host = family?.hostMetadata && typeof family.hostMetadata === 'object' ? family.hostMetadata : {};
    const extensions = { ...(host.extensions || {}), [OWN_EXTENSION_KEY]: family?.model ?? null };
    const meta = { ...host, integrity: normIntegrity(family?.integrity), extensions };
    const bound = chatKey != null ? family?.keyBindings?.[chatKey] : null;
    if (bound?.mainChat) meta.main_chat = bound.mainChat;
    return meta;
}

/**
 * 入向聊天头并入前的处理（T1）：绑定键（分支/检查点）的 `main_chat` 属于该键自己，
 * 不得混进家族级 hostMetadata——否则根键也会带上「返回父聊天」。
 * @returns {object} 可并入家族级的聊天头内容
 */
function stripKeyOwnedMeta(family, chatKey, incomingHost) {
    const src = incomingHost && typeof incomingHost === 'object' ? incomingHost : {};
    if (chatKey == null || !family?.keyBindings?.[chatKey]) return src;
    const { main_chat: _omit, ...rest } = src; // eslint-disable-line no-unused-vars
    return rest;
}

/**
 * 从完整 chat_metadata 拆出库内三份中的两份：`{ hostMetadata, model }`。
 * hostMetadata = 去掉本插件两项之后的**其余全部内容**（其他插件命名空间、main_chat、变量……）。
 * @param {object} meta
 */
function splitChatMetadata(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const extensions = { ...(m.extensions || {}) };
    const model = extensions[OWN_EXTENSION_KEY] ?? null;
    delete extensions[OWN_EXTENSION_KEY];
    const host = { ...m };
    delete host.integrity;
    if (Object.keys(extensions).length) host.extensions = extensions;
    else delete host.extensions;
    return { hostMetadata: host, model };
}

/**
 * 合并宿主元数据（T0/R0 关键：**不能浅合并掉别人的命名空间**）。
 *
 * 顶层浅合并 + `extensions` **按命名空间逐项合并**：其他插件的数据都挂在
 * `extensions.<插件名>` 下，若整体替换 `extensions`，宿主一次自带 `extensions` 的保存
 * 就会把所有插件的命名空间一起抹掉（真机实测：时有时无的丢命名空间）。
 * 每个命名空间内部按「该插件发来的整份即其最新值」替换，不做深合并。
 * 删除命名空间：`chats/meta/patch` 的 remove op（**非旧副本差分**的那种）——本函数不删任何东西。
 *
 * @param {object} prev 库内已有
 * @param {object} incoming 本次入向
 */
function mergeHostMetadata(prev, incoming) {
    const a = prev && typeof prev === 'object' ? prev : {};
    const b = incoming && typeof incoming === 'object' ? incoming : {};
    const merged = { ...a, ...b };
    if (a.extensions || b.extensions) {
        merged.extensions = { ...(a.extensions || {}), ...(b.extensions || {}) };
    }
    return merged;
}

/**
 * 入向模型是否代表一次「走法切换」。
 * 只有切换才让入向模型决定结构：宿主内存里的模型副本可能是旧版（它不知道本插件刚登记的
 * 追加楼层/新走法），让旧副本盖掉库内结构会丢东西。非切换场景一律以库内模型为准。
 * @param {{model?: object}} family 库内家族
 * @param {object|null} incoming 入向模型（chat_metadata.extensions.chatfilesys）
 */
function modelSwitchesBranch(family, incoming) {
    const storedActive = family?.model?.active_branch;
    if (!incoming?.active_branch || !Array.isArray(incoming.branches)) return false;
    return incoming.active_branch !== storedActive;
}

/** 本次请求（某个聊天键）实际读写的那条走法 */
function branchFor(family, chatKey) {
    const id = branchIdForKey(family, chatKey);
    return family?.model?.branches?.find((b) => b.id === id) || null;
}

/**
 * 键绑定跟随走法切换（T1）。
 *
 * 原生分支/检查点键各自绑定一条走法；而 UI 的「切换走法」是在**当前键**上把
 * `model.active_branch` 改掉后落库的。若不同步改该键的绑定，读路径仍按键绑定解析，
 * 用户会看到「切了但内容没变」。故：某键上发生切换 → 该键重新指向新走法。
 * 无绑定的键（根键）返回 null：它本来就靠 `active_branch` 解析，不需要绑定。
 * @param {{active_branch?: string}|null} nextModel 含目标走法的形态
 * @returns {object|null} 需要落库的新 keyBindings（无需改则 null）
 */
function followKeyBinding(family, chatKey, nextModel) {
    const kb = family?.keyBindings;
    const want = nextModel?.active_branch;
    if (!kb || !chatKey || !want) return null;
    const cur = kb[chatKey];
    if (!cur || cur.branchId === want) return null;
    return { ...kb, [chatKey]: { ...cur, branchId: want } };
}

/**
 * 入向模型的 `active_branch` 归属（T1）。
 *
 * 家族只有**一个** `active_branch`，而根键没有绑定、靠它解析投影。若绑定键（原生分支/检查点）
 * 上的走法切换把它带跑，用户点「返回父聊天」回到根键时会看到**截断内容**。
 * 故：绑定键上的切换只改该键的绑定（`followKeyBinding`），家族活跃走法保持不动。
 * 根键（无绑定）不 pin —— 那里的切换就是家族级切换，语义正确。
 * @returns {object|null} 落库用模型（active_branch 已归属）
 */
function pinActiveForBoundKey(family, chatKey, incomingModel) {
    if (!incomingModel || chatKey == null) return incomingModel ?? null;
    if (!family?.keyBindings?.[chatKey]) return incomingModel;
    const stored = family?.model?.active_branch;
    if (!stored || stored === incomingModel.active_branch) return incomingModel;
    return { ...incomingModel, active_branch: stored };
}

/**
 * 聊天头增量 op 过滤（T0c 真机证据，2026-09-25 Dev 8003 `test_chat_record_fidelity` 接缝日志）。
 *
 * 宿主的 `chats/meta/patch` 是**差分**：它把「服务端快照」改造成「宿主内存副本」，于是
 * **凡是它内存副本里没有的键，都会发一条 `remove`**——实测 op 序列里出现：
 *   `test /main_chat` + `remove /main_chat`、`remove /e2e_probe_top`、
 *   `remove /extensions/third-party~1e2e_probe`，甚至 `remove /extensions/chatfilesys/branches/0/path/3`
 *   （把本插件模型里的楼层引用也删了）。
 * 触发条件：宿主快照被服务端刷新而内存副本仍是旧版（本插件的版本号乐观锁与直写都会造成这一点）。
 * 原样落库 = 抹掉别的插件写进聊天头的内容，与 R0「自定义内容不得丢」直接冲突。
 *
 * **判定信号**：一个「要删别人的内容」的批次只可能来自旧副本差分——本插件自己发起的
 * `saveMetadata()` 差分前后同源（都是内存副本），绝不会产生针对其他插件命名空间/顶层键的 remove。
 * 于是按批次定性：
 *   · 批次含**非自管路径的 remove**（= 旧副本差分）→ 删除一律不可信：`remove` 全部丢弃，
 *     自管路径的 add/replace 照常（宿主可能确实带了更新的模型，交给行表一致性兜底）
 *   · 否则（干净批次，例如本插件 `deleteFloor` 走法重编号）→ 原样应用，含自管路径的 remove
 * 另外两条与批次无关的固定规则：
 *   · 指向 `/integrity` 的 op 一律丢弃（版本号真源在库，宿主那份只是镜像）
 *   · `replace`/`add` 到 `/extensions` 整对象 → 降级为**逐命名空间合并**（不整体替换别人）
 *
 * @param {Array} ops 入向 ops
 * @param {object} composedCurrent 库内合成后的完整 chat_metadata（供合并规则用）
 * @returns {{ops: Array, dropped: string[], staleCopy: boolean}} 过滤结果 + 丢弃说明 + 是否旧副本差分
 */
function filterMetaOps(ops, composedCurrent) {
    const list = (Array.isArray(ops) ? ops : []).filter((o) => o && typeof o === 'object');
    const pathOf = (o) => String(o.path ?? '');
    const kindOf = (o) => String(o.op || '').toLowerCase();
    const isOwn = (p) => p === `/extensions/${OWN_EXTENSION_KEY}` || p.startsWith(`/extensions/${OWN_EXTENSION_KEY}/`);
    // 旧副本差分信号：有 op 要删「非自管路径」（别人的命名空间/宿主字段）
    const staleCopy = list.some((o) => kindOf(o) === 'remove' && !isOwn(pathOf(o)) && pathOf(o) !== '/integrity');

    const out = [];
    const dropped = [];
    for (const op of list) {
        const kind = kindOf(op);
        const path = pathOf(op);
        if (path === '/integrity' || path.startsWith('/integrity/')) {
            dropped.push(`${kind} ${path}（版本号真源在库）`);
            continue;
        }
        if (kind === 'remove' && (staleCopy || !isOwn(path))) {
            dropped.push(`remove ${path}（${staleCopy ? '旧副本差分' : '宿主对第三方内容的删除'}）`);
            continue;
        }
        if ((kind === 'replace' || kind === 'add') && path === '/extensions') {
            const merged = { ...(composedCurrent.extensions || {}), ...(op.value && typeof op.value === 'object' ? op.value : {}) };
            out.push({ ...op, value: merged });
            continue;
        }
        out.push(op);
    }
    return { ops: out, dropped, staleCopy };
}

/**
 * 把新写入的楼层并入**本次请求所在走法的 path**（T0 实测暴露的必要条件）。
 *
 * 读路径按「该走法 path 引用的行」做投影过滤——若写入时只落行、不落 path，
 * 这些行就会被当成「其他走法的折叠行」而**读不回来**（消息写进库却像丢了）。
 * 因此任何追加/全量写都要同步扩展 path。
 *
 * @param {import('./storage/adapter.js').StorageAdapterAPI} adapter
 * @param {{model?: object}} family
 * @param {object} branch 目标走法（按键绑定解析出的那条）
 * @param {Array<{floorNo: number, variantId: string}>} floors
 * @param {Function} log
 */
async function ensurePathCovers(adapter, family, branch, floors, log) {
    if (!branch) return;
    let changed = false;
    for (const f of floors) {
        if (branch.path[f.floorNo] !== f.variantId) {
            branch.path[f.floorNo] = f.variantId;
            changed = true;
        }
    }
    if (!changed) return;
    const r = await adapter.saveModel({ familyId: family.familyId, model: family.model, expectedIntegrity: null, keepCurrent: false });
    if (r && r.ok === false) log('[chatfilesys-seam] 走法路径扩展落库失败（读回可能缺行）:', r.reason);
}

/**
 * 安装 fetch 拦截接缝。
 * @param {import('./storage/adapter.js').StorageAdapterAPI} adapter 三档存储适配器（duck-typed）
 * @param {{pageSize?: number, log?: Function}} [opts]
 * @returns {{dispose: Function}} dispose 恢复原始 fetch
 */
export function installSeam(adapter, opts = {}) {
    const pageSize = opts.pageSize ?? 200;
    const log = opts.log ?? console.warn;
    const originalFetch = globalThis.fetch;

    /**
     * 未命中家族 → 尝试接管原生「创建分支 / 创建检查点」（T1/R2.1，裁定 N22）。
     *
     * 判定链（三重，任一不满足即透传，宁可不接管）：
     *   ① 父线索：请求头 `chat_metadata.main_chat`（宿主创建分支/检查点时写入）→ 父键能命中家族
     *   ② 内容闸门：正文行序列必须是父走法当前投影的**逐行前缀**
     *   ③ 类型：分支名宿主自动生成不可改 → 命中 ` - Branch #<n>` 即分支，其余即检查点
     * 全部通过 → 在父家族内建一条走法 + 键绑定，落库后回成功（**磁盘不产生复制文件**）。
     * @returns {Response|null} null = 未接管，调用方透传原生路径（行为与改造前一致）
     */
    async function tryTakeoverNewKey({ chatKey, fileName, avatarUrl, rows, incomingMeta }) {
        const hostMain = incomingMeta?.main_chat;
        if (!hostMain || !rows.length) return null;
        const parentKey = normalizeChatKey(avatarUrl, hostMain);
        const parent = await adapter.loadFamily({ chatKey: parentKey });
        if (!parent) return null;
        const parentBranchId = branchIdForKey(parent, parentKey);
        const parentPath = parent.model?.branches?.find((b) => b.id === parentBranchId)?.path || {};
        // 只需覆盖前 rows.length 层的行（含同层的其他变体行，故多取一页）
        const { floors } = await adapter.loadFloors({ familyId: parent.familyId, from: 0, limit: rows.length + pageSize });
        const parentContents = floors
            .filter((f) => parentPath[f.floorNo] === f.variantId)
            .map((f) => f.content);
        const plan = planTakeover({
            kind: classifyNewChat(fileName),
            rows,
            parentContents,
            parentModel: parent.model,
            parentBranchId,
            parentKey,
            newKey: chatKey,
            fileName,
            mainChat: hostMain,
            parentBindings: parent.keyBindings,
        });
        if (!plan.ok) {
            log(`[chatfilesys-seam] 疑似原生分支/检查点「${fileName}」未接管（${plan.reason}），透传原生路径`);
            return null;
        }
        const r = await adapter.saveModel({
            familyId: parent.familyId,
            model: plan.model,
            keyBindings: plan.keyBindings,
            expectedIntegrity: null, // 建键不是对已有内容的写，不走乐观锁
        });
        if (!r || r.ok === false) {
            log('[chatfilesys-seam] 原生分支/检查点接管落库失败，透传原生路径:', r?.reason);
            return null;
        }
        log(`[chatfilesys-seam] 已接管原生${plan.kind === 'branch' ? '分支' : '检查点'}「${fileName}」→ 库内走法 ${plan.branchId}（第 ${plan.forkFloor} 层分叉，磁盘不落文件）`);
        return jsonResponse({ ok: true, integrity: normIntegrity(r.integrity) });
    }

    /** 读路径：chats/get → 库分片读 → 本次键所在走法投影 → [header, ...rows] */
    async function handleGet(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null; // 未接管：透传原生路径
        // T1：投影走法按键绑定解析（原生分支/检查点键各自代表一条走法；无绑定回落活跃走法）
        const branch = branchFor(family, chatKey) || family.model?.branches?.[0];
        const activePath = branch?.path || null;
        const { floors } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: pageSize });
        // 投影过滤：body = 该走法 path 引用的行（导入合并/分叉产生的非本走法变体行不进 body）
        const rows = (activePath
            ? floors.filter((f) => activePath[f.floorNo] === f.variantId)
            : floors
        ).map((f) => JSON.parse(f.content));
        const header = {
            user_name: 'unused',
            character_name: 'unused',
            // 聊天头**整份回显**（T0/R0）：宿主与其他插件写进去的内容一律不得丢失；
            // 本插件两项（integrity 与 extensions.chatfilesys）覆盖在各自位置。
            chat_metadata: composeChatMetadata(family, chatKey),
        };
        return jsonResponse([header, ...rows]);
    }

    /** 写路径：chats/save → 全量 upsert 库分片（未命中家族时先试接管原生分支/检查点） */
    async function handleSave(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        // 宿主 save 请求体 chat = [header, ...messages]（script.js saveChatInternal 真机事实）：
        // 首行是 {user_name, character_name, chat_metadata} 无 mes——剥掉，防 header 污染楼层
        const allRows = Array.isArray(body?.chat) ? body.chat : [];
        const isHeaderRow = (r) => r && typeof r === 'object' && !('mes' in r) && ('chat_metadata' in r || 'user_name' in r);
        const hasHeader = allRows.length > 0 && isHeaderRow(allRows[0]);
        const rows = hasHeader ? allRows.slice(1) : allRows;
        const incomingMeta = hasHeader ? allRows[0]?.chat_metadata ?? null : null;

        const family = await adapter.loadFamily({ chatKey });
        if (!family) {
            // T1：原生「创建分支/创建检查点」= 宿主往一个新键全量写 → 在此拦下改为库内走法
            return await tryTakeoverNewKey({
                chatKey, fileName: body?.file_name, avatarUrl: body?.avatar_url, rows, incomingMeta,
            });
        }
        // 聊天头整份并入（T0/R0）：宿主与其他插件写进去的命名空间、main_chat、变量……一律落库，
        // 只有本插件两项例外——extensions.chatfilesys 走模型通道，integrity 由库自管。
        const { hostMetadata: incomingHost, model: incomingModel } = splitChatMetadata(incomingMeta);
        const mergedHost = mergeHostMetadata(family.hostMetadata, stripKeyOwnedMeta(family, chatKey, incomingHost));
        const hostChanged = JSON.stringify(mergedHost) !== JSON.stringify(family.hostMetadata || {});
        const pinned = pinActiveForBoundKey(family, chatKey, incomingModel);
        const modelChanged = Boolean(pinned) && JSON.stringify(pinned) !== JSON.stringify(family.model);
        const nextBindings = followKeyBinding(family, chatKey, incomingModel);
        if (hostChanged || modelChanged || nextBindings) {
            const rMeta = await adapter.saveModel({
                familyId: family.familyId,
                model: modelChanged ? pinned : family.model,
                hostMetadata: hostChanged ? mergedHost : undefined,
                keyBindings: nextBindings || undefined,
                expectedIntegrity: null,
                keepCurrent: !modelChanged, // 模型没变则不重建结构表，只写聊天头/键绑定
            });
            if (rMeta && rMeta.ok === false) log('[chatfilesys-seam] 聊天头落库失败:', rMeta.reason);
            if (modelChanged) family.model = pinned;
            if (hostChanged) family.hostMetadata = mergedHost;
            if (nextBindings) family.keyBindings = nextBindings;
        }
        // 全量保存 = body 数组逐行 upsert（floorNo = 行序 +1；变体身份取自本次键所在走法的 path）
        const branch = branchFor(family, chatKey);
        const floors = rows.map((row, i) => ({
            floorNo: i + 1,
            variantId: branch?.path?.[i + 1] || `g${i + 1}`,
            seq: 0,
            content: JSON.stringify(row),
            contentHash: null, // save 路径不做合并判定，hash 留空由适配器按需补
            sendDate: row?.send_date ?? null,
        }));
        await ensurePathCovers(adapter, family, branch, floors, log); // 新楼层必须进 path，否则读回被投影过滤丢掉
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: expectedIntegrityOf(body) });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, integrity: normIntegrity(r.integrity) });
    }

    /** 写路径：chats/append → 新楼层追加入库（T0c：请求体带的聊天头一并并入） */
    async function handleAppend(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        // T0c：宿主 append 请求体同样带整份 chat_metadata（真机探针证实）——
        // 其他插件命名空间跟着这条写进来时必须落地，否则「写命名空间 + 发消息」这一步会丢。
        // 模型不动：结构由本插件（UI）与 ensurePathCovers 维护，宿主副本可能是旧版。
        const { hostMetadata: incomingHost } = splitChatMetadata(body?.chat_metadata);
        const mergedHost = mergeHostMetadata(family.hostMetadata, stripKeyOwnedMeta(family, chatKey, incomingHost));
        const hostChanged = JSON.stringify(mergedHost) !== JSON.stringify(family.hostMetadata || {});
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const branch = branchFor(family, chatKey);
        const activePath = branch?.path || {};
        const base = Math.max(0, ...Object.keys(activePath).map(Number), 0);
        const floors = messages.map((row, i) => ({
            floorNo: base + i + 1,
            variantId: activePath[base + i + 1] || `g${base + i + 1}`,
            seq: 0,
            content: JSON.stringify(row),
            contentHash: null,
            sendDate: row?.send_date ?? null,
        }));
        await ensurePathCovers(adapter, family, branch, floors, log); // 新楼层必须进 path，否则读回被投影过滤丢掉
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: expectedIntegrityOf(body) });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        let integrity = r.integrity;
        if (hostChanged) {
            const rMeta = await adapter.saveModel({
                familyId: family.familyId, model: undefined, hostMetadata: mergedHost,
                expectedIntegrity: null, keepCurrent: true,
            });
            if (rMeta?.integrity != null) integrity = rMeta.integrity;
        }
        return jsonResponse({ ok: true, appended: messages.length, created: false, integrity: normIntegrity(integrity) });
    }

    /**
     * 写路径：chats/patch → 消息补丁**真正应用**（T0b）+ 同车元数据并入（T0c）。
     *
     * 真机事实（2026-09-25 探针 tests/e2e/probe_patch_ops.py，Dev 8003）：
     * - 宿主编辑消息 / swipe → `test /N` + `replace /N`（整行）
     * - 第三方插件改内存字段后保存 → `add /0/extra/第三方~1键`（**字段级**，深路径）
     * - 删消息 → `test /N` + `remove /N`
     * - 请求体**同时带整份 chat_metadata**（宿主内存副本）→ 其中的走法切换与其他插件命名空间
     *   必须与消息写入一起落地，否则「挂在这条写上的元数据变化」静默丢失（T0c 的时有时无）。
     *
     * ops 打在「按活跃走法投影出来的 body 数组」上，库存的是含非活跃变体的行表——
     * 投影 → 应用 → 按键写回由 `core/patch-rows.js` 统一完成（三档共用同一实现）。
     */
    async function handlePatch(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const { hostMetadata: incomingHost, model: incomingModel } = splitChatMetadata(body?.chat_metadata);
        const mergedHost = mergeHostMetadata(family.hostMetadata, incomingHost);
        const hostChanged = JSON.stringify(mergedHost) !== JSON.stringify(family.hostMetadata || {});
        // 入向模型只在「走法切换」时决定结构：宿主内存副本可能是旧版，
        // 让旧副本盖掉本插件的结构更新会丢新走法（非切换时以库内模型为准）
        const switchTarget = modelSwitchesBranch(family, incomingModel) ? incomingModel.active_branch : null;
        const adoptModel = switchTarget ? pinActiveForBoundKey(family, chatKey, incomingModel) : undefined;
        const nextBindings = switchTarget ? followKeyBinding(family, chatKey, { active_branch: switchTarget }) : null;
        const r = await adapter.applyOps({
            familyId: family.familyId,
            ops: Array.isArray(body?.operations) ? body.operations : [],
            model: adoptModel,
            // 投影基准（T1）：切换时 = 目标走法（宿主 ops 是按它的 body 算的）；
            // 否则 = 本次键所在走法（原生分支/检查点键各有各的 body）
            branchId: switchTarget ?? branchIdForKey(family, chatKey),
            hostMetadata: hostChanged ? mergedHost : undefined,
            keyBindings: nextBindings || undefined,
            expectedIntegrity: expectedIntegrityOf(body),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        if (r && r.ok === false) {
            // test 不通过 = 库内容与宿主的假设不一致 → 409 走宿主自己的冲突重放；
            // 其余形态（中间插入、非法路径）→ 400，宿主按失败路径回退全量保存
            const conflict = r.reason === 'test-failed';
            log(`[chatfilesys-seam] chats/patch 未应用：${r.reason}${r.detail ? '｜' + r.detail : ''}`);
            return jsonResponse({ ok: false, reason: r.reason, detail: r.detail || null }, conflict ? 409 : 400);
        }
        return jsonResponse({
            ok: true,
            applied: (body?.operations || []).length,
            total_messages: r.totalMessages ?? 0,
            integrity: normIntegrity(r.integrity),
        });
    }

    /** 写路径：chats/rename → 家族重命名（隐藏容器模式下等价改名） */
    async function handleRename(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.original_file);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        await adapter.renameFamily({ familyId: family.familyId, newName: String(body?.renamed_file || '') });
        return jsonResponse({ ok: true, sanitizedFileName: body?.renamed_file });
    }

    /** 写路径：chats/delete → 家族删除（jsonl 原文件由 UI 层先经回收站，seam 不删源） */
    async function handleDelete(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.chatfile);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const r = await adapter.deleteFamily({ familyId: family.familyId });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true });
    }

    /** 写路径：chats/meta → 家族模型 + 聊天头整份更新（现有 UI setModel→saveMetadata 的落点） */
    async function handleMeta(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        // T0/R0：消息头整份并入（其他插件命名空间、main_chat、变量……），本插件两项走各自通道
        const { hostMetadata: incomingHost, model } = splitChatMetadata(body?.chat_metadata);
        const mergedHost = mergeHostMetadata(family.hostMetadata, stripKeyOwnedMeta(family, chatKey, incomingHost));
        const r = await adapter.saveModel({
            familyId: family.familyId,
            model: pinActiveForBoundKey(family, chatKey, model),
            hostMetadata: mergedHost,
            keyBindings: followKeyBinding(family, chatKey, model) || undefined,
            expectedIntegrity: expectedIntegrityOf(body),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        family.hostMetadata = mergedHost;
        return jsonResponse({ ok: true, updated: true, total_messages: 0, created: false, integrity: normIntegrity(r.integrity) });
    }

    /**
     * 写路径：chats/meta/patch → RFC6902 增量**真正应用**。
     * T0/R0：M1 时期这里整包丢弃（只递增版本号），导致其他插件写入的元数据不生效——本函数是修复点。
     * 应用对象 = 整份 chat_metadata（合成 → 应用 → 拆回三份），故指向任一插件命名空间的 op 都能生效。
     */
    async function handleMetaPatch(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const rawOps = Array.isArray(body?.operations) ? body.operations : [];
        const composed = composeChatMetadata(family, chatKey);
        const { ops, dropped } = filterMetaOps(rawOps, composed);
        if (dropped.length) {
            log(`[chatfilesys-seam] chats/meta/patch 丢弃 ${dropped.length} 条删除/自管项 op（避免宿主旧副本抹掉内容）：${dropped.join('、')}`);
        }
        let next;
        try {
            // 深拷贝后应用：composeChatMetadata 是浅拷贝，嵌套对象仍与 family 共享引用，必须隔离
            next = applyOpsToObject(JSON.parse(JSON.stringify(composed)), ops);
        } catch (e) {
            log(`[chatfilesys-seam] chats/meta/patch 应用失败（未写入，避免静默丢内容）：${String(e?.message || e)}`);
            return jsonResponse({ ok: false, reason: 'patch-apply-failed', detail: String(e?.message || e) }, 400);
        }
        const { hostMetadata: nextHostRaw, model: nextModel } = splitChatMetadata(next);
        const nextHost = stripKeyOwnedMeta(family, chatKey, nextHostRaw);
        const r = await adapter.saveModel({
            familyId: family.familyId,
            model: pinActiveForBoundKey(family, chatKey, nextModel),
            hostMetadata: nextHost,
            keyBindings: followKeyBinding(family, chatKey, nextModel) || undefined,
            expectedIntegrity: expectedIntegrityOf(body),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        family.hostMetadata = nextHost;
        family.model = nextModel;
        return jsonResponse({ ok: true, applied: ops.length, integrity: normIntegrity(r.integrity) });
    }

    /** 读路径：chats/get-delta → 库分片读的区间响应（原生分页读兼容） */
    async function handleGetDelta(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const from = Number(body?.from_index ?? 0);
        const limit = Number(body?.limit ?? 100);
        const { floors, hasMore } = await adapter.loadFloors({ familyId: family.familyId, from, limit });
        return jsonResponse({
            chat: floors.map((f) => JSON.parse(f.content)),
            chat_metadata: composeChatMetadata(family, chatKey), // T0/R0：整份回显，不只本插件模型
            from_index: from,
            next_index: from + floors.length,
            total_messages: Object.keys(family.branchPaths?.[Object.keys(family.branchPaths)[0]] || {}).length,
            has_more: Boolean(hasMore),
        });
    }

    const handlers = {
        'chats/get': handleGet, 'chats/save': handleSave, 'chats/append': handleAppend,
        'chats/patch': handlePatch, 'chats/rename': handleRename, 'chats/delete': handleDelete,
        'chats/meta': handleMeta, 'chats/meta/patch': handleMetaPatch, 'chats/get-delta': handleGetDelta,
    };

    async function interceptingFetch(input, init) {
        let route = null;
        let url = null;
        try {
            url = urlOf(input);
            const pathname = url?.pathname || '';
            route = ROUTES.find((r) => pathname.endsWith('/api/' + r) || pathname === '/' + r || pathname.endsWith(r));
        } catch {
            route = null;
        }
        if (!route) return originalFetch(input, init); // 非聊天请求：原样透传

        try {
            const body = await bodyOf(input, init);
            const handler = handlers[route];
            const response = await handler(body);
            if (response) return response;
            return originalFetch(input, init); // 未接管聊天：透传
        } catch (e) {
            log(`[chatfilesys-seam] ${route} 拦截处理失败，已透传原生请求:`, e);
            return originalFetch(input, init);
        }
    }

    try {
        globalThis.fetch = interceptingFetch;
    } catch (e) {
        log('[chatfilesys-seam] 安装失败，宿主保持原生行为:', e);
        return { dispose: () => {} };
    }

    return {
        dispose() {
            if (globalThis.fetch === interceptingFetch) globalThis.fetch = originalFetch;
        },
        /** 原生 fetch 通道（绕开拦截）：导入旅程读源 jsonl / 删源文件必须走这里 */
        native(input, init) {
            return originalFetch(input, init);
        },
    };
}
