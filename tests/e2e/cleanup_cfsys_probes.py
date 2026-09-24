"""清场脚本：删除真机测试遗留的探针隐容器（交接文档 00-HANDOVER.md §五义务）

删除虚构 avatar `__cfsys__` 下的探针容器（插件产物，可自主清，非用户数据）：
- 5 个测试家族容器 + index 索引容器
- 用户聊天 `__cb_e2e` 内的探针消息是透传写入的用户数据，不在本脚本职责内（只提示不代删，PARDON）

用法: python tests/e2e/cleanup_cfsys_probes.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"

PROBES = [
    "__cfsys__f_journey0924.jsonl",
    "__cfsys__f_j2.jsonl",
    "__cfsys__f_min.jsonl",
    "__cfsys__f_final.jsonl",
    "__cfsys__f_v3.jsonl",
    "__cfsys__index.jsonl",
]

JS = """async (names) => {
    const c = window.SillyTavern?.getContext?.();
    const H = c?.getRequestHeaders?.();
    if (!H) return { ok: false, reason: 'no-ctx-headers' };
    const out = [];
    for (const name of names) {
        try {
            const r = await fetch('/api/chats/delete', {
                method: 'POST',
                headers: H,
                body: JSON.stringify({ avatar_url: '__cfsys__', chatfile: name }),
            });
            out.push({ name, status: r.status, body: (await r.text()).slice(0, 80) });
        } catch (e) {
            out.push({ name, error: String(e).slice(0, 80) });
        }
    }
    return { ok: true, results: out };
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        result = page.evaluate(JS, PROBES)
        browser.close()

    for r in result.get("results", []):
        print(f"  {r}")
    if result.get("ok"):
        print("\nCLEANUP DONE: 探针隐容器清理完成（用户数据未触碰）")
    else:
        print(f"\nCLEANUP FAIL: {result}")
        sys.exit(1)


if __name__ == "__main__":
    main()
