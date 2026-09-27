"""结构图（B4）真机用例 —— Dev Luker 8003 真实浏览器。

**它证明什么**（每一条都是「纸面看着对、真机可能完全不是这样」的地方）：
  ① 弹窗多出「结构图」页签且可达（不是只在代码里存在）
  ② B1 数据源 → B2 图引擎 → B3 布局 → B4 渲染**整条链在真浏览器里跑通**
     （模块导入路径、`import.meta.url` 解析 worker、`<script>` 之外的 dagre 取值…… 全是真机才暴露的）
  ③ 布局**走了哪条路**（Worker / 主线程）印在界面上，且是真值——TL 的 worker 全程没生效却没人知道
  ④ 视口数学在真 DOM 里成立（适应窗口后每个节点都落在画布内、缩放真的改 scale）
  ⑤ **命中测试**：点节点能选中（分片渲染中途也点得中——判据走坐标，不走事件目标）
  ⑥ **共享前缀零复制**：磁盘上真写第二份「同前缀 + 多一条」的聊天文件后，
     应该出现 `sessionCount ≥ 2` 的节点（图引擎的头号卖点，必须在真数据上见到）

隔离：只碰 `__cb_e2e` 角色；额外写的聊天文件是本用例自建自删的测试产物。
跑法：`PYTHONIOENCODING=utf-8 python tests/e2e/test_graph_view.py`
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import (  # noqa: E402
    Runner, browser_ctx, report, reset_instance, BASE, ENTRY, EXT_SRC, TEST_CHAR,
)
from playwright.sync_api import sync_playwright  # noqa: E402

results = []


# 磁盘上另写一份聊天文件（共享前缀 + 多一条）——用来在真数据上造出**分叉与共享**。
# 为什么不用模型层的分支来造：模型分支住**同一个文件**，文件源只会看到 1 个会话；
# 图引擎的「共享前缀零复制」要**两个会话**才看得见。
WRITE_EXTRA_CHAT_JS = """async ([name, fileName, rows]) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const res = await fetch('/api/chats/save', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: char.name, file_name: fileName, avatar_url: char.avatar,
            chat: [{ user_name: ctx.name1, character_name: char.name, chat_metadata: {} }, ...rows],
        }),
    });
    return res.status;
}"""

DELETE_CHAT_FILE_JS = """async ([fileName]) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const res = await fetch('/api/chats/delete', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: char.name, file_name: fileName, avatar_url: char.avatar }),
    });
    return res.status;
}"""

# 从**当前**聊天取前 N 行（用来拼那份共享前缀的文件）
CURRENT_ROWS_JS = """(n) => (SillyTavern.getContext().chat || []).slice(0, n).map(x => ({
    name: x.name, is_user: x.is_user, mes: x.mes, send_date: x.send_date,
}))"""

# 读结构图的状态（HUD 文本、SVG 节点数、变换、降级行）
GRAPH_STATE_JS = """() => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    const g = root && root.querySelector('.chatfilesys-graph');
    if (!g) return { present: false };
    const s = g.querySelector('.chatfilesys-graph-svg');
    const nodes = [...g.querySelectorAll('.chatfilesys-gnode')];
    const edges = [...g.querySelectorAll('.chatfilesys-gedge')];
    const xf = g.querySelector('.chatfilesys-graph-nodes')?.getAttribute('transform') || '';
    const m = /translate\\(([-0-9.e]+),([-0-9.e]+)\\)\\s*scale\\(([-0-9.e]+)\\)/.exec(xf);
    const boxes = nodes.map(n => {
        const r = n.querySelector('rect');
        const mm = /translate\\(([-0-9.e]+),([-0-9.e]+)\\)/.exec(n.getAttribute('transform') || '');
        return r && mm ? { x: +mm[1], y: +mm[2], w: +r.getAttribute('width'), h: +r.getAttribute('height') }
                       : null;
    }).filter(Boolean);
    return {
        present: true,
        hud: g.querySelector('.chatfilesys-graph-hud')?.textContent || '',
        status: root.querySelector('[data-role="graph-status"]')?.textContent || '',
        degrade: [...root.querySelectorAll('.chatfilesys-graph-degrade')].map(x => x.textContent),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        transform: m ? { scale: +m[3], tx: +m[1], ty: +m[2] } : null,
        boxes,
        minimap: Boolean(g.querySelector('.chatfilesys-graph-minimap:not([hidden])')),
        selection: root.querySelector('[data-role="graph-selection"]')?.textContent || '',
        hasSelectionChips: Boolean(root.querySelector('[data-role="graph-selection"] .chatfilesys-gchip')),
    };
}"""


def graph_state(r):
    r.ensure_popup()
    return r.js(GRAPH_STATE_JS)


# 打开测试角色。**真机事实（2026-09-27 本用例实测）**：`reset_instance` 末尾那次页面重载之后，
# 宿主 boot 时 `ctx.characterId` 是 `undefined`（没有角色被选中）——此时本插件报
# 「数据源当前不可用（库模式未启用或没有活动角色）」，那是**正确行为**，不是缺陷。
# 用例必须自己把角色打开；且首次 `selectCharacterById` 常因初始化竞态早退（characterId 不变），
# 故按既有用例的同一做法**重试直到落位**（宿主 `script.js:2374`：已在同一角色时不 getChat）。
OPEN_TEST_CHAR_JS = """async (name) => {
    const c = SillyTavern.getContext();
    const idx = (c.characters || []).findIndex(
        (x) => String(x.avatar || '').replace(/\\.png$/i, '') === name);
    if (idx < 0) return { ok: false, why: 'char-not-found' };
    for (let i = 0; i < 5 && String(c.characterId) !== String(idx); i++) {
        await c.selectCharacterById(idx);
        await new Promise((r) => setTimeout(r, 2500));
    }
    await new Promise((r) => setTimeout(r, 2000));
    return { ok: String(c.characterId) === String(idx), characterId: c.characterId, idx };
}"""


def open_test_char(r):
    return r.js(OPEN_TEST_CHAR_JS, TEST_CHAR)


# 测试角色磁盘上的聊天文件（**测试自产**，可删；不是用户数据）
LIST_CHATS_JS = """async (name) => {
    const c = SillyTavern.getContext();
    const res = await fetch('/api/characters/chats', { method: 'POST',
        headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: name + '.png' }) });
    const d = await res.json();
    return Array.isArray(d) ? d.map((x) => x.file_name) : [];
}"""

DELETE_CHAT_BY_NAME_JS = """async ([name, fileName]) => {
    const c = SillyTavern.getContext();
    // `file_name` 不带 `.jsonl`（宿主两处端点口径不同：列举给带后缀的，删除要裸名）
    const bare = String(fileName).replace(/\\.jsonl$/i, '');
    const res = await fetch('/api/chats/delete', { method: 'POST', headers: c.getRequestHeaders(),
        body: JSON.stringify({ ch_name: name, file_name: bare, avatar_url: name + '.png' }) });
    return res.status;
}"""

# **必须显式落盘**再读图：宿主的 `saveChat` 是防抖的，而 B1 的文件源读的是**磁盘**。
# 不落盘就断言节点数 ⇒ 看到的是几秒前的旧文件（2026-09-27 实测：内存 6 条、磁盘还没写完，
# 图上只有 3 个节点，断言「≥5」假红）。这是「测试要按真实数据流推一遍」的又一例。
FLUSH_CHAT_JS = """async () => {
    const c = SillyTavern.getContext();
    await c.saveChat();
    return (c.chat || []).length;
}"""


def wipe_test_chat_files(r):
    """删掉测试角色名下的**全部**聊天文件（测试自产，非用户数据）。

    为什么必须清（2026-09-27 实测）：`reset_instance` 里那句 `delete_chats: true` **没有真的
    删掉磁盘上的聊天文件**——连跑两轮后测试角色名下累积了 2 个文件，而 `selectCharacterById`
    载入的是其中一个**上一轮遗留、已带 chatfilesys 模型**的聊天 ⇒ 弹窗里根本没有
    `[data-action="enable"]`（那个按钮只在「未启用的聊天」上出现），用例卡在第一步。
    清干净之后，用例对「第几轮运行」不再敏感。
    """
    names = r.js(LIST_CHATS_JS, TEST_CHAR) or []
    deleted = []
    for fn in names:
        st = r.js(DELETE_CHAT_BY_NAME_JS, [TEST_CHAR, fn])
        if st == 200:
            deleted.append(fn)
    return {"before": names, "deleted": deleted}


def open_graph_tab(r):
    r.popup_switch_tab("结构图")
    # 建图是异步的（读数据 → 建图 → 布局），等状态行不再停在「正在读取」
    end = time.time() + 40
    while time.time() < end:
        st = graph_state(r)
        if st.get("present") and st.get("nodeCount", 0) > 0 and "正在读取" not in st.get("status", ""):
            return st
        r.pg.wait_for_timeout(500)
    return graph_state(r)


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        page = c.new_page()
        r = Runner(page, "graph-view")
        extra = None
        try:
            page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            print("  复位实例…")
            # **宿主冷启动慢是环境事实，不是缺陷**：本机 Dev Luker 载 26 个第三方扩展 +
            # S-Timelines，实测「页面开始 → 插件入口按钮出现」= **38 秒**（2026-09-27 定时探针
            # `probe_entry10`）——`reset_instance` 内部的 60s 超时在连跑多轮后余量不足，
            # 会以 `Timeout ... waiting for locator("#chatfilesys-entry")` 的形式失败，
            # 看起来像「插件坏了」，实际只是没等够。故这里**兜住它并自己等足**。
            try:
                reset_instance(page)
            except Exception as e:      # noqa: BLE001
                print(f"  [warn] reset_instance 未在其超时内完成（宿主冷启动慢），继续等入口：{e}")
            page.wait_for_selector(ENTRY, state="attached", timeout=180000)
            print("  插件入口已就绪")
            opened = open_test_char(r)
            report("预备-0 测试角色已打开（characterId 落位——宿主 boot 时不选角色）",
                   opened.get("ok"), f"{opened}")

            # ---------- 造一个至少有内容的聊天 ----------
            # 先清掉测试角色名下**遗留的聊天文件**（见 `wipe_test_chat_files` 的实测说明）——
            # 否则载入的可能是上一轮那个已带模型的聊天，`enable` 按钮根本不存在。
            wiped = wipe_test_chat_files(r)
            print(f"  清掉遗留聊天文件 {len(wiped['deleted'])}/{len(wiped['before'])} 个")

            # 按需启用：**已经启用过就不点**（`enable` 按钮只在未启用的聊天上出现）。
            # 这条分支本身就是真机教训：写死「点 enable」会让用例对历史状态敏感。
            r.ensure_popup()
            r.popup_switch_tab("当前聊天")
            if r.state().get("branches") is None:
                r.click_action("enable")
                r.settle(1200)
            else:
                print("  （本聊天已启用分支，跳过 enable）")
            base_len = r.state()["chatLen"]
            # 造楼层：走**官方消息 API**（与插件自己的写路径同一入口），非 silent —— 让宿主的
            # MESSAGE_SENT/RECEIVED 正常发，插件与其它插件的联动都跑一遍（真机就该这样）
            for i in range(5):
                who = "我" if i % 2 == 0 else TEST_CHAR
                r.js("""async ([name, isUser, mes]) => {
                    const ctx = SillyTavern.getContext();
                    await ctx.addMessages([{ name, is_user: isUser, mes }]);
                    return 'ok';
                }""", [who, i % 2 == 0, f"图探针第 {i + 1} 层：这条是用来把结构图撑出节点的。"])
                r.settle(500)
            r.settle(1500)
            flushed = r.js(FLUSH_CHAT_JS)
            r.settle(1200)
            st0 = r.state()
            # 断言**增量**（不是绝对条数）：内存里的聊天可能还带着上一轮的旧消息
            # （我们清的是磁盘文件，不是内存）。判增量才对「第几轮运行」不敏感。
            report("预备：本轮新加了 5 层（结构图才有东西可画）",
                   st0["chatLen"] >= base_len + 5,
                   f"chatLen {base_len} → {st0['chatLen']}（落盘 {flushed} 条）")

            # ---------- ① 结构图页签可达 ----------
            tabs = r.js("""() => {
                const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                return [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map(x => x.textContent.trim());
            }""")
            report("① 弹窗有「结构图」页签", "结构图" in (tabs or []), f"tabs={tabs}")
            if "结构图" not in (tabs or []):
                return 1

            # ---------- ②③ 图渲染 + 布局路径 ----------
            gs = open_graph_tab(r)
            report("② 结构图渲染出节点与边（B1→B2→B3→B4 整链跑通）",
                   gs.get("present") and gs.get("nodeCount", 0) >= 5 and gs.get("edgeCount", 0) >= 4,
                   f"nodes={gs.get('nodeCount')} edges={gs.get('edgeCount')} hud={gs.get('hud')!r}")
            report("③ 布局路径是**真值**且印在界面上（Worker/主线程 + 算法）",
                   ("Worker" in gs.get("hud", "") or "主线程" in gs.get("hud", ""))
                   and ("dagre" in gs.get("hud", "") or "迭代分层" in gs.get("hud", "")),
                   f"hud={gs.get('hud')!r}")
            report("③b 状态行报了节点/边/会话数与耗时",
                   "节点" in gs.get("status", "") and "ms" in gs.get("status", ""),
                   f"status={gs.get('status')!r}")

            # ---------- ④ 视口：适应窗口 + 缩放 ----------
            t_fit = gs.get("transform")
            finite = bool(t_fit) and all(isinstance(t_fit[k], (int, float)) for k in ("scale", "tx", "ty"))
            report("④ 适应窗口后变换是有限数且 scale 合理",
                   finite and 0 < t_fit["scale"] <= 4, f"transform={t_fit}")
            # 适应窗口后每个节点都应落在画布内（用视口数学自己验一遍）
            inside = r.js("""() => {
                const g = document.querySelector('dialog[open]:not([closing]) .chatfilesys-graph');
                const svg = g.querySelector('.chatfilesys-graph-svg');
                const box = svg.getBoundingClientRect();
                const groups = [...g.querySelectorAll('.chatfilesys-gnode')];
                const m = /translate\\(([-0-9.e]+),([-0-9.e]+)\\)\\s*scale\\(([-0-9.e]+)\\)/
                    .exec(g.querySelector('.chatfilesys-graph-nodes').getAttribute('transform'));
                const [, tx, ty, sc] = m.map(Number);
                let out = 0;
                for (const n of groups) {
                    const r = n.querySelector('rect');
                    const mm = /translate\\(([-0-9.e]+),([-0-9.e]+)\\)/.exec(n.getAttribute('transform'));
                    const cx = (+mm[1]) * sc + tx, cy = (+mm[2]) * sc + ty;
                    if (cx < -1 || cy < -1 || cx > box.width + 1 || cy > box.height + 1) out++;
                }
                return { out, total: groups.length, w: box.width, h: box.height };
            }""")
            report("④b 适应窗口后所有节点都落在画布内",
                   inside["total"] > 0 and inside["out"] == 0,
                   f"越界 {inside['out']}/{inside['total']}，画布 {inside['w']:.0f}×{inside['h']:.0f}")

            r.click_action("graph-zoom-in")
            r.settle(400)
            gs2 = graph_state(r)
            report("④c 缩小再放大会改变 scale（缩放真的接到了视口）",
                   abs(gs2["transform"]["scale"] - t_fit["scale"]) > 1e-6,
                   f"{t_fit['scale']} → {gs2['transform']['scale']}")
            r.click_action("graph-fit")
            r.settle(400)

            # ---------- ⑤ 命中：点节点 → 详情 ----------
            # 用**坐标派发**（点节点中心），这样走的是与真人一样的路径：命中判定必须自己算出来；
            # 直接对 g 元素 dispatch 会绕过命中测试，测的就不是这件事了。
            hit = r.js("""() => {
                const g = document.querySelector('dialog[open]:not([closing]) .chatfilesys-graph');
                const stage = g.querySelector('.chatfilesys-graph-stage');
                const box = stage.getBoundingClientRect();
                const sc = /scale\\(([-0-9.e]+)\\)/
                    .exec(g.querySelector('.chatfilesys-graph-nodes').getAttribute('transform'))[1];
                const tx = /translate\\(([-0-9.e]+),/.exec(
                    g.querySelector('.chatfilesys-graph-nodes').getAttribute('transform'))[1];
                const ty = /translate\\([-0-9.e]+,([-0-9.e]+)\\)/.exec(
                    g.querySelector('.chatfilesys-graph-nodes').getAttribute('transform'))[1];
                const n = g.querySelectorAll('.chatfilesys-gnode')[0];
                const mm = /translate\\(([-0-9.e]+),([-0-9.e]+)\\)/.exec(n.getAttribute('transform'));
                const cx = (+mm[1]) * (+sc) + (+tx) + box.left;
                const cy = (+mm[2]) * (+sc) + (+ty) + box.top;
                stage.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
                return { cx, cy, id: n.getAttribute('data-node') };
            }""")
            r.settle(900)
            gs3 = graph_state(r)
            report("⑤ 点节点命中并给出详情（只显结构，邻接是可点小块）",
                   gs3.get("hasSelectionChips") and "#" in gs3.get("selection", ""),
                   f"selection={gs3.get('selection', '')[:120]!r}")

            # ---------- ⑥ 共享前缀：磁盘上真写第二份聊天文件 ----------
            # 先落盘：第二份文件要与**当前那份磁盘文件**有同样的前 4 行，否则共享前缀无从谈起
            r.js(FLUSH_CHAT_JS)
            r.settle(1200)
            rows = r.js(CURRENT_ROWS_JS, 4)
            extra = f"cfsys-graph-extra-{int(time.time()) % 100000}"
            rc = r.js(WRITE_EXTRA_CHAT_JS, [TEST_CHAR, extra, rows + [
                {"name": TEST_CHAR, "is_user": False, "mes": "第二份会话独有的一条", "send_date": 1},
            ]])
            report("⑥-0 磁盘上写出了第二份聊天文件（共享前 4 行）", rc == 200, f"HTTP {rc}")
            r.click_action("graph-reload")
            r.settle(2500)
            gs4 = open_graph_tab(r)
            shared = r.js("""() => {
                const g = document.querySelector('dialog[open]:not([closing]) .chatfilesys-graph');
                const titles = [...g.querySelectorAll('.chatfilesys-gnode title')].map(t => t.textContent);
                return titles.filter(t => /被 \\d+ 条会话共享/.test(t));
            }""")
            report("⑥ 共享前缀零复制：出现「被 ≥2 条会话共享」的节点（图引擎头号卖点，真数据）",
                   len(shared or []) >= 4,
                   f"共享节点 {len(shared or [])} 个，例：{(shared or ['(无)'])[0]!r}")
            report("⑥b 节点总数随第二份会话增长",
                   gs4.get("nodeCount", 0) >= 6,
                   f"nodes={gs4.get('nodeCount')}（前 4 行共享 + 各自 1 条独有）")

            # ---------- ⑦ 全程零 chatfilesys 归因报错 ----------
            errs = [e for e in r.errors if "chatfilesys" in str(e)]
            report("⑦ 全程零 chatfilesys 归因 pageerror", not errs, f"errors={errs[:2]}")
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                if extra:
                    r.js(DELETE_CHAT_FILE_JS, [extra])
            except Exception as e:
                print(f"  [warn] 删测试聊天文件失败: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nGRAPH VIEW " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
