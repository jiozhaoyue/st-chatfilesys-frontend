/**
 * ChatFilesys — 图视图编排（B4）：把 B1 → B2 → B3 → 视图 串起来
 *
 * ── 为什么不把这段塞进 `index.js` ──
 * `index.js` 已经 2100 行；而这段编排有**明确的输入输出**（数据源 → 图 → 坐标 → 视图），
 * 且每一段都能注入替身（单测不必开浏览器）。放在这里，`index.js` 只留一句 `graphPanel.refresh()`。
 *
 * ── 三段各自的职责边界（越界即缺陷） ──
 * | 层 | 干什么 | 不干什么 |
 * |---|---|---|
 * | B1 `ChatSource` | 读聊天与家族 | 不知道什么叫「图」 |
 * | B2 `buildGraph` | 装配节点/边/会话序列 | 不读盘、不渲染 |
 * | B3 `createLayoutService` | 坐标 | 不画、不做降级判定 |
 * | 本模块 | 编排 + 缓存 + 降级判定 | **不自己算父子和坐标** |
 *
 * ── 缓存两层，各管各的 ──
 * 1. **图缓存**（B2 的 `createGraphCache`）：`digest` 未变 ⇒ 不重建图（省装配 + 排序 + 哈希的比较）
 * 2. **坐标缓存**（本模块）：`digest` 未变 ⇒ 复用上次坐标（省一次 dagre / worker 往返）
 * 宿主事件到达时调 `invalidate()` —— 两个缓存一起丢。
 */

import { createChatSource } from '../../core/source/chat-source.js';
import { createGraphCache } from '../../core/graph/graph.js';
import { createLayoutService } from '../../core/graph/layout-service.js';
import { planDegrade, DEGRADE_DEFAULTS } from './degrade.js';

/** 布局 worker 的 URL（相对本模块；`new URL(..., import.meta.url)` 在两宿主下都对） */
function defaultWorkerUrl() {
    try {
        return new URL('../../core/graph/layout.worker.js', import.meta.url).href;
    } catch {
        return null;   // 拿不到 URL（罕见）→ 走主线程，`via` 会如实报 'main'
    }
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.getSourceDeps `ChatSourceDeps`（角色上下文 / 适配器 / 原生通道…）；
 *   返回 `null` = 当前不可建源（如库模式未启用）
 * @param {() => object} deps.environment 采环境事实（视口尺寸 / 节点数之外的设备事实）
 * @param {number} [deps.workerTimeoutMs]
 * @param {string|null} [deps.workerUrl]
 * @param {Function} [deps.log]
 * @param {Function} [deps.decorate] 节点装饰器（B5 开放面）
 * @returns {{refresh: Function, invalidate: Function, describe: Function, dispose: Function}}
 */
export function createGraphController(deps = {}) {
    const log = deps.log ?? (() => {});
    /**
     * **信息性**日志（每次刷新的摘要）。与 `log` 分开是有意的：
     * 它平时没人看（每次弹窗刷新都刷一行），归「详细日志」设置管；
     * 而降级/失败这类**必须看得见**的东西走 `log`，不受那个开关影响。
     */
    const info = deps.info ?? log;
    const cache = createGraphCache({ log });
    const layoutService = createLayoutService({
        workerUrl: deps.workerUrl === undefined ? defaultWorkerUrl() : deps.workerUrl,
        timeoutMs: deps.workerTimeoutMs,
        log,
    });

    /** 上次坐标（连同它的 digest，用来判「能不能复用」） */
    let lastLayout = null;   // { digest, layout }
    let lastSummary = null;  // 最近一次 refresh 的结果（describe 用）

    /** 丢掉全部缓存（宿主事件 / 设置变更时调） */
    function invalidate() {
        cache.invalidate();
        lastLayout = null;
    }

    /**
     * 取图（用缓存）。
     * @returns {Promise<{graph, digest, changed, notes, sourceNotes}>}
     */
    async function loadGraph() {
        const sourceDeps = typeof deps.getSourceDeps === 'function' ? deps.getSourceDeps() : null;
        if (!sourceDeps) {
            const e = new Error('数据源当前不可用（库模式未启用或没有活动角色）');
            e.code = 'CFS-G100';
            throw e;
        }
        const source = createChatSource(sourceDeps);
        const inputs = await source.graphInputs();
        const out = await cache.build(inputs);
        return { ...out, sourceNotes: source.describe?.()?.notes || [] };
    }

    /**
     * 刷新：建图 → 布局 → 降级判定 → 交给视图。
     *
     * @param {{view: object, force?: boolean, environment?: object}} opts
     *   `view` = `ui/graph/view.js#createGraphView()` 的产物
     * @returns {Promise<object>} 摘要（含 `degrade.reasons`、`layout.via`、`changed`…）
     */
    async function refresh({ view, force = false, environment = {} } = {}) {
        if (!view) throw new Error('refresh 需要传 view');

        if (force) invalidate();

        const t0 = Date.now();
        const { graph, digest, changed, notes, sourceNotes } = await loadGraph();
        const tGraph = Date.now();

        let layout = null;
        if (!changed && lastLayout && lastLayout.digest === digest) {
            layout = lastLayout.layout;       // 图没变 ⇒ 坐标也不必重算
        } else {
            // 布局参数（方向/间距/节点尺寸）来自设置：**现取**而不是建面板时取一次——
            // 用户改完设置立刻要看到效果，缓存住旧参数会让「改了没生效」重现
            const layoutOptions = typeof deps.layoutOptions === 'function'
                ? (deps.layoutOptions() || {}) : (deps.layoutOptions || {});
            layout = await layoutService.layout(graph, layoutOptions);
            if (layout) lastLayout = { digest, layout };
        }
        const tLayout = Date.now();

        const facts = {
            nodeCount: graph?.nodes?.length || 0,
            ...(typeof deps.environment === 'function' ? deps.environment() : {}),
            ...(environment || {}),
        };
        const degradeOpts = typeof deps.degradeOptions === 'function'
            ? deps.degradeOptions() : (deps.degradeOptions || null);
        const degrade = planDegrade(facts, degradeOpts || DEGRADE_DEFAULTS);

        view.render({
            graph, layout, digest, degrade,
            decorate: deps.decorate,
            activeId: deps.getActiveNodeId ? deps.getActiveNodeId() : null,
        });

        const summary = {
            nodeCount: facts.nodeCount,
            edgeCount: graph?.edges?.length || 0,
            sessionCount: graph?.sessions?.length || 0,
            changed,
            digest,
            layout: layout ? { via: layout.via, kind: layout.kind, degraded: layout.degraded || null } : null,
            degrade: { tier: degrade.tier, reasons: [...degrade.reasons], chunked: degrade.chunked,
                minimap: degrade.minimap, edgeLabels: degrade.edgeLabels },
            notes: [...(sourceNotes || []), ...(notes || [])],
            timing: { graphMs: tGraph - t0, layoutMs: tLayout - tGraph, totalMs: Date.now() - t0 },
            /** 布局不可用时的**原因**（不是一句"失败了"） */
            layoutFailedReason: layout ? null : (layoutService.describe?.().lastReason || '布局服务没有给出坐标'),
        };
        lastSummary = summary;
        info('图刷新', {
            nodes: summary.nodeCount, changed, via: summary.layout?.via,
            tier: degrade.tier, graphMs: summary.timing.graphMs, layoutMs: summary.timing.layoutMs,
        });
        return summary;
    }

    const describe = () => ({
        ...(lastSummary || { refreshed: false }),
        layoutStats: layoutService.describe(),
        cachedDigest: cache.peek()?.digest || null,
    });

    function dispose() {
        layoutService.dispose();
        invalidate();
    }

    return { refresh, invalidate, describe, dispose, layoutService };
}

export { DEGRADE_DEFAULTS };
