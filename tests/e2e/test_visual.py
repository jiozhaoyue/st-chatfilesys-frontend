"""前端视觉验证:面板各状态截图(未启用/启用/分叉点/弹窗/导出行)。"""
import os
import sys
import time
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, TEST_CHAR

OUT = os.path.join(os.path.dirname(__file__), "shots")


def open_outer_drawer(r):
    """打开魔杖菜单里的扩展抽屉,让 #extensions_settings 可见。"""
    r.js("""() => {
        const btn = document.querySelector('#extensions-settings-button');
        const content = document.querySelector('#rm_extensions_block');
        const open = content && !content.classList.contains('closedDrawer') &&
                     content.getBoundingClientRect().width > 0;
        if (!open) btn?.querySelector('.drawer-toggle')?.click() ?? btn?.click();
        return 'toggled';
    }""")
    r.pg.wait_for_timeout(800)


def open_inner_drawer(r):
    """二期：等价于打开管理弹窗（复杂 UI 宿主=弹窗）。"""
    r.ensure_popup()
    r.pg.wait_for_timeout(400)


def shot(r, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    r.pg.screenshot(path=path)
    print("shot:", path)
    # 弹窗特写
    el = r.pg.query_selector('dialog[open] .chatfilesys-popup')
    if el:
        try:
            el.screenshot(path=os.path.join(OUT, name.replace(".png", "_panel.png")))
        except Exception as e:
            print("panel shot skip:", e)


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            try:
                r.delete_test_char()
                r.settle(800)
            except Exception:
                pass
            r.create_test_char()
            r.open_test_char()
            r.settle(2500)
            open_outer_drawer(r)
            open_inner_drawer(r)

            st = r.state()
            shot(r, "01_enabled_empty.png" if st["branches"] else "01_not_enabled.png")
            if not st["branches"]:
                # 未启用才需要手动启用（新聊天会自动建家族，一般不走这）
                r.click_action("enable")
                r.popup_ok()
                r.settle(1500)
                shot(r, "02_enabled_empty.png")

            # 造楼
            for cmd in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
                r.cmd(cmd)
                r.settle(650)
            r.wait_state(lambda s: s["chatLen"] == 5, desc="造楼")
            open_outer_drawer(r)
            open_inner_drawer(r)
            shot(r, "03_main_5floors.png")

            # 分叉 → 分叉点标记 + 双分支
            r.click_action("fork", floor=3)
            r.popup_ok()
            r.settle(1500)
            r.ensure_active("b_main")
            shot(r, "04_forked.png")

            # 收编弹窗特写
            r.fire_native_branch(1)
            r.settle(800)
            shot(r, "05_adopt_popup.png")
            try:
                r.popup_cancel()
            except Exception:
                pass
            r.settle(800)

            # 导出按钮 + 自动导出行(已在面板里),再来一张重命名弹窗
            r.click_action("rename", branch="b1")
            r.settle(600)
            shot(r, "06_rename_popup.png")
            try:
                r.popup_cancel()
            except Exception:
                pass

        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            if created:
                try:
                    r.delete_test_char()
                except Exception:
                    pass
            b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
