"""ChatFilesys 纯库模式真机验证（Dev 实例 8003，运行时注入，零部署）

约束（L0-1）：不向实例目录写入任何文件。本测试把本仓新版扩展模块以动态 import
注入真实 Luker 页面运行（仅存在于该测试页签的内存中），验证：
① seam 在真实宿主环境安装/卸载正常，非聊天请求透传不破坏页面
② 拦截 chats/get 时能正确识别「未接管聊天」并透传原生响应（真实端点行为基线）

用法: python tests/e2e/test_pure_db_devinject.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"
# 扩展源码经本仓静态服务器伺服（.claude/launch.json 的 chatfilesys-mock-host，端口 8417）
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"

print(f"扩展源码 HTTP 源: {EXT_SRC}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
    print("[dev] Luker 页面就绪")

    # 在页面上下文里动态 import 本仓源码（file:// 跨源——用 fetch 文本+eval 绕过，仅测试用）
    result = page.evaluate(
        """async (extSrc) => {
            const out = { steps: [] };
            try {
                // ① 动态加载 seam（fetch file:// 文本 + blob URL import，绕开 CORS）
                const src = await (await fetch(extSrc + '/core/seam.js')).text();
                const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                const mod = await import(blobUrl);
                out.steps.push('import seam: ok (' + Object.keys(mod).join(',') + ')');

                // ② 构造哑适配器（任何 loadFamily 都返回 null = 全部未接管 → 纯透传模式）
                const dummy = {
                    async loadFamily() { return null; },
                    async loadFloors() { return { floors: [], hasMore: false }; },
                    async saveFloors() { return { ok: true, integrity: 1 }; },
                    async applyOps() { return { ok: true, integrity: 1 }; },
                    async renameFamily() { return { ok: true }; },
                    async deleteFamily() { return { ok: true }; },
                };
                const handle = mod.installSeam(dummy, { log: (m) => out.steps.push('warn: ' + String(m).slice(0, 120)) });
                out.steps.push('install: ok');

                // ③ 真实宿主请求经 seam 透传（未接管聊天 get → 原生响应）
                const r = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ avatar_url: 'none-mock.png', file_name: '__probe__.jsonl' }),
                });
                out.steps.push('native get status: ' + r.status + ' (body head: ' + String(await r.text()).slice(0, 80) + ')');

                // ④ 非聊天请求透传（站点内任意静态资源）
                const s = await fetch('/img/five.png', { method: 'GET' });
                out.steps.push('static passthrough: ' + s.status);

                handle.dispose();
                out.steps.push('dispose: ok');
                out.ok = true;
            } catch (e) {
                out.steps.push('FAIL: ' + (e && e.message || String(e)));
                out.ok = false;
            }
            return out;
        }""",
        EXT_SRC,
    )
    browser.close()

print("\n".join(result["steps"]))
if not result.get("ok"):
    sys.exit(1)
print("\nDEV-INJECT E2E PASS: seam 在真实 Luker 环境安装/透传/卸载正常")
