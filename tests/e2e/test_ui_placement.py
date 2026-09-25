"""ChatFilesys 界面分工 e2e（T4/R5 铁律，AC7）

用户 2026-09-25 铁律：**面板只在设置页**（从设置页按钮 / `/cb` / Alt+B 进）；**聊天界面只有三样**——
输入框上方的分支标识（只显示、不可点开面板）、每条消息旁的分叉按钮、分叉点标记。

断言：
  ① 徽章是纯状态元素（DIV、不可点、pointer-events: none、title「当前分支」），点它**不打开**面板
  ② 聊天界面除「分支标识 + 分叉按钮 + 分叉点标记」外**无本插件任何元素**（含 `#form_sheld` 与 `#chat` 全扫）
  ③ 面板本体只存在于弹窗内：未打开时 `.chatfilesys-popup` 数量为 0；打开时全部在 dialog 内
  ④ 三个入口都能打开面板：设置页按钮 / `/cb` / Alt+B

依赖：Dev Luker 8003 在跑（用专用测试角色 @@CHAR@@）。
用法：python tests/e2e/test_ui_placement.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, TEST_CHAR, PANEL  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"

results = []

STEPS_ENABLE = """async (extSrc) => {
    const c = SillyTavern.getContext();
    const mod = await import(extSrc + '/core/branches.js');
    // 启用分支（写模型到聊天头）——经官方 saveMetadata，不碰文件系统
    c.chatMetadata.extensions = c.chatMetadata.extensions || {};
    c.chatMetadata.extensions.chatfilesys = mod.enableForChat(c.chat || []);
    await c.saveMetadata();
    await c.reloadCurrentChat(); // 触发 CHAT_CHANGED → 插件 renderAll（徽章 + 消息旁注入）
    return { branches: c.chatMetadata.extensions.chatfilesys.branches.length, msgs: (c.chat || []).length };
}"""

SCAN = """() => {
    const seen = { badge: null, tools: 0, forkBtns: 0, marks: 0, extra: [], popups: 0, popupsOutsideDialog: 0 };
    const badge = document.querySelector('#chatfilesys-badge');
    if (badge) {
        const cs = getComputedStyle(badge);
        seen.badge = {
            tag: badge.tagName, title: badge.title, text: badge.textContent,
            hidden: badge.hidden, cursor: cs.cursor, pointerEvents: cs.pointerEvents,
            clickable: typeof badge.onclick === 'function' || badge.tagName === 'BUTTON',
        };
    }
    document.querySelectorAll('.chatfilesys-mes-tools').forEach((t) => {
        seen.tools += 1;
        seen.forkBtns += t.querySelectorAll('.chatfilesys-mes-fork').length;
        seen.marks += t.querySelectorAll('.chatfilesys-mes-forkmark').length;
    });
    // 聊天界面（输入框容器 + 消息区）里除三样之外的本插件元素
    document.querySelectorAll('#form_sheld *, #chat *').forEach((el) => {
        const cls = [...(el.classList || [])].filter((x) => x.startsWith('chatfilesys-'));
        const id = el.id || '';
        if (!cls.length && !id.startsWith('chatfilesys-')) return;
        const allowed = id === 'chatfilesys-badge' || el.closest('.chatfilesys-mes-tools');
        if (!allowed) seen.extra.push((id || '-') + '|' + cls.join('.'));
    });
    document.querySelectorAll('.chatfilesys-popup').forEach((el) => {
        seen.popups += 1;
        if (!el.closest('dialog[open]')) seen.popupsOutsideDialog += 1;
    });
    return seen;
}"""


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "ui-placement")
        try:
            r.boot()
            res = r.create_test_char()
            if res.get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(2500)

            # 准备：启用分支模型（聊天界面应立刻出现三样元素）
            en = r.js(STEPS_ENABLE, EXT_SRC)
            print("启用分支:", en)
            r.settle(2500)

            # ③ 未打开面板时：面板本体不得存在
            before = r.js(SCAN)
            ok_popup_closed = before["popups"] == 0
            results.append(report("③ 未打开面板时无 .chatfilesys-popup 本体", ok_popup_closed, str(before["popups"])))

            # ① 徽章 = 纯状态显示
            bd = before.get("badge") or {}
            ok_badge = (bd.get("tag") == "DIV" and bd.get("title") == "当前分支"
                        and str(bd.get("text", "")).startswith("⎇")
                        and bd.get("pointerEvents") == "none" and not bd.get("clickable"))
            results.append(report("① 徽章为纯状态显示（DIV/不可点/pointer-events:none）", ok_badge, str(bd)))

            # ①b 点徽章不得打开面板
            r.js("() => { const el = document.querySelector('#chatfilesys-badge'); if (el) el.click(); }")
            r.settle(1200)
            after_click = r.js(SCAN)
            ok_badge_click = after_click["popups"] == 0
            results.append(report("①b 点徽章不打开面板", ok_badge_click, f"popups={after_click['popups']}"))

            # ② 聊天界面除三样外无本插件元素
            ok_three = (len(before["extra"]) == 0 and before["forkBtns"] >= 1
                        and before["tools"] == before["forkBtns"])
            results.append(report("② 聊天界面只有分支标识+分叉按钮+分叉点标记",
                                  ok_three, f"extra={before['extra']} tools={before['tools']} forks={before['forkBtns']} marks={before['marks']}"))

            # ④ 三入口
            # 入口1：/cb
            r.cmd("/cb")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            inside1 = r.js("() => { const els=[...document.querySelectorAll('.chatfilesys-popup')]; return els.length>0 && els.every(e=>!!e.closest('dialog[open]')); }")
            results.append(report("④-1 /cb 打开面板（且本体只在弹窗内）", bool(inside1), str(inside1)))
            r.close_popup()
            r.settle(600)
            # 入口2：Alt+B
            r.js("""() => document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true, code: 'KeyB', key: 'b', bubbles: true }))""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            results.append(report("④-2 Alt+B 打开面板", True, "ok"))
            r.close_popup()
            r.settle(600)
            # 入口3：设置页按钮
            r.js("""() => document.querySelector('#chatfilesys-settings [data-action="open-popup"]').click()""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            results.append(report("④-3 设置页按钮打开面板", True, "ok"))
            r.close_popup()
            r.settle(600)

            # 关掉面板后再扫一次：不得残留面板本体
            final = r.js(SCAN)
            results.append(report("③b 关闭后无面板残留", final["popups"] == 0, f"popups={final['popups']}"))

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            results.append(report("全程零 chatfilesys 归因报错", len(errs) == 0, str(errs[:2])))
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            b.close()


if __name__ == "__main__":
    code = main()
    ok = all(results) if results else False
    print("\nUI PLACEMENT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
