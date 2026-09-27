"""TauriTavern 兼容 e2e —— 用 `tauri-pilot` 的 **eval** 驱动桌面 WebView。

用户 2026-09-27 令：「4 种酒馆都要自动化测试，保证兼容」。TT 是四宿主里唯一**没有 HTTP 端点**
的（Rust/Tauri 桌面应用），故它的驱动方式与前三个不同：

    pnpm tauri:dev:pilot          # 起 TT（启用 tauri-plugin-pilot）
    cargo install tauri-pilot-cli # 装驱动 CLI（TT 官方 README 指定的唯一自动化方式）
    tauri-pilot eval "<js>"       # 在页面里求值 —— 等价于 Playwright 的 page.evaluate

于是本文件能复用与 `test_host_compat.py` **同一套断言**（静态面 / 入口 / 弹窗与页签 /
关窗无残留 / 零本插件归因报错 / 落点白名单），只是把「驱动」换成子进程调 CLI。

前提（跑之前确认）：
  1. TT 在跑，且 `tauri-pilot ping` 能连上
  2. 插件已同步到 TT 的扩展目录（`%APPDATA%/com.tauritavern.client/data/default-user/extensions/`）
  3. **同步之后要重载页面**（`location.reload()`）——TT 只在启动时扫扩展目录，
     不重载的话插件不会加载（2026-09-28 实测：同步后入口一直是 false，重载后才出现）

跑法：PYTHONIOENCODING=utf-8 python tests/e2e/test_host_compat_tt.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from hosts import HOSTS, PLUGIN_SRC, EXT_URL, ENTRY, sync_plugin  # noqa: E402

TT = HOSTS["tt"]
CARGO_BIN = pathlib.Path(os.environ.get("USERPROFILE", "")) / ".cargo" / "bin"
PILOT = str(CARGO_BIN / "tauri-pilot.exe")

results = []


def report(name, ok, detail=""):
    results.append(bool(ok))
    print(f"  {'✅' if ok else '❌'} {name}" + (f" —— {detail}" if detail else ""))
    return ok


def pilot(*args, timeout=180):
    """调一次 CLI，返回 (returncode, stdout)。"""
    env = dict(os.environ)
    env["PATH"] = f"{CARGO_BIN}{os.pathsep}{env.get('PATH', '')}"
    try:
        p = subprocess.run([PILOT, *args], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout, env=env)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, "tauri-pilot 未安装（cargo install tauri-pilot-cli）"
    except subprocess.TimeoutExpired:
        return 124, f"超时（{timeout}s）"


def ev(js, timeout=180):
    """在 TT 页面里求值，返回解析后的 JSON（约定：脚本自己 `JSON.stringify`）。"""
    code, out = pilot("eval", js, timeout=timeout)
    if code != 0:
        return {"__error": out.strip()[:300]}
    # CLI 可能带前后缀输出；取最后一行能解析成 JSON 的
    for line in reversed(out.strip().splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {"__raw": out.strip()[:300]}


def ev_json(js, timeout=180, poll=90):
    """在页面里跑一段**异步** JS 并把结果 JSON 化返回。

    **不能直接用顶层 await**：`tauri-pilot eval` 按**表达式**求值，没有模块语义
    （实测报 `await is not defined`，2026-09-28）。故走**副作用 + 轮询**：
    先挂一个 async IIFE 把结果写到 `window.__probe`，再轮询读它。
    """
    start = ("window.__probe = null; window.__probeErr = null;\n"
             "(async () => { try { window.__probe = JSON.stringify(await (async () => {"
             f"{js}"
             "})()); } catch (e) { window.__probeErr = String(e && (e.stack || e.message) || e); }\n"
             "})();\n'started'")
    code, out = pilot("eval", start, timeout=60)
    if code != 0:
        return {"__error": out.strip()[:300]}
    end = time.time() + poll
    while time.time() < end:
        time.sleep(1.5)
        v = ev("window.__probe")
        # **注意 `ev()` 已经把 CLI 输出解析过了**：`window.__probe` 存的是 JSON 字符串，
        # CLI 把它按「字符串值」打印出来 → `ev()` 再 `json.loads` 一次就成了 dict/list。
        # 第一版这里只判 `isinstance(v, str)`，于是明明写回了也**永远判超时**
        # （2026-09-28 实测：值早就在，用例却报「轮询超时」）。
        if v is None or (isinstance(v, str) and not v):
            pass                                   # 还没写回
        elif isinstance(v, (dict, list)):
            return v                               # 已解析好
        elif isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return {"__raw": v[:300]}
        e = ev("window.__probeErr")
        if e:
            return {"__error": str(e)[:300]}
    return {"__error": "轮询超时（异步脚本没在 %ds 内写回结果）" % poll}


def ev_sync(js, timeout=120):
    """同步求值（走 CLI 的原生返回）。"""
    return ev(js, timeout=timeout)


# ---------------- 断言（与前三个宿主同形） ----------------

def main():
    print(f"TauriTavern —— 驱动：{PILOT}")
    code, out = pilot("ping", timeout=60)
    report("T0 tauri-pilot 能连上 TT（应用在跑且 pilot 已启用）", code == 0 and "Connected" in out,
           out.strip().splitlines()[0][:120] if out.strip() else "(无输出)")
    if code != 0:
        print("  提示：先 `cd Instance/Dev/TauriTavern && RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc pnpm tauri:dev:pilot`")
        return 1

    # 同步插件（TT 的数据在 %APPDATA%，不在仓里）
    ok, msg = sync_plugin(TT)
    report("T1 插件已同步到 TT 扩展目录", ok, msg)

    # **同步之后必须重载**：TT 只在启动时扫扩展目录
    print("  重载页面（TT 只在启动时扫扩展目录）…")
    ev("location.reload(); 'ok'", timeout=60)
    deadline = time.time() + 180
    entry = False
    while time.time() < deadline:
        time.sleep(5)
        entry = ev(f"Boolean(document.querySelector('{ENTRY}'))")
        if entry is True:
            break
    report("T2 插件入口出现（宿主调到了 init）", entry is True,
           f"{ENTRY} {'在' if entry is True else '不在'}")
    # **重载刚结束时页面还在初始化**：此时挂的异步探针会被随后的导航/重绘冲掉
    # （2026-09-28 实测：T3/T5/T7 全部「轮询超时」，而同一个脚本手工直测是好的）。
    time.sleep(8)

    # 静态面：内容是不是我们的（防「200 但是别的东西」）
    st = ev_json(f"""const out = {{}};
        for (const f of ['manifest.json','index.js','style.css']) {{
            const r = await fetch('{EXT_URL}/' + f, {{ cache: 'no-store' }});
            const t = r.ok ? await r.text() : '';
            out[f] = {{ status: r.status, len: t.length,
                looksRight: f === 'manifest.json' ? t.trim().startsWith('{{')
                    : f === 'index.js' ? t.includes('ChatFilesys') : t.includes('chatfilesys-') }};
        }}
        return out;""")
    static_ok = all(isinstance(st.get(f), dict) and st[f].get('status') == 200 and st[f].get('looksRight')
                    for f in ('manifest.json', 'index.js', 'style.css'))
    report("T3 静态面可取且**内容真是我们的**", static_ok, json.dumps(st, ensure_ascii=False)[:220])

    # 打开弹窗（与浏览器版同样的方式：派发点击）
    ev_sync(f"""document.querySelector('{ENTRY}')?.dispatchEvent(
        new MouseEvent('click', {{ bubbles: true, cancelable: true }})); 'clicked'""")
    time.sleep(3)
    pv = ev_json("""const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
        if (!root) return { open: false };
        const tabs = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map(x => x.textContent.trim());
        const btn = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')]
            .find(x => x.textContent.trim() === '当前聊天');
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { open: true, tabs };""")
    want = {'当前聊天', '结构图', '角色卡的聊天', '设置', '回收站'}
    got = set(pv.get('tabs') or [])
    report("T4 管理弹窗可开且五个页签齐全", pv.get('open') and want.issubset(got),
           f"open={pv.get('open')} tabs={sorted(got)}")

    time.sleep(1.5)
    tab = ev_json("""const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
        const body = root?.querySelector('[data-tabbody="chat"]');
        return { inner: Boolean(body?.querySelector('.chatfilesys-tab-inner')),
            hasTree: Boolean(body?.querySelector('[data-role="tree-host"]')),
            hasPicker: Boolean(body?.querySelector('[data-role="branch-picker"]')),
            hasEnable: Boolean(body?.querySelector('[data-action="enable"]')) };""")
    ok_tab = bool(tab.get('hasEnable')) or (bool(tab.get('inner')) and bool(tab.get('hasTree')))
    report("T5 「当前聊天」页签内容渲染出来（启用态看树 / 未启用态看引导）", ok_tab, f"{tab}")

    # 关窗 + 残留
    ev_sync("""const dlgs = [...document.querySelectorAll('dialog')].filter(d => d.querySelector('.chatfilesys-popup'));
        const dlg = dlgs.find(d => d.open) || dlgs[0];
        dlg?.querySelector('.popup-button-close')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })); 'closing'""")
    time.sleep(2.5)
    residue = ev("document.querySelectorAll('.chatfilesys-popup').length")
    report("T6 关窗后无残留节点", residue == 0, f"残留 {residue} 个")

    # 落点白名单
    place = ev_json("""const inChat = [...document.querySelectorAll('#chat [class*=chatfilesys], #chat [id*=chatfilesys]')]
            .filter(x => !x.classList.contains('chatfilesys-ver-btn')).length;
        const entryInLeft = [...document.querySelectorAll('#leftSendForm > [id*=chatfilesys]')].length;
        const stray = [...document.querySelectorAll('body > [class*=chatfilesys], body > [id*=chatfilesys]')]
            .filter(x => !x.closest('dialog')).filter(x => !['SCRIPT','LINK','STYLE'].includes(x.tagName)).length;
        return { inChat, entryInLeft, stray };""")
    report("T7 落点白名单（聊天区零注入、入口在工具排、body 下零游离）",
           place.get('inChat') == 0 and place.get('entryInLeft', 0) >= 1 and not place.get('stray'),
           f"{place}")

    # 零本插件归因报错（读 TT 自己的日志）
    code, logs = pilot("logs", "--level", "error", timeout=120)
    mine = [ln for ln in logs.splitlines() if 'chatfilesys' in ln.lower()]
    report("T8 错误日志里零本插件归因", not mine, f"{mine[:2]}")

    return 0 if all(results) else 1


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nHOST COMPAT TT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
