/**
 * ChatFilesys — 入库提醒弹窗（T8 / R8.1 / AC21）
 *
 * 宿主 = 官方 Popup（`POPUP_TYPE.TEXT` + `customButtons`），只有内容与几个选择，
 * 选择语义与压制判定在 `core/import-prompt.js`（纯函数），**这里不发网络请求、不改任何数据**。
 *
 * 用户裁定（2026-09-26）：「默认是增强，但是强制弹出弹窗，提醒装库流程，选择是否转换到数据库，
 * 然后继续走」+「选择1，再加2，以及完全不再提醒」+「可以关」。
 * 现行摆法（W8）：两个**模式短按钮**「纯库」「双写」+ 小字次按钮「不入库」+ 两个小勾选
 * （「这个聊天不再提醒」「全部不再提醒」）。关窗（**本弹窗自己画的 X** / Esc）= 不入库。
 *
 * 为什么 X 要自己画（F4，2026-09-26）：宿主对 `POPUP_TYPE.TEXT` 一律先把自带的
 * `.popup-button-close` 置 `display:none`（只有 DISPLAY 型才恢复）→ 真机上那个 X 根本不存在。
 * 做法不是在样式上跟宿主对抗（不写覆盖内联样式的 `!important`），而是在内容里放一个自己的 X，
 * 并用宿主自己的结果控件机制（`data-result`）走与「不入库」**完全相同**的那条路。
 */

// ui/ 比 index.js 深一层 → 多一级 `../`（与 ui/versions.js 同深度，指向 public/scripts/popup.js）
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../../popup.js';
import { IMPORT_PROMPT_MODE } from '../core/import-prompt.js';

/** 根容器类名（e2e 定位用；与 `ui/popup.js` 的管理弹窗 `.chatfilesys-popup` 区分开） */
export const IMPORT_PROMPT_CLASS = 'chatfilesys-import-prompt';

/** 弹窗里自己画的关闭 X 的类名（e2e 定位用；宿主自带的那个对 TEXT 型弹窗不可见，见文件头） */
export const IMPORT_PROMPT_CLOSE_CLASS = 'chatfilesys-ip-x';

/** 两个小勾选的 id（宿主 Popup 的 customInputs 用 id 查询，故必须是简单 id） */
export const IMPORT_PROMPT_CHECKBOX = {
    MUTE_KEY: 'chatfilesys-ip-mute-key',
    MUTE_ALL: 'chatfilesys-ip-mute-all',
};

/**
 * 三个按钮（用户 2026-09-26 重裁定按钮摆法）：两个**模式短按钮** + 一个小字次按钮。
 * 「不入库」加 `chatfilesys-ip-skip` 类做次级观感（小字、不抢眼）。
 */
const BUTTONS = [
    {
        text: '纯库',
        icon: 'fa-database',
        result: POPUP_RESULT.CUSTOM1,
        mode: IMPORT_PROMPT_MODE.PURE,
        tooltip: '内容存进数据库（磁盘上不再保留该聊天的 jsonl）',
    },
    {
        text: '双写',
        icon: 'fa-clone',
        result: POPUP_RESULT.CUSTOM2,
        mode: IMPORT_PROMPT_MODE.MIRROR,
        tooltip: '数据库为准，同时在磁盘留一份标准聊天文件（原生酒馆也能打开）',
    },
    {
        text: '不入库',
        result: POPUP_RESULT.CUSTOM3,
        mode: IMPORT_PROMPT_MODE.SKIP,
        classes: ['chatfilesys-ip-skip'],
        tooltip: '这次不转，照常走聊天文件（以后打开这个聊天还会提醒）',
    },
];

/** 两个小勾选（不是按钮）：复用宿主 Popup 的原生 checkbox 观感类名，但挂在**自己的内容里**
 *  （而不是宿主的 `customInputs`）——这样样式能被 `.chatfilesys-import-prompt` 精确限定，
 *  不会漏到别的扩展的弹窗上（R6：其他插件不受影响）。 */
const CHECKBOXES = [
    { id: IMPORT_PROMPT_CHECKBOX.MUTE_KEY, label: '这个聊天不再提醒' },
    { id: IMPORT_PROMPT_CHECKBOX.MUTE_ALL, label: '全部不再提醒' },
];

/** 「不入库」那条（关窗 = 走它这条路：同一个结果码，压制勾选照常生效） */
const SKIP_BUTTON = BUTTONS.find((b) => b.mode === IMPORT_PROMPT_MODE.SKIP);

/** 弹窗正文（中文人话，不写代码） */
function bodyHtml(fileName) {
    const who = fileName ? `「${fileName}」` : '这个聊天';
    const boxes = CHECKBOXES.map((b) => `
            <label class="checkbox_label justifyCenter" for="${b.id}">
                <input type="checkbox" id="${b.id}"><span>${b.label}</span>
            </label>`).join('');
    // 自己画的关闭 X：`data-result` 是宿主的**结果控件**机制（点了就等于按那个结果关窗），
    // 于是它走的正是「不入库」那条路（含两个勾选的处理），不需要我们自己写任何点击处理。
    // 字形用 `×`（U+00D7，GBK 可编码）而不是花体 ✕：e2e 用例会把弹窗正文打进断言明细，
    // Windows 控制台默认 GBK，非 GBK 字符会让打印那一行 UnicodeEncodeError 崩掉。
    return `<div class="${IMPORT_PROMPT_CLASS}">
        <div class="${IMPORT_PROMPT_CLOSE_CLASS}" data-result="${SKIP_BUTTON.result}"
             title="关掉窗口（= 不入库）" aria-label="关掉窗口">×</div>
        <div class="chatfilesys-ip-title">${who}还没录进数据库</div>
        <div class="chatfilesys-ip-body">
            入库后：内容存在数据库里，分支与 swipe 由本插件统一管理。选「纯库」磁盘上不再保留该聊天的文件；
            选「双写」则同时在磁盘留一份标准聊天文件，原生酒馆也能打开。
        </div>
        <div class="chatfilesys-ip-body">
            也可以先不转：选「不入库」（或关掉窗口），这次就照常走聊天文件。
        </div>
        <div class="chatfilesys-ip-checks">${boxes}</div>
    </div>`;
}

/** 读当前两个勾选的现场值（勾选与按钮取向无关，两者都生效） */
function readCheckboxes() {
    const q = (id) => Boolean(document.getElementById(id)?.checked);
    return { muteKey: q(IMPORT_PROMPT_CHECKBOX.MUTE_KEY), muteAll: q(IMPORT_PROMPT_CHECKBOX.MUTE_ALL) };
}

/**
 * 打开入库提醒弹窗并等待用户选择。
 *
 * @param {{fileName?: string}} [opts] `fileName` = 当前聊天文件名（显示用，不带 .jsonl 更好看）
 * @returns {Promise<{mode: 'pure'|'mirror'|'skip', muteKey: boolean, muteAll: boolean}>}
 *          关闭（内容里自己画的 X / Esc）= `mode: 'skip'`；两个勾选**任何关闭路径**都会被带回。
 */
export async function openImportPrompt({ fileName = '' } = {}) {
    const shown = String(fileName || '').replace(/\.jsonl$/i, '');
    // 勾选现场：宿主在 `onClosing` 里才把弹窗交给我们，此时 DOM 还在，是唯一可靠的读取点；
    // 按钮的 action 也抓一次，双保险（两条路径都指向这个闭包变量）。
    let grabbed = readCheckboxes();
    const grab = () => { grabbed = readCheckboxes(); };

    const ret = await callGenericPopup(bodyHtml(shown), POPUP_TYPE.TEXT, '', {
        customButtons: BUTTONS.map((b) => ({
            text: b.text, icon: b.icon, result: b.result, tooltip: b.tooltip, classes: b.classes, action: grab,
        })),
        okButton: false,
        cancelButton: false,
        allowEscapeClose: true,
        onClosing: () => { grab(); return true; }, // 返回 true = 允许关闭（返回假值会被宿主当成「取消关闭」）
    });
    const hit = BUTTONS.find((b) => b.result === Number(ret));
    return { mode: hit ? hit.mode : IMPORT_PROMPT_MODE.SKIP, ...grabbed };
}
