/**
 * 图视图单测（B4 / AC2）：`ui/graph/viewport.js` + `ui/graph/degrade.js`
 *
 * 只测**纯函数层**（无 DOM，`node --test` 下直接跑）。DOM 那一层（`view.js` / `minimap.js`）
 * 由真机 e2e `tests/e2e/test_graph_view.py` 覆盖——本仓的规矩是：
 * 纯逻辑必须有单测（快、可穷举），DOM 必须有真机（真浏览器、真宿主）。
 *
 * ── 三组各钉住一件**真会出错**的事（不是凑数） ──
 * 1. **变换可逆且锚点不漂**：`toWorld(toScreen(p)) === p`；滚轮缩放时锚点下的世界坐标前后不动
 *    （不满足这条，用户会看到「越缩放越跑偏」——这是 canvas 类视图最常见的 bug）
 * 2. **命中用坐标而不是事件目标**：分片渲染中途节点还没画出来时，事件目标是 svg 本身；
 *    只靠 `e.target` 的实现会点空。本组直接对着 `hitTest` 断言，与 DOM 无关
 * 3. **降级原因必须挂在返回值上**（B3 的教训）：`reasons` 恒为数组，且每一档都能说出为什么。
 *    只 `console.warn` 的实现必红——因为这里根本不给它日志可断言
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    IDENTITY, SCALE_MIN, SCALE_MAX, clampScale, toScreen, toWorld, boundsOf, fitTransform,
    zoomAt, panBy, hitTest, visibleNodes, screenRectToWorld, minimapViewportRect,
} from '../../public/scripts/extensions/third-party/chatfilesys/ui/graph/viewport.js';
import { planDegrade, DEGRADE_DEFAULTS } from '../../public/scripts/extensions/third-party/chatfilesys/ui/graph/degrade.js';

/* ---------------- 夹具 ---------------- */

/** 一颗「节点 → 坐标」的格子：宽度 100 高度 40，中心坐标 */
function grid(cols, rows) {
    const positions = {};
    const order = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const id = `n${r}_${c}`;
            positions[id] = { x: c * 120, y: r * 60, width: 100, height: 40 };
            order.push(id);
        }
    }
    return { positions, order };
}

/* ---------------- 1. 变换与取景 ---------------- */

test('viewport：toWorld 是 toScreen 的逆（任意变换下逐个点都对得上）', () => {
    const t = { scale: 1.7, tx: -33, ty: 12.5 };
    for (const p of [{ x: 0, y: 0 }, { x: 123.5, y: -88 }, { x: -7, y: 7 }]) {
        const back = toWorld(t, toScreen(t, p));
        assert.ok(Math.abs(back.x - p.x) < 1e-9, `x 往返：${back.x} vs ${p.x}`);
        assert.ok(Math.abs(back.y - p.y) < 1e-9, `y 往返：${back.y} vs ${p.y}`);
    }
});

test('viewport：scale 为 0 时不产生 NaN/Infinity（退化变换也要能算）', () => {
    const w = toWorld({ scale: 0, tx: 0, ty: 0 }, { x: 5, y: 6 });
    assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y), '不允许出现 NaN/Infinity');
});

test('viewport：滚轮缩放的锚点不动（这条不成立 ⇒ 用户看到「越缩放越跑偏」）', () => {
    const t = { scale: 1, tx: 10, ty: 20 };
    const anchor = { x: 300, y: 180 };
    const before = toWorld(t, anchor);
    const after = toWorld(zoomAt(t, 1.5, anchor), anchor);
    assert.ok(Math.abs(after.x - before.x) < 1e-9, `锚点世界 x 漂了：${before.x} → ${after.x}`);
    assert.ok(Math.abs(after.y - before.y) < 1e-9, `锚点世界 y 漂了：${before.y} → ${after.y}`);
});

test('viewport：clampScale 夹住上下限、非有限值回落（不给 NaN 进画笔）', () => {
    assert.equal(clampScale(1e9), SCALE_MAX);
    assert.equal(clampScale(1e-9), SCALE_MIN);
    assert.equal(clampScale(Number.NaN), SCALE_MIN);
    assert.equal(clampScale(undefined), SCALE_MIN);
    assert.equal(clampScale(2), 2);
});

test('viewport：panBy 是屏幕空间平移（直接加到 tx/ty，不改 scale）', () => {
    const t = panBy({ scale: 2, tx: 5, ty: 5 }, 10, -3);
    assert.deepEqual(t, { scale: 2, tx: 15, ty: 2 });
});

test('viewport：boundsOf 取的是**外接**盒子（含宽高，不是中心点集）', () => {
    const b = boundsOf({ a: { x: 0, y: 0, width: 100, height: 40 }, b: { x: 200, y: 100, width: 100, height: 40 } });
    assert.equal(b.minX, -50);
    assert.equal(b.maxX, 250);
    assert.equal(b.minY, -20);
    assert.equal(b.maxY, 120);
    assert.equal(b.width, 300);
    assert.equal(b.height, 140);
});

test('viewport：boundsOf 对空/坏坐标返回 null（不编一个空盒子）', () => {
    assert.equal(boundsOf({}), null);
    assert.equal(boundsOf(null), null);
    assert.equal(boundsOf({ a: { x: Number.NaN, y: 1 } }), null);
});

test('viewport：fitTransform 把整图装进视口且**不放大超过 1**（三五个节点不该撑成一屏）', () => {
    const vp = { width: 800, height: 600 };
    const small = fitTransform({ minX: 0, minY: 0, width: 100, height: 50 }, vp);
    assert.equal(small.scale, 1, '图比视口小 ⇒ 不放大');

    const big = fitTransform({ minX: 0, minY: 0, width: 3200, height: 2400 }, vp);
    assert.ok(big.scale < 1, '图比视口大 ⇒ 缩小');
    // 装得下：变换后的包围盒必须落在视口内
    const tl = toScreen(big, { x: 0, y: 0 });
    const br = toScreen(big, { x: 3200, y: 2400 });
    assert.ok(tl.x >= -0.5 && tl.y >= -0.5, `左上角跑到视口外：${JSON.stringify(tl)}`);
    assert.ok(br.x <= vp.width + 0.5 && br.y <= vp.height + 0.5, `右下角跑到视口外：${JSON.stringify(br)}`);
});

test('viewport：fitTransform 对「单节点/空图」给确定答案（不给 NaN）', () => {
    const t = fitTransform(null, { width: 400, height: 300 });
    assert.ok(Number.isFinite(t.scale) && Number.isFinite(t.tx) && Number.isFinite(t.ty));
    const t2 = fitTransform({ minX: 5, minY: 5, width: 0, height: 0 }, { width: 400, height: 300 });
    assert.ok(Number.isFinite(t2.tx) && Number.isFinite(t2.ty));
});

/* ---------------- 2. 命中与裁剪 ---------------- */

test('viewport：hitTest 命中节点矩形，落在空隙返回 null', () => {
    const { positions, order } = grid(3, 3);
    const t = IDENTITY;
    // n0_0 中心在 (0,0)，宽 100 高 40
    assert.equal(hitTest(order, positions, t, { x: 0, y: 0 }), 'n0_0');
    assert.equal(hitTest(order, positions, t, { x: 49, y: 19 }), 'n0_0', '边界内');
    assert.equal(hitTest(order, positions, t, { x: 51, y: 0 }), null, '出了右边界');
    // n1_1 中心 (120, 60)
    assert.equal(hitTest(order, positions, t, { x: 120, y: 60 }), 'n1_1');
});

test('viewport：hitTest 在缩放/平移后仍然对（判据走世界坐标）', () => {
    const { positions, order } = grid(2, 2);
    const t = { scale: 0.5, tx: 37, ty: -11 };
    const center = toScreen(t, positions.n1_1);      // 把 n1_1 的中心搬到屏幕上某个点
    assert.equal(hitTest(order, positions, t, center), 'n1_1');
    assert.equal(hitTest(order, positions, t, { x: center.x + 200, y: center.y }), null);
});

test('viewport：hitTest 的 slack 是**屏幕像素**（缩放小时手指点不准）', () => {
    const { positions, order } = grid(1, 1);
    const t = { scale: 0.2, tx: 0, ty: 0 };          // 缩到 20%：节点在屏幕上只有 20×8
    const center = toScreen(t, positions.n0_0);
    const off = { x: center.x + 40, y: center.y };   // 屏幕外 40px
    assert.equal(hitTest(order, positions, t, off, 0), null, '不容差 ⇒ 点空');
    assert.equal(hitTest(order, positions, t, off, 60), 'n0_0', '给 60px 容差 ⇒ 命中（容差按屏幕算，已折进世界）');
});

test('viewport：visibleNodes 裁掉视口外的（留 margin），且保持传入顺序', () => {
    const { positions, order } = grid(5, 5);
    const t = IDENTITY;
    // 视口 130×70；节点宽 100 高 40 —— 判据含**节点自身尺度**（部分可见也要画），
    // 故第一行两个（中心 y=0）与第二行两个（中心 y=60，上沿 40 仍在视口内）在内
    const vis = visibleNodes(order, positions, t, { width: 130, height: 70 }, 0);
    assert.deepEqual(vis, ['n0_0', 'n0_1', 'n1_0', 'n1_1']);
    // 顺序与传入一致（不是被重排）
    const src = order.filter((id) => vis.includes(id));
    assert.deepEqual(vis, src, '可见集必须保持传入顺序');
    // 收紧到只够第一行 ⇒ 第二行被裁掉（证明这条断言有能力变红）
    const tight = visibleNodes(order, positions, t, { width: 130, height: 30 }, 0);
    assert.deepEqual(tight, ['n0_0', 'n0_1'], '视口变矮 ⇒ 第二行必须被裁掉');
});

test('viewport：screenRectToWorld 给出规范化矩形（min<max）', () => {
    const r = screenRectToWorld({ scale: 2, tx: 100, ty: 100 }, { x: 0, y: 0, width: 40, height: 20 });
    assert.ok(r.minX < r.maxX && r.minY < r.maxY);
    assert.equal(r.minX, -50);
    assert.equal(r.minY, -50);
});

test('viewport：minimapViewportRect 夹在小地图画布内（视野大于整图时铺满，不画出框外）', () => {
    const bounds = { minX: 0, minY: 0, width: 1000, height: 800 };
    const t = fitTransform(bounds, { width: 400, height: 300 });
    const r = minimapViewportRect(bounds, t, { width: 400, height: 300 }, { width: 148, height: 96 });
    assert.ok(r.x >= -0.5 && r.y >= -0.5, `取景框跑到左上外：${JSON.stringify(r)}`);
    assert.ok(r.x + r.width <= 148.5, `取景框右边界越界：${r.x + r.width}`);
    assert.ok(r.y + r.height <= 96.5, `取景框下边界越界：${r.y + r.height}`);
    assert.ok(r.width > 0 && r.height > 0);

    // 放大到只看图的一小块 ⇒ 框必须**明显变小**（证明夹取没把信息夹没）
    const zoomed = zoomAt(t, 6, { x: 200, y: 150 });
    const rz = minimapViewportRect(bounds, zoomed, { width: 400, height: 300 }, { width: 148, height: 96 });
    assert.ok(rz.width < r.width && rz.height < r.height, `放大后取景框应变小：${r.width}→${rz.width}`);
});

/* ---------------- 3. 降级判定 ---------------- */

test('degrade：小图小视口之外 = full 档，且 reasons 为空数组（不是 undefined）', () => {
    const d = planDegrade({ nodeCount: 20, viewportWidth: 900, viewportHeight: 700 });
    assert.equal(d.tier, 'full');
    assert.deepEqual(d.reasons, []);
    assert.equal(d.minimap, true);
    assert.equal(d.edgeLabels, true);
    assert.equal(d.chunked, false);
});

test('degrade：reasons 恒为数组且是**人话**（含数字与后果）——只 console.warn 的实现必红', () => {
    const d = planDegrade({ nodeCount: 1500, viewportWidth: 900, viewportHeight: 700 });
    assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, '降级必须带原因');
    for (const r of d.reasons) {
        assert.equal(typeof r, 'string');
        assert.ok(r.length > 6, `原因太短，看不懂：${r}`);
        assert.ok(/\d/.test(r), `原因里应带上触发它的数字：${r}`);
    }
});

test('degrade：节点多 ⇒ 关小地图、关边标签；更多 ⇒ 分片渲染（阈值可被设置覆盖）', () => {
    const mid = planDegrade({ nodeCount: DEGRADE_DEFAULTS.minimapNodeBudget + 1, viewportWidth: 900, viewportHeight: 700 });
    assert.equal(mid.minimap, false);
    assert.equal(mid.edgeLabels, false);
    assert.equal(mid.tier, 'lite');

    const big = planDegrade({ nodeCount: DEGRADE_DEFAULTS.chunkNodeBudget + 1, viewportWidth: 900, viewportHeight: 700 });
    assert.equal(big.chunked, true);
    assert.equal(big.tier, 'minimal');
    assert.ok(big.chunkSize > 0);

    // 覆盖阈值：把 minimapNodeBudget 调到 10 ⇒ 20 个节点就已经降级
    const custom = planDegrade({ nodeCount: 20, viewportWidth: 900, viewportHeight: 700 }, { minimapNodeBudget: 10 });
    assert.equal(custom.minimap, false, '阈值覆盖必须生效（设置页要能改它）');
});

test('degrade：小视口关小地图（它自己也要地方）', () => {
    const d = planDegrade({ nodeCount: 10, viewportWidth: 200, viewportHeight: 200 });
    assert.equal(d.minimap, false);
    assert.ok(d.reasons.some((r) => r.includes('视口')), '要说清是视口小，不是节点多');
});

test('degrade：reducedMotion 关动画但**不算失败**（tier 不因此下降）', () => {
    const d = planDegrade({ nodeCount: 10, viewportWidth: 900, viewportHeight: 700, reducedMotion: true });
    assert.equal(d.animate, false);
    assert.equal(d.tier, 'full');
    assert.ok(d.reasons.some((r) => r.includes('减少动效')));
});

test('degrade：forcedMinimal 直接落最小档（设置里的强制开关）', () => {
    const d = planDegrade({ nodeCount: 5, viewportWidth: 900, viewportHeight: 700, forcedMinimal: true });
    assert.equal(d.tier, 'minimal');
    assert.equal(d.chunked, true);
    assert.ok(d.reasons.some((r) => r.includes('强制')));
});

test('degrade：分片大小随节点数放大（否则 5000 节点要一帧一帧长出来）', () => {
    const a = planDegrade({ nodeCount: 1300, viewportWidth: 900, viewportHeight: 700 });
    const b = planDegrade({ nodeCount: 6000, viewportWidth: 900, viewportHeight: 700 });
    assert.ok(b.chunkSize > a.chunkSize, `大图应给更大的批：${a.chunkSize} → ${b.chunkSize}`);
});
