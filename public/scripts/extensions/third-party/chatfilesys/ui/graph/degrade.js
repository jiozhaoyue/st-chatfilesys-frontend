/**
 * ChatFilesys — 图视图 · 降级判定（B4）
 *
 * **纯函数，零 DOM**：调用方把「环境事实」采好传进来（视口尺寸、节点数、`matchMedia` 结果、
 * 设备内存…），本模块只做判定。这样判定规则可以在 `node --test` 下穷举，不必开浏览器。
 *
 * ── 为什么降级原因必须挂在**返回值**上（B3 的教训，本仓 spec 的 Forbidden） ──
 * B3 实测：dagre 回落迭代分层这件事只交给了 `onError`，而主路径跑在 worker 里——
 * **worker 内没有任何人能接 `onError`**，于是调用方只看到 `kind:'layered'`、stats 里
 * `workerOk` 还在涨，看着像一切正常。图视图同理：降级若只 `console.warn`，
 * 用户看到的是「图怎么这么朴素」，而没人说得清为什么。
 * 故本模块的返回**恒带 `reasons`**（空数组 = 没降级，也是明确的事实）。
 *
 * ── 三级档位（`full` → `lite` → `minimal`） ──
 * | 档 | 小地图 | 边标签 | 分片渲染 | 何时 |
 * |---|---|---|---|---|
 * | `full` | 开 | 开 | 不用 | 默认 |
 * | `lite` | 关 | 关 | 不用 | 节点多 / 屏幕小 |
 * | `minimal` | 关 | 关 | 开 | 弱设备 / 图很大 |
 */

/** 默认阈值（**每一项都可由调用方覆盖**——它们同时是设置页暴露的那几项） */
export const DEGRADE_DEFAULTS = Object.freeze({
    /** 超过这个节点数就不开小地图（小地图本身要渲染 N 个点） */
    minimapNodeBudget: 400,
    /** 超过这个节点数就不画边标签（每条边一个 `<text>`，是 DOM 数量的大头） */
    edgeLabelNodeBudget: 200,
    /** 超过这个节点数改用分片渲染 */
    chunkNodeBudget: 1200,
    /** 视口（宽×高）小于这个值算「屏幕小」 */
    smallViewportArea: 260 * 220,
    /** 总分片数上限（每帧渲染一批；批太小反而卡在调度上） */
    chunkSize: 240,
});

/**
 * 判定降级档位。
 *
 * @param {object} facts **环境事实**（全部由调用方采集，本函数不自己探测）
 * @param {number} [facts.nodeCount] 图的节点数
 * @param {number} [facts.viewportWidth] 视口宽（屏幕 px）
 * @param {number} [facts.viewportHeight] 视口高（屏幕 px）
 * @param {boolean} [facts.reducedMotion] `prefers-reduced-motion: reduce`
 * @param {number} [facts.deviceMemory] `navigator.deviceMemory`（GB；缺失 = 未知）
 * @param {boolean} [facts.forcedMinimal] 用户/设置强制最小档
 * @param {object} [opts] 阈值覆盖（缺省用 `DEGRADE_DEFAULTS`）
 * @returns {{tier:'full'|'lite'|'minimal', minimap:boolean, edgeLabels:boolean,
 *            chunked:boolean, chunkSize:number, reasons:string[],
 *            budget:{nodeCount:number, viewportArea:number}}}
 *   `reasons` **恒为数组**（空 = 未降级）；每条形如 `'节点 1503 > 1200：改为分片渲染'`——
 *   人话、可直接显示给用户，也是 e2e 的断言点。
 */
export function planDegrade(facts = {}, opts = {}) {
    const cfg = { ...DEGRADE_DEFAULTS, ...(opts || {}) };
    const nodeCount = Math.max(0, Number(facts.nodeCount) || 0);
    const vw = Math.max(0, Number(facts.viewportWidth) || 0);
    const vh = Math.max(0, Number(facts.viewportHeight) || 0);
    const viewportArea = vw * vh;
    const reasons = [];

    const small = viewportArea > 0 && viewportArea < cfg.smallViewportArea;
    const byNodes = nodeCount > cfg.minimapNodeBudget;
    const minimap = !(small || byNodes);
    if (small) reasons.push(`视口 ${vw}×${vh} 偏小：关掉小地图腾出作图区域`);
    if (byNodes) reasons.push(`节点 ${nodeCount} > ${cfg.minimapNodeBudget}：关掉小地图（它本身要点满一屏）`);

    const edgeLabels = nodeCount <= cfg.edgeLabelNodeBudget;
    if (!edgeLabels) reasons.push(`节点 ${nodeCount} > ${cfg.edgeLabelNodeBudget}：不画边标签（每条边一个文本元素）`);

    let chunked = nodeCount > cfg.chunkNodeBudget;
    let chunkSize = cfg.chunkSize;
    if (chunked) reasons.push(`节点 ${nodeCount} > ${cfg.chunkNodeBudget}：改为分片渲染（每批 ${chunkSize} 个）`);
    // 分片大小随节点数走：图越大批越大（否则 5000 节点要 21 帧才画完，用户看到的是「一格一格长出来」）
    if (chunked) chunkSize = Math.max(cfg.chunkSize, Math.ceil(nodeCount / 12));

    let tier = 'full';
    if (minimap === false || !edgeLabels) tier = 'lite';
    if (chunked) tier = 'minimal';

    // 弱设备：内存小 or 用户要减少动效 → 至少 lite，并把原因说清楚
    const mem = Number(facts.deviceMemory);
    if (Number.isFinite(mem) && mem > 0 && mem <= 2) {
        tier = chunked ? 'minimal' : 'lite';
        reasons.push(`设备内存 ${mem}GB 偏小：降为 ${tier} 档`);
    }
    if (facts.reducedMotion) {
        reasons.push('系统开了「减少动效」：不做布局过渡动画');
    }
    if (facts.forcedMinimal) {
        tier = 'minimal';
        chunked = true;
        chunkSize = Math.max(cfg.chunkSize, Math.ceil(Math.max(1, nodeCount) / 12));
        reasons.push('设置里强制了最小档');
    }

    return {
        tier,
        minimap: tier === 'full' ? minimap : false,
        edgeLabels,
        chunked,
        chunkSize,
        animate: !facts.reducedMotion,
        reasons,
        budget: { nodeCount, viewportArea },
    };
}
