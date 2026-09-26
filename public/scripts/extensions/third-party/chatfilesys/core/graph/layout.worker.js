/**
 * ChatFilesys — 布局 Worker（B3）
 *
 * **本文件是「不要重犯 TL 那个坑」的地方**，务必看清下面两行：
 *
 *   TL 的写法：`new Worker(url, { type: 'module' })` **却**在 worker 里调 `importScripts(...)`。
 *   module worker 里 **没有** `importScripts` → 每次都抛 → 它静默退回主线程，布局从未真正在
 *   worker 里跑过（`research/TL-1-engine.md` 有实测证据）。
 *
 *   我们的写法：**module worker 里用 `import`**（module worker 的合法方式）。
 *   下面两行 import 各司其职：
 *     ① `import '../.../vendor/dagre.js'` —— 只为**副作用**（UMD 包在 ESM 语境下没有 `exports`/`module`/
 *        `window`，会走 `g = self` 那一支把库挂到 `self.dagre`；这一点由 node 的 `vm` 实验实证过）。
 *     ② `import { planLayout } from './layout.js'` —— 复用同一份布局逻辑（**不复制**一份到 worker 里）。
 *
 * 通信契约（与 `core/graph/layout-request.js` 同源，改一处必改两处）：
 *   收：`{ id, graph, options }`（`options` 里只有数据，dagre 由本 worker 自己拿）
 *   发：`{ id, ok: true, result }` 或 `{ id, ok: false, reason }`
 */

import '../../vendor/dagre.js';
import { planLayout, clipReason } from './layout.js';

self.onmessage = (ev) => {
    const msg = ev?.data ?? {};
    const id = msg.id;
    const dagre = self.dagre;
    const hasApi = Boolean(dagre?.graphlib) && typeof dagre?.layout === 'function';
    let lastErr = null;
    const result = planLayout(msg.graph, {
        ...(msg.options ?? {}),
        dagre,
        onError: (e) => { lastErr = String((e && (e.stack || e.message)) || e); },
    });
    if (!result) {
        // 失败必须给出**可判因**的回执（临场排查时别只剩一句"布局不可用"）
        self.postMessage({ id, ok: false, reason: `布局不可用｜hasApi=${hasApi}`
            + `｜dagreKeys=${Object.keys(dagre || {}).join(',') || '(空)'}`
            + `｜err=${lastErr ? clipReason(lastErr) : '(无异常：看图是否为空)'}` });
        return;
    }
    self.postMessage({ id, ok: true, result });
};
