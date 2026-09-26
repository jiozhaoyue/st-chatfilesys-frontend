/**
 * ChatFilesys — 数据源入口：按当前**存储模式**自动选源（单点判定）
 *
 * 三档模式（`core/mode.js`）与两档数据源的对应关系（prd.md R1 / design.md §4）：
 *
 * | 模式 | 事实源 | 数据源 |
 * |---|---|---|
 * | `off` | 磁盘聊天文件 | `jsonlSource`（直接扫 jsonl，原生通道） |
 * | `pure` | 库 | `librarySource`（库内家族/楼层/变体/分支） |
 * | `mirror` | 库（+ 落标准文件副本） | `librarySource` |
 *
 * 模式判定**复用既有 `core/mode.js`**（单点，不在各处写字符串比较）；库里那份是事实源，
 * 双写模式下磁盘文件只是副本，故 `mirror` 与 `pure` 同档。
 * 非法/缺失模式一律回落 `off`（`normMode` 的既有语义）。
 */

import { normMode, isPureLike } from '../mode.js';
import { createJsonlSource } from './jsonl-source.js';
import { createLibrarySource } from './library-source.js';

/**
 * 模式 → 数据源档位（**单点判定**，改一处即可）。
 * @param {unknown} mode 存储模式（任意值；非法回落 `off`）
 * @returns {'jsonl'|'library'}
 */
export function sourceTierForMode(mode) {
    return isPureLike(normMode(mode)) ? 'library' : 'jsonl';
}

/**
 * 建一个与「数据从哪来」无关的数据源。
 *
 * @param {import('./types.js').ChatSourceDeps & {mode?: unknown}} [opts]
 *   `mode` = 当前存储模式；其余依赖见 `types.js` 的 `ChatSourceDeps`
 *   （`pure` / `mirror` 下 `adapter` 必需；`off` 下 `nativeFetch` 建议传 `seam.native`，
 *   接缝未装时缺省的 `globalThis.fetch` 就是原生通道；**库模式下必须显式传 `seam.native`**——
 *   那时缺省的 `fetch` 就是接缝本身，文件源会读到投影而不是磁盘事实）
 * @returns {import('./types.js').ChatSource}
 */
export function createChatSource(opts = {}) {
    return sourceTierForMode(opts.mode) === 'library' ? createLibrarySource(opts) : createJsonlSource(opts);
}

export { createJsonlSource, createLibrarySource };
