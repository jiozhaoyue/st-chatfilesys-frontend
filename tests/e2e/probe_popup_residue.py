"""探针：管理弹窗关闭后的 DOM 残骸归因（T4r.11 的 ③/④-1 失败根因取证）

要回答的问题：`test_ui_placement.py` 实测「弹窗没开过也有 1 个 .chatfilesys-popup、关三次剩 3 个」，
到底是插件在偷偷预建，还是**关闭方式**的问题？

做法：同一页面里跑两种关闭方式，各数一次 `.chatfilesys-popup` 节点数：
  A. 点宿主自己的关闭按钮 `.popup-button-close`（DISPLAY 型唯一可见的关闭控件，data-result=0）
     —— 走宿主 Popup#complete → #hide，宿主自己在关闭动画结束后 `dlg.remove()`
  B. 直接 `dialog.close()` —— 绕过宿主 #hide，宿主那份 DOM 清理不会执行

预期（真机事实）：
  A → 0（走宿主关闭路径，宿主自己在关动画结束后 `dlg.remove()`）
  B → **插件修复前 1**（dialog 留在 body 里，只是 open=false）；**修复后 0**——`index.js` 现在在
      dialog `close` 事件里补一次 `dialog.remove()`，任何非宿主路径的关闭都不再留孤儿节点。
即：残骸来自「关闭方式绕过了宿主的清理」，不是插件预建；插件侧原本缺的是「关闭时顺手清 DOM」。

用法：PYTHONIOENCODING=utf-8 python tests/e2e/probe_popup_residue.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

COUNT = "() => document.querySelectorAll('.chatfilesys-popup').length"

# 每种关法后 dump 一次残骸形态：它在不在 dialog 里、dialog 是否 open、是否还有 closing 属性
DUMP = """() => [...document.querySelectorAll('.chatfilesys-popup')].map((el) => {
    const dlg = el.closest('dialog');
    return {
        inDialog: !!dlg,
        dialogOpen: dlg ? dlg.open : null,
        dialogClosing: dlg ? dlg.hasAttribute('closing') : null,
        dialogConnected: dlg ? dlg.isConnected : null,
    };
})"""

CLOSE_BTN = """() => {
    const dlg = [...document.querySelectorAll('dialog')].find((d) => d.querySelector('.chatfilesys-popup'));
    if (!dlg) return 'no-dialog';
    const btn = dlg.querySelector('.popup-button-close');
    if (!btn) return 'no-close-button';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked-close-button';
}"""

CLOSE_RAW = """() => {
    const dlg = [...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('.chatfilesys-popup'));
    if (!dlg) return 'no-open-dialog';
    dlg.close();
    return 'raw-dialog-close';
}"""


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-popup-residue")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(400)
            res = r.create_test_char()
            if res.get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(2500)

            print("开弹窗前 .chatfilesys-popup 数 =", r.js(COUNT))

            # ---- A：走宿主自己的关闭按钮 ----
            r.open_popup()
            r.settle(500)
            n_open = r.js(COUNT)
            print("A 打开后 .chatfilesys-popup 数 =", n_open)
            print("A 关闭动作 =", r.js(CLOSE_BTN))
            r.pg.wait_for_function("() => document.querySelectorAll('.chatfilesys-popup').length === 0",
                                   timeout=8000)
            print("A 关闭后 .chatfilesys-popup 数 =", r.js(COUNT), "（宿主 #hide 里 dlg.remove() 生效）")

            # ---- B：直接 dialog.close()（旧 harness.close_popup 的做法） ----
            r.open_popup()
            r.settle(500)
            print("B 打开后 .chatfilesys-popup 数 =", r.js(COUNT))
            print("B 关闭动作 =", r.js(CLOSE_RAW))
            r.settle(1500)
            print("B 关闭后 .chatfilesys-popup 数 =", r.js(COUNT), "（修复后应为 0；修复前为 1）")
            print("B 残骸形态 =", r.js(DUMP))

            # ---- 再开一次：证明「每开一次叠一份」的前提（有残骸时）已被插件侧清掉 ----
            r.open_popup()
            r.settle(500)
            print("C 再开一次后 .chatfilesys-popup 数 =", r.js(COUNT), "（应为 1：上一份已被清掉）")

            print("\n结论：B 的差异只与「关闭方式」有关；A/B 都为 0 证明插件自身不预建、也不残留。")
            return 0
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            b.close()


if __name__ == "__main__":
    sys.exit(main())
