/**
 * ChatFilesys — 结构树/结构图的**非模态浮层小窗**（`PO-3` 的实现载体）
 *
 * ⚠️ **挂载点豁免的唯一凭证**：本模块是规则「项目覆盖」`PO-3` 明许的例外——
 * 酒馆官方没有任何非模态承载点（`POPUP_TYPE` 五种全模态、`PopupOptions` 无非模态项），
 * 用户 2026-09-28 在已知悉代价的前提下选择真非模态小窗。豁免**只**给结构树与结构图两个
 * 视图的展示，其它任何 UI 一律走官方 Popup（`L1-MR-4`）——别拿本模块当通用浮层库用。
 *
 * 三条硬条件（`PO-3`）的落点：
 * 1. **范围**：本模块不做任何业务判断；调用方（`ui/popup.js`）只从树/图两处入口打开它。
 * 2. **样式**：全部类名 `chatfilesys-floatwin*` 前缀；配色一律 `var(--SmartTheme*, 回退值)`，
 *    零硬编码色（自查 grep 见 `tests/e2e` 的 CSS 体检）；绝不裸用酒馆全站类名。
 * 3. **自愈**：`ensureAttached()` 是唯一的再挂载点——宿主 `printMessages` 批量重绘会抹掉
 *    直插 DOM（2026-08-29 事故形态）；本窗挂在 `document.body`（重绘只动 `#chat` 子树），
 *    且调用方在每次 `renderAll` / `CHAT_CHANGED` 后调 `ensureAttached()` 兜底。
 *    真机取证脚本：`tests/e2e/test_floatwin.py`；结论登记 `.trellis/spec/frontend/`。
 *
 * 纯 UI 模块：无业务依赖、无存储依赖；`destroy()` 必须解净监听并移除节点（`L1-MR-8` 精神：
 * 持有关联资源的字段置 null）。
 */

/** 缺省几何（首次打开；之后记忆用户拖/拉的位置） */
const DEFAULTS = Object.freeze({ width: 480, height: 400, margin: 16 });

export function createFloatWin({
    title = '小窗',
    width = DEFAULTS.width,
    height = DEFAULTS.height,
    onClose = null,
} = {}) {
    const doc = document;
    const root = doc.createElement('div');
    root.className = 'chatfilesys-floatwin';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', title);

    root.innerHTML = `
        <div class="chatfilesys-floatwin-head" data-role="head">
            <span class="chatfilesys-floatwin-title" data-role="title"></span>
            <span class="chatfilesys-floatwin-spring"></span>
            <button class="chatfilesys-floatwin-btn chatfilesys-floatwin-close" data-role="close"
                title="关闭小窗（数据不受影响）" aria-label="关闭">✕</button>
        </div>
        <div class="chatfilesys-floatwin-body" data-role="body"></div>
        <div class="chatfilesys-floatwin-resize" data-role="resize" title="拖拽调整大小"></div>`;
    root.querySelector('[data-role="title"]').textContent = String(title);

    const headEl = root.querySelector('[data-role="head"]');
    const bodyEl = root.querySelector('[data-role="body"]');
    const closeBtn = root.querySelector('[data-role="close"]');
    const resizeEl = root.querySelector('[data-role="resize"]');

    /** 几何状态（跨重绘记忆；视口越界时钳回可见范围） */
    const geo = { x: null, y: null, w: width, h: height };
    let destroyed = false;
    let onCloseCb = onClose;

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

    function applyGeo() {
        const vw = doc.documentElement.clientWidth;
        const vh = doc.documentElement.clientHeight;
        geo.w = clamp(geo.w, 280, Math.max(280, vw - DEFAULTS.margin * 2));
        geo.h = clamp(geo.h, 200, Math.max(200, vh - DEFAULTS.margin * 2));
        if (geo.x === null || geo.y === null) {
            // 首次：屏幕右上角往下一格（不遮输入框；非模态 = 用户仍可继续聊天）
            geo.x = Math.max(DEFAULTS.margin, vw - geo.w - DEFAULTS.margin * 2);
            geo.y = DEFAULTS.margin + 40;
        }
        geo.x = clamp(geo.x, 0, Math.max(0, vw - geo.w));
        geo.y = clamp(geo.y, 0, Math.max(0, vh - 40));
        root.style.left = `${Math.round(geo.x)}px`;
        root.style.top = `${Math.round(geo.y)}px`;
        root.style.width = `${Math.round(geo.w)}px`;
        root.style.height = `${Math.round(geo.h)}px`;
    }

    /** 拖拽（标题栏）/ 缩放（右下角把手）—— Pointer Events 统一鼠标与触屏；
     *  活动手势的清理句柄留存在 `dragCleanup`，destroy 时兜底解绑（不泄漏半截手势） */
    let dragCleanup = null;
    function startDrag(ev, mode) {
        if (destroyed || ev.button !== 0) return;
        ev.preventDefault();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const base = { ...geo };
        const onMove = (e2) => {
            if (mode === 'move') {
                geo.x = base.x + (e2.clientX - startX);
                geo.y = base.y + (e2.clientY - startY);
            } else {
                geo.w = base.w + (e2.clientX - startX);
                geo.h = base.h + (e2.clientY - startY);
            }
            applyGeo();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            dragCleanup = null;
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        dragCleanup = onUp;
    }
    const onHeadDown = (ev) => { if (!ev.target.closest('[data-role="close"]')) startDrag(ev, 'move'); };
    const onResizeDown = (ev) => startDrag(ev, 'resize');
    headEl.addEventListener('pointerdown', onHeadDown);
    resizeEl.addEventListener('pointerdown', onResizeDown);

    /** 关闭：回调先行（调用方可能要把视图挂回弹窗页签），再拆手势、移除节点、置空 */
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        try { dragCleanup?.(); } catch { /* 半截手势的清理不该阻断销毁 */ }
        try { onCloseCb?.(); } catch { /* 关闭回调的异常不该阻断销毁 */ }
        root.remove();
        dragCleanup = null;
        onCloseCb = null;
    }
    const onCloseClick = () => destroy();
    closeBtn.addEventListener('click', onCloseClick);

    /** 自愈再挂载：不在文档里（被宿主清场/意外移除）→ 按记忆的几何重新挂回 body */
    function ensureAttached() {
        if (destroyed) return false;
        if (!doc.contains(root)) {
            doc.body.appendChild(root);
            applyGeo();
            return true; // true = 发生了再挂载（调用方可记日志/取证）
        }
        return false;
    }

    // 首挂 + 出初始几何
    doc.body.appendChild(root);
    applyGeo();

    return {
        root,
        body: bodyEl,
        get isOpen() { return !destroyed && doc.contains(root); },
        ensureAttached,
        destroy,
        setTitle(t) { if (!destroyed) root.querySelector('[data-role="title"]').textContent = String(t); },
    };
}
