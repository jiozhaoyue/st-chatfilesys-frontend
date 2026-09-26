"""只读侦察：宿主 Luker 实例（8003）上 chatfilesys 面板是否出现 + boot 是否完成。

不写任何实例数据。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "https://127.0.0.1:8003"

logs = []
errors = []


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        pg = b.new_page(ignore_https_errors=True, viewport={"width": 1600, "height": 1000})
        pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        pg.on("pageerror", lambda e: errors.append(str(e)))

        pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        print("URL:", pg.url, "TITLE:", pg.title())

        # 等 boot：ST 完成后 #send_textarea 可见
        booted = False
        try:
            pg.wait_for_selector("#send_textarea", state="attached", timeout=60000)
            booted = True
        except Exception as e:
            print("BOOT-WAIT-FAIL:", type(e).__name__)

        print("BOOTED:", booted)

        # 探测扩展加载状态（R5：入口 = 工具图标排里的插件按钮；设置抽屉零注入）
        info = pg.evaluate("""() => {
            const entry = document.getElementById('chatfilesys-entry');
            return {
                hasExtensionsSettings: !!document.querySelector('#extensions_settings'),
                legacyDrawer: !!document.querySelector('#chatfilesys-settings'),
                hasEntryButton: !!entry,
                entryInSendForm: entry ? entry.parentElement?.id === 'leftSendForm' : false,
                extPanelCount: document.querySelectorAll('#extensions_settings .inline-drawer').length,
                chatMesCount: document.querySelectorAll('#chat .mes').length,
                verBtnCount: document.querySelectorAll('#chat .chatfilesys-ver-btn').length,
            };
        }""")
        for k, v in info.items():
            print(f"{k}: {v}")

        print("--- chatfilesys console lines ---")
        for line in [x for x in logs if "chatfilesys" in x]:
            print(" ", line)
        print("--- console errors ---")
        for line in [x for x in logs if x.startswith("[error]")][:20]:
            print(" ", line)
        print("--- pageerrors ---")
        for e in errors[:20]:
            print(" ", e)
        print(f"TOTALS logs={len(logs)} errors={len(errors)}")

        b.close()
    return 0 if booted else 1


if __name__ == "__main__":
    sys.exit(main())
