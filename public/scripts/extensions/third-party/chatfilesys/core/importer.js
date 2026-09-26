/**
 * ChatFilesys — 导入旅程（design.md §6 导入流程，R3/AC4）
 *
 * 职责：存量 jsonl → 库家族的编排层（纯函数 + 可注入依赖）：
 * - planImport：纯函数——候选列表 + 库内既有家族 → 导入计划（首文件建家族、后续文件合并）
 * - runImport：执行——逐文件读源（native fetch）→ prepareRows 指纹 → alignMerge LCP →
 *   分块 saveFloors（500/批）→ 快照回收站 → 删源（native fetch）；每文件回报进度
 *
 * 契约（N2 用户旅程）：
 * - 检测阶段不读全文（search 端点列表 + 文件名过滤）；执行阶段才逐文件读
 * - 删除源前必须先 moveToTrash 成功（trash.js snapshotAndMove 同语义：先快照后移除）
 * - 全程失败安全：任一文件失败 → 记入 failed，不阻断其余文件（结果弹窗统一汇报）
 */

import { prepareRows, alignMerge, computeHash } from './merge.js';
import { storeFromModel } from './store-bridge.js';
import { enableForChat } from './branches.js';
import { normalizeChatKey } from './seam.js';
import { hostMetadataOfHeader, mergeHostMetadata, stripKeyOwnedMeta } from './chat-meta.js';

/** 隐容器前缀：这些文件是本插件的库存储，绝不能当存量 jsonl 导入 */
const HIDDEN_PREFIX = '__cfsys__';

/**
 * 纯函数：候选聊天列表 → 导入计划。
 * @param {Array<{file_name: string}>} candidates search 端点返回的聊天列表
 * @param {{currentFileName?: string, only?: string|string[]|null, includeCurrent?: boolean}} opts
 *        `currentFileName` = 当前打开的聊天（默认排除：它正被宿主使用，全量导入不该动它）；
 *        `only` 非空 = 只导入指定的这几个文件名（弹窗「角色卡的聊天 → 转数据库」按行触发）；
 *        `includeCurrent` = **连当前打开的聊天一起导入**（T8 入库提醒弹窗的「纯库」/「双写」按钮：
 *        用户要转的就是眼前这个聊天）。只在 `only` 明确点到它时才有意义——默认全量导入仍然排除当前聊天。
 * @returns {{candidates: Array<{fileName: string}>, skipped: {hidden: string[], current: string[]}}}
 */
export function planImport(candidates, opts = {}) {
    const hidden = [];
    const current = [];
    const list = [];
    const cur = String(opts.currentFileName || '').replace(/\.jsonl$/i, '');
    const only = opts.only == null
        ? null
        : new Set((Array.isArray(opts.only) ? opts.only : [opts.only])
            .map((x) => String(x || '').replace(/\.jsonl$/i, ''))
            .filter(Boolean));
    for (const c of candidates || []) {
        const name = String(c?.file_name || '').replace(/\.jsonl$/i, '');
        if (!name) continue;
        if (name.startsWith(HIDDEN_PREFIX) || name.includes(HIDDEN_PREFIX)) { hidden.push(name); continue; }
        if (only && !only.has(name)) continue;
        if (cur && name === cur && !opts.includeCurrent) { current.push(name); continue; }
        list.push({ fileName: name });
    }
    return { candidates: list, skipped: { hidden, current } };
}

/**
 * 纯函数：单个 jsonl 文件内容 → 首次建档的 family + 首批楼层行。
 *
 * W5（2026-09-26）：`hostMetadata` = 源 jsonl 首行 header 里的**聊天头保留面**
 * （其他插件写进 chat_metadata 的命名空间、`main_chat` 线索……）。冷导入（导入一个当前
 * 没打开的聊天）时，宿主内存里的那份 metadata 帮不上忙，源文件就是唯一来源——
 * 不带上它，别的插件的内容与父线索就永远进不了库。
 *
 * @param {string[]} lines [header, ...消息行字符串]
 * @param {{familyId, chatKey, characterId, name}} identity
 * @param {object|null} [hostMetadata] 源 header 的保留面（`hostMetadataOfHeader` 产物）
 * @returns {Promise<{family, floors, stats}>} family = storeFromModel 产物；floors = 楼层行
 */
export async function buildFamilyFromJsonl(lines, identity, hostMetadata = null) {
    const { rows, stats } = await prepareRows(lines);
    const model = enableForChat(rows.map((r) => r.row)); // 主分支 = 全部楼层
    const family = storeFromModel(model, identity) // 版本号由 store-bridge 生成（T1/N19 字符串形态）;
    if (hostMetadata && Object.keys(hostMetadata).length) family.hostMetadata = hostMetadata;
    const floors = rows.map((r) => ({
        floorNo: r.floorNo,
        variantId: `g${r.floorNo}`,
        seq: 0,
        content: JSON.stringify(r.row),
        contentHash: r.hash,
        sendDate: r.sendDate,
    }));
    return { family, floors, stats };
}

/**
 * 纯函数：后续 jsonl → 对既有家族的合并增量。
 * 与 buildFamilyFromJsonl 同源（都是 prepareRows+alignMerge 的编排），合并语义见 merge.js。
 * @param {Array<{hash, sendDate?, sender?}>} existingRows 库内既有楼层（带 hash）
 * @param {string[]} lines 导入文件行
 * @returns {Promise<{floors, stats, forkFloor}>} floors = 需追加的行（旁挂变体，floorNo=null 由调用方分配）
 */
export async function mergeIntoFamily(existingRows, lines) {
    const { rows } = await prepareRows(lines);
    const { ops, stats, forkFloor } = await alignMerge(existingRows, rows);
    const floors = ops.map((op) => ({
        floorNo: null,
        variantId: op.variantId,
        seq: 0,
        content: JSON.stringify(op.content),
        contentHash: op.hash,
        sendDate: op.content?.send_date ?? null,
    }));
    return { floors, stats, forkFloor };
}

/**
 * 旁挂变体行 → 真实楼层号分配（导入合并用）。
 * 合并分叉挂在 forkFloor 之后：新行 floorNo = forkFloor+k+1，variantId 保留 merge 的 m 序号，
 * 并在模型上登记子分支（path 引用这些变体）。
 * @param {object} model 现有 chatfilesys 模型（就地修改）
 * @param {Array<{variantId, content, contentHash, sendDate}>} mergeFloors mergeIntoFamily 产物
 * @param {number} forkFloor
 * @param {string} branchName 新子分支名（默认用源文件名）
 * @returns {{floors: Array, branchId: string}} 已分配 floorNo 的行 + 新分支 id
 */
export function attachMergedFork(model, mergeFloors, forkFloor, branchName) {
    if (!mergeFloors?.length) return { floors: [], branchId: null };
    const forkBase = Number(forkFloor) || 0;
    // 找 forkFloor 处的宿主分支（模型上楼层号 forkFloor 的拥有者 = 默认分支前缀）
    const host = model.branches.find((b) => Object.hasOwn(b.path, forkFloor))
        || model.branches.find((b) => b.is_default)
        || model.branches[0];
    const hostMax = Math.max(0, ...Object.keys(host.path).map(Number));
    if (forkFloor > hostMax) {
        throw new Error(`attachMergedFork: 分叉层 ${forkFloor} 超出宿主分支范围 1..${hostMax}`);
    }
    // 分配楼层号：从 forkFloor+1 起（同层多变体：merge 的 m 序号即变体）
    const assigned = mergeFloors.map((f, k) => ({
        ...f,
        floorNo: forkBase + k + 1,
    }));
    // 新分支：path = 宿主前缀 [1..forkFloor] + 新变体段
    const forkBranch = {
        id: nextBranchIdOf(model),
        name: String(branchName || `合并·F${forkBase}`),
        is_default: false,
        fork_base: forkBase,
        path: {},
    };
    for (let f = 1; f <= forkBase; f++) forkBranch.path[f] = host.path[f];
    assigned.forEach((f, k) => { forkBranch.path[f.floorNo] = mergeFloors[k].variantId; });
    model.branches.push(forkBranch);
    return { floors: assigned, branchId: forkBranch.id };
}

/** 模型上下一个分支 id（b<max+1>，与 branches.js nextBranchId 同规则） */
function nextBranchIdOf(model) {
    let max = 0;
    for (const b of model.branches || []) {
        const m = /^b(\d+)$/.exec(b.id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return 'b' + (max + 1);
}

/**
 * 执行导入（编排层；依赖全注入，可单测）。
 * @param {{
 *   adapter: object,
 *   trash: {snapshotAndMove: Function},
 *   api: {searchChats: Function, readChatFile: Function, deleteChatFile: Function},
 *   confirm: Function, progress: Function,
 * }} deps
 * @param {{currentFileName?: string, deleteSources: boolean, only?: string|string[]|null,
 *          includeCurrent?: boolean}} opts
 * @returns {Promise<{totalFiles, importedFiles, totalMerged, failed: Array, families: Array}>}
 */
export async function runImport(deps, opts = {}) {
    const { adapter, trash, api, confirm, progress = () => {} } = deps;
    const results = { totalFiles: 0, importedFiles: 0, totalMerged: 0, failed: [], families: [] };

    // ① 检测：枚举候选（native fetch，绕开 seam 拦截）；opts.only 限定到指定文件；
    //    opts.includeCurrent = 连当前打开的聊天一起导入（T8 提醒弹窗的「纯库」/「双写」按钮）
    const listing = await api.searchChats();
    const plan = planImport(listing, {
        currentFileName: opts.currentFileName, only: opts.only, includeCurrent: opts.includeCurrent,
    });
    results.totalFiles = plan.candidates.length;
    progress({ phase: 'detected', total: plan.candidates.length, skipped: plan.skipped });
    if (!plan.candidates.length) return results;

    // ② 执行确认（PARDON：删除用户数据前显式确认）
    const confirmed = await confirm({
        total: plan.candidates.length,
        deleteSources: opts.deleteSources,
    });
    if (!confirmed) { progress({ phase: 'aborted' }); return results; }

    // ③ 逐文件导入（N16：同角色跨聊天合并入同一家族——首建档者为合并目标）
    let primaryFamilyId = opts.targetFamilyId ?? null;
    for (let i = 0; i < plan.candidates.length; i++) {
        const { fileName } = plan.candidates[i];
        try {
            progress({ phase: 'importing', index: i, fileName, total: plan.candidates.length });
            const r = await importOneFile({ adapter, trash, api }, { fileName, targetFamilyId: primaryFamilyId, ...opts });
            results.importedFiles++;
            results.totalMerged += r.mergedCount;
            if (r.createdFamily) {
                results.families.push(r.familyId);
                if (!primaryFamilyId) primaryFamilyId = r.familyId;
            }
            progress({ phase: 'imported', index: i, fileName, merged: r.mergedCount, total: plan.candidates.length });
        } catch (e) {
            results.failed.push({ fileName, error: String(e?.message || e) });
            progress({ phase: 'failed', index: i, fileName, error: String(e?.message || e) });
        }
    }
    return results;
}

/** 单文件导入（内部）：targetFamilyId 非空 → 合并入该家族；否则按 chatKey 查，无则建档 */
async function importOneFile(deps, { fileName, targetFamilyId, characterId, avatarUrl, deleteSources }) {
    const { adapter, trash, api } = deps;
    const chatKey = normalizeChatKey(avatarUrl, `${fileName}.jsonl`);

    // 读取源文件（native：绕开 seam 拦截，读原生 jsonl）
    const data = await api.readChatFile(fileName);
    if (!data) throw new Error('源文件读取失败');
    // W5：源 jsonl 首行 header 的聊天头**整份保留**（其他插件的命名空间、main_chat 线索……）。
    // 冷路径（导入一个当前没打开的聊天）里，宿主内存那份 metadata 帮不上忙，源文件是唯一来源。
    const incomingHost = hostMetadataOfHeader(data.header);

    // 合并目标：显式 targetFamilyId（跨聊天合并）→ chatKey 既有 → 新建档
    let existing = null;
    if (targetFamilyId != null) {
        existing = await adapter.loadFamily({ familyId: targetFamilyId });
        if (!existing) throw new Error('合并目标家族不存在');
    } else {
        existing = await adapter.loadFamily({ chatKey });
    }
    let mergedCount = 0;
    let createdFamily = false;
    let familyId = null;
    if (!existing) {
        const { family, floors } = await buildFamilyFromJsonl(data.lines, {
            familyId: `f_${fileName.replace(/[^\w-]/g, '_')}_${Date.now().toString(36)}`,
            chatKey, characterId: characterId ?? '', name: fileName,
        }, incomingHost);
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) throw new Error(`建档失败: ${cr?.reason}`);
        // 分块写（500/批）
        await chunkedSaveFloors(adapter, family.familyId, floors);
        familyId = family.familyId;
        mergedCount = floors.length;
        createdFamily = true;
    } else {
        // 合并：库内既有行（带 hash） vs 源文件行（limit 用大数不用 Infinity——Authority 档直传 SQL 参数）
        const { floors: existingFloors } = await adapter.loadFloors({ familyId: existing.familyId, from: 0, limit: 1e9 });
        // 指纹补齐（2026-09-26 真机实录）：接缝写路径落库的行 `contentHash` 留空（它不做合并判定），
        // 而 LCP 比的是 hash —— `null ≠ sha256` 会让对齐在**第 1 层**就断，整份内容被当成"分叉"再挂
        // 一条同内容分支（现象：纯库模式下新建的聊天再走一次导入 → 家族里多出一条重复分支）。
        // 故库里没存 hash 的行在导入前按内容现算一次，对齐才是按内容对齐。
        const existingRows = await Promise.all(existingFloors.map(async (f) => {
            const obj = safeParse(f.content);
            return {
                hash: f.contentHash ?? (obj ? await computeHash(obj) : null),
                sendDate: f.sendDate,
                sender: obj?.name ?? null,
            };
        }));
        const { floors: mergeFloors, stats, forkFloor } = await mergeIntoFamily(existingRows, data.lines);
        if (mergeFloors.length) {
            // 旁挂变体 → 分配楼层号 + 模型登记子分支（深拷贝防适配器缓存别名污染）
            const model = structuredClone(existing.model || { active_branch: null, branches: [], groups: {} });
            const { floors: assigned, branchId } = attachMergedFork(model, mergeFloors, forkFloor ?? 0, fileName);
            await chunkedSaveFloors(adapter, existing.familyId, assigned);
            const saveModel = await adapter.saveModel({ familyId: existing.familyId, model, expectedIntegrity: null });
            if (!saveModel?.ok) throw new Error('合并分支登记失败');
        }
        mergedCount = stats.merged;
        familyId = existing.familyId;
    }

    // W5：聊天头（整份）并入——**逐命名空间合并**，不得整包覆盖库内已有内容
    // （合并语义单点 = `core/chat-meta.js#mergeHostMetadata`，与接缝写路径同一套）
    // F2（2026-09-26）：并入家族级的只有**属于这个家族**的项——被并入的那个聊天自己的
    // `main_chat`（父线索）归它自己的键绑定，混进家族级会让主键也冒出「返回父聊天」。
    // 建档案那一路不剔（`existing` 为空）：那份文件就是新家族的主键，父线索是它自己的。
    if (Object.keys(incomingHost).length) {
        const forFamily = existing ? stripKeyOwnedMeta(existing, chatKey, incomingHost) : incomingHost;
        const mergedHost = mergeHostMetadata(existing?.hostMetadata, forFamily);
        if (JSON.stringify(mergedHost) !== JSON.stringify(existing?.hostMetadata || {})) {
            const rHost = await adapter.saveModel({
                familyId, model: undefined, hostMetadata: mergedHost,
                expectedIntegrity: null, keepCurrent: true, // 只写聊天头，不动模型
            });
            if (rHost && rHost.ok === false) throw new Error(`聊天头落库失败: ${rHost.reason}`);
        }
    }

    // ④ 快照回收站 → 删源（顺序保证：快照成功才删）
    if (deleteSources) {
        const snap = await trash.snapshotAndMove({ source: chatKey, content: data.raw });
        if (!snap?.ok) throw new Error('回收站快照失败，源文件保留');
        const del = await api.deleteChatFile(fileName);
        if (!del?.ok) throw new Error('源文件删除失败（回收站已有副本）');
    }
    return { familyId, mergedCount, createdFamily };
}

/** 分块写楼层（500/批，authority 纪律；其他档整批亦可） */
async function chunkedSaveFloors(adapter, familyId, floors) {
    const CHUNK = 500;
    for (let i = 0; i < floors.length; i += CHUNK) {
        await adapter.saveFloors({ familyId, floors: floors.slice(i, i + CHUNK), expectedIntegrity: null });
    }
}

function safeParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}
