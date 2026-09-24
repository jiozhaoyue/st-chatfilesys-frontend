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

/** 拦截的路由（URL 路径尾部匹配） */
const ROUTES = ['chats/get', 'chats/save', 'chats/append', 'chats/patch', 'chats/rename', 'chats/delete'];

/**
 * 归一化宿主聊天键：avatar 与文件名小写、去首尾空白后拼接。
 * @param {string} avatarUrl
 * @param {string} fileName
 * @returns {string} chatKey
 */
export function normalizeChatKey(avatarUrl, fileName) {
    return `${String(avatarUrl || '').trim().toLowerCase()}::${String(fileName || '').trim().toLowerCase()}`;
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

    /** 读路径：chats/get → 库分片读 → [header, ...rows] */
    async function handleGet(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null; // 未接管：透传原生路径
        const { floors } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: pageSize });
        const header = {
            user_name: 'unused',
            character_name: 'unused',
            chat_metadata: {
                extensions: {
                    chatfilesys: family.model, // 现有 UI 直接消费的分支树模型（store-bridge 桥接形态）
                },
            },
        };
        const rows = floors.map((f) => JSON.parse(f.content));
        return jsonResponse([header, ...rows]);
    }

    /** 写路径：chats/save → 全量 upsert 库分片 */
    async function handleSave(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const rows = Array.isArray(body?.chat) ? body.chat : [];
        // 全量保存 = body 数组逐行 upsert（floorNo = 行序 +1；family.model 内含活跃分支路径）
        const floors = rows.map((row, i) => ({
            floorNo: i + 1,
            variantId: family.model.branches.find((b) => b.id === family.model.active_branch)?.path?.[i + 1] || `g${i + 1}`,
            seq: 0,
            content: JSON.stringify(row),
            contentHash: null, // save 路径不做合并判定，hash 留空由适配器按需补
            sendDate: row?.send_date ?? null,
        }));
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: body?.integrity });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, integrity: r.integrity });
    }

    /** 写路径：chats/append → 新楼层追加入库 */
    async function handleAppend(body) {
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
        const r = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: body?.integrity });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, appended: messages.length, created: false, integrity: r.integrity });
    }

    /** 写路径：chats/patch → RFC6902 ops 库内执行 */
    async function handlePatch(body) {
        const chatKey = normalizeChatKey(body?.avatar_url, body?.file_name);
        const family = await adapter.loadFamily({ chatKey });
        if (!family) return null;
        const r = await adapter.applyOps({
            familyId: family.familyId,
            ops: body?.operations || [],
            expectedIntegrity: body?.integrity,
        });
        if (r?.conflict) return jsonResponse({ ok: false, conflict: true }, 409);
        return jsonResponse({ ok: true, applied: (body?.operations || []).length, integrity: r.integrity });
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

    const handlers = { 'chats/get': handleGet, 'chats/save': handleSave, 'chats/append': handleAppend,
        'chats/patch': handlePatch, 'chats/rename': handleRename, 'chats/delete': handleDelete };

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
    };
}
