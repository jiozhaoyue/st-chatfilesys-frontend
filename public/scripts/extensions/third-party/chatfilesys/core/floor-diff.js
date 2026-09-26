/**
 * ChatFilesys — 楼层差量（W1：宿主原生删消息后的层号重排）
 *
 * 问题：JSONL 增强模式（`storage_mode='off'`）下分支模型住在聊天文件头里，宿主的
 * `chat_metadata` 副本**不会**随删消息重排楼层号；纯库/双写由接缝在 `remove /N` 时统一重排
 * （`core/patch-rows.js`），于是三模式行为不一致（R4 的旅程明确包含「删层」）。
 *
 * 真机事实（Dev Luker 源码核实，2026-09-25）：
 * - `MESSAGE_DELETED` 载荷 = `(chat.length, { kind:'delete', deletedPlayableSeq* })`——
 *   **不含被删下标**，从事件本身推不出删的是哪一层；
 * - 全部删除路径（`messages.js#deleteMessages` 的 splice、`script.js#deleteLastMessage`、
 *   注释里那处从某层删到末尾、以及重生成失败回退）都是**原地**改 `chat` 数组：
 *   幸存的消息**对象引用不变**，且相对顺序不变；
 * - 消息编辑 / 换 swipe 是 `Object.assign(chat[i], patch)` 原地改（引用不变）；
 * - 重新加载聊天（`getChat`/`clearChat(clearData)`）会整批换成新对象，但它后面必跟
 *   `CHAT_CHANGED`（调用方在那里重取基线），不会走到本模块的判定上。
 *
 * 于是用「基线快照的**引用**对比」反推被删楼层：既精确（不是内容启发式），也不依赖任何猜测。
 * 判定不通过（对象被换过、当前里出现了基线没有的对象）→ 返回 `null`，调用方**不得改模型**。
 *
 * 纯函数：无 DOM、无网络、无适配器依赖，可单测。
 */

/**
 * 从「改动前的 body 快照」与「改动后的 body」反推被删楼层号（1 基）。
 *
 * 判定规则（严格保守，任一不满足即 `null`）：
 *  1. 当前行数必须**少于**基线行数（行数不变或变多 = 不是删除，交给各自的既有路径处理）
 *  2. 贪心对齐：当前每一行都必须在基线里按**同一对象引用**、按**相对顺序**找得到
 *     （找不到 = 对象被换过/不是「只删了若干层」→ 不判定）
 * 对不上的基线位置即被删楼层。
 *
 * @param {Array<object>|null} baseline 改动前的 body（消息对象数组的快照）
 * @param {Array<object>|null} current 改动后的 body（`ctx.chat`）
 * @returns {number[]|null} 被删楼层号升序；无法判定返回 null
 */
export function detectRemovedFloors(baseline, current) {
    if (!Array.isArray(baseline) || !Array.isArray(current)) return null;
    if (current.length >= baseline.length) return null;

    const removed = [];
    let i = 0; // 基线游标
    let j = 0; // 当前游标
    while (i < baseline.length && j < current.length) {
        if (baseline[i] === current[j]) { i++; j++; continue; }
        removed.push(i + 1); // 基线这一位在当前里没有 → 第 i+1 层被删
        i++;
    }
    // 当前还剩没对齐的行 → 出现了基线里没有的对象，不是「只删了若干层」→ 不判定
    if (j !== current.length) return null;
    // 基线尾部整段被删（删最后一条 / 从某层删到末尾）
    while (i < baseline.length) { removed.push(i + 1); i++; }
    return removed.length ? removed : null;
}
