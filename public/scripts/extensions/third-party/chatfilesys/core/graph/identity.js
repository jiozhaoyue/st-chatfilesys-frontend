/**
 * ChatFilesys — 图引擎 · 节点身份（B2 / prd R3，design.md §2）
 *
 * 本文件是「一个消息在图上是谁」的**唯一定义**，也是**不继承 TL 缺陷一**的地方：
 * TL 的节点 id 依赖文件插入顺序（只交换两个文件顺序，`message3` / `message5` 的内容就互换，
 * diff 退化成大面积 added+removed）。我们的 id = `层号 : 内容指纹`——
 * **与输入顺序无关**，也与「这个会话是第几个被读到的」无关。
 *
 * 三件定死的事（design.md §2）：
 * 1. **内容指纹复用本仓唯一的哈希辅助单点** `core/merge.js#computeHash`（不另写哈希原语）：
 *    同一 Web Crypto 调用 + 同一 `normalizeText` 归一（去 BOM / 统一换行 / 去首尾空白）。
 *    **但两层参与身份的字段不同，判定口径并不一致**（复检 F3 的实测事实，照实记下，不粉饰）：
 *    `computeHash` 收的是 `{name, is_user, mes}`，**`name` 进哈希**；本层只喂 `{is_user, mes}`，
 *    `name` 被归一成常量 `''`（见下条第 2 点）。
 *    于是**只看显示名改没改**（同一段正文、只换 `name`）时，两层会给出**相反**的判定——
 *    合并层 `computeHash` 变了 → 认作不同的行（LCP 在此停下、进入分叉）；
 *    本层 `contentKey` 不变 → 仍是同一个节点。
 *    这不是笔误、也不是待修的缺陷：图层**故意**不认显示名（显示名可改，认它就会「一改名丢共享」）。
 *    两层的取舍本就不同，故「合并层说变了、图层说没变」这种各说各话**是可能发生的**，
 *    消费方不要假设两层同判；要改就该改那**一个**单点（`core/merge.js`），而不是在图层另立一套
 *    ——本任务 R8 不碰它，故这里只把事实说清。
 * 2. **只取 `is_user` + `mes` 两个字段**：同一段正文出自用户还是角色是两条消息；
 *    `name`（显示名）**不参与**——显示名可改，改了就换节点会丢共享。
 *    实现上仍让 `computeHash` 吃一个消息行，`name` 由它归一成常量 `''`（常量不参与区分）。
 * 3. **必须带层号**（design.md §2 的「假环」）：只按内容会让「后面又出现一次同样的台词」
 *    塌成同一个节点。`(层号, 内容指纹)` 显式表达 TL 的「只在同深度内按 mes 分桶」，
 *    但**不依赖位置**——这也是整张图保证无环的根据（每条边都从层号 f 到 f+1，见 `build.js`）。
 *
 * 一处如实记下的继承（不擅自修，见 R8「不碰 core/source 之外的既有语义」同源纪律）：
 * `mes` 若是数组（多模态 / 流式形态），`normalizeText` 走 `String()` 拼接，
 * `['a','b']` 与 `['a,b']` 会得到同一个指纹。这一坍缩**合并层本来就有**，
 * 本层照用同一处归一，两层口径保持一致；要改应当改那一个单点，而不是在图层另立一套。
 */

import { computeHash } from '../merge.js';

/** id 里层号与指纹的分隔符 */
export const ID_SEP = ':';

/**
 * 一条消息的内容指纹（sha256 hex）。
 *
 * @param {object|null|undefined} message 消息行（`Message`；`mes` / `is_user` 之外的字段不参与）
 * @returns {Promise<string>} sha256 hex
 */
export async function contentKeyOf(message) {
    return await computeHash({ is_user: message?.is_user, mes: message?.mes });
}

/**
 * 节点 id = `层号:内容指纹`。
 * @param {number} floor 层号（1 起；该消息在所属会话里的位置）
 * @param {string} contentKey 内容指纹
 * @returns {string}
 */
export function nodeIdOf(floor, contentKey) {
    return `${floor}${ID_SEP}${contentKey}`;
}

/**
 * 从节点 id 取回层号（排序与「同深度」判定要用）。
 * @param {string} id
 * @returns {number|null} 取不出（外来 id / 非本层产物）→ null
 */
export function floorOfNodeId(id) {
    const head = String(id ?? '').split(ID_SEP)[0];
    return /^\d+$/.test(head) ? Number(head) : null;
}

/**
 * 文本摘要（sha256 hex）——**同一个 sha256 单点**，用于建图的输入指纹（`build.js` §4）。
 *
 * 实现：仍旧走 `core/merge.js#computeHash`（它是「一个消息行 → sha256 hex」的函数），
 * 把要摘要的文本放进它的 `mes` 字段即得该文本的摘要；`name` / `is_user` 在此都是常量，
 * 不影响区分力。这样全仓只有一个哈希原语（引库 / 单点优先），不另写 Web Crypto 调用。
 *
 * @param {string} text
 * @returns {Promise<string>} sha256 hex
 */
export async function textDigest(text) {
    return await computeHash({ is_user: false, mes: text });
}
