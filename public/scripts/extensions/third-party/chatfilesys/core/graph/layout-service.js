/**
 * ChatFilesys — 布局服务（B3）
 *
 * 职责：拿一张图 → 给出坐标。**优先在 Worker 里算**（不占主线程），拿不到就退回主线程（L0-11 静默降级）。
 *
 * **必须能回答「这次是 worker 还是主线程」**（返回值里的 `via`）：TL 的 worker 全程没生效却没人知道
 * （它静默退回主线程，见 `research/TL-1-engine.md`）；我们把它变成**可断言的事实**——真机用例会断言
 * `via === 'worker'`，而不是只看"布局出来了就算过"。
 *
 * 依赖注入（为了可在 node 下单测，不在模块里直接碰 Worker/DOM）：
 *   · `workerUrl`     —— worker 脚本的 URL（调用方给；不给 = 不用 worker，直接主线程）
 *   · `workerFactory` —— 创建 worker 的函数（默认 `new Worker(url, {type:'module'})`）
 *   · `dagre`         —— 主线程那条路用的 dagre（默认取 `self.dagre`，即页面里 `<script>` 加载的那个）
 *   · `timeoutMs`     —— worker 超时（默认 8000ms），超时视为失败并退回主线程
 */

import { planLayout } from './layout.js';

const workerDagre = () => (typeof self !== 'undefined' ? self.dagre : undefined);

let seq = 0;
const nextId = () => `lay-${++seq}`;

/**
 * @param {{workerUrl?: string|null, workerFactory?: Function, dagre?: object,
 *          timeoutMs?: number, log?: Function}} deps
 */
export function createLayoutService(deps = {}) {
    const log = deps.log ?? (() => {});
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 8000;
    const getMainDagre = () => deps.dagre ?? workerDagre();
    const factory = deps.workerFactory
        ?? (typeof Worker !== 'undefined' ? ((url) => new Worker(url, { type: 'module' })) : null);

    const stats = { workerOk: 0, workerFail: 0, mainOk: 0, mainFail: 0, degraded: 0,
        lastVia: null, lastReason: null, lastDegrade: null };
    let worker = null;
    let workerDead = false;      // worker 一旦失败就不再重试（一次失败通常意味着环境不支持）
    const pending = new Map();   // id → {resolve, reject, timer}

    /**
     * 记下「dagre 撑不住、回落迭代分层」这件事。
     * **为什么必须记**：这条回落路径在真机上是常态（真实聊天的图就是长链，dagre 递归 dfs 会爆栈），
     * 而它**不是失败**（坐标照样算得出来）——正因为不失败，才最容易被静默吞掉：
     * 调用方只看到 `kind:'layered'`、stats 里 `workerOk` 还在涨，没人知道为什么布局变朴素了。
     * 这里把真原因同时**带回结果**（`degraded.reason`）并**进日志与 stats**。
     */
    function noteDegrade(r) {
        if (!r?.degraded) return;
        stats.degraded += 1;
        stats.lastDegrade = r.degraded.reason;
        log('[chatfilesys-graph] dagre 撑不住，已回落迭代分层（原因如实回报，非失败）:',
            r.degraded.reason);
    }

    function ensureWorker() {
        if (workerDead || !deps.workerUrl || !factory) return null;
        if (worker) return worker;
        try {
            worker = factory(deps.workerUrl);
            worker.onmessage = (ev) => {
                const { id, ok, result, reason } = ev?.data ?? {};
                const slot = pending.get(id);
                if (!slot) return;
                pending.delete(id);
                clearTimeout(slot.timer);
                if (ok) slot.resolve(result);
                else slot.reject(new Error(reason || 'worker 报告失败'));
            };
            worker.onerror = (e) => {
                // worker 自身出错（脚本加载失败 / 语法错）：判死并让所有在飞的请求失败 → 上层退主线程
                workerDead = true;
                const msg = String((e && (e.message || e.filename)) || 'worker 出错');
                for (const [id, slot] of pending) {
                    pending.delete(id);
                    clearTimeout(slot.timer);
                    slot.reject(new Error(msg));
                }
                log('[chatfilesys-graph] 布局 worker 不可用，后续退回主线程:', msg);
            };
            return worker;
        } catch (e) {
            workerDead = true;
            log('[chatfilesys-graph] 布局 worker 建不起来，退回主线程:', e);
            return null;
        }
    }

    function layoutInWorker(graph, options) {
        const w = ensureWorker();
        if (!w) return Promise.reject(new Error('worker 不可用'));
        const id = nextId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`worker 超时（${timeoutMs}ms）`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            try {
                w.postMessage({ id, graph, options });
            } catch (e) {
                pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    /** 主线程直算（同步）。拿不到 dagre 就返回 null。 */
    function layoutNow(graph, options = {}) {
        let err = null;
        const r = planLayout(graph, {
            ...options,
            dagre: getMainDagre(),
            onError: (e) => { err = String((e && (e.stack || e.message)) || e); },
        });
        if (r) {
            stats.mainOk += 1;
            stats.lastVia = 'main';
            noteDegrade(r);
        } else {
            stats.mainFail += 1;
            // 真错优先（别用泛化文案盖掉具体原因——本仓禁止静默吞错）
            stats.lastReason = err ?? '主线程布局不可用（dagre 未加载或图为空）';
            if (err) log('[chatfilesys-graph] 主线程布局出错:', err);
        }
        return r ? { ...r, via: 'main' } : null;
    }

    /**
     * 布局（异步）：worker 优先，失败/超时/无 worker → 主线程；两条都不行 → `null`（**不抛**）。
     * @returns {Promise<{positions, width, height, order, via: 'worker'|'main'} | null>}
     */
    async function layout(graph, options = {}) {
        if (deps.workerUrl && !workerDead) {
            try {
                const r = await layoutInWorker(graph, options);
                stats.workerOk += 1;
                stats.lastVia = 'worker';
                noteDegrade(r);       // worker 里 dagre 撑不住 → 原因随回执带回来，这里记账并上报
                return r ? { ...r, via: 'worker' } : null;
            } catch (e) {
                stats.workerFail += 1;
                stats.lastReason = String((e && e.message) || e);
                log('[chatfilesys-graph] worker 布局失败，退回主线程:', stats.lastReason);
            }
        }
        return layoutNow(graph, options);
    }

    function dispose() {
        try { worker?.terminate(); } catch { /* 忽略 */ }
        worker = null;
        // dispose = 关停：之后不再新建 worker，直接走主线程（否则"关停后又被悄悄拉起一个 worker"）
        workerDead = true;
        for (const [, slot] of pending) clearTimeout(slot.timer);
        pending.clear();
    }

    const describe = () => ({ ...stats, workerDeclared: Boolean(deps.workerUrl), workerDead });

    return { layout, layoutNow, dispose, describe, stats };
}
