/**
 * ChatFilesys — 数据源共用的「静默降级」笔记本（铁律 L0-11）
 *
 * 两个实现（文件源 / 库源）都只用这一个笔记本管四件事，保证降级行为**单点**、可断言：
 * - `hint`：**来源自述**（这份数据从哪来、看不到什么）——构造时注入，**不算缺项**，
 *   也不打日志；它让 `describe()` 能解释「两档结果不同不是错，是来源不同」（design.md §6 真机口径）
 * - `sticky`：**源的性质**（不是某一次调用的问题，如「缺省 fetch 在库模式下就是接缝」）——
 *   每次作用域开始时重新记一条（`partial` 由各项自定），同样不打日志
 * - `note(msg, {partial})`：跳过/读失败记录；标 `partial` 的会让 `describe().fidelity` 变 `partial`
 * - `guard(what, fallback, fn)`：包住一次副作用读；异常 → 记一条 + 返回 `fallback`，**绝不抛到上层**
 *
 * **作用域 = 一次公开调用**（`listSessions` / `readSession` / `graphInputs`，实施期定案）：
 * `scope(fn)` 在最外层调用开始时**清空记录**（只留 `hint` 与 `sticky`），
 * `describe()` 报的就是**最近一次调用**的结果；否则记录无界增长、也无法说清「这次」。
 * `scope` 可**重入**：`graphInputs` 内部调 `listSessions` / `readSession` 时不再重置，
 * 于是外层这一次的记录不会被内层调用清掉。
 */

/**
 * @param {{log?: Function, hint?: string|null, sticky?: Array<{msg: string, partial?: boolean}>}} [opts]
 * @returns {{note: Function, scope: Function, guard: Function, list: Function, fidelity: Function}}
 */
export function createSourceNotes({ log = console.warn, hint = null, sticky = [] } = {}) {
    let notes = [];
    let partial = false;
    let inScope = false;

    /** 记一条（`logIt` = 是否同时打到 console：来源自述不打，问题记录打） */
    const push = (msg, impacts, logIt) => {
        const text = String(msg);
        notes.push(text);
        if (impacts) partial = true;
        if (logIt) {
            try { log(`[chatfilesys-source] ${text}`); } catch { /* 日志本身失败与数据面无关 */ }
        }
    };

    /** 回到「本次调用刚开始」的状态：`hint` + `sticky` 常驻，问题记录清空 */
    const reset = () => {
        notes = [];
        partial = false;
        if (hint) push(hint, false, false);
        for (const s of sticky || []) push(s?.msg, Boolean(s?.partial), false);
    };
    reset();

    return {
        /**
         * 记一条问题记录。
         * @param {string} msg
         * @param {{partial?: boolean}} [opts] `partial` = 这条是「跳过/缺项」（影响保真度）
         */
        note(msg, { partial: impacts = false } = {}) {
            push(msg, impacts, true);
        },
        /**
         * 一次公开调用的作用域：最外层调用重置记录；内层嵌套调用沿用外层。
         * @template T
         * @param {() => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async scope(fn) {
            if (inScope) return await fn();
            inScope = true;
            reset();
            try {
                return await fn();
            } finally {
                inScope = false;
            }
        },
        /**
         * 包住一次副作用读：异常降级为 `fallback`（该项为空），不抛。
         * @template T
         * @param {string} what 动作名（进记录，如「枚举聊天文件」）
         * @param {T} fallback 降级返回值
         * @param {() => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async guard(what, fallback, fn) {
            try {
                return await fn();
            } catch (e) {
                push(`${what}失败，本次按空结果处理：${e?.message || e}`, true, true);
                return fallback;
            }
        },
        /** 最近一次公开调用的全部记录（副本；首条通常是来源自述） */
        list() {
            return [...notes];
        },
        /** 保真度：最近一次调用有任何「跳过/缺项」记录 → `partial` */
        fidelity() {
            return partial ? 'partial' : 'full';
        },
    };
}
