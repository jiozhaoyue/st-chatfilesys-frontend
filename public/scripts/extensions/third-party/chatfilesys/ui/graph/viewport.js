/**
 * ChatFilesys — 图视图 · 视口数学（B4）
 *
 * **纯函数，零 DOM**（L1-MR-6：纯逻辑层禁 DOM 依赖）——故可在 `node --test` 下直接测。
 * `ui/graph/view.js` 只负责把这些结果贴到 SVG 上。
 *
 * ── 坐标口径（写死在这里，别处不许再定义） ──
 * - **世界坐标** = 布局服务（B3）给的坐标，单位 px，`x`/`y` 是**节点中心**（dagre 惯例）
 * - **屏幕坐标** = 视口容器内的像素，`(0,0)` 在容器左上
 * - 变换只有 `{scale, tx, ty}` 三个数：`screen = world * scale + t`
 *
 * 用「中心点 + 显式宽高」而不是「左上角 + 右下角」，是因为 B3 两条布局路径
 * （dagre / 迭代分层）都产出中心点；换口径会让两条路径的产物需要各自解释一遍。
 */

/** 视口变换的恒等元 */
export const IDENTITY = Object.freeze({ scale: 1, tx: 0, ty: 0 });

/** 缩放上下限（与既有的分支树 pan/zoom 同量级；超出这个范围没有可读性可言） */
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 4;

/** 把 scale 夹进允许区间（非有限值 → 回落到 `fallback`） */
export function clampScale(scale, { min = SCALE_MIN, max = SCALE_MAX } = {}) {
    const s = Number(scale);
    if (!Number.isFinite(s)) return min;
    return Math.min(max, Math.max(min, s));
}

/** 世界 → 屏幕 */
export function toScreen(t, point) {
    const scale = Number(t?.scale) || 0;
    return {
        x: (Number(point?.x) || 0) * scale + (Number(t?.tx) || 0),
        y: (Number(point?.y) || 0) * scale + (Number(t?.ty) || 0),
    };
}

/** 屏幕 → 世界（`toScreen` 的逆；scale 为 0 时返回屏幕点本身，不产生 NaN/Infinity） */
export function toWorld(t, point) {
    const scale = Number(t?.scale) || 0;
    if (!scale) return { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
    return {
        x: ((Number(point?.x) || 0) - (Number(t?.tx) || 0)) / scale,
        y: ((Number(point?.y) || 0) - (Number(t?.ty) || 0)) / scale,
    };
}

/**
 * 一组节点的包围盒（**世界坐标**，含节点自身的宽高，故是「外接」而不是「中心点集」）。
 * @param {Object<string, {x:number,y:number,width?:number,height?:number}>} positions
 * @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}|null}
 *   没有任何可用坐标 → `null`（调用方自己决定怎么办，别在这里编一个空盒子）
 */
export function boundsOf(positions) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const p of Object.values(positions || {})) {
        const x = Number(p?.x), y = Number(p?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const w = Number.isFinite(Number(p?.width)) ? Number(p.width) : 0;
        const h = Number.isFinite(Number(p?.height)) ? Number(p.height) : 0;
        any = true;
        minX = Math.min(minX, x - w / 2);
        maxX = Math.max(maxX, x + w / 2);
        minY = Math.min(minY, y - h / 2);
        maxY = Math.max(maxY, y + h / 2);
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 「整图装进视口」的变换（等比缩放 + 居中；图比视口小时**不放大超过 1**，
 * 否则三五个节点会被拉成一屏怪兽）。
 *
 * @param {{minX:number,minY:number,width:number,height:number}|null} bounds
 * @param {{width:number,height:number}} viewport 视口尺寸（屏幕 px）
 * @param {{padding?:number, maxScale?:number}} [opts]
 * @returns {{scale:number,tx:number,ty:number}}
 */
export function fitTransform(bounds, viewport, opts = {}) {
    const pad = Number.isFinite(Number(opts.padding)) ? Number(opts.padding) : 16;
    const vw = Math.max(1, Number(viewport?.width) || 0);
    const vh = Math.max(1, Number(viewport?.height) || 0);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        // 没有尺寸（单节点 / 空图）：放个 1 倍居中原点，别给 NaN
        return { scale: 1, tx: vw / 2 - (Number(bounds?.minX) || 0), ty: vh / 2 - (Number(bounds?.minY) || 0) };
    }
    const availW = Math.max(1, vw - pad * 2);
    const availH = Math.max(1, vh - pad * 2);
    const raw = Math.min(availW / bounds.width, availH / bounds.height);
    const cap = Number.isFinite(Number(opts.maxScale)) ? Number(opts.maxScale) : 1;
    const scale = clampScale(Math.min(raw, cap));
    const cx = bounds.minX + bounds.width / 2;
    const cy = bounds.minY + bounds.height / 2;
    return { scale, tx: vw / 2 - cx * scale, ty: vh / 2 - cy * scale };
}

/**
 * 以某个**屏幕锚点**为中心缩放（滚轮缩放的标准做法：锚点下的世界坐标缩放前后不动）。
 * @param {{scale:number,tx:number,ty:number}} t
 * @param {number} factor 缩放倍率（>1 放大）
 * @param {{x:number,y:number}} anchor 屏幕坐标
 */
export function zoomAt(t, factor, anchor) {
    const cur = clampScale(Number(t?.scale) || 1);
    const next = clampScale(cur * (Number(factor) || 1));
    const ax = Number(anchor?.x) || 0;
    const ay = Number(anchor?.y) || 0;
    const tx = Number(t?.tx) || 0;
    const ty = Number(t?.ty) || 0;
    return {
        scale: next,
        tx: ax - (ax - tx) * (next / cur),
        ty: ay - (ay - ty) * (next / cur),
    };
}

/** 拖拽平移（屏幕像素增量直接加到 `t` 上——因为 `t` 就是屏幕空间平移量） */
export function panBy(t, dx, dy) {
    return {
        scale: Number(t?.scale) || 1,
        tx: (Number(t?.tx) || 0) + (Number(dx) || 0),
        ty: (Number(t?.ty) || 0) + (Number(dy) || 0),
    };
}

/**
 * 命中测试：屏幕点落在哪个节点里（**后绘制的在上层**，故从后往前找）。
 *
 * 判据用**世界坐标的矩形**（把屏幕点反变换回世界再去比），而不是把每个节点变换到屏幕——
 * 节点数多时前者只做一次除法，后者要做 N 次乘法。
 *
 * @param {string[]} order 绘制顺序（`positions` 的键序；后面的盖前面的）
 * @param {Object<string, {x:number,y:number,width?:number,height?:number}>} positions
 * @param {{scale:number,tx:number,ty:number}} t
 * @param {{x:number,y:number}} screenPoint
 * @param {number} [slack] 额外容差（屏幕 px，缩放小的时候手指点不准）
 * @returns {string|null} 命中的节点 id
 */
export function hitTest(order, positions, t, screenPoint, slack = 0) {
    const w = toWorld(t, screenPoint);
    const scale = Number(t?.scale) || 1;
    const pad = (Number(slack) || 0) / (scale || 1);
    const list = Array.isArray(order) ? order : Object.keys(positions || {});
    for (let i = list.length - 1; i >= 0; i--) {
        const id = list[i];
        const p = positions?.[id];
        if (!p) continue;
        const hw = (Number.isFinite(Number(p.width)) ? Number(p.width) : 0) / 2 + pad;
        const hh = (Number.isFinite(Number(p.height)) ? Number(p.height) : 0) / 2 + pad;
        if (Math.abs(w.x - (Number(p.x) || 0)) <= hw && Math.abs(w.y - (Number(p.y) || 0)) <= hh) return id;
    }
    return null;
}

/**
 * 视口内可见的节点（裁剪用；`margin` 给屏幕 px 的余量，避免边缘节点进出时闪）。
 * @returns {string[]} 可见 id（保持传入顺序）
 */
export function visibleNodes(order, positions, t, viewport, margin = 64) {
    const scale = Number(t?.scale) || 1;
    const m = (Number(margin) || 0) / (scale || 1);
    const tl = toWorld(t, { x: -m * scale, y: -m * scale });
    const br = toWorld(t, {
        x: (Number(viewport?.width) || 0) + m * scale,
        y: (Number(viewport?.height) || 0) + m * scale,
    });
    const out = [];
    for (const id of Array.isArray(order) ? order : Object.keys(positions || {})) {
        const p = positions?.[id];
        if (!p) continue;
        const hw = (Number.isFinite(Number(p.width)) ? Number(p.width) : 0) / 2;
        const hh = (Number.isFinite(Number(p.height)) ? Number(p.height) : 0) / 2;
        if (p.x + hw < tl.x || p.x - hw > br.x || p.y + hh < tl.y || p.y - hh > br.y) continue;
        out.push(id);
    }
    return out;
}

/**
 * 从一个**屏幕矩形**反算世界矩形（框选用；也用来给小地图画取景框）。
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function screenRectToWorld(t, rect) {
    const a = toWorld(t, { x: rect?.x, y: rect?.y });
    const b = toWorld(t, { x: (Number(rect?.x) || 0) + (Number(rect?.width) || 0),
        y: (Number(rect?.y) || 0) + (Number(rect?.height) || 0) });
    return {
        minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
    };
}

/**
 * 小地图上「当前视口」的那个框（**小地图自己那套坐标**：整图等比缩进小地图画布）。
 *
 * **结果被夹在小地图画布内**——不是修饰，是必要性：把整图装进视口时，视口实际看到的世界范围
 * 可能**大于整图**（四周留白也算看到了），此时未夹的框会画到画布外，用户只看到半个框，
 * 反而以为「还有东西没显示」。夹住之后语义变成「你把整张图都看到了」，这才是真的。
 *
 * @param {object} bounds 整图世界包围盒
 * @param {{scale:number,tx:number,ty:number}} t 主视口变换
 * @param {{width:number,height:number}} viewport 主视口尺寸
 * @param {{width:number,height:number}} mini 小地图尺寸
 * @returns {{x:number,y:number,width:number,height:number}} 小地图坐标下的取景框（已夹在画布内）
 */
export function minimapViewportRect(bounds, t, viewport, mini) {
    const b = bounds || { minX: 0, minY: 0, width: 1, height: 1 };
    const mw = Math.max(1, Number(mini?.width) || 1);
    const mh = Math.max(1, Number(mini?.height) || 1);
    const k = Math.min(mw / Math.max(1, b.width), mh / Math.max(1, b.height));
    // 世界 → 小地图
    const project = (p) => ({
        x: (p.x - b.minX) * k + (mw - b.width * k) / 2,
        y: (p.y - b.minY) * k + (mh - b.height * k) / 2,
    });
    const topLeft = toWorld(t, { x: 0, y: 0 });
    const bottomRight = toWorld(t, { x: Number(viewport?.width) || 0, y: Number(viewport?.height) || 0 });
    const a = project(topLeft);
    const c = project(bottomRight);
    const x1 = Math.min(a.x, c.x);
    const y1 = Math.min(a.y, c.y);
    const x2 = Math.max(a.x, c.x);
    const y2 = Math.max(a.y, c.y);
    // 夹进画布（浮点留一点余量，免得 148.0000001 被断言成越界）
    const cx1 = Math.max(0, Math.min(mw, x1));
    const cy1 = Math.max(0, Math.min(mh, y1));
    const cx2 = Math.max(0, Math.min(mw, x2));
    const cy2 = Math.max(0, Math.min(mh, y2));
    return { x: cx1, y: cy1, width: cx2 - cx1, height: cy2 - cy1 };
}
