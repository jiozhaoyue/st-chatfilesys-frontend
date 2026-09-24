"""ChatFilesys 纯库模式 e2e（mock 宿主，零实例依赖）

替代 Dev 实例 e2e（design.md §8.4）：本仓 tests/e2e/mock-host/index.html 经 Playwright
驱动，验证 seam 拦截 → 库读 → 拼装响应 → 库写回环。不触碰任何酒馆实例（L0-1）。

页面内动态 import 扩展源码（/public/... 绝对路径）需 http 源（file:// 的模块加载被
Chromium CORS 拦截）——本测试自起 http.server 伺服仓库根，无外部依赖。

用法: python tests/e2e/test_pure_db_mock.py
"""

import http.server
import pathlib
import socket
import sys
import threading

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
MOCK_HOST_PATH = '/tests/e2e/mock-host/index.html'


def serve_repo_root():
    """起一个伺服仓库根的 http 服务器（随机空闲端口），返回 (base_url, shutdown)。"""
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(REPO_ROOT), **kw)

        def log_message(self, *a):  # 静默
            pass

    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return f'http://127.0.0.1:{port}', server.shutdown


def main():
    failures = []
    base, shutdown = serve_repo_root()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(base + MOCK_HOST_PATH)
            page.wait_for_function("() => document.getElementById('log')?.textContent?.includes('家族容器已就位')", timeout=10000)

            # ① 打开聊天：seam 拦截 get → official 档容器读 → 拼装 [header,...rows]
            page.click('#btn-open')
            page.wait_for_function("() => document.getElementById('log').textContent.includes('打开聊天')", timeout=5000)
            log = page.evaluate("() => document.getElementById('log').textContent")
            if '打开聊天：2 行' not in log:
                failures.append(f'① 打开聊天行数不符: {log.splitlines()[-3:]}')
            if 'header 含模型: true' not in log:
                failures.append('① header 未携带分支树模型')

            # ② 追加消息：seam 拦截 append → 库写 → 响应 appended:1
            page.click('#btn-append')
            page.wait_for_function("() => document.getElementById('log').textContent.includes('append 响应')", timeout=5000)
            log = page.evaluate("() => document.getElementById('log').textContent")
            if '"appended":1' not in log.replace("'", '"'):
                failures.append(f'② append 响应异常: {log.splitlines()[-2:]}')

            # ③ 库状态：floors 行数 = 3（2 初始 + 1 追加）；integrity = 写计数（建档1+追加1 = 2）
            page.click('#btn-status')
            page.wait_for_function("() => document.getElementById('log').textContent.includes('库内家族')", timeout=5000)
            log = page.evaluate("() => document.getElementById('log').textContent")
            if '楼层行=3' not in log:
                failures.append(f'③ 库内楼层数不符（期望 3）: {log.splitlines()[-1]}')
            if 'integrity=2' not in log:
                failures.append(f'③ integrity 未随写递增（期望 2）: {log.splitlines()[-1]}')

            browser.close()
    finally:
        shutdown()

    if failures:
        print('E2E FAIL:')
        for f in failures:
            print(' -', f)
        sys.exit(1)
    print('E2E PASS: ① 打开聊天（伪装响应+模型） ② append 写库 ③ 库状态一致（3 行/integrity 递增）')


if __name__ == '__main__':
    main()
