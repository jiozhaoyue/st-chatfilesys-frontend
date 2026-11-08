/**
 * ChatFilesys — 工作台控制器（宿主无关，web 同构的核心产出）
 *
 * **它是什么**：把 index.js 里「弹窗动作编排」那半边（`handleAction` 大 switch +
 * `currentView()` 视图组装）抽成**只依赖 ports 的纯编排层**，让酒馆弹窗与独立 web 页
 * 共享同一套动作语义与同一份 `refresh(v)` 视图合同（L1-MR-10 单一模板源精神：
 * UI 出自 ui/popup.js，动作出自本文件，两处都不造第二份）。
 *
 * **ports（全部由入口装配，本文件零宿主依赖）**：
 * - `adapter`  StorageAdapterAPI（三档统一，core/storage/adapter.js 契约）
 * - `settings` { get(key), set(key, value), tree(), resetAll(), exportAll() }
 *              —— key 为 registry 的点分路径；入口决定存哪（插件=extension_settings，web=localStorage）
 * - `notify`   { ok, info, warn, error } —— 入口决定形态（插件=toastr，web=页内 toast）
 * - `dialog`   { prompt(msg, def), confirm(msg) } —— 插件=官方 Popup，web=原生对话框
 * - `files`    { exportJsonl(name, text), listHostChats: fn|null }
 * - `caps`     { liveChat, mirror, ai, graph } —— **置灰判据唯一来源**（宿主专属能力声明）
 * - `events`   { rendered() } —— 状态变化后入口重渲染的钩子（web=popup.refresh，插件=renderAll）
 *
 * **正文（body）口径**（design.md §4.1）：插件里 body=宿主 ctx.chat；本控制器把
 * 「活跃分支投影」当 body 的事实源（loadFloors → variantId ∈ 活跃 path → 行内容），
 * 与 store-bridge「活跃行留 body、非活跃行进 groups」的既有语义一致。
 *
 * **写路径纪律**：全部走 `adapter.saveModel/applyOps`（三档统一端口 + integrity 乐观锁），
 * 模型改动 = core/branches 纯函数产新模型 → saveModel。web 不直写任何存储内部。
 *
 * **错误纪律**：失败进 `errors` 面（ui/popup.js#errorsHtml 消费），归因不吞；
 * web 本地失败用 `WEB-LOCAL` 编号（故意不像目录编号——条件标记不借错误编号命名空间，
 * 见 00-HANDOVER「G100 哨兵」教训）。
 */

import { buildFamilyFromJsonl, mergeIntoFamily, attachMergedFork } from '../core/importer.js';
import { modelFromStore } from '../core/store-bridge.js';
import { renameBranch, setMainBranch, deleteBranch } from '../core/branches.js';
import { getActiveBranch } from './common.js';
import { parentsOf, childrenOf } from '../core/graph/graph.js';
import { createGraphView } from './graph/view.js';
import { createGraphController } from './graph/controller.js';
import { DEGRADE_DEFAULTS } from './graph/degrade.js';
import { grouped as settingsGroupsOf, readSetting, writeSetting, defaults as settingsDefaults, SETTINGS } from '../core/settings-registry.js';
import { APPLY } from '../core/settings-registry.js';
import { STORAGE_MODES, STORAGE_MODE_LABELS } from '../core/mode.js';
import { activateVariant, deleteVariants, deletionOrder, moveVariant, editVariantText, targetBranchForGroup } from '../core/versions.js';
import { computeHash } from '../core/merge.js';
import { buildVersionsContent } from './versions.js';

const WEB_LOCAL_CODE = 'WEB-LOCAL'; // 故意不像目录编号（不借错误编号命名空间）

export function createWorkbench(ports = {}) {
    const adapter = ports.adapter;
    const settings = ports.settings;
    const notify = ports.notify ?? { ok() {}, info() {}, warn() {}, error() {} };
    const dialog = ports.dialog ?? { prompt: (m, d) => globalThis.prompt(m, d), confirm: (m) => globalThis.confirm(m) };
    const files = ports.files ?? {};
    const caps = { liveChat: false, mirror: false, ai: false, graph: true, ...(ports.caps || {}) };
    const onRendered = () => { try { ports.events?.rendered?.(); } catch { /* 钩子失败不阻断主流程 */ } };

    /* ---------------- 状态 ---------------- */

    let tier = null;            // 'authority' | 'official' | 'idb'
    let family = null;          // loadFamily 产物 + fullModel + floors
    let currentBranchId = null; // 视图基准分支（= 活跃投影）
    let treeDirection = 'down';
    let errorLog = [];
    let chatsToken = 0;
    // 图栈（B4 装配样板同款：懒建 + token 重挂 + 两层缓存在 controller）
    let graphPanel = null;
    let graphSelectedNodeId = null;
    let graphSummary = null;
    let graphToken = 0;

    function pushError(code, { what, why = null, fix = [], detail = null } = {}) {
        errorLog.push({ code, what, why, fix, detail });
        if (errorLog.length > 50) errorLog = errorLog.slice(-50);
    }

    /* ---------------- 家族装载 ---------------- */

    /** 打开家族：懒加载合同 → loadFloors → modelFromStore 重建全模型（含 groups） */
    async function openFamily(familyId) {
        if (!adapter) return;
        const fam = await adapter.loadFamily({ familyId });
        if (!fam) { notify.warn(`家族 ${familyId} 不存在或读取失败。`); return; }
        const { floors } = await adapter.loadFloors({ familyId, from: 0, limit: 1e9 });
        fam.floors = floors || [];
        fam.fullModel = modelFromStore(fam, fam.floors);
        family = fam;
        currentBranchId = fam.fullModel.active_branch ?? fam.model?.active_branch ?? null;
        invalidateGraph();
        onRendered();
    }

    /** 活跃分支的投影行（body 事实源）：variantId ∈ 活跃 path，按楼层序 */
    function activeRows() {
        if (!family) return [];
        const active = getActiveBranch(family.fullModel, currentBranchId);
        if (!active) return [];
        const path = new Set(Object.values(active.path || {}));
        return (family.floors || [])
            .filter((r) => path.has(r.variantId))
            .sort((a, b) => (a.floorNo - b.floorNo) || ((a.seq || 0) - (b.seq || 0)))
            .map((r) => { try { return JSON.parse(r.content); } catch { return null; } })
            .filter(Boolean);
    }

    /**
     * 全家族行（阅读视图 / 全局搜索 / 统计的数据面）：库行 + 每行的分支归属。
     * 与 activeRows() 的差别：activeRows 只给活跃投影；这里给**全家族**（含别的分支的变体行），
     * 归属 = variantId 出现在某分支 path 的值集里（一行可同属多条分支——共享楼层）。
     * 只读：不缓存、不落库，每次现算（行数 = 楼层行总数，量级安全）。
     */
    function allRows() {
        if (!family) return [];
        const rows = (family.floors || []).map((r) => {
            let line = null;
            try { line = JSON.parse(r.content); } catch { /* 坏行按原样呈现（line=null），不吞 */ }
            return {
                floorNo: r.floorNo,
                variantId: r.variantId,
                seq: r.seq || 0,
                line,
                sendDate: r.sendDate ?? line?.send_date ?? null,
                branchIds: [],
            };
        });
        for (const b of family.fullModel?.branches || []) {
            const pathSet = new Set(Object.values(b.path || {}));
            for (const row of rows) if (pathSet.has(row.variantId)) row.branchIds.push(b.id);
        }
        rows.sort((a, b) => (a.floorNo - b.floorNo) || ((a.seq || 0) - (b.seq || 0)));
        return rows;
    }

    /** 重拉楼层行 + 重建全模型（任何落库写之后都要走一遍，保持内存态=库内态） */
    async function reloadFloors() {
        if (!family || !adapter) return;
        const { floors } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: 1e9 });
        family.floors = floors || [];
        family.fullModel = modelFromStore(family, family.floors);
        currentBranchId = family.fullModel.active_branch ?? currentBranchId;
    }

    /* ---------------- 导入合并旅程（与 index.js#importOneFile 的合并支同编排） ---------------- */

    /**
     * 对已在库的家族做指纹合并：库内既有行 vs 导入行 → 差异行经 attachMergedFork 旁挂成子分支。
     * @returns {Promise<'noop'|'merged'>} noop = 内容完全一致（零写入）
     */
    async function mergeExisting(existing, lines, branchName) {
        if (!adapter) throw new Error('存储未就绪');
        const { floors: allRows } = await adapter.loadFloors({ familyId: existing.familyId, from: 0, limit: 1e9 });
        const existingRows = await Promise.all((allRows || []).map(async (f) => {
            let obj = null;
            try { obj = JSON.parse(f.content); } catch { /* 坏行按原样算哈希素材 */ }
            return { hash: f.contentHash ?? (obj ? await computeHash(obj) : null), sendDate: f.sendDate, sender: obj?.name ?? null };
        }));
        const { floors: mergeFloors, stats, forkFloor } = await mergeIntoFamily(existingRows, lines);
        if (!mergeFloors?.length || forkFloor == null) return 'noop';
        // 差异落库前要用户点头（合并是结构变更：原分支不动，新增子分支）
        const ok = dialog.confirm(
            `「${branchName}」与库内版本有差异（新增 ${mergeFloors.length} 行）。合并为子分支？（原分支不动）`);
        if (!ok) throw new Error('用户取消合并');
        // 模型是**家族级**的：先在库内现值上旁挂（不拿视图缓存直接改——乐观锁要求以库内 integrity 为基准）
        const fam = await adapter.loadFamily({ familyId: existing.familyId });
        const { floors: libRows } = await adapter.loadFloors({ familyId: existing.familyId, from: 0, limit: 1e9 });
        const model = modelFromStore(fam, libRows);
        const assigned = attachMergedFork(model, mergeFloors, forkFloor, branchName);
        const sr = await adapter.saveFloors({
            familyId: existing.familyId, floors: assigned.floors, expectedIntegrity: fam.integrity ?? null,
        });
        if (!sr?.ok) throw new Error(sr?.conflict ? 'conflict' : (sr?.reason || '存储拒绝'));
        const sm = await adapter.saveModel({
            familyId: existing.familyId, model, expectedIntegrity: sr.integrity ?? null,
        });
        if (!sm?.ok) throw new Error(sm?.conflict ? 'conflict' : (sm?.reason || '存储拒绝'));
        notify.ok(`已合并为子分支「${branchName}」（branchId=${assigned.branchId}）。`);
        await openFamily(existing.familyId);
        return 'merged';
    }

    /* ---------------- 楼层版本四能力（写路径：库行原位改 + saveFloors 合并式 upsert） ---------------- */

    /**
     * 对活跃路径上某楼层的行执行一次变更（core/versions 纯函数就地改 line）。
     * 行身份 = (floorNo, variantId=活跃 path 值)；saveFloors 按 (familyId, floorNo, variantId)
     * 合并式 upsert + integrity 自增（core/storage/idb.js#saveFloors，三档同契约）。
     * @param {(line: object) => void} mutator core/versions 纯函数（抛错即中止，不落库）
     */
    async function applyFloorOp(floor, mutator) {
        if (!family || !adapter) throw new Error('未打开家族');
        const active = getActiveBranch(family.fullModel, currentBranchId);
        const variantId = active?.path?.[floor];
        const row = (family.floors || []).find((r) => r.floorNo === floor && r.variantId === variantId);
        if (!row) throw new Error(`楼层 ${floor}（${variantId || '无路径'}）不在活跃分支上，或库行缺失`);
        const line = JSON.parse(row.content);
        mutator(line); // 抛错 = 数据未动（纯函数契约）
        row.content = JSON.stringify(line);
        row.contentHash = await computeHash(line);
        row.sendDate = line?.send_date ?? row.sendDate ?? null;
        const res = await adapter.saveFloors({
            familyId: family.familyId, floors: [row], expectedIntegrity: family.integrity ?? null,
        });
        if (!res?.ok) throw new Error(res?.conflict ? '库内已有更新的版本（conflict），请重新打开家族' : (res?.reason || '存储拒绝'));
        family.integrity = res.integrity;
        await reloadFloors();
        invalidateGraph();
        onRendered();
    }

    /**
     * 打开「该层版本」模态（web 载体 = `<dialog>`；内容与插件同源 buildVersionsContent）。
     * @param {number} floor 楼层号（从 1 起）
     */
    async function openVersions(floor) {
        if (!family) { notify.warn('先打开一个家族。'); return; }
        const root = buildVersionsContent({
            floor,
            getView: () => ({ model: family.fullModel, chat: activeRows(), currentBranchId }),
            onSwitchVariant: (k) => applyFloorOp(floor, (line) => activateVariant(line, k)),
            // 别的组的版本 = 切到它所在分支（与插件 switchToGroupVersionFlow 同语义）
            onSwitchGroup: (gid, k) => (async () => {
                const branchId = targetBranchForGroup(family.fullModel, gid, floor, currentBranchId);
                if (!branchId) throw new Error(`组 ${gid} 没有对应的分支归属`);
                family.fullModel.active_branch = branchId;
                currentBranchId = branchId;
                if (await saveModel()) notify.ok('已切换分支。');
                onRendered();
            })(),
            onDeleteVariants: (indices) => applyFloorOp(floor, (line) => deleteVariants(line, deletionOrder(indices))),
            onMoveVariant: (from, to) => applyFloorOp(floor, (line) => moveVariant(line, from, to)),
            onEditVariant: (k, text) => applyFloorOp(floor, (line) => editVariantText(line, k, text)),
        });
        if (!root) { notify.warn('该层没有可管理的版本。'); return; }
        const dlg = document.createElement('dialog');
        dlg.className = 'cfsysw-modal';
        dlg.appendChild(root);
        const close = document.createElement('button');
        close.className = 'menu_button';
        close.textContent = '关闭';
        close.addEventListener('click', () => dlg.close());
        root.appendChild(close);
        document.body.appendChild(dlg);
        dlg.addEventListener('close', () => dlg.remove());
        dlg.showModal();
    }

    /** 模型写回（唯一写入口）：integrity 乐观锁；冲突如实报 */
    async function saveModel() {
        if (!family || !adapter) return false;
        const res = await adapter.saveModel({
            familyId: family.familyId,
            model: family.fullModel,
            expectedIntegrity: family.integrity ?? null,
        });
        if (res?.ok) {
            family.integrity = res.integrity;
            invalidateGraph();
            return true;
        }
        pushError(WEB_LOCAL_CODE, {
            what: '模型写入被拒绝（版本冲突或存储拒绝）',
            why: res?.conflict ? '库内版本号已变（可能有另一个窗口写入了）' : (res?.reason || null),
            fix: [{ label: '重新打开该家族后重试' }],
            detail: JSON.stringify(res),
        });
        notify.error('写入失败：' + (res?.conflict ? '库内已有更新的版本（conflict）' : (res?.reason || '存储拒绝')));
        return false;
    }

    /* ---------------- 图栈（与 index.js 同一装配样板） ---------------- */

    function graphSourceDeps() {
        if (!adapter) return null; // 没有适配器就不给源——让上层报明确错误，不建空图
        return {
            mode: 'pure', // web 工作台天生是库面
            adapter,
            character: () => ({ avatarUrl: '', characterId: 'standalone', name: family?.name || '' }),
            log: console.warn,
        };
    }

    function graphEnvironment() {
        const nav = globalThis.navigator || {};
        let reducedMotion = false;
        try { reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { /* 老浏览器当作没开 */ }
        const host = graphPanel?.host;
        return {
            viewportArea: host ? Math.max(1, (host.getBoundingClientRect?.().width || 640) * (host.getBoundingClientRect?.().height || 320)) : undefined,
            reducedMotion,
            deviceMemory: Number(nav.deviceMemory) || undefined,
            forcedMinimal: Boolean(settings?.get?.('graph.force_minimal')),
        };
    }

    async function ensureGraphPanel(host) {
        if (!graphPanel) {
            const view = createGraphView({
                log: console.warn,
                measure: () => {
                    const r = graphPanel?.host?.getBoundingClientRect?.();
                    return { width: Math.max(1, r?.width || 640), height: Math.max(1, r?.height || 320) };
                },
                onAction: (action, payload) => {
                    if (action === 'graph-node' && payload?.nodeId) {
                        graphSelectedNodeId = payload.nodeId;
                        bumpGraph();
                        onRendered();
                    }
                },
            });
            const controller = createGraphController({
                getSourceDeps: graphSourceDeps,
                environment: graphEnvironment,
                degradeOptions: () => ({
                    minimapNodeBudget: Number(settings?.get?.('graph.minimap_budget')),
                    edgeLabelNodeBudget: Number(settings?.get?.('graph.edge_label_budget')),
                    chunkNodeBudget: Number(settings?.get?.('graph.chunk_budget')),
                    chunkSize: Number(settings?.get?.('graph.chunk_size')),
                    smallViewportArea: DEGRADE_DEFAULTS.smallViewportArea,
                }),
                layoutOptions: () => ({ direction: settings?.get?.('graph.direction') }),
                log: console.warn,
                info: () => {},
            });
            graphPanel = { controller, view, host: null };
        }
        if (host) graphPanel.host = host;
        return graphPanel;
    }

    async function renderGraphInto(host, graphBody) {
        const statusEl = graphBody?.querySelector?.('[data-role="graph-status"]');
        const setStatus = (t) => { if (statusEl) statusEl.textContent = t || ''; };
        if (!host) return;
        try {
            const panel = await ensureGraphPanel(host);
            if (panel.view.el.parentElement !== host) panel.view.mount(host);
            setStatus('正在读取数据并建图…');
            const summary = await panel.controller.refresh({ view: panel.view, environment: graphEnvironment() });
            graphSummary = summary;
            panel.view.fit();
            const bits = [
                `${summary.nodeCount} 节点 / ${summary.edgeCount} 边 / ${summary.sessionCount} 条会话`,
                summary.layout ? `布局 ${summary.layout.via === 'worker' ? 'Worker' : '主线程'}·${summary.layout.kind}` : '',
                summary.changed ? '已重建' : '复用缓存',
                `${summary.timing.graphMs}ms 建图 + ${summary.timing.layoutMs}ms 布局`,
            ].filter(Boolean);
            setStatus(bits.join(' · '));
            const reasons = summary.degrade?.reasons || [];
            if (reasons.length) {
                const line = document.createElement('div');
                line.className = 'chatfilesys-note chatfilesys-graph-degrade';
                line.textContent = `已降级（${summary.degrade.tier}）：${reasons.join('；')}`;
                statusEl?.after?.(line);
            }
            if (!summary.nodeCount) {
                const line = document.createElement('div');
                line.className = 'chatfilesys-note';
                line.textContent = family
                    ? '图是空的：该家族读不出会话结构（库行缺失或数据源不可用）——不是「这个聊天没有结构」。'
                    : '还没有打开家族：从上方选择或导入一个，再来看图。';
                statusEl?.after?.(line);
            }
        } catch (e) {
            setStatus('建图失败。');
            pushError(WEB_LOCAL_CODE, {
                what: '结构图构建失败',
                why: e?.code === 'SRC_UNAVAILABLE' ? '数据源不可用（没有适配器）' : (e?.message || null),
                fix: [{ label: '重算' }, { label: '检查存储档位' }],
                detail: e?.stack || String(e),
            });
        }
    }

    function graphSelection() {
        const id = graphSelectedNodeId;
        if (!id || !graphSummary) return null;
        const graph = graphPanel?.view?.state?.graph;
        if (!graph) return null;
        const node = graph.nodes?.find((n) => n.id === id);
        if (!node) return null;
        const brief = (nid) => {
            const n = graph.nodes?.find((x) => x.id === nid);
            return n ? { id: n.id, floor: n.floor, isUser: Boolean(n.isUser) } : null;
        };
        return {
            nodeId: id,
            floor: node.floor,
            isUser: Boolean(node.isUser),
            sessionCount: node.sessions?.length || 0,
            parents: parentsOf(graph, id).map(brief).filter(Boolean),
            children: childrenOf(graph, id).map(brief).filter(Boolean),
            isFork: childrenOf(graph, id).length >= 2,
        };
    }

    function bumpGraph() { graphToken += 1; }

    function invalidateGraph() {
        graphPanel?.controller?.invalidate?.();
        graphSelectedNodeId = null;
        graphSummary = null;
        bumpGraph();
    }

    async function graphReloadFlow() {
        if (!graphPanel) { bumpGraph(); onRendered(); return; }
        try {
            const summary = await graphPanel.controller.refresh({ view: graphPanel.view, force: true, environment: graphEnvironment() });
            graphSummary = summary;
            graphPanel.view.fit();
        } catch (e) {
            pushError(WEB_LOCAL_CODE, { what: '结构图重算失败', why: e?.message || null, fix: [{ label: '重试' }], detail: e?.stack || String(e) });
        }
        bumpGraph();
        onRendered();
    }

    /* ---------------- 导出 / 导入 ---------------- */

    /** 活跃分支 → 纯标准 JSONL（离开插件仍可读；不带 chatfilesys 命名空间） */
    function buildExportJsonl() {
        if (!family) return null;
        const active = getActiveBranch(family.fullModel, currentBranchId);
        if (!active) return null;
        const header = {
            user_name: 'User',
            character_name: family.name || family.chatKey || 'chat',
            create_date: family.hostMetadata?.create_date ?? null,
            chat_metadata: { ...(family.hostMetadata || {}) }, // T0/R0 保留面原样带回，不含 chatfilesys 自身
        };
        const lines = [JSON.stringify(header), ...activeRows().map((r) => JSON.stringify(r))];
        return { name: `${family.name || family.familyId} - 分支「${active.name}」.jsonl`, text: lines.join('\n') + '\n' };
    }

    async function importText(name, text) {
        if (!adapter) throw new Error('存储未就绪');
        const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (!lines.length) throw new Error(`${name}: 文件为空`);
        const base = String(name).replace(/\.jsonl$/i, '');
        const identity = {
            // familyId 保留 CJK（\w 只认 ASCII）；仅替换真正危险的字符
            familyId: `f_web_${base}`.replace(/[^\w\u4e00-\u9fff-]/g, '_'),
            chatKey: `${base}.jsonl`,
            characterId: 'standalone',
            name: base,
        };
        // 幂等（产品契约 §5 基线场景）：同 familyId 或同 chatKey 已在库 ⇒ 零写入直接打开。
        // 但若**内容有差异**（同一聊天的更新版本）→ 走合并旅程：指纹对齐 → 差异行旁挂 → 子分支。
        const existing = await adapter.loadFamily({ familyId: identity.familyId })
            || await adapter.loadFamily({ chatKey: identity.chatKey });
        if (existing) {
            const mergeRes = await mergeExisting(existing, lines, base);
            if (mergeRes === 'noop') {
                notify.info(`${name}：已在库内且无变化（幂等，零写入）`);
                await openFamily(existing.familyId);
                return { imported: false, familyId: existing.familyId };
            }
            return { imported: true, merged: true, familyId: existing.familyId };
        }
        const { family: famStore, floors } = await buildFamilyFromJsonl(lines, identity, null);
        const cr = await adapter.createFamily({ family: famStore });
        if (!cr?.ok) throw new Error(`建档失败：${cr?.reason || 'unknown'}`);
        await adapter.saveFloors({ familyId: famStore.familyId, floors, expectedIntegrity: null });
        await openFamily(famStore.familyId);
        return { imported: true, familyId: famStore.familyId };
    }

    /* ---------------- 视图组装（refresh(v) 合同，与 index.js#currentView 同语义） ---------------- */

    function settingsValuesAll() {
        const tree = settings.tree();
        return Object.fromEntries(SETTINGS.map((s) => [s.key, readSetting(tree, s.key)]));
    }

    function view() {
        const tierLabel = tier === 'authority' ? 'Authority 数据库'
            : tier === 'official' ? '官方通道（直连实例）'
            : tier === 'idb' ? '本机 IndexedDB（缓存档）' : '未就绪';
        return {
            model: family?.fullModel ?? null,
            chat: [],
            familyName: family?.name || family?.familyId || '（未打开家族）',
            warning: '',
            isGroupChat: false,
            autoExport: false,
            treeDirection,
            canSummarize: caps.ai,
            // N15 口径：档位没有回收站目录就明说，不给假「空列表」
            listTrash: tier === 'authority' ? async () => (await adapter.listTrash()) || [] : null,
            trashNote: tier === 'authority' ? '' : `当前档位（${tierLabel}）没有回收站目录；删除动作不经过回收站。`,
            listChats: caps.liveChat && typeof files.listHostChats === 'function' ? files.listHostChats : null,
            chatsNote: 'web 模式没有宿主文件面；接入酒馆直连（档2）后这里会列出实例里的聊天。',
            chatsToken,
            storage: {
                // web 工作台天生是库面：storage_mode 锁定 'pure'（选择器改动会被视图回填拉回，
                // 并触发 onSettingChanged 的 STORAGE 提示——见 bind() 的 change 委托）
                mode: 'pure',
                modes: STORAGE_MODES,
                labels: STORAGE_MODE_LABELS,
                pureLike: true,
                mirror: caps.mirror,
                tierLabel,
                mirrorPending: false,
            },
            branchId: currentBranchId,
            graphToken,
            renderGraph: caps.graph ? renderGraphInto : null,
            graphSelection: graphSelection(),
            graphEnabled: Boolean(settings.get('graph.enabled')),
            settingsGroups: settingsGroupsOf(),
            settingsValues: settingsValuesAll(),
            errors: [...errorLog],
        };
    }

    /* ---------------- 动作分发（与 index.js#handleAction 同名同语义） ---------------- */

    async function handleAction(action, el) {
        const branchId = el?.dataset?.branch;
        switch (action) {
            case 'enable':
                notify.info('web 工作台：从上方选择或导入一个家族即可（这里没有「当前聊天」需要启用）。');
                return;
            case 'switch': {
                if (!family || !branchId) return;
                family.fullModel.active_branch = branchId;
                currentBranchId = branchId;
                if (await saveModel()) { notify.ok('已切换分支（活跃投影已更新）。'); }
                onRendered();
                return;
            }
            case 'rename': {
                if (!family || !branchId) return;
                const cur = family.fullModel.branches.find((b) => b.id === branchId);
                const name = dialog.prompt('新的分支名：', cur?.name || '');
                if (!name || name === cur?.name) return;
                renameBranch(family.fullModel, branchId, name);
                if (await saveModel()) notify.ok('分支已改名。');
                onRendered();
                return;
            }
            case 'set-main-branch': {
                if (!family || !branchId) return;
                setMainBranch(family.fullModel, branchId);
                if (await saveModel()) notify.ok('已设为主分支。');
                onRendered();
                return;
            }
            case 'delete-branch': {
                if (!family || !branchId) return;
                const cur = family.fullModel.branches.find((b) => b.id === branchId);
                if (!dialog.confirm(`删除分支「${cur?.name || branchId}」？其私有组一并回收（当前档位无回收站，不可还原）。`)) return;
                deleteBranch(family.fullModel, branchId);
                if (currentBranchId === branchId) currentBranchId = family.fullModel.active_branch;
                if (await saveModel()) notify.ok('分支已删除。');
                onRendered();
                return;
            }
            case 'export': {
                const out = buildExportJsonl();
                if (!out) { notify.warn('先打开一个家族再导出。'); return; }
                await files.exportJsonl(out.name, out.text);
                notify.ok('已导出为纯标准 JSONL。');
                return;
            }
            case 'run-import':
                notify.info('web 工作台：用顶栏「导入 .jsonl」选择文件（支持多选）。');
                return;
            case 'sync-mirror':
                notify.warn('双写落盘需要酒馆运行时（宿主文件通道），web 模式不可用。');
                return;
            case 'ai-summary':
                notify.warn('AI 总结需要酒馆生成链路，web 模式不可用。');
                return;
            case 'merge-branches':
                pushError(WEB_LOCAL_CODE, {
                    what: '合并流程尚未在 web 接线',
                    why: '合并走 C1 计划层 + 家族对齐，属于下一增量（implement.md 阶段3）',
                    fix: [{ label: '在酒馆插件里完成合并' }, { label: '等待下一增量' }],
                    detail: null,
                });
                notify.warn('合并流程尚未在 web 接线（见错误面）。');
                onRendered();
                return;
            case 'chat-import': case 'chat-export': case 'chat-tree':
                notify.warn('宿主文件面在 web 模式不可用；接入酒馆直连（档2）后启用。');
                return;
            case 'tree-direction':
                treeDirection = treeDirection === 'down' ? 'right' : 'down';
                onRendered();
                return;
            case 'graph-reload': return await graphReloadFlow();
            case 'graph-fit': graphPanel?.view?.fit(); return;
            case 'graph-zoom-in': graphPanel?.view?.zoom(1.2); return;
            case 'graph-zoom-out': graphPanel?.view?.zoom(1 / 1.2); return;
            case 'graph-goto': {
                const nodeId = el?.dataset?.node;
                const pos = graphPanel?.view?.state?.positions?.[nodeId];
                if (!pos) return;
                graphSelectedNodeId = nodeId;
                graphPanel.view.setActive(nodeId);
                graphPanel.view.centerOn({ x: pos.x, y: pos.y });
                bumpGraph();
                onRendered();
                return;
            }
            case 'settings-enable-graph':
                settings.set('graph.enabled', true);
                onRendered();
                return;
            case 'settings-reset-all': {
                if (!dialog.confirm('把全部设置恢复为默认值？（不影响库内数据）')) return;
                settings.resetAll();
                notify.ok('设置已恢复默认。');
                onRendered();
                return;
            }
            case 'settings-export': {
                const text = JSON.stringify(settings.exportAll(), null, 2);
                await files.exportJsonl('chatfilesys-web-settings.json', text);
                return;
            }
            case 'trash-restore': {
                if (tier !== 'authority') return;
                const r = await adapter.restoreFromTrash({ trashId: el?.dataset?.trash });
                notify.ok(r?.ok ? '已还原。' : '还原失败。');
                chatsToken += 1;
                onRendered();
                return;
            }
            case 'trash-purge': {
                if (tier !== 'authority') return;
                if (!dialog.confirm('从回收站永久删除？（不可撤回）')) return;
                await adapter.deleteFromTrash({ trashId: el?.dataset?.trash });
                notify.ok('已清理。');
                chatsToken += 1;
                onRendered();
                return;
            }
            case 'errors-copy': {
                const text = errorLog.map((e) => `[${e.code}] ${e.what}\n为什么：${e.why || '未定位'}\n怎么办：${(e.fix || []).map((f) => f.label).join(' / ')}`).join('\n\n');
                try { await navigator.clipboard.writeText(text); notify.ok('诊断已复制。'); } catch { notify.warn('复制失败（剪贴板权限）。'); }
                return;
            }
            case 'errors-clear':
                errorLog = [];
                onRendered();
                return;
            default:
                pushError(WEB_LOCAL_CODE, { what: `未登记的动作 ${action}`, why: 'workbench 未实现该动作', fix: [{ label: '检查动作名' }] });
                onRendered();
        }
    }

    /* ---------------- 设置应用（registry 的 apply 声明 → web 执行处） ---------------- */

    function onSettingChanged(key, apply) {
        if (apply === APPLY.GRAPH) invalidateGraph();
        else if (apply === APPLY.STORAGE) notify.warn('存储模式在 web 模式固定为库面（idb / Authority）；接缝与双写仅在酒馆运行时可用。');
        // APPLY.UI 及其余 → onRendered 由调用方统一触发
    }

    /* ---------------- 事件委托（弹窗内容 + PO-3 小窗共一个文档级委托） ---------------- */

    /**
     * 绑定动作委托。web 入口绑在 document 上（弹窗内容与小窗都覆盖）；
     * 插件入口沿用 index.js#bindPopupEvents（root 级），不受本方法影响。
     */
    function bind(rootEl) {
        if (!rootEl) return;
        rootEl.addEventListener('click', async (evt) => {
            const el = evt.target.closest('[data-action]');
            if (!el || !rootEl.contains(el)) return;
            evt.stopPropagation();
            try {
                await handleAction(el.dataset.action, el);
            } catch (e) {
                console.error('[chatfilesys-web] 动作失败:', el.dataset.action, e);
                pushError(WEB_LOCAL_CODE, {
                    what: `动作 ${el.dataset.action} 抛了异常`,
                    why: e?.message || null,
                    fix: [{ label: '重试' }],
                    detail: e?.stack || String(e),
                });
                onRendered();
            }
        });
        rootEl.addEventListener('change', async (evt) => {
            const sel = evt.target.closest('[data-role="setting"]');
            if (sel) {
                const key = sel.dataset.key;
                const type = sel.dataset.type;
                let raw = type === 'boolean' ? sel.checked : sel.value;
                if (type === 'number') raw = Number(raw);
                const r = settings.set(key, raw); // {value, changed, apply}
                if (r?.changed) onSettingChanged(key, r.apply);
                onRendered();
                return;
            }
            const mode = evt.target.closest('[data-role="storage-mode"]');
            if (mode) {
                onSettingChanged('storage_mode', APPLY.STORAGE);
                onRendered(); // 视图会以锁定值回填（回退选择）
            }
        });
    }

    return {
        view,
        handleAction,
        bind,
        openFamily,
        importText,
        openVersions,
        listFamilies: () => (adapter ? adapter.listFamilies({}) : Promise.resolve([])),
        activeRows,
        allRows,
        saveModel,
        invalidateGraph,
        get tier() { return tier; },
        set tier(v) { tier = v; },
    };
}
