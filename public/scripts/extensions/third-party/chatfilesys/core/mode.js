/**
 * ChatFilesys — 存储模式判定（design.md §1，裁定 Q1：三个模式，对外呈现为三选一）
 *
 * | 模式 | 用户看到的 | 事实源 | 磁盘聊天文件 |
 * |---|---|---|---|
 * | `off`    | jsonl 增强 | 聊天文件（模型住 header） | 有（宿主原生维护） |
 * | `pure`   | 纯数据库   | 库 | 无 |
 * | `mirror` | 双写       | 库 | 有（本插件防抖生成的副本） |
 *
 * 内部实现上 mirror = pure + 保留聊天文件，但**对外是第三个模式**（忠于 N2 的旅程问法）；
 * 全仓一律经本模块判定，不在各处写字符串比较（单点判定，改一处即可）。
 */

/** 合法模式（顺序 = 设置页呈现顺序） */
export const STORAGE_MODES = ['off', 'pure', 'mirror'];

/** 设置页展示名 */
export const STORAGE_MODE_LABELS = {
    off: 'JSONL 增强',
    pure: '纯数据库',
    mirror: '双写（库为准 + 保留聊天文件）',
};

/**
 * 归一化模式值：非法/缺失一律回落 `off`（旧设置里是布尔语义的纯库开关，见 index.js 迁移）。
 * @param {unknown} v
 * @returns {'off'|'pure'|'mirror'}
 */
export function normMode(v) {
    return STORAGE_MODES.includes(v) ? v : 'off';
}

/** 是否「走库」的模式（pure 与 mirror 都装接缝、都以库为事实源） */
export function isPureLike(mode) {
    return normMode(mode) === 'pure' || normMode(mode) === 'mirror';
}

/** 是否双写（额外把当前走法落成标准聊天文件） */
export function isMirror(mode) {
    return normMode(mode) === 'mirror';
}
