"""只读侦察 2：给扩展激活留足时间，打时间轴，看激活链走到哪一步。"""
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "https://127.0.0.1:8003"
logs = []
errors = []


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        pg = b.new_page(ignore_https_errors=True, viewport={"width": 1600, "height": 1000})
        pg.on("console", lambda m: logs.append((round(time.time() - t0, 1), m.type, m.text[:300])))
        pg.on("pageerror", lambda e: errors.append((round(time.time() - t0, 1), str(e)[:300])))

        t0 = time.time()
        pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        print(f"[{time.time()-t0:.1f}s] domcontentloaded {pg.url}")

        probe = """() => ({
            ext: document.querySelectorAll('#extensions_settings .inline-drawer').length,
            ext2: document.querySelectorAll('#extensions_settings2 .inline-drawer').length,
            drawer: !!document.querySelector('#chatfilesys-settings'),
            contentLen: (document.querySelector('#chatfilesys-settings .chatfilesys-content')||{innerHTML:''}).innerHTML.length,
            mes: document.querySelectorAll('#chat .mes').length,
            sendReady: !!document.querySelector('#send_textarea'),
            loader: !!document.querySelector('#loader'),
        })"""

        last = None
        deadline = t0 + 150
        while time.time() < deadline:
            try:
                cur = pg.evaluate(probe)
            except Exception as e:
                print(f"[{time.time()-t0:.1f}s] eval-fail {type(e).__name__}")
                time.sleep(2)
                continue
            if cur != last:
                print(f"[{time.time()-t0:.1f}s] {cur}")
                last = cur
            if cur["drawer"] and cur["contentLen"] > 0:
                print(f"[{time.time()-t0:.1f}s] >>> chatfilesys panel RENDERED")
                break
            time.sleep(2)

        print("--- console (all, first 60) ---")
        for ts, typ, txt in logs[:60]:
            print(f"  [{ts}s][{typ}] {txt}")
        print("--- pageerrors ---")
        for ts, e in errors[:20]:
            print(f"  [{ts}s] {e}")
        print(f"TOTALS logs={len(logs)} errors={len(errors)}")
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
