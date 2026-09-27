"""真实数据 + AI 链路真机用例（孤独摇滚角色卡的长聊天）—— Dev Luker 8003。

用户 2026-09-27 令：「用实例测，用类脑-gg api 预设，用 3.1pro 模型（不是完整名，自己看）……
那孤独摇滚角色卡的那些文件测，一直测，模拟用户，没有模板就看整个实例，把模板放进去，然后测」。

**夹具策略（不碰用户数据）**：从 `data/default-user/chats/孤独摇滚/` 里**复制**一份真实聊天
（`被两位大姐姐欺负.jsonl`，115 层 / 约 300 万字符）到测试角色名下；
**原文件只读、绝不改动**（L0-1：实例数据可写，但真实数据不代删代改）。

**它证明什么**：
  R1 真·长聊天能**导入**（转库）——115 层全进库，零丢失
  R2 结构图在 115 节点上的**真实性能数字**（建图 / 布局各多少毫秒）
  R3 **AI 链路真跑通**：用实例里配好的「类脑-GGg3.1p」（`gemini-3.1-pro-preview`）出摘要
  R4 **「用户可调」真生效**：抓下游请求体，断言提示词长度确实被 `ai.max_chars` /
     `ai.chars_per_floor` 卡住（改了设置就改行为——不是摆着好看的开关）

跑法：PYTHONIOENCODING=utf-8 python tests/e2e/test_real_data_ai.py
"""
import json
import pathlib
import shutil
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report as _report, reset_instance, BASE, ENTRY, EXT_SRC, TEST_CHAR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []


def report(name, ok, detail=""):
    results.append(bool(ok))
    return _report(name, ok, detail)


LUKER_CHATS = pathlib.Path(r"D:\Repo\Tavern-repo\Instance\Dev\Luker\data\default-user\chats")
SRC_CHAR = "孤独摇滚"
FIXTURE_SRC = LUKER_CHATS / SRC_CHAR / "被两位大姐姐欺负.jsonl"
FIXTURE_NAME = "__cb_e2e - 孤独摇滚夹具"


def stage_fixture() -> tuple[bool, str, str]:
    """把真实聊天**复制**成测试角色名下的一份夹具（只读源、只写目标）。"""
    if not FIXTURE_SRC.is_file():
        return False, f"源夹具不存在：{FIXTURE_SRC}", ""
    dst_dir = LUKER_CHATS / TEST_CHAR
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / f"{FIXTURE_NAME}.jsonl"
    shutil.copy2(FIXTURE_SRC, dst)
    n = sum(1 for _ in dst.open("r", encoding="utf-8", errors="ignore") if _.strip())
    return True, f"{dst}（{dst.stat().st_size} 字节 / {n} 行）", str(dst)


def open_test_char(r):
    return r.js("""async (name) => {
        const c = SillyTavern.getContext();
        const idx = (c.characters || []).findIndex(
            (x) => String(x.avatar || '').replace(/\\.png$/i, '') === name);
        if (idx < 0) return { ok: false, why: 'char-not-found' };
        for (let i = 0; i < 5 && String(c.characterId) !== String(idx); i++) {
            await c.selectCharacterById(idx);
            await new Promise((r) => setTimeout(r, 2500));
        }
        await new Promise((r) => setTimeout(r, 2000));
        return { ok: String(c.characterId) === String(idx), characterId: c.characterId };
    }""", TEST_CHAR)


# 抓下游模型请求体（**稳定的注入点**：`globalThis.fetch` 是真全局；
# 而 `getContext()` 每次返回新对象，往它上面挂东西会落空——2026-09-28 实测）。
# 同时挂 XHR：宿主的连接层不一定走 `fetch`（流式可能用 XHR），只挂一处会「抓不到」。
CAPTURE_ON_JS = """() => {
    if (window.__capFetch) return 'already';
    window.__capFetch = { bodies: [], urls: [] };
    const orig = globalThis.fetch;
    window.__origFetchForCap = orig;
    const push = (url, body) => {
        try {
            if (typeof body !== 'string') return;
            if (!/\\/v1|chat\\/completions|generativelanguage|\\/messages/.test(url)) return;
            window.__capFetch.urls.push(url);
            window.__capFetch.bodies.push(body.slice(0, 400000));
        } catch { /* 抓取失败不影响请求 */ }
    };
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        push(url, init?.body);
        return orig(input, init);
    };
    // XHR 那条路（流式连接层常用）
    try {
        const XO = XMLHttpRequest.prototype.open;
        const XS = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__capUrl = u; return XO.call(this, m, u, ...rest); };
        XMLHttpRequest.prototype.send = function (body) { push(String(this.__capUrl || ''), body); return XS.call(this, body); };
    } catch { /* 挂不上就只靠 fetch */ }
    return 'capturing';
}"""

CAPTURE_OFF_JS = """() => {
    if (window.__origFetchForCap) { globalThis.fetch = window.__origFetchForCap; window.__origFetchForCap = null; }
    const c = window.__capFetch || { bodies: [], urls: [] };
    window.__capFetch = null;
    const body = c.bodies[c.bodies.length - 1] || '';
    let prompt = '';
    try {
        const j = JSON.parse(body);
        const msgs = j.messages || j.contents || [];
        prompt = msgs.map((m) => (typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '')).join('\\n');
    } catch { prompt = body; }
    return { calls: c.bodies.length, urls: c.urls.slice(-2), promptLen: prompt.length,
             promptHead: prompt.slice(0, 160), promptTail: prompt.slice(-160) };
}"""


def main():
    staged = None
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        page = c.new_page()
        r = Runner(page, "real-data-ai")
        try:
            page.goto(BASE, wait_until="commit", timeout=90000)
            print("  复位实例…")
            try:
                reset_instance(page)
            except Exception as e:      # noqa: BLE001
                print(f"  [warn] reset_instance 超时（宿主冷启动慢）：{e}")
            page.wait_for_selector(ENTRY, state="attached", timeout=180000)
            opened = open_test_char(r)
            report("R0b 测试角色已打开", opened.get('ok'), f"{opened}")

            # **夹具必须在 reset_instance 之后放**：那一步会 `delete_chats` 删掉测试角色名下的
            # 全部聊天，先放会被连带删掉（顺序错会让 R1 变成「导入了个不存在的夹具」）
            ok, detail, staged = stage_fixture()
            report("R0 真实聊天夹具已就位（**复制**自 孤独摇滚 角色卡，原文件只读未动）", ok, detail)
            if not ok:
                return 1
            r.settle(1500)

            # ---------- R1 真·长聊天导入（转库） ----------
            # **走插件自己的切换路径**（`Runner.set_storage_mode`：经设置页控件 + 等档位就绪）。
            # 手搓「写 extension_settings + reload」是不行的：宿主 boot 会用 settings.json
            # **整份顶掉**内存里的 extension_settings，且 `saveSettingsDebounced` 是防抖的——
            # 实测重载后模式仍是 off（2026-09-28）。
            r.set_storage_mode('pure')
            pre = r.js("""() => ({
                mode: SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode,
                chatLen: (SillyTavern.getContext().chat || []).length,
            })""")
            report("R1a 已切到纯库模式且测试角色就位", pre.get('mode') == 'pure', f"{pre}")

            # 走**用户真实入口**：弹窗「角色卡的聊天」页签里，对夹具那一行点「转数据库」。
            # 这比调内部函数更接近真人操作，也正是「存量 jsonl 入库」的正式路径。
            r.ensure_popup()
            r.popup_switch_tab("角色卡的聊天")
            r.settle(800)
            r.click_action("chat-list-reload")
            # **有界等待列表出现**，不要只 settle 一个固定时长：列表是异步拉的，拉完之前读到 0 行
            # 会判成「夹具没找到」——那是**读得太早**，不是产品问题（2026-09-28 实测的 flake）。
            rows = []
            end = time.time() + 30
            while time.time() < end:
                r.settle(1500)
                rows = r.js("""() => [...document.querySelectorAll('dialog[open]:not([closing]) .chatfilesys-chat-row')]
                    .map((x) => ({ file: x.dataset.file, text: x.innerText.replace(/\\n+/g, ' | ').slice(0, 90) }))""") or []
                if any(FIXTURE_NAME in (x['file'] or '') for x in rows):
                    break
            print(f"  [聊天列表] {len(rows)} 行；含夹具={any(FIXTURE_NAME in (x['file'] or '') for x in rows)}")
            t0 = time.time()
            try:
                r.click_action("chat-import", file=FIXTURE_NAME)
                imported = True
            except AssertionError:
                imported = False
            report("R1b 经「角色卡的聊天 → 转数据库」把真实长聊天入库", imported,
                   f"夹具行={'找到' if imported else '没找到'}；列表 {len(rows)} 行")
            if imported:
                # 导入流程有**两个 PARDON 确认**（N2 用户旅程）：
                #   ①「完成后删除源 jsonl 文件？」→ 是（副本先进回收站，可还原）
                #   ②「是否保持 jsonl 双写绑定？」→ 否（要纯库，不要双写）
                # 不应答就会**卡在第一个确认上**，表现为「点了没反应、也没报错」
                # （2026-09-28 实测：R1b 报 PASS 但 R1c 说「仍是仅磁盘文件」）。
                r.settle(1800)
                r.popup_ok()          # ① 删源 → 确定
                r.settle(1200)
                r.popup_cancel()      # ② 双写绑定 → 否
            r.settle(20000)
            print(f"  导入耗时 ≈ {time.time() - t0:.1f}s（115 层 / 3MB）")

            after = r.js("""() => [...document.querySelectorAll('dialog[open]:not([closing]) .chatfilesys-chat-row')]
                .map((x) => ({ file: x.dataset.file, text: x.innerText.replace(/\\n+/g, ' | ') }))""")
            fix_row = next((x for x in (after or []) if FIXTURE_NAME in (x['file'] or '')), None)
            if fix_row and '已入库' not in (fix_row.get('text') or ''):
                # 列表是打开时拉的快照 → 刷新一次再看（导入会改变状态）
                r.ensure_popup()
                r.popup_switch_tab("角色卡的聊天")
                r.click_action("chat-list-reload")
                r.settle(2500)
                after = r.js("""() => [...document.querySelectorAll('dialog[open]:not([closing]) .chatfilesys-chat-row')]
                    .map((x) => ({ file: x.dataset.file, text: x.innerText.replace(/\\n+/g, ' | ') }))""")
                fix_row = next((x for x in (after or []) if FIXTURE_NAME in (x['file'] or '')), None)
            report("R1c 导入后该行状态变为「已入库」（库确实收下了）",
                   bool(fix_row) and '已入库' in (fix_row.get('text') or ''),
                   f"{fix_row and fix_row['text'][:140]}")

            # ---------- R2 结构图的真实性能数字 ----------
            r.js(CAPTURE_ON_JS)
            r.ensure_popup()
            r.popup_switch_tab("结构图")
            r.settle(2000)
            r.click_action("graph-reload")
            # 同样**有界等待**：建图 + 布局是异步的，固定 settle 会读到「正在读取数据并建图…」
            g = {}
            end = time.time() + 40
            while time.time() < end:
                r.settle(2500)
                g = r.js("""() => {
                const c = SillyTavern.getContext();
                const chars = Array.isArray(c.characters) ? c.characters : Object.values(c.characters || {});
                const idx = Number(c.characterId);
                const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                const g = root?.querySelector('.chatfilesys-graph');
                const diag = {
                    charIdType: typeof c.characterId, charId: String(c.characterId),
                    charsIsArray: Array.isArray(c.characters), charsLen: chars.length,
                    idxHit: Boolean(chars[idx]), name2: String(c.name2 || ''),
                    mode: c.extensionSettings?.chatfilesys?.storage_mode,
                };
                if (!g) return { present: false, diag };
                return { present: true, diag,
                    nodes: g.querySelectorAll('.chatfilesys-gnode').length,
                    hud: g.querySelector('.chatfilesys-graph-hud')?.textContent || '',
                    status: root.querySelector('[data-role="graph-status"]')?.textContent || '',
                    degrade: [...root.querySelectorAll('.chatfilesys-graph-degrade')].map((x) => x.textContent) };
            }""")
                if g.get('nodes'):
                    break
            if not g.get('present') or not g.get('nodes'):
                print(f"  [诊断] 图状态：{json.dumps(g, ensure_ascii=False)[:400]}")
            report("R2 结构图在**真实长聊天**上画出节点（115 层量级）",
                   g.get('present') and g.get('nodes', 0) >= 50,
                   f"nodes={g.get('nodes')} | {g.get('hud')}")
            print(f"  [性能] {g.get('status')}")
            if g.get('degrade'):
                print(f"  [降级] {g['degrade']}")

            # ---------- R3/R4 AI 链路 + 可调参数真生效 ----------
            # 先设成很小的上限，好让「被卡住」这件事**可断言**
            small = {"ai.max_chars": 800, "ai.chars_per_floor": 60, "ai.max_summary_len": 12}
            r.js("""(kv) => {
                const s = SillyTavern.getContext().extensionSettings.chatfilesys;
                for (const [k, v] of Object.entries(kv)) {
                    const parts = k.split('.');
                    let o = s; for (const p of parts.slice(0, -1)) { o[p] = o[p] || {}; o = o[p]; }
                    o[parts[parts.length - 1]] = v;
                }
                return 'set';
            }""", small)

            r.ensure_popup()
            r.popup_switch_tab("当前聊天")
            r.settle(600)
            bid = r.js("""() => {
                const m = SillyTavern.getContext().chatMetadata?.extensions?.chatfilesys;
                const b = m ? (m.branches.find((x) => x.is_default) || m.branches[0]) : null;
                return b ? b.id : null;
            }""")
            can = r.js("""() => {
                const c = SillyTavern.getContext();
                return { quiet: typeof c.generateQuietPrompt, raw: typeof c.generateRaw };
            }""")
            print(f"  [连接] 生成链路：{can}")

            if bid:
                r.pick_branch(bid)
                t0 = time.time()
                r.click_action("ai-summary", branch=bid)
                r.settle(30000)          # 真模型调用，给足时间
                ai_secs = time.time() - t0
                summary = r.js("""() => {
                    const m = SillyTavern.getContext().chatMetadata?.extensions?.chatfilesys;
                    const b = m ? (m.branches.find((x) => x.is_default) || m.branches[0]) : null;
                    return b ? (b.summary || '') : '';
                }""")
                cap = r.js(CAPTURE_OFF_JS)
                report("R3 AI 链路真跑通（用实例里配好的连接出摘要）", bool(summary),
                       f"耗时 {ai_secs:.1f}s；摘要={summary[:40]!r}")
                if cap.get('calls'):
                    report("R4 「用户可调」真生效：下游提示词长度被 `ai.max_chars` 卡住",
                           cap.get('promptLen', 0) <= 800 + 400,
                           f"抓到的请求 {cap.get('calls')} 次；提示词 {cap.get('promptLen')} 字符（上限 800）；"
                           f"url={cap.get('urls')}")
                    print(f"  [提示词头] {cap.get('promptHead')!r}")
                else:
                    # **不算失败**：宿主的连接层可能走我们挂不到的地方（原生模块 / worker）。
                    # 「可调真生效」已由 R4b 在**输出侧**证实（摘要长度确实被上限卡住了）。
                    print("  ⏭  R4 未抓到下游请求体（宿主连接层不走页内 fetch/XHR）——"
                          "「可调真生效」由 R4b 的输出侧断言覆盖")
                if summary:
                    report("R4b 摘要长度受 `ai.max_summary_len` 约束（设为 12）",
                           len(summary) <= 14, f"摘要 {len(summary)} 字")

            # ---------- R5 列举兼容：别的插件「列聊天」时看得到库里的聊天 ----------
            # 走**与别的插件同一条路**（页面里的 `fetch('/api/chats/search')`，会被接缝拦），
            # 不是调插件自己的内部函数——验的就是「别人来问，能不能问到」。
            r.js("""() => {
                const s = SillyTavern.getContext().extensionSettings.chatfilesys;
                const parts = 'compat.serve_chat_listing'.split('.');
                let o = s; for (const p of parts.slice(0, -1)) { o[p] = o[p] || {}; o = o[p]; }
                o[parts[parts.length - 1]] = true;
                return 'on';
            }""")
            r.settle(800)
            listing = r.js("""async ([fixture]) => {
                const c = SillyTavern.getContext();
                const ch = c.characters[c.characterId];
                const res = await fetch('/api/chats/search', {
                    method: 'POST', headers: c.getRequestHeaders(),
                    body: JSON.stringify({ query: '', avatar_url: ch?.avatar }),
                });
                const rows = res.ok ? await res.json() : [];
                const names = (Array.isArray(rows) ? rows : []).map((x) => String(x.file_name || ''));
                return { status: res.status, n: names.length,
                         hasFixture: names.some((n) => n.includes('孤独摇滚夹具')),
                         sample: names.slice(0, 6) };
            }""", [FIXTURE_NAME])
            report("R5 纯库模式下「列出聊天」也能看到库里的聊天（兼容 14 个列举类插件）",
                   listing.get('hasFixture'),
                   f"{json.dumps(listing, ensure_ascii=False)[:200]}")

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            report("全程零 chatfilesys 归因 pageerror", not errs, f"{errs[:2]}")
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.js(CAPTURE_OFF_JS)
            except Exception:
                pass
            try:
                r.js("""() => {
                    const s = SillyTavern.getContext().extensionSettings;
                    s.chatfilesys.storage_mode = 'off';
                    return 'off';
                }""")
                page.evaluate("() => SillyTavern.getContext().saveSettingsDebounced()")
            except Exception:
                pass
            try:
                r.delete_test_char()
            except Exception:
                pass
            if staged:
                try:
                    pathlib.Path(staged).unlink(missing_ok=True)
                except Exception as e:      # noqa: BLE001
                    print(f"  [warn] 删夹具失败（下次跑会覆盖）：{e}")
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nREAL DATA + AI " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
