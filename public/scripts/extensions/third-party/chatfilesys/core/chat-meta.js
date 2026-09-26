/**
 * ChatFilesys — 聊天头（chat_metadata）的拆装与合并（R0/R2.1/R8.5 共用）
 *
 * 「聊天头零丢失」是 R0 的第一条：宿主与所有第三方插件写进 `chat_metadata` 的东西必须
 * 整份留在库里、读回时原样回显。本插件只在里面自管**两项**：
 *   · `extensions.chatfilesys` —— 分支模型（真源在库，聊天头里那份是给宿主的视图）
 *   · `integrity`              —— 版本号（真源在库）
 * 其余一切（别人的命名空间、`main_chat`、变量、书签引用……）都属于「保留面 hostMetadata」，
 * 三档适配器把它按家族持久化。
 *
 * 为什么抽成独立模块：**接缝（seam.js）与导入旅程（importer.js）必须用同一套拆装语义**——
 * 冷导入（W5）要把源 jsonl 头里的内容按同样的规则并入家族，否则「导入」与「接管」两条
 * 入口会对同一份聊天头给出两种结果。F1/F2 追加同一条理由：**键归属**（哪些项属于某个键、
 * 不该进家族级）也只能有一份实现，见 `stripKeyOwnedMeta`。
 *
 * 纯函数：无 DOM、无网络、无适配器依赖。
 */

/** 本插件在聊天头里的命名空间 */
export const OWN_EXTENSION_KEY = 'chatfilesys';

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 完整 chat_metadata → 库内两份：`{ hostMetadata, model }`。
 * hostMetadata = 去掉本插件两项之后的**其余全部内容**。
 * @param {object|null} meta
 * @returns {{hostMetadata: object, model: object|null}}
 */
export function splitChatMetadata(meta) {
    const m = isObj(meta) ? meta : {};
    const extensions = { ...(m.extensions || {}) };
    const model = extensions[OWN_EXTENSION_KEY] ?? null;
    delete extensions[OWN_EXTENSION_KEY];
    const host = { ...m };
    delete host.integrity;
    if (Object.keys(extensions).length) host.extensions = extensions;
    else delete host.extensions;
    return { hostMetadata: host, model };
}

/**
 * 合并聊天头（**不能浅合并掉别人的命名空间**）。
 *
 * 顶层浅合并 + `extensions` **按命名空间逐项合并**：其他插件的数据都挂在
 * `extensions.<插件名>` 下，若整体替换 `extensions`，宿主一次自带 `extensions` 的保存
 * 就会把所有插件的命名空间一起抹掉（真机实测：时有时无的丢命名空间）。
 * 每个命名空间内部按「该插件发来的整份即其最新值」替换，不做深合并。
 * 删除命名空间：`chats/meta/patch` 的 remove op（**非旧副本差分**的那种）——本函数不删任何东西。
 *
 * @param {object|null} prev 库内已有
 * @param {object|null} incoming 本次入向
 * @returns {object} 新对象（不改入参）
 */
export function mergeHostMetadata(prev, incoming) {
    const a = isObj(prev) ? prev : {};
    const b = isObj(incoming) ? incoming : {};
    const merged = { ...a, ...b };
    if (a.extensions || b.extensions) {
        merged.extensions = { ...(a.extensions || {}), ...(b.extensions || {}) };
    }
    return merged;
}

/**
 * 入向聊天头并入家族级之前的「**键归属**」剔除（F1/F2，2026-09-26）。
 *
 * `main_chat`（父线索）是**属于某个聊天键**的：宿主靠它驱动「返回父聊天」。家族级的
 * `hostMetadata` 是**所有键共用**的，混进去会让别的键也冒出「返回父聊天」——真机症状：
 * 在原生检查点聊天里切 swipe / 编辑消息（宿主发 `chats/patch`，请求体带整份 `chat_metadata`，
 * 含该键的 `main_chat`），根聊天从此凭空多出一个指向自己的「返回父聊天」，且持久化。
 *
 * 判定按**键的性质**（`family.chatKey` = 家族主键 = 这个聊天本身）：
 *   · 主键 → `main_chat` 就是它自己的父线索（原生分支文件被单独导入当主键时确实有），原样保留
 *   · 其余键（原生分支/检查点键、被合并进家族的聊天）→ 它的父线索归它自己：落点在键绑定
 *     （`keyBindings[key].mainChat`，读该键时覆盖回显），不进家族级
 *
 * 抽在本模块是因为**接缝（seam.js）与导入旅程（importer.js）必须同一套语义**——
 * 否则「聊天里写一次」与「导入一次」会对同一份聊天头给出两种归属。
 *
 * @param {{chatKey?: string, keyBindings?: object}|null} family 库内家族
 * @param {string|null} chatKey 本次请求/导入的聊天键
 * @param {object|null} incomingHost 入向聊天头（`splitChatMetadata` 的保留面）
 * @returns {object} 可并入家族级的内容（不改入参）
 */
export function stripKeyOwnedMeta(family, chatKey, incomingHost) {
    const src = isObj(incomingHost) ? incomingHost : {};
    if (chatKey == null || !Object.hasOwn(src, 'main_chat')) return src;
    if (family?.chatKey === chatKey) return src; // 主键：父线索是它自己的
    const { main_chat: _omit, ...rest } = src; // eslint-disable-line no-unused-vars
    return rest;
}

/**
 * 从源 jsonl 的**首行 header** 取出「保留面」（W5：冷导入不得丢聊天头）。
 *
 * 源文件可能是原生聊天（没有 `chat_metadata`，或里面只有别人的命名空间），
 * 也可能是本插件增强模式（`off`）写出来的文件（额外带本插件模型与版本号）——
 * 后者的两项必须剔除（真源在库，不能被文件里的旧副本顶掉）。
 *
 * @param {object|null} header jsonl 首行（`{user_name, character_name, chat_metadata}`）
 * @returns {object} 可直接并入家族 hostMetadata 的内容（空对象表示源里没有聊天头内容）
 */
export function hostMetadataOfHeader(header) {
    if (!isObj(header)) return {};
    return splitChatMetadata(header.chat_metadata).hostMetadata;
}
