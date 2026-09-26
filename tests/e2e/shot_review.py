"""人工审查截图：入口按钮 / 聊天界面 / 管理弹窗每个页签各截一张，落盘供用户判读。

用途：用户要判断界面形态（弹窗四页签、版本按钮、结构树）是否符合 R5 契约，需先看到实际形态。
纪律：只操作 __cb_e2e 测试角色（探针，末尾清理）；截图只落盘，主会话不读图。
"""
import os
import sys

from playwright.sync_api import sync_playwright

from harness import Runner, browser_ctx, TEST_CHAR

OUT = os.path.join(os.path.dirname(__file__), "shots", "review")
POPUP = 'dialog[open]:not([closing]) .chatfilesys-popup'


def shot_el(r, selector, name):
    """截元素特写；元素不存在则跳过（不抛，保证后续截图照跑）。"""
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    el = r.pg.query_selector(selector)
    if not el:
        print(f"  [skip] 元素不存在: {selector}")
        return None
    try:
        el.screenshot(path=path)
    except Exception as e:
        print(f"  [skip] 截图失败 {name}: {e}")
        return None
    print("shot:", path)
    return path


def shot_page(r, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    r.pg.screenshot(path=path)
    print("shot:", path)
    return path


def open_outer_drawer(r):
    """打开魔杖菜单里的扩展抽屉，让 #extensions_settings 可见。"""
    r.js("""() => {
        const btn = document.querySelector('#extensions-settings-button');
        const content = document.querySelector('#rm_extensions_block');
        const open = content && !content.classList.contains('closedDrawer') &&
                     content.getBoundingClientRect().width > 0;
        if (!open) { (btn?.querySelector('.drawer-toggle') || btn)?.click(); }
        return 'toggled';
    }""")
    r.pg.wait_for_timeout(900)


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "review")
        try:
            r.boot()

            # 版本校验：R5 版必有工具图标排入口按钮与弹窗（旧版有 #chatfilesys-settings 抽屉）
            has_entry = r.js("() => !!document.getElementById('chatfilesys-entry')")
            legacy = r.js("() => !!document.querySelector('#chatfilesys-settings')")
            print(f"新版特征（入口按钮 / 旧设置抽屉）: entry={has_entry} legacyDrawer={legacy}")
            if not has_entry or legacy:
                raise AssertionError("实例里不是 R5 版扩展，截图无意义——先确认覆盖安装生效")

            # 探针角色：清旧 → 建新 → 打开
            try:
                r.delete_test_char()
                r.settle(800)
            except Exception:
                pass
            r.create_test_char()
            r.open_test_char()
            r.settle(2500)

            # 造楼 5 层
            for cmd in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3",
                        "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
                r.cmd(cmd)
                r.settle(650)
            r.wait_state(lambda s: s["chatLen"] == 5, desc="造楼")

            # 第 3 层后分叉 → 两条分支；再让新分支续一层 → F4 成为多组层（版本按钮出现处）
            nb = r.create_branch(3, name="分叉·F3")
            r.settle(800)
            try:
                r.ensure_active(nb)
                r.cmd("/send U-b1-F4")
                r.settle(900)
                r.ensure_active("b_main")
            except Exception as e:
                print("  [warn] 分支切换失败（不影响截图）:", e)
            r.close_popup()
            r.settle(600)

            # ---- 1. 聊天界面：工具图标排里的入口按钮 + 分叉层的版本按钮 ----
            r.pg.evaluate("() => { const c = document.querySelector('#chat'); if (c) c.scrollTop = c.scrollHeight; }")
            r.settle(600)
            shot_page(r, "01_chat_ui.png")
            shot_el(r, "#chat", "01b_chat_area.png")
            shot_el(r, "#leftSendForm", "01c_entry_button.png")

            # ---- 2. 输入框上方工具图标排（入口按钮的原生观感）----
            r.settle(300)

            # ---- 3. 管理弹窗各页签 ----
            r.ensure_popup()
            r.settle(500)
            shot_el(r, POPUP, "03_tab_current_chat.png")
            for label, fname in [("角色卡的聊天", "04_tab_character.png"),
                                 ("设置", "05_tab_settings.png"),
                                 ("回收站", "06_tab_trash.png")]:
                try:
                    r.popup_switch_tab(label)
                    r.settle(700)
                    shot_el(r, POPUP, fname)
                except Exception as e:
                    print(f"  [skip] 页签 {label}: {e}")

            # ---- 4. 该层版本弹窗（多组层才有版本按钮）----
            r.close_popup()
            r.settle(600)
            opened = r.js("""() => {
                const btn = [...document.querySelectorAll('#chat .chatfilesys-ver-btn')].pop();
                if (!btn) return 'no-version-button';
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return 'clicked';
            }""")
            print("版本按钮:", opened)
            r.settle(800)
            shot_el(r, ".chatfilesys-versions", "07_versions_popup.png")
            r.js("""() => { [...document.querySelectorAll('dialog[open]')]
                .find(d => d.querySelector('.chatfilesys-versions'))?.close(); }""")

            # ---- 5. 扩展设置抽屉（契约：零插件元素）----
            open_outer_drawer(r)
            shot_el(r, "#extensions_settings", "08_settings_drawer_empty.png")

            st = r.state()
            print("最终状态 branches:", [x["name"] for x in (st["branches"] or [])],
                  "chatLen:", st["chatLen"])
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
