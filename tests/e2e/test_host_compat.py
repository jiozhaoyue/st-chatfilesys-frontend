"""四宿主兼容 e2e —— 同一套断言跑在 SillyTavern / Luker / PureTavern / TauriTavern 上。

用户 2026-09-27 令：「4 种酒馆都要自动化测试，保证兼容（只要 4 个实例就好）」。

**测什么**（跨宿主真正会不一样的那几件事，而不是把功能用例再跑一遍）：
  A1 宿主起得来（能连、能到就绪信号）
  A2 插件的**静态面**能被宿主取到（manifest / index.js / style.css 三个 200，且内容真
     是我们的——防「Vite 的 SPA 回退给一份 HTML 也回 200」这类假通过）
  A3 插件在该宿主**装得上/载得入**（各宿主路径不同，见 hosts.py 与下面的 host_adapter）
  A4 插件入口出现（`#chatfilesys-entry`）——说明 `init` 被宿主调到了
  A5 管理弹窗能开，且五个页签齐全
  A6 **全程零本插件归因报错**（pageerror / console.error 里含 chatfilesys）
  A7 插件**不往宿主界面里乱塞东西**（聊天区与输入区的落点白名单）

**为什么不是「把功能用例复制四遍」**：功能语义与宿主无关（有单测与 Luker 的真机用例覆盖）；
跨宿主真正会碎的是**装配与协议**——这正是本文件测的。

跑法：
    PYTHONIOENCODING=utf-8 python tests/e2e/test_host_compat.py            # 全部可跑的宿主
    HOSTS=st,luker PYTHONIOENCODING=utf-8 python tests/e2e/test_host_compat.py

纪律：**串行**跑（同一实例并发驱动会互相污染）；只连 Instance/Dev/**。
"""
import json
import pathlib
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from hosts import HOSTS, ORDER, EXT_URL, ENTRY, REPO, PLUGIN_SRC, reachable, sync_plugin, start_hint  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

results = []


def report(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  {'✅' if ok else '❌'} {name}" + (f" —— {detail}" if detail else ""))
    return ok


# ---------------- 静态资产服务（给 PT 的 zip 安装用） ----------------

class _Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):        # 静音（默认每条请求一行，会把用例输出淹掉）
        return

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")   # PT 是跨源取 zip
        super().end_headers()


def serve_dir(directory: str, port: int) -> ThreadingHTTPServer:
    handler = lambda *a, **k: _Quiet(*a, directory=directory, **k)   # noqa: E731
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def make_plugin_zip(out_path: pathlib.Path) -> pathlib.Path:
    """把插件目录打成 zip（PT 的安装入口收一个 `.zip` URL）。"""
    import shutil
    if out_path.exists():
        out_path.unlink()
    base = out_path.with_suffix("")
    if base.exists():
        shutil.rmtree(base)
    shutil.copytree(PLUGIN_SRC, base / "chatfilesys")
    shutil.make_archive(str(out_path.with_suffix("")), "zip", root_dir=str(base))
    return out_path


# ---------------- 断言（与宿主无关的部分） ----------------

STATIC_PROBE_JS = """async ([extUrl]) => {
    const out = {};
    for (const f of ['manifest.json', 'index.js', 'style.css']) {
        try {
            const r = await fetch(extUrl + '/' + f, { cache: 'no-store' });
            const t = r.ok ? await r.text() : '';
            out[f] = { status: r.status, len: t.length,
                // 是不是**我们的**内容（防 SPA 回退把 index.html 当 200 返回）
                looksRight: f === 'manifest.json' ? t.trim().startsWith('{')
                    : f === 'index.js' ? t.includes('ChatFilesys')
                    : t.includes('chatfilesys-') };
        } catch (e) { out[f] = { status: 'ERR', err: String(e) }; }
    }
    return out;
}"""

DOM_PLACEMENT_JS = """() => {
    // 「聊天区注入」= #chat 里有本插件的元素（消息旁的版本按钮**允许**，故单独计数）
    const inChat = [...document.querySelectorAll('#chat [class*=chatfilesys], #chat [id*=chatfilesys]')];
    const inChatNonBtn = inChat.filter(x => !x.classList.contains('chatfilesys-ver-btn')).length;
    const verBtns = inChat.filter(x => x.classList.contains('chatfilesys-ver-btn')).length;
    // 入口必须在**输入框上方工具排**里（R5 裁定）；它就在 #form_sheld 内，故 form 里应当恰有它
    const entryInLeft = [...document.querySelectorAll('#leftSendForm > [id*=chatfilesys]')].length;
    // body 直挂的游离**界面**节点（弹窗里的不算）——这是「自造浮层 / 关窗没清干净」的判据。
    // 排除 SCRIPT/LINK/STYLE：那是**宿主自己的扩展加载器**插的（它把 `<script id="third-party/…">`
    // 挂在 body 上），不是本插件注入的界面（2026-09-27 实测：Luker/ST 都会插一个）。
    const stray = [...document.querySelectorAll('body > [class*=chatfilesys], body > [id*=chatfilesys]')]
        .filter(x => !x.closest('dialog'))
        .filter(x => !['SCRIPT', 'LINK', 'STYLE'].includes(x.tagName))
        .map(x => `${x.tagName}#${x.id}.${x.className}`.slice(0, 80));
    const loaderTags = [...document.querySelectorAll('body > script[id*=chatfilesys], body > link[id*=chatfilesys]')]
        .map(x => `${x.tagName}#${x.id}`.slice(0, 60));
    return { inChat: inChatNonBtn, verBtns, allInChat: inChat.length, entryInLeft, stray, loaderTags };
}"""

POPUP_PROBE_JS = """() => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    if (!root) return { open: false };
    const tabs = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map(x => x.textContent.trim());
    // 切到「当前聊天」页签再取内容：宿主 tabs 惰性渲染，别的页签的 body 可能还没建
    const btn = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')]
        .find(x => x.textContent.trim() === '当前聊天');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { open: true, tabs };
}"""

# 「当前聊天」页签**两种合法形态**，取决于这个聊天启用没启用：
#  已启用 → 结构树 host + 分支选择器
#  未启用 → 「启用」按钮（引导态）
# 两者都没才说明页签内容没渲染出来（真缺陷）
CHAT_TAB_PROBE_JS = """() => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    if (!root) return { present: false };
    const body = root.querySelector('[data-tabbody="chat"]');
    return {
        present: Boolean(body),
        inner: Boolean(body?.querySelector('.chatfilesys-tab-inner')),
        hasTree: Boolean(body?.querySelector('[data-role="tree-host"]')),
        hasPicker: Boolean(body?.querySelector('[data-role="branch-picker"]')),
        hasEnable: Boolean(body?.querySelector('[data-action="enable"]')),
    };
}"""


def open_popup(page):
    page.evaluate("""() => {
        const b = document.querySelector('#chatfilesys-entry');
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }""")
    page.wait_for_timeout(2500)


def assert_common(page, host, errors, console_errors) -> None:
    """与宿主无关的那几条断言（A4-A7）。"""
    entry = page.evaluate(f"() => Boolean(document.querySelector('{ENTRY}'))")
    report(f"[{host.label}] A4 插件入口出现（宿主调到了 init）", entry,
           f"{ENTRY} {'在' if entry else '不在'}")
    if not entry:
        return

    open_popup(page)
    pv = page.evaluate(POPUP_PROBE_JS)
    want = {'当前聊天', '结构图', '角色卡的聊天', '设置', '回收站'}
    got = set(pv.get('tabs') or [])
    report(f"[{host.label}] A5 管理弹窗可开且五个页签齐全",
           pv.get('open') and want.issubset(got),
           f"open={pv.get('open')} tabs={sorted(got)}")

    page.wait_for_timeout(900)          # 等页签切换后的内容渲染
    tab = page.evaluate(CHAT_TAB_PROBE_JS)
    # 两种合法形态：**启用态**（.chatfilesys-tab-inner 内有树 + 分支选择器）或
    # **未启用态**（`renderInactiveContent` 会把整个 tab-inner **换掉**，只剩「启用」按钮——
    # 那时 `.chatfilesys-tab-inner` 本来就不存在，不是缺陷）
    ok_tab = bool(tab.get('hasEnable')) or (
        bool(tab.get('inner')) and bool(tab.get('hasTree')) and bool(tab.get('hasPicker')))
    report(f"[{host.label}] A5b 「当前聊天」页签内容渲染出来（启用态看树 / 未启用态看引导）",
           ok_tab, f"{tab}")

    # 关窗（走宿主自己的关闭路径；顺带验证「关得掉」）
    page.evaluate("""() => {
        const dlgs = [...document.querySelectorAll('dialog')].filter(d => d.querySelector('.chatfilesys-popup'));
        const dlg = dlgs.find(d => d.open) || dlgs[0];
        dlg?.querySelector('.popup-button-close')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }));
    }""")
    page.wait_for_timeout(1200)
    residue = page.evaluate("() => document.querySelectorAll('.chatfilesys-popup').length")
    report(f"[{host.label}] A5c 关窗后无残留节点", residue == 0, f"残留 {residue} 个")

    mine = [e for e in errors if 'chatfilesys' in e.lower()]
    mycon = [e for e in console_errors if 'chatfilesys' in e.lower()]
    report(f"[{host.label}] A6 全程零本插件归因报错", not mine and not mycon,
           f"pageerror={mine[:2]} console={mycon[:2]}")

    place = page.evaluate(DOM_PLACEMENT_JS)
    # 白名单口径（与 spec/frontend/ui-placement.md 一致）：
    #  · 聊天区**只允许**消息旁的版本按钮（`.chatfilesys-ver-btn`），别的一律不许
    #  · 入口必须在 `#leftSendForm` 里（官方工具排）——**不是在 `#form_sheld` 里就算**，
    #    因为 `#leftSendForm` 本身就在 `#form_sheld` 内，那样写会把「挂错位置」判成通过
    #  · `body` 下不许有**不在 dialog 内**的本插件节点（自造浮层的判据）
    ok_place = (place['inChat'] == 0 and place['entryInLeft'] >= 1 and not place['stray'])
    report(f"[{host.label}] A7 落点白名单（聊天区零注入、入口在工具排、body 下零游离）",
           ok_place, f"{place}")


# ---------------- 各宿主的装配差异（只有这里允许分叉） ----------------

def boot_http(page, host, timeout_ms=200000):
    """驱一个 HTTP 宿主到就绪。"""
    page.goto(host.base + "/", wait_until="commit", timeout=120000)
    page.wait_for_selector(host.ready_selector, timeout=timeout_ms)
    page.wait_for_timeout(host.wait_ms)


def install_pt(page, zip_url: str):
    """PureTavern：**不做文件系统发现**，只认 `installExtension(url)`（zip）。

    现场依据（PT 仓 `apps/web/scripts/legacy-contracts.mjs:536`）：
    「Runtime discovery currently returns an empty list and third-party extension loading is
    disabled」——但 `verify-browser-startup.mjs:1002` 又确实调 `installExtension(extensionUrl, ...)`
    装一个 `.zip`。故 PT 的兼容路径 = **走它自己的安装入口**，不是往目录里拷文件。

    **必须有界**（2026-09-28 实测）：第二次跑时扩展**已经装过**，宿主不再弹「第三方扩展」警告框，
    于是 `await p` 永远不 settle ⇒ 用例整段挂死四十分钟（不是失败，是挂着）。
    故 ① 先查是不是已装、② 用 `Promise.race` 给安装本身加超时。
    """
    return page.evaluate("""async ([url]) => {
        try {
            const m = await import('/scripts/extensions.js');
            if (typeof m.installExtension !== 'function') return { ok: false, why: 'no-installExtension' };
            const already = (m.extensionNames || []).some((x) => x.includes('chatfilesys'));
            const p = m.installExtension(url, false, '');
            // 警告框可能弹（首次）也可能不弹（已装过）——点一下，点不到就算了
            await new Promise((r) => setTimeout(r, 2500));
            let clicked = 0;
            for (const d of [...document.querySelectorAll('.popup[open], dialog[open]')]) {
                const ok = d.querySelector('.popup-button-ok');
                if (ok) { ok.click(); clicked += 1; }
            }
            // 有界等待：8s 不 settle 就按「已装/无框」继续，不让用例挂死
            const settled = await Promise.race([
                p.then((v) => ({ done: true, v })).catch((e) => ({ done: true, err: String(e).slice(0, 160) })),
                new Promise((r) => setTimeout(() => r({ done: false }), 8000)),
            ]);
            const names = (m.extensionNames || []).filter((x) => x.includes('chatfilesys'));
            return { ok: names.length > 0, already, clicked, settled, names,
                     warning: settled.done ? null : '安装 promise 未在 8s 内 settle（已按已装处理）' };
        } catch (e) { return { ok: false, why: String(e).slice(0, 200) }; }
    }""", [zip_url])


def run_http_host(pw, host, static_probe_url):
    b = pw.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
    c = b.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1000})
    page = c.new_page()
    errors, console_errors = [], []
    page.on("pageerror", lambda e: errors.append(str(e)[:300]))
    page.on("console", lambda m: console_errors.append(m.text[:300]) if m.type == "error" else None)
    try:
        boot_http(page, host)
        report(f"[{host.label}] A1 宿主到就绪", True, host.ready_selector)

        st = page.evaluate(STATIC_PROBE_JS, [EXT_URL])
        static_ok = all(
            isinstance(st.get(f), dict) and st[f].get('status') == 200 and st[f].get('looksRight')
            for f in ('manifest.json', 'index.js', 'style.css'))
        print(f"  静态面探测（安装前）：{json.dumps(st, ensure_ascii=False)[:200]}")

        if static_ok:
            report(f"[{host.label}] A2 静态面可取且**内容真是我们的**", True,
                   "宿主扫扩展目录，插件文件直接可取")
            report(f"[{host.label}] A3 扩展目录直装（宿主扫目录）", True, "无需安装步骤")
        else:
            # 这里**不是失败**：PT 这类宿主不扫目录（discovery 恒为空），要先经它自己的安装入口装。
            # 反而是「回 200 但内容不是我们的」这件事值得说明——Vite 的 SPA 回退会把 index.html
            # 当 200 返回（实测 743107 字节的 HTML），只看状态码就会把它误判成「扩展已就位」。
            print("  ↳ 未取到我们的静态面（宿主不扫目录，或 SPA 回退返回了 HTML）⇒ 走安装入口")
            inst = install_pt(page, static_probe_url)
            report(f"[{host.label}] A3 经宿主安装入口装入扩展", inst.get('ok'),
                   json.dumps(inst, ensure_ascii=False)[:200])
            page.reload(wait_until="commit")
            page.wait_for_selector(host.ready_selector, timeout=200000)
            page.wait_for_timeout(host.wait_ms)
            st2 = page.evaluate(STATIC_PROBE_JS, [EXT_URL])
            report(f"[{host.label}] A2 装入后静态面可取且是我们自己的", all(
                isinstance(st2.get(f), dict) and st2[f].get('status') == 200 and st2[f].get('looksRight')
                for f in ('manifest.json', 'index.js', 'style.css')),
                json.dumps(st2, ensure_ascii=False)[:220])

        # 入口出现需要时间（宿主按 loading_order 逐个激活；实测 Luker 冷启动 ~38s）
        deadline = time.time() + 90
        while time.time() < deadline:
            if page.evaluate(f"() => Boolean(document.querySelector('{ENTRY}'))"):
                break
            page.wait_for_timeout(1500)

        assert_common(page, host, errors, console_errors)
    finally:
        b.close()


def run_host(pw, key: str, static_probe_url: str):
    host = HOSTS[key]
    print(f"\n===== {host.label}（{host.base or '桌面宿主'}）=====")
    if host.pilot:
        print(f"  ⏭  TauriTavern 走 WebView 自动化（tauri-plugin-pilot），见 test_host_compat_tt")
        return
    up, how = reachable(host.base, timeout=20)
    if not up:
        # 环境没起 ≠ 产品不兼容：**记一条跳过并打印启动命令**，不计入失败
        print(f"  ⏭  跳过：宿主没起（{how}）")
        print(f"     启动：{start_hint(host)}")
        return
    if host.ext_dir is not None:
        ok, msg = sync_plugin(host)
        print(f"  插件同步：{'✅' if ok else '❌'} {msg}")
        if not ok:
            report(f"[{host.label}] 插件可同步到实例", False, msg)
            return
    else:
        # 该宿主不扫目录（PT：只认 `installExtension(zipUrl)`）⇒ **不该同步**，
        # 由用例走到安装分支去装。此时中止就等于「因为没拷文件而判定不兼容」，是错判。
        print("  插件同步：⏭  该宿主不扫目录，改走它自己的安装入口")
    run_http_host(pw, host, static_probe_url)


def main():
    zip_url = None
    srv = None
    try:
        # PT 要从 URL 装 zip：起一个静态服务
        out = REPO / ".e2e-dist" / "chatfilesys"
        out.parent.mkdir(exist_ok=True)
        zp = make_plugin_zip(out.with_suffix(".zip"))
        srv = serve_dir(str(out.parent), 8417)
        zip_url = "http://127.0.0.1:8417/chatfilesys.zip"
        print(f"静态服务：http://127.0.0.1:8417/（zip={zip_url}）")

        with sync_playwright() as pw:
            for key in ORDER:
                try:
                    run_host(pw, key, zip_url)
                except Exception:      # noqa: BLE001
                    import traceback
                    traceback.print_exc()
                    report(f"[{HOSTS[key].label}] 用例自身异常", False, "见上面的栈")
        return 0 if results and all(ok for _n, ok in results) else 1
    finally:
        if srv:
            srv.shutdown()


if __name__ == "__main__":
    code = main()
    skipped = [k for k in ORDER if HOSTS[k].pilot or not reachable(HOSTS[k].base, timeout=8)[0]]
    print(f"\n（跳过：{skipped or '无'}）")
    ok = bool(results) and all(o for _n, o in results) and code == 0
    print("\nHOST COMPAT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
