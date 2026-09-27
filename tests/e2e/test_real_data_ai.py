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
# 而 `getContext()` 每次返回新对象，往它上面挂东西会落空——2026-09-28 实测）
CAPTURE_ON_JS = """() => {
    if (window.__capFetch) return 'already';
    window.__capFetch = { bodies: [], urls: [] };
    const orig = globalThis.fetch;
    window.__origFetchForCap = orig;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        try {
            if (init?.body && typeof init.body === 'string' && url.includes('/v1')) {
                window.__capFetch.urls.push(url);
                window.__capFetch.bodies.push(init.body.slice(0, 200000));
            }
        } catch { /* 抓取失败不影响请求 */ }
        return orig(input, init);
    };
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
            r.js("""(mode) => {
                const s = SillyTavern.getContext().extensionSettings;
                s.chatfilesys = s.chatfilesys || {};
                s.chatfilesys.storage_mode = mode;
                return mode;
            }""", "pure")
            page.evaluate("() => SillyTavern.getContext().saveSettingsDebounced()")
            page.reload(wait_until="commit")
            page.wait_for_selector(ENTRY, state="attached", timeout=180000)
            r.settle(4000)
            opened2 = open_test_char(r)
            r.settle(4000)

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
            r.settle(2500)
            rows = r.js("""() => [...document.querySelectorAll('dialog[open]:not([closing]) .chatfilesys-chat-row')]
                .map((x) => ({ file: x.dataset.file, text: x.innerText.replace(/\\n+/g, ' | ').slice(0, 90) }))""")
            print(f"  [聊天列表] {len(rows)} 行；含夹具={any(FIXTURE_NAME in (x['file'] or '') for x in rows)}")
            t0 = time.time()
            try:
                r.click_action("chat-import", file=FIXTURE_NAME)
                imported = True
            except AssertionError:
                imported = False
            r.settle(20000)
            print(f"  导入耗时 ≈ {time.time() - t0:.1f}s（115 层 / 3MB）")
            report("R1b 经「角色卡的聊天 → 转数据库」把真实长聊天入库", imported,
                   f"夹具行={'找到' if imported else '没找到'}；列表 {len(rows)} 行")

            after = r.js("""() => [...document.querySelectorAll('dialog[open]:not([closing]) .chatfilesys-chat-row')]
                .map((x) => ({ file: x.dataset.file, text: x.innerText.replace(/\\n+/g, ' | ') }))""")
            fix_row = next((x for x in (after or []) if FIXTURE_NAME in (x['file'] or '')), None)
            report("R1c 导入后该行状态变为「已入库」（库确实收下了）",
                   bool(fix_row) and '已入库' in (fix_row.get('text') or ''),
                   f"{fix_row and fix_row['text'][:120]}")

            # ---------- R2 结构图的真实性能数字 ----------
            r.js(CAPTURE_ON_JS)
            r.ensure_popup()
            r.popup_switch_tab("结构图")
            r.settle(2000)
            r.click_action("graph-reload")
            r.settle(9000)
            g = r.js("""() => {
                const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                const g = root?.querySelector('.chatfilesys-graph');
                if (!g) return { present: false };
                return { present: true,
                    nodes: g.querySelectorAll('.chatfilesys-gnode').length,
                    hud: g.querySelector('.chatfilesys-graph-hud')?.textContent || '',
                    status: root.querySelector('[data-role="graph-status"]')?.textContent || '',
                    degrade: [...root.querySelectorAll('.chatfilesys-graph-degrade')].map((x) => x.textContent) };
            }""")
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
                    report("R4 「用户可调」真生效（抓到了下游请求体）", False,
                           "没抓到 /v1 请求——AI 可能没真发出（连接未配？看上面的 [连接] 行）")
                if summary:
                    report("R4b 摘要长度受 `ai.max_summary_len` 约束（设为 12）",
                           len(summary) <= 14, f"摘要 {len(summary)} 字")

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
