/**
 * ChatFilesys — 长聊天对齐的 Worker 运行器（implement-v2 C1.3）
 *
 * 一个文件两半：
 * · **主线程侧** `createAlignRunner` —— spawn/复用 Worker、协议收发、取消桥接、dispose；
 *   无 `Worker` 环境（node 单测 / 老宿主）自动**主线程分片降级**（`alignLinearAsync` 内部
 *   12ms 门限让出调度），结果与 Worker 路径一致（同一份 `planFamilyMerge`）。
 * · **Worker 侧** 接线 —— 收 `start`/`cancel`，回 `progress`/`result`/`error`；同一进程内
 *   用**普通对象旗标**传取消（design-v2：AbortSignal 不能 postMessage，取消消息只传 operationId）。
 *
 * 协议（`ALIGN_MSG`）：
 *   main → worker: {type:'start',  opId, aRows, bRows, opts:{maxCells, yieldEvery}}
 *                  {type:'cancel', opId}
 *   worker → main: {type:'progress', opId, progress}
 *                  {type:'result',  opId, plan}
 *                  {type:'error',   opId, message}
 *
 * 生命周期纪律（`L1-MR-8`）：`dispose()` 必须 `terminate()` 且把引用**置 null** ——
 * 被 terminate 的 Worker 会静默忽略后续 postMessage，忘置空 = 每一次后续对齐永久挂死。
 * dispose 后 runner 仍可复用（下次 `run` 重建）。
 */

import { planFamilyMerge } from './family-align.js';

/** 消息类型常量（协议契约，单测钉住五种齐全） */
export const ALIGN_MSG = Object.freeze({
    START: 'start',
    CANCEL: 'cancel',
    PROGRESS: 'progress',
    RESULT: 'result',
    ERROR: 'error',
});

/**
 * 创建对齐运行器。
 * @param {{workerFactory?: null|(url:URL)=>Worker}} [opts]
 *   `workerFactory: null` 强制主线程降级（测试用）；缺省在浏览器里用 module Worker。
 * @returns {{run:Function, dispose:Function, hasWorker:boolean}}
 */
export function createAlignRunner({ workerFactory } = {}) {
    const canWorker = typeof Worker !== 'undefined';
    let worker = null; // **唯一持有者**；dispose 后置 null（L1-MR-8）
    let seq = 0;
    const pending = new Map(); // opId → {resolve, reject, onProgress}

    function ensureWorker() {
        if (worker || !canWorker) return worker;
        const factory = workerFactory ?? ((url) => new Worker(url, { type: 'module' }));
        worker = factory(new URL('./family-align-worker.js', import.meta.url));
        worker.onmessage = (ev) => {
            const m = ev?.data || {};
            const p = pending.get(m.opId);
            if (!p) return;
            if (m.type === ALIGN_MSG.RESULT) { pending.delete(m.opId); p.resolve(m.plan); } 
            else if (m.type === ALIGN_MSG.ERROR) { pending.delete(m.opId); p.reject(new Error(m.message)); } 
            else if (m.type === ALIGN_MSG.PROGRESS) { p.onProgress?.(m.progress); }
        };
        worker.onerror = (ev) => {
            const err = new Error(String(ev?.message || 'align worker error'));
            for (const [, p] of pending) p.reject(err);
            pending.clear();
        };
        return worker;
    }

    /**
     * 跑一次对齐预览。取消约定：**以计划形式返回**（`uncertain/aborted`），不 reject、不悬挂
     * —— 取消是正常控制流，不是错误（spec：取消反馈有界，结果不能谎报）。
     * @param {Array<object>} aRows
     * @param {Array<object>} bRows
     * @param {{signal?:AbortSignal, abortFlag?:{aborted:boolean}, onProgress?:Function,
     *          maxCells?:number, yieldEvery?:number}} [opts]
     */
    async function run(aRows, bRows, { signal, abortFlag, onProgress, maxCells, yieldEvery } = {}) {
        const opId = `align-${++seq}`;
        if (!canWorker) {
            // 主线程分片降级：把 AbortSignal 桥接成普通旗标；分片让出在 alignLinearAsync 内部
            const flag = abortFlag ?? { aborted: Boolean(signal?.aborted) };
            if (signal && !abortFlag) {
                signal.addEventListener('abort', () => { flag.aborted = true; }, { once: true });
            }
            return planFamilyMerge({ aRows, bRows, abortFlag: flag, maxCells, onProgress, yieldEvery });
        }
        const w = ensureWorker();
        return new Promise((resolve, reject) => {
            pending.set(opId, { resolve, reject, onProgress });
            w.postMessage({ type: ALIGN_MSG.START, opId, aRows, bRows, opts: { maxCells, yieldEvery } });
            if (signal) {
                signal.addEventListener('abort', () => {
                    w.postMessage({ type: ALIGN_MSG.CANCEL, opId });
                }, { once: true });
            }
        });
    }

    /** 终止并置空（幂等）；dispose 后可继续 `run`（惰性重建）。 */
    function dispose() {
        if (worker) {
            worker.terminate();
            worker = null; // L1-MR-8：terminate 后必须置空引用
        }
        const err = new Error('[disposed] 对齐运行器已销毁');
        for (const [, p] of pending) p.reject(err);
        pending.clear();
    }

    return { run, dispose, hasWorker: canWorker };
}

/* ---------------- Worker 侧接线（非 Worker 环境跳过 —— node 直接 import 不炸） ---------------- */

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
    const runs = new Map(); // opId → 取消旗标（同进程普通对象，不传 AbortSignal）
    self.onmessage = async (ev) => {
        const m = ev?.data || {};
        if (m.type === ALIGN_MSG.START) {
            const flag = { aborted: false };
            runs.set(m.opId, flag);
            try {
                const plan = await planFamilyMerge({
                    aRows: m.aRows,
                    bRows: m.bRows,
                    maxCells: m.opts?.maxCells,
                    yieldEvery: m.opts?.yieldEvery,
                    abortFlag: flag,
                    onProgress: (p) => {
                        if (!flag.aborted) self.postMessage({ type: ALIGN_MSG.PROGRESS, opId: m.opId, progress: p });
                    },
                });
                self.postMessage({ type: ALIGN_MSG.RESULT, opId: m.opId, plan });
            } catch (e) {
                self.postMessage({ type: ALIGN_MSG.ERROR, opId: m.opId, message: String(e?.message || e) });
            } finally {
                runs.delete(m.opId);
            }
        } else if (m.type === ALIGN_MSG.CANCEL) {
            const flag = runs.get(m.opId);
            if (flag) flag.aborted = true; // 下一行检查即停：取消有界
        }
    };
}
