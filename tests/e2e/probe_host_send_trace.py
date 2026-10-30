"""探针：UI 发消息时宿主实际发哪些 /api/chats/* 请求（决定 seam 拦截面）"""
import sys, pathlib
sys.path.insert(0, r"D:\Repo\Tavern-repo\My-repo\ST-chatfilesys-rebuild\tests\e2e")
from playwright.sync_api import sync_playwright
from harness import reset_instance  # noqa

BASE = "https://127.0.0.1:8003"
CHAR = "__cb_e2e"
CREATE = r"""async (name) => { const r = await fetch('/api/characters/create', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: (() => { const fd = new FormData(); fd.append('name', name); fd.append('description', 'e2e'); fd.append('first_mes', '开场问候语（F1）'); fd.append('avatar', 'none'); return fd; })() }); return { status: r.status }; }"""

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        reset_instance(page)
        page.evaluate(CREATE, CHAR)
        page.wait_for_timeout(1500)
        # 打开该角色
        page.evaluate(r"""async (name) => {
            const c = SillyTavern.getContext();
            const idx = (c.characters || []).findIndex((x) => x.name === name);
            await c.selectCharacterById(idx);
            await new Promise((r) => setTimeout(r, 3000));
            return c.characterId;
        }""", CHAR)
        page.wait_for_timeout(2000)
        # 记录所有 fetch/xhr 到 /api/
        page.evaluate(r"""() => {
            window.__trace = [];
            const of = window.__nativeFetch || globalThis.fetch;
            globalThis.fetch = (...a) => {
                try {
                    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
                    if (u.includes('/api/chats/')) {
                        let body = null;
                        try { body = a[1]?.body ? String(a[1].body).slice(0, 700) : null; } catch {}
                        window.__trace.push({ u: u.slice(0, 120), m: a[1]?.method || 'GET', body });
                    }
                } catch {}
                return of(...a);
            };
            const xo = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (m, u, ...rest) {
                try { if (String(u).includes('/api/')) window.__trace.push({ u: String(u).slice(0, 120), m, xhr: true }); } catch {}
                return xo.call(this, m, u, ...rest);
            };
        }""")
        page.evaluate("""() => { const ta = document.querySelector('#send_textarea'); ta.value = '探针消息'; ta.dispatchEvent(new Event('input', { bubbles: true })); }""")
        page.evaluate("""() => document.querySelector('#send_but').click()""")
        page.wait_for_timeout(9000)
        trace = page.evaluate("() => window.__trace")
        chat_len = page.evaluate("() => (SillyTavern.getContext().chat || []).length")
        for t in trace: print(" ", t)
        print("chatLen =", chat_len)
        b.close()

if __name__ == "__main__":
    main()
