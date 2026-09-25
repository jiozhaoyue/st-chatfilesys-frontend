/**
 * ChatFilesys — 家族版本号（integrity）纯模块（design.md §3，裁定 N19）
 *
 * 形态：**字符串**，每次成功写生成一个新值（形如 `c-<36进制时间戳>-<随机>`）。
 * 为什么不再是数字（T1 前的形态）：
 *  - 宿主 `chat_metadata.integrity` 本来就是字符串（无则自造 uuid），数字形态迫使接缝做
 *    「`cfsys:<n>` slug ⇄ 数字」的双向桥接，且桥接对「非 cfsys 形态的 uuid」只能放行不锁
 *    ——两处同时改同一家族时静默覆盖（N19 要修掉的正是这一条）。
 *  - 改字符串后，接缝不再桥接、不再放行：入向值必须与库内值**字符串相等**才允许写。
 *
 * 兼容：库内历史行可能是数字（SQLite 动态类型 / 早期建档），`normIntegrity` 统一转字符串后比较。
 */

/**
 * 生成新的版本号（成功写一次一个新值）。
 * 时间戳保证可读排序，随机后缀保证同毫秒内不撞。
 * @returns {string}
 */
export function nextIntegrity() {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 版本号归一：空/未定义 → null（表示「没带版本号」或「库内尚未写过」）；其余转字符串。
 * @param {unknown} v
 * @returns {string|null}
 */
export function normIntegrity(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/**
 * 是否版本冲突（乐观锁判定；三档适配器共用同一语义）。
 * 放行（false）的两种情形：
 *  - `expected` 为空 → 调用方未带版本号（例如宿主原生 saveChat 不带 integrity，或 force 覆盖）
 *  - 库内为空 → 家族尚未写过，放行首次写
 * @param {unknown} expected 入向
 * @param {unknown} current 库内
 * @returns {boolean}
 */
export function integrityConflict(expected, current) {
    const e = normIntegrity(expected);
    if (e === null) return false;
    const c = normIntegrity(current);
    if (c === null) return false;
    return e !== c;
}
