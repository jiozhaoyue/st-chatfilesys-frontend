"""ChatFilesys §8.4④ 真机验证（Dev 实例 8003，零部署，守 L0-1）

验证核心风险点（design.md §8.4④）：宿主消息 API 持久化是否走 /api/chats/* fetch
（→ seam 可拦截转写库）。已真机定论（2026-09-24）：

    发一条消息 → chats/append + chats/save + chats/meta/patch（全部 fetch，seam 可拦）
    chats/state/patch ×4 = Chat State 侧车（.luker-state.<ns>.json，独立于 jsonl，
    正确行为 = 透传不拦；FK CASCADE 级联删随聊天文件走）

本脚本固化该验证为可回归 e2e：selectCharacterById 打开 __cb_e2e 测试角色 → 注入
fetch 记录器（记录后原样转发）→ 真实 UI 发消息 → 断言观察到 chats/append 或
chats/save 写端点。

L0-1 纪律：不写实例文件系统；聊天写入仅限 __cb_e2e 专用测试角色。
用法: python tests/e2e/test_message_api_fetch.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"
CHAR_NAME = "__cb_e2e"  # 专用测试角色（历史 e2e 已用，可写入）


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        browser_ctx = browser.new_context(ignore_https_errors=True)
        page = browser_ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        print("[dev] Luker 页面就绪")

        # ① 注入 fetch 记录器（wrap：记录 /api/chats/* 调用后原样转发，不拦截不修改）
        page.evaluate(
            """() => {
                window.__fetchLog = [];
                const of = globalThis.fetch;
                globalThis.fetch = function (input, init) {
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url) || '';
                        if (url.includes('/api/chats/')) {
                            let body = init && init.body;
                            if (body) { try { body = JSON.parse(body); } catch { body = String(body).slice(0, 80); } }
                            window.__fetchLog.push({ url, method: (init && init.method) || 'GET', body });
                        }
                    } catch (e) {}
                    return of.apply(this, arguments);
                };
            }"""
        )

        # ② 经角色列表索引 selectCharacterById 打开测试角色（页面内完成，零文件写入）
        opened = page.evaluate(
            """async (charName) => {
                const c = window.SillyTavern?.getContext?.();
                const H = c?.getRequestHeaders?.();
                const res = await fetch('/api/characters/all', { method: 'POST', headers: H, body: JSON.stringify({}) });
                const chars = await res.json();
                const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === charName);
                if (idx < 0) return { ok: false, reason: 'char-not-found', n: chars.length };
                await c.selectCharacterById(idx);
                await new Promise(res2 => setTimeout(res2, 6000));
                return { ok: true, chatId: c.chatId, chatLen: (c.chat || []).length };
            }""",
            CHAR_NAME,
        )
        print(f"[dev] selectCharacterById: {opened}")
        if not opened.get("ok") or not opened.get("chatLen"):
            browser.close()
            sys.exit(f"打开测试聊天失败: {opened}")

        # ③ 真实 UI 发消息（探针消息，落在测试角色的聊天里，可删）
        page.fill("#send_textarea", "§8.4④ 探针（e2e 测试角色，可删）")
        page.click("#send_but")
        page.wait_for_timeout(12000)  # 等回复/保存链跑完

        logs = page.evaluate("() => window.__fetchLog || []")
        print(f"[dev] 捕获 {len(logs)} 个 /api/chats/* 调用")
        seen_urls = {e["url"] for e in logs}
        for u in sorted(seen_urls):
            print(f"  {u}")
        browser.close()

    # 断言：消息持久化写端点走 fetch（append/save 任一出现即证明可拦截）
    write_hits = [u for u in seen_urls if u.endswith("/api/chats/append") or u.endswith("/api/chats/save") or u.endswith("/api/chats/patch")]
    if write_hits:
        print(f"\nVERIFY PASS: 宿主消息持久化走 fetch（{', '.join(sorted(set(write_hits)))}）——seam 可拦截，无需第二接缝")
    else:
        print("\nVERIFY FAIL: 未观察到消息写端点")
        sys.exit(1)


if __name__ == "__main__":
    main()

