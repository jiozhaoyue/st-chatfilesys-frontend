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
 * integrity 形态桥接：库内数字计数器 ⇄ 宿主字符串 slug。
 * 真机事实（2026-09-24 Dev Luker script.js）：宿主 chat_metadata.integrity 是字符串
 * （无则自造 uuid 且 applyIntegrityFromWritePayload 只认非空字符串——数字被静默丢弃，
 * 宿主锁值永不前进）；get 响应 header 不带 integrity 时宿主 saveChatInternal 以
 * 「chat not fully loaded」拒绝保存。边界统一转 slug，库内保持数字。
 */
function toHostIntegrity(n) {
    return `cfsys:${n}`;
}

/**
 * 宿主发来的 integrity（slug / 纯数字 / 宿主自造 uuid / 空）→ 库乐观锁值。
 * 非 cfsys 形态的 uuid 说明宿主未从库拿到过 slug（混合状态）→ null 放行不锁。
 * @returns {number|null}
 */
function parseHostIntegrity(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string' || !v.trim()) return null;
    const m = /^cfsys:(\d+)$/.exec(v.trim());
    if (m) return Number(m[1]);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
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
 * @param {{hostMetadata?: object, model?: object, integrity?: any}} family
 */
function composeChatMetadata(family) {
    const host = family?.hostMetadata && typeof family.hostMetadata === 'object' ? family.hostMetadata : {};
    const extensions = { ...(host.extensions || {}), [OWN_EXTENSION_KEY]: family?.model ?? null };
    return { ...host, integrity: toHostIntegrity(family?.integrity), extensions };
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
 * 删除命名空间的唯一路径是 `chats/meta/patch` 的 remove op（那条路径不经本函数）。
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
 * 把新写入的楼层并入**当前走法的 path**（T0 实测暴露的必要条件）。
 *
 * 读路径按「活跃分支 path 引用的行」做投影过滤——若写入时只落行、不落 path，
 * 这些行就会被当成「其他分支的折叠行」而**读不回来**（消息写进库却像丢了）。
 * 因此任何追加/全量写都要同步扩展 path。
 *
 * @param {import('./storage/adapter.js').StorageAdapterAPI} adapter
 * @param {{model?: {active_branch?: string, branches?: Array<{id: string, path: object}>}}} family
 * @param {Array<{floorNo: number, variantId: string}>} floors
 * @param {Function} log
 */
async function ensurePathCovers(adapter, family, floors, log) {
    const active = family?.model?.branches?.find((b) => b.id === family.model.active_branch);
    if (!active) return;
    let changed = false;
    for (const f of floors) {
        if (active.path[f.floorNo] !== f.variantId) {
            active.path[f.floorNo] = f.variantId;
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

    /** 读路径：chats/get → 库分片读 → 活跃分支投影 → [header, ...rows] */
    async function handleGet(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null; // 未接管：透传原生路径
        const active = family.model?.branches?.find((b) => b.id === family.model?.active_branch)
            || family.model?.branches?.[0];
        const activePath = active?.path || null;
        const { floors } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: pageSize });
        // 投影过滤：body = 活跃分支 path 引用的行（导入合并/分叉产生的非活跃变体行不进 body）
        const rows = (activePath
            ? floors.filter((f) => activePath[f.floorNo] === f.variantId)
            : floors
        ).map((f) => JSON.parse(f.content));
        const header = {
            user_name: 'unused',
            character_name: 'unused',
            // 聊天头**整份回显**（T0/R0）：宿主与其他插件写进去的内容一律不得丢失；
            // 本插件两项（integrity 与 extensions.chatfilesys）覆盖在各自位置。
            chat_metadata: composeChatMetadata(family),
        };
        return jsonResponse([header, ...rows]);
    }

    /** 写路径：chats/save → 全量 upsert 库分片 */
    async function handleSave(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        // 宿主 save 请求体 chat = [header, ...messages]（script.js saveChatInternal 真机事实）：
        // 首行是 {user_name, character_name, chat_metadata} 无 mes——剥掉，防 header 污染楼层
        const allRows = Array.isArray(body?.chat) ? body.chat : [];
        const isHeaderRow = (r) => r && typeof r === 'object' && !('mes' in r) && ('chat_metadata' in r || 'user_name' in r);
        const hasHeader = allRows.length > 0 && isHeaderRow(allRows[0]);
        const rows = hasHeader ? allRows.slice(1) : allRows;
        // 聊天头整份并入（T0/R0）：宿主与其他插件写进去的命名空间、main_chat、变量……一律落库，
        // 只有本插件两项例外——extensions.chatfilesys 走模型通道，integrity 由库自管。
        const incomingMeta = hasHeader ? allRows[0]?.chat_metadata ?? null : null;
        const { hostMetadata: incomingHost, model: incomingModel } = splitChatMetadata(incomingMeta);
        const mergedHost = mergeHostMetadata(family.hostMetadata, incomingHost);
        const hostChanged = JSON.stringify(mergedHost) !== JSON.stringify(family.hostMetadata || {});
        const modelChanged = Boolean(incomingModel) && JSON.stringify(incomingModel) !== JSON.stringify(family.model);
        if (hostChanged || modelChanged) {
            const rMeta = await adapter.saveModel({
                familyId: family.familyId,
                model: modelChanged ? incomingModel : family.model,
                hostMetadata: hostChanged ? mergedHost : undefined,
                expectedIntegrity: null,
                keepCurrent: !modelChanged, // 模型没变则不重建结构表，只写聊天头
            });
            if (rMeta && rMeta.ok === false) log('[chatfilesys-seam] 聊天头落库失败:', rMeta.reason);
            if (modelChanged) family.model = incomingModel;
            if (hostChanged) family.hostMetadata = mergedHost;
        }
        // 全量保存 = body 数组逐行 upsert（floorNo = 行序 +1；family.model 内含活跃分支路径）
        const floors = rows.map((row, i) => ({
            floorNo: i + 1,
            variantId: family.model.branches.find((b) => b.id === family.model.active_branch)?.path?.[i + 1] || `g${i + 1}`,
            seq: 0,
            content: JSON.stringify(row),
            contentHash: null, // save 路径不做合并判定，hash 留空由适配器按需补
            sendDate: row?.send_date ?? null,
        }));
        await ensurePathCovers(adapter, family, floors, log); // 新楼层必须进 path，否则读回被投影过滤丢掉
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: parseHostIntegrity(body?.integrity) });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, integrity: toHostIntegrity(r.integrity) });
    }

    /** 写路径：chats/append → 新楼层追加入库 */    async function handleAppend(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const activePath = family.model.branches.find((b) => b.id === family.model.active_branch)?.path || {};
        const base = Math.max(0, ...Object.keys(activePath).map(Number), 0);
        const floors = messages.map((row, i) => ({
            floorNo: base + i + 1,
            variantId: activePath[base + i + 1] || `g${base + i + 1}`,
            seq: 0,
            content: JSON.stringify(row),
            contentHash: null,
            sendDate: row?.send_date ?? null,
        }));
        await ensurePathCovers(adapter, family, floors, log); // 新楼层必须进 path，否则读回被投影过滤丢掉
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: parseHostIntegrity(body?.integrity) });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, appended: messages.length, created: false, integrity: toHostIntegrity(r.integrity) });
    }

    /** 写路径：chats/patch → RFC6902 ops 库内执行 */
    async function handlePatch(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const r = await adapter.applyOps({
            familyId: family.familyId,
            ops: body?.operations || [],
            expectedIntegrity: parseHostIntegrity(body?.integrity),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, applied: (body?.operations || []).length, integrity: toHostIntegrity(r.integrity) });
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
        const mergedHost = mergeHostMetadata(family.hostMetadata, incomingHost);
        const r = await adapter.saveModel({
            familyId: family.familyId,
            model,
            hostMetadata: mergedHost,
            expectedIntegrity: parseHostIntegrity(body?.integrity),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        family.hostMetadata = mergedHost;
        return jsonResponse({ ok: true, updated: true, total_messages: 0, created: false, integrity: toHostIntegrity(r.integrity) });
    }

    /**
     * 写路径：chats/meta/patch → RFC6902 增量**真正应用**。
     * T0/R0：M1 时期这里整包丢弃（只递增版本号），导致其他插件写入的元数据不生效——本函数是修复点。
     * 应用对象 = 整份 chat_metadata（合成 → 应用 → 拆回三份），故指向本插件模型或任一插件命名空间的 op 都能生效。
     */
    async function handleMetaPatch(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const ops = Array.isArray(body?.operations) ? body.operations : [];
        let next;
        try {
            // 深拷贝后应用：composeChatMetadata 是浅拷贝，嵌套对象仍与 family 共享引用，必须隔离
            next = applyOpsToObject(JSON.parse(JSON.stringify(composeChatMetadata(family))), ops);
        } catch (e) {
            log('[chatfilesys-seam] chats/meta/patch 应用失败（未写入，避免静默丢内容）:', e);
            return jsonResponse({ ok: false, reason: 'patch-apply-failed', detail: String(e?.message || e) }, 400);
        }
        const { hostMetadata: nextHost, model: nextModel } = splitChatMetadata(next);
        const r = await adapter.saveModel({
            familyId: family.familyId,
            model: nextModel,
            hostMetadata: nextHost,
            expectedIntegrity: parseHostIntegrity(body?.integrity),
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        family.hostMetadata = nextHost;
        family.model = nextModel;
        return jsonResponse({ ok: true, applied: ops.length, integrity: toHostIntegrity(r.integrity) });
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
            chat_metadata: composeChatMetadata(family), // T0/R0：整份回显，不只本插件模型
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
