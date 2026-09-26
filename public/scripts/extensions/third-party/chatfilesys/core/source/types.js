/**
 * ChatFilesys — 数据源（ChatSource）契约
 *
 * **本文件只有 JSDoc，没有运行时代码**（design.md §1）：它是一份可被编辑器与阅读者直接
 * 引用的形状说明，不代表任何行为。两个实现（`jsonl-source.js` / `library-source.js`）
 * 必须产出**同形**的结果——差异只在「哪来的」，不在「长什么样」。
 *
 * 为什么需要这一层（父任务 design.md §1.1）：
 * - 内化 TL 的消费层能力（图 / 检索 / 大纲 / 看板 / Diff / 画廊…）时，「数据从哪来」
 *   必须与「能力」解耦，否则每个能力都要写两遍（一遍读 jsonl、一遍读库）。
 * - TL 的失真面有两处：它取数走 `/api/chats/get` 并假设拿到的是「整个会话文件的全部消息」，
 *   而本插件的接缝对同一端点返回的是「**本键所在分支的投影**」；它列聊天走
 *   `/api/characters/chats`，该端点不在接缝的 9 条路由内，纯库模式下拿到的是磁盘事实
 *   （导入后源文件可能已删）→ 列表残缺。
 *
 * 实现纪律（对应 prd.md R1–R8）：
 * - **逐字段保真**：`extra` 与 `swipes` / `swipe_info` / `swipe_id` 原样保留，不做白名单裁剪，
 *   **缺就不补默认值**（补默认值会污染老数据）。
 * - **静默降级**（铁律 L0-11）：读失败 / 坏行一律降级为「该项为空」+ `describe().notes` 记一条 +
 *   `console.warn`，**绝不抛到上层阻断**。
 * - **不缓存**：本层每次调用都真读（缓存与增量失效是 B2 的事），先把「读得对」立住。
 *
 * @module core/source/types
 */

/**
 * 一条会话引用（「有哪些会话」的条目）。
 *
 * @typedef {object} SessionRef
 * @property {string} id 稳定标识（会话内唯一、跨刷新稳定；两档同源：`id === key`）
 * @property {string} key 聊天键（`avatar::文件名`，与 `core/seam.js#normalizeChatKey` 同形）
 * @property {string|number} characterId 所属角色
 * @property {string} name 文件名主体（不含 `.jsonl`）：文件源取**磁盘原名**（保留大小写，读文件要用它），
 *   库源取家族名/键的文件名部分——键经 `normalizeChatKey` 小写化，故绑定键的 `name` 是小写的
 *   （跨档比对请用 `key`，不要用 `name`）
 * @property {'chat'|'branch-file'|'group'|'family-member'} kind 这份引用是什么
 *   - `chat`：磁盘上的普通聊天文件（**钩子缺省时的回落值**）
 *   - `branch-file`：磁盘上宿主原生「创建分支 / 创建检查点」落下的派生文件（独立会话，不并进父会话）
 *   - `group`：群聊（**不接管**：两个实现都只在**枚举层钩子** `isGroup(fileName)` 认它，
 *     读它一律降级为空 + 记一条；钩子缺省时不会出现这个值——宿主群聊住另一端点/目录，本层不猜契约）
 *   - `family-member`：库内家族的一个键（家族主键或原生分支/检查点键）；同样是钩子缺省时的回落值
 * @property {'file'|'library'} origin 这份引用是哪来的（`file` = 文件源，`library` = 库源）
 */

/**
 * 一条消息（`Message`）。
 *
 * **逐字段保真**：除下列标准字段外，宿主/第三方写进去的键一个不丢；标为「可选」的字段
 * **缺就不补**（不注入默认值），取值一律与来源原样一致（不做类型强转）。
 *
 * @typedef {object} Message
 * @property {string} mes 正文
 * @property {boolean} is_user 是否用户发言
 * @property {string} [name] 发言者名
 * @property {string|number} [send_date] 发送时间（原样保留）
 * @property {object} [extra] 扩展字段（宿主与第三方都往这里写；缺则不补）
 * @property {string[]} [swipes] swipe 正文数组（ST 原生三件套之一；缺则不补）
 * @property {Array<object>} [swipe_info] swipe 元信息（同上）
 * @property {number} [swipe_id] 当前 swipe 下标（同上）
 */

/**
 * 聊天头（jsonl 首行；库源由家族内容合成出同形的一份）。
 *
 * @typedef {object} SessionHeader
 * @property {string} user_name 宿主字段（读回时原样）
 * @property {string} character_name 宿主字段（读回时原样）
 * @property {object} chat_metadata 聊天头（宿主与其他插件写进去的内容整份保留）
 */

/**
 * 一个会话（「读某个会话」的产物）。
 *
 * @typedef {object} Session
 * @property {SessionRef} ref 这份会话对应的引用（来源标记原样带回）
 * @property {SessionHeader|object} header 聊天头（空文件 = `{}`）
 * @property {Message[]} messages 该会话的全部消息（按顺序；坏行已跳过）
 * @property {BranchModelRef} [branches] 家族/分支模型；**只有库源给得出**（文件源没有家族模型）
 */

/**
 * 家族/分支模型引用（建图的骨架）。
 *
 * 库源把它当**一等公民**给出（不必像 TL 那样从「同深度相同消息」反推分支结构）；
 * 文件源给不出（off 模式没有家族模型，`graphInputs().branches` 缺省）。
 *
 * @typedef {object} BranchModelRef
 * @property {string} familyId 家族 id
 * @property {string} chatKey 家族主键
 * @property {string} name 家族名
 * @property {{active_branch: string|null, branches: Array<object>, groups: object}} model
 *   chatfilesys 模型形态（每分支含 `path`：`{楼层号: 变体 id}`）
 */

/**
 * 数据源自述（UI 上要能显示「当前用哪一档、保真度如何」）。
 *
 * **口径是「最近一次公开调用」**（`listSessions` / `readSession` / `graphInputs`）：
 * 每次公开调用开始时记录重置（像一次作用域），`describe()` 报的就是那一次的结果——
 * 免得记录无界增长，也免得「这次有跳过」说不清是哪一次。调用之前（或从未调用）时报的是初始态。
 *
 * @typedef {object} SourceDescription
 * @property {'jsonl'|'library'} tier 当前档位
 * @property {'full'|'partial'} fidelity 保真度（`partial` = **最近一次调用**有跳过/缺项）
 * @property {string[]} notes 说明与记录：**首条是来源自述**（解释「这份数据从哪来、看不到什么」，
 *   不是缺项），其后是常驻的源的性质（如「缺省通道在库模式下就是接缝」）与**最近一次调用**的问题
 *   （坏行 / 读失败 / 行不齐 / 未入库……）
 */

/**
 * 数据源接口（两个实现必须同形）。
 *
 * @typedef {object} ChatSource
 * @property {() => Promise<SessionRef[]>} listSessions 有哪些会话
 * @property {(ref: SessionRef) => Promise<Session>} readSession 读某个会话的全部消息
 * @property {() => Promise<{sessions: Session[], branches?: BranchModelRef[]}>} graphInputs 建图输入
 * @property {() => SourceDescription} describe 自述（当前档位与保真度）
 */

/**
 * 两个实现的公共依赖。
 *
 * @typedef {object} ChatSourceDeps
 * @property {() => {avatarUrl: string, characterId: string|number, name?: string, groupId?: string|null}} [character]
 *   角色上下文（宿主 ctx 是活的 → 传取值函数，每次调用现取）
 * @property {(url: string, init?: object) => Promise<Response>} [nativeFetch]
 *   **原生通道**（绕开接缝；调用方传 `seam.native`）。缺省 = `globalThis.fetch`
 *   —— 只在 `off` 模式（接缝未安装）下才等价于读磁盘；库模式下缺省值就是接缝本身，
 *   此时本层不抛错（L0-11），但会在 `describe().notes` 里记一条并把保真度置 `partial`
 * @property {(fileName: string) => boolean} [isGroup]
 *   **枚举层钩子**：这个文件名是不是群聊（宿主群聊住另一端点/目录，两个实现的枚举面都拿不到
 *   群聊字段——本层**不猜宿主契约**，只认这个钩子）。缺省 = 一律不是群聊（回落 `chat` /
 *   `family-member`）；认出来时该引用 `kind='group'`，读它降级为空 + 记一条
 * @property {() => object} [headers] 请求头（鉴权；缺省只带 JSON 头）
 * @property {object} [adapter] 存储适配器（`core/storage/adapter.js` 契约；库源必需，文件源不用）
 * @property {Function} [log] 日志器（缺省 `console.warn`）
 */
