"""ChatFilesys 界面契约 e2e（T4r.11 / R5 + AC7 + AC20）

用户 2026-09-25 重裁定（推翻 2026-09-05 版本）：
  · **唯一界面 = 插件弹窗**；入口 = 输入框上方工具图标排里的插件按钮 + Alt+B（`/cb` 已删除）
  · **扩展设置抽屉零注入**（settings.html 已删除）
  · **聊天界面只剩两样**：① 入口按钮 ② 消息旁的**版本按钮**——仅该层 swipe 组数 > 1 时出现，
    形状 = 分叉图标 + 计数（不用左右箭头）；其余零插件元素（无徽章、无分叉按钮、无分叉点记号）
  · **绝不逐层列举楼层**（弹窗内任何位置都不得逐层列出楼层）

断言：
  ① 扩展设置抽屉（#extensions_settings / #extensions_settings2）内**零本插件元素**
  ② 聊天界面（#form_sheld + #chat）只有「入口按钮 + 版本按钮」；版本按钮**仅多分叉层**出现，
     且出现条件与数据层 `swipeGroupsAt` 完全一致（单组消息上零插件元素）
  ③ 弹窗内**无逐层列举**（已废除类名零命中 + DOM 无「连续多行楼层号」的枚举列表）
     并断言弹窗页签 = 新四页签（旧「楼层 / 批量操作」页签不得复活）
  ④ 入口可达：工具图标排按钮 + Alt+B；`/cb` **已删除**（执行后不得打开弹窗）
  ⑤ 全扫 #form_sheld + #chat + 弹窗 DOM，类名/ID 一律 `chatfilesys-*` 白名单

依赖：Dev Luker 8003 在跑（用专用测试角色 @@CHAR@@）；扩展已同步到实例的
`data/default-user/extensions/chatfilesys/`（被测代码 = 实例实际加载的那份）。
用法：python tests/e2e/test_ui_placement.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, TEST_CHAR, PANEL, ENTRY, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 被测模块一律走**页面自身 origin**（扩展就装在这个路径下；不依赖额外的静态源服务）

# 本插件允许出现在聊天界面的类名（其余一律违规）：入口按钮 + 版本按钮（含其容器）
ALLOWED_CHAT_CLASSES = {"chatfilesys-mes-tools", "chatfilesys-ver-btn"}
ALLOWED_CHAT_IDS = {"chatfilesys-entry"}

STEPS_ENABLE = """async (extSrc) => {
    const c = SillyTavern.getContext();
    const mod = await import(extSrc + '/core/branches.js');
    if (!c.chatMetadata.extensions?.chatfilesys) {
        c.chatMetadata.extensions = c.chatMetadata.extensions || {};
        c.chatMetadata.extensions.chatfilesys = mod.enableForChat(c.chat || []);
        await c.saveMetadata();
    }
    return { branches: c.chatMetadata.extensions.chatfilesys.branches.length, msgs: (c.chat || []).length };
}"""

# 聊天界面 + 设置抽屉全扫（返回违规元素清单与版本按钮分布）
SCAN = """(allowed) => {
    const clsOf = (el) => [...(el.classList || [])].filter((x) => x.startsWith('chatfilesys-'));
    const idOf = (el) => el.id || '';
    const collect = (rootSel) => {
        const bad = [];
        document.querySelectorAll(rootSel + ' *').forEach((el) => {
            const c = clsOf(el);
            const id = idOf(el);
            if (!c.length && !id.startsWith('chatfilesys-')) return;
            const okId = !id || allowed.ids.includes(id);
            const okCls = c.every((x) => allowed.classes.includes(x));
            if (!okId || !okCls) bad.push((id || '-') + '|' + c.join('.') + '|' + el.tagName);
        });
        return bad;
    };
    const out = {
        entries: collect('#form_sheld'),
        chat: collect('#chat'),
        settings: collect('#extensions_settings') .concat(collect('#extensions_settings2')),
        entryBtn: (() => {
            const b = document.getElementById('chatfilesys-entry');
            if (!b) return null;
            const cs = getComputedStyle(b);
            return { inLeftSendForm: b.parentElement?.id === 'leftSendForm',
                     title: b.title, display: cs.display, hasIcon: b.className.includes('fa-') };
        })(),
        mesRows: [...document.querySelectorAll('#chat .mes')].map((mes) => {
            const tools = mes.querySelector(':scope > .chatfilesys-mes-tools');
            const btn = tools?.querySelector('.chatfilesys-ver-btn');
            return { floor: Number(mes.getAttribute('mesid')) + 1,
                     tools: !!tools,
                     label: btn ? btn.textContent.trim() : null,
                     arrows: btn ? /[←→‹›]/.test(btn.textContent) : false };
        }),
        popups: document.querySelectorAll('.chatfilesys-popup').length,
        popupsOutsideDialog: [...document.querySelectorAll('.chatfilesys-popup')]
            .filter((el) => !el.closest('dialog[open]')).length,
    };
    return out;
}"""

# 弹窗内扫描：已废除类名 + 逐层列举特征 + 页签
POPUP_SCAN = """() => {
    const root = document.querySelector('.chatfilesys-popup');
    if (!root) return null;
    const banned = ['.chatfilesys-floor', '.chatfilesys-floorlist', '.chatfilesys-branchlist',
                    '.chatfilesys-branch-summary', '#chatfilesys-badge', '.chatfilesys-mes-fork'];
    const bannedHits = [];
    for (const sel of banned) if (root.querySelector(sel)) bannedHits.push(sel);
    // 逐层列举特征：某容器下 >= 3 个子元素的文本都以「F<数字>」/「第<数字>层」开头（同构楼层行）
    const floorish = (t) => /^\\s*(F\\d+|第\\s*\\d+\\s*层)/.test(t || '');
    let enumerateHosts = [];
    root.querySelectorAll('*').forEach((el) => {
        const kids = [...el.children];
        if (kids.length < 3) return;
        const sameTag = new Set(kids.map((k) => k.tagName)).size === 1;
        const n = kids.filter((k) => floorish(k.innerText)).length;
        if (sameTag && n >= 3) enumerateHosts.push(el.className || el.tagName);
    });
    const tabs = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map((x) => x.textContent.trim());
    return {
        bannedHits,
        enumerateHosts,
        tabs,
        text: root.innerText.replace(/\\n+/g, ' | ').slice(0, 1200),
    };
}"""

# 数据层对照：每层 swipe 组数（UI 的版本按钮出现条件必须与它一致）
# 注意：**返回数组而非对象**——Playwright evaluate 走 JSON 序列化，JS 对象的数字键会变成字符串
# （`{4: 2}` → `{"4": 2}`），Python 侧 `4 in {"4": 2}` 恒为 False。2026-09-26 就是这里把
# 「② 多组楼层 = 第 4 层」与「② 版本按钮仅多分叉层出现」两条判成 FAIL 的（实测明细 `多组层=['4']`
# 里的引号即证据）。数组里 `floor` 是真数字，比较才不会假阴。
FORK_FLOORS = """async () => {
    const c = SillyTavern.getContext();
    const mod = await import('%s/ui/common.js');
    const m = c.chatMetadata.extensions.chatfilesys;
    if (!m) return null;
    const maxF = Math.max(0, ...m.branches.flatMap((b) => Object.keys(b.path).map(Number)));
    const out = [];
    for (let f = 1; f <= maxF; f++) out.push({ floor: f, groups: mod.swipeGroupsAt(m, f, c.chat || []).length });
    return out;
}""" % EXT_SRC

# 源码级断言（AC20：已废除实现必须从仓库里消失）
ABOLISHED_SOURCE = ["renderFloorsList", "floorRow(", "chatfilesys-floor", "chatfilesys-mes-fork",
                    "chatfilesys-branchlist", "BADGE_ID", "updateBadge"]
SCAN_SRC_FILES = ["index.js", "ui/popup.js", "ui/marker.js", "ui/common.js", "ui/tree.js", "style.css"]


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "ui-placement")
        try:
            r.boot()
            stb = r.state()
            print("boot 后（未清理）:", {k: v for k, v in stb.items() if k in ("chatFile", "chatLen")})
            # 幂等前置清理：上一次运行若中途崩了，实例里会留下 __cb_e2e 角色**和它的聊天目录**；
            # 不清的话 `open_test_char` 会把上一轮那份旧聊天重新载入，造层数就变成「旧内容 + 新内容」
            # （背景记录的失败现象：造层数变成 9 而非 5 → 后面 wait_state(chatLen==5) 超时）。
            # `delete_test_char` 带 delete_chats=true，宿主会连角色聊天目录一起删（characters.js）。
            # 清不掉不阻断（首次运行本来就没东西可清），但把结果打出来。
            print("前置清理:", r.delete_test_char())
            r.settle(600)
            res = r.create_test_char()
            if res.get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(2500)
            st0 = r.state()
            print("洁净起点:", {k: v for k, v in st0.items() if k in ("chatFile", "chatLen", "domMes")})
            # 起点必须是「刚建的新聊天」（只有开场语 1 层）——否则后面的层号期望值全部错位，
            # 会以「造 5 层超时」这种次生现象暴露，反而查不到真正原因。
            results.append(report("前置 洁净起点（新建聊天，仅开场语 1 层）", st0["chatLen"] == 1,
                                  f"chatFile={st0['chatFile']} chatLen={st0['chatLen']}"))

            # ---------- 准备：5 层 + F3 处分叉 + b1 续聊（制造「F4 多组、其余单组」） ----------
            print("启用:", r.js(STEPS_ENABLE, EXT_SRC))
            r.settle(1500)
            for cmd in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
                r.cmd(cmd)
                r.settle(700)
            r.wait_state(lambda s: s["chatLen"] == 5, desc="造 5 层")
            new_b = r.create_branch(3, name="分叉·F3")
            r.settle(800)
            r.ensure_active(new_b)                     # 切到新走法 → F4 起折叠
            r.cmd("/send U-b1-F4")                     # b1 延展一层 → 与 b_main 在 F4 分叉
            r.settle(900)
            r.ensure_active("b_main")                  # 切回 → F4 两个组
            r.settle(900)
            r.close_popup()
            r.settle(600)

            # ---------- ② 聊天界面只有「入口按钮 + 版本按钮」 ----------
            scan = r.js(SCAN, {"classes": sorted(ALLOWED_CHAT_CLASSES), "ids": sorted(ALLOWED_CHAT_IDS)})
            ok2a = not scan["entries"] and not scan["chat"]
            results.append(report("② 聊天界面无白名单外的本插件元素（#form_sheld + #chat 全扫）",
                                  ok2a, f"#form_sheld={scan['entries']} #chat={scan['chat']}"))

            # 入口按钮 = 输入框上方工具图标排里的插件图标按钮
            eb = scan.get("entryBtn") or {}
            ok2b = bool(eb.get("inLeftSendForm")) and eb.get("display") not in (None, "none") and bool(eb.get("hasIcon"))
            results.append(report("② 入口按钮在输入框上方工具图标排里（#leftSendForm）", ok2b, str(eb)))

            # 版本按钮：出现条件 = 该层 swipe 组数 > 1（与数据层对照）
            grp = r.js(FORK_FLOORS) or []
            groups_by_floor = {int(x["floor"]): int(x["groups"]) for x in grp}
            rows = scan["mesRows"]
            with_btn = {row["floor"]: row["label"] for row in rows if row["tools"] and row["label"]}
            expect_floors = {f for f, n in groups_by_floor.items() if n > 1}
            # 逐层显式布尔化比较：`tools` 是 DOM 层「该消息上有没有插件工具容器」的事实，
            # `floor in expect_floors` 是数据层的应然（int 键已由 FORK_FLOORS 保证）。
            per_floor_ok = all(bool(row["tools"]) == (row["floor"] in expect_floors) for row in rows)
            ok2c = (len(rows) == 5
                    and set(with_btn.keys()) == expect_floors
                    and per_floor_ok)
            results.append(report("② 版本按钮仅多分叉层出现（与 swipeGroupsAt 一致）",
                                  ok2c, f"buttons={with_btn} 组数={groups_by_floor} 多层={sorted(expect_floors)}"))
            # 期望值**独立**给出（不抄实现）：F3 建分支 + 该分支延展一层 → 只有第 4 层是多组（分叉点）
            results.append(report("② 多组楼层 = 第 4 层（独立期望值，非抄 swipeGroupsAt）",
                                  expect_floors == {4}, f"多组层={sorted(expect_floors)}"))
            ok2d = all(not row["arrows"] for row in rows)
            results.append(report("② 版本按钮不用左右箭头（形状 = 分叉图标 + 计数）", ok2d,
                                  str([row["label"] for row in rows])))
            ok2e = len(expect_floors) >= 1 and len(rows) > len(expect_floors)
            results.append(report("② 单组消息上零插件元素（存在多分叉层也有单组层）", ok2e,
                                  f"多组层={sorted(expect_floors)} 总层={len(rows)}"))

            # ---------- ① 扩展设置抽屉内零插件元素 ----------
            results.append(report("① 扩展设置抽屉内零本插件元素", not scan["settings"], str(scan["settings"])))

            # ---------- ③ 未打开弹窗前：弹窗本体不得存在 ----------
            # 此刻「打开—关闭」至少已发生过一次（ensure_active 走 UI 时会开弹窗），
            # 所以 0 既证明没预建、也证明**关闭后不留残骸**（残骸根因见 probe_popup_residue.py）。
            results.append(report("③ 未打开时无 .chatfilesys-popup 本体", scan["popups"] == 0,
                                  f"节点数={scan['popups']}（此刻弹窗未打开）"))

            # ---------- ④ 入口可达 ----------
            r.open_popup()
            inside = r.js("""() => { const els=[...document.querySelectorAll('.chatfilesys-popup')];
                return { n: els.length, allInOpenDialog: els.length > 0 && els.every(e => !!e.closest('dialog[open]')) }; }""")
            results.append(report("④-1 工具图标排按钮打开弹窗（本体只在弹窗内，且恰好 1 份）",
                                  bool(inside.get("allInOpenDialog")) and inside.get("n") == 1, str(inside)))

            # ③ 弹窗内无逐层列举 + 新四页签
            ps = r.js(POPUP_SCAN) or {}
            ok3a = ps.get("bannedHits") == [] and ps.get("enumerateHosts") == []
            results.append(report("③ 弹窗内无逐层列举（废除类名 0 命中 + 无连续楼层行枚举）",
                                  ok3a, f"banned={ps.get('bannedHits')} enumerate={ps.get('enumerateHosts')}"))
            tabs = ps.get("tabs") or []
            ok3b = set(tabs) == {'当前聊天', '角色卡的聊天', '设置', '回收站'}
            results.append(report("③ 弹窗四页签 = 当前聊天/角色卡的聊天/设置/回收站", ok3b, str(tabs)))
            results.append(report("③ 旧页签「楼层 / 批量操作」未复活",
                                  '楼层' not in tabs and '批量操作' not in tabs and '分支树' not in tabs, str(tabs)))
            # 结构树只显结构：树节点文本里不得出现任何消息内容
            tree = r.js("""() => {
                const ns = [...document.querySelectorAll('.chatfilesys-popup .chatfilesys-tnode')];
                return ns.map(n => ({ name: n.querySelector('.chatfilesys-tnode-name')?.textContent || '',
                                      meta: n.querySelector('.chatfilesys-tnode-meta')?.textContent || '' }));
            }""") or []
            ok3c = len(tree) >= 1 and all(('层' in t["meta"]) for t in tree) and all(('U-' not in t["name"] and 'A-' not in t["name"] and 'U-' not in t["meta"]) for t in tree)
            results.append(report("③ 结构树只显结构（#序号/走法名 + 层数，不含消息内容）", ok3c, str(tree)))
            r.close_popup()
            r.settle(600)

            # ---------- ④-2 Alt+B ----------
            r.js("""() => document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true, code: 'KeyB', key: 'b', bubbles: true }))""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            results.append(report("④-2 Alt+B 打开弹窗", True, "ok"))
            r.close_popup()
            r.settle(600)

            # ---------- ④-3 /cb 已删除 ----------
            r.cmd("/cb")
            r.settle(1200)
            cb_open = bool(r.pg.query_selector(PANEL))
            results.append(report("④-3 /cb 已删除（执行后不打开弹窗）", not cb_open, f"popup={cb_open}"))

            # ---------- ③b 关闭后无面板残留 ----------
            final = r.js(SCAN, {"classes": sorted(ALLOWED_CHAT_CLASSES), "ids": sorted(ALLOWED_CHAT_IDS)})
            results.append(report("③b 关闭后无弹窗残留", final["popups"] == 0,
                                  f"节点数={final['popups']}（本轮共开关 3 次）"))

            # ---------- ⑤ 源码级：已废除实现零命中 ----------
            srcs = r.js("""async ([src, files]) => {
                const out = {};
                for (const f of files) {
                    try {
                        const res = await fetch(src + '/' + f);
                        out[f] = res.ok ? await res.text() : `<<http-${res.status}>>`;
                    } catch (e) { out[f] = `<<fetch-failed ${e}>>`; }
                }
                return out;
            }""", [EXT_SRC, SCAN_SRC_FILES]) or {}
            hits = [f"{f}:{k}" for f, s in srcs.items() for k in ABOLISHED_SOURCE if k in s]
            results.append(report("⑤ 源码级：已废除实现（楼层列表/徽章/分叉记号）零命中", hits == [], str(hits)))
            has_entry = ("leftSendForm" in srcs.get("index.js", "")
                         and "chatfilesys-entry" in srcs.get("index.js", ""))
            results.append(report("⑤ 源码级：入口落点 = #leftSendForm（官方工具图标排）", has_entry, ""))

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            ce = r.console_errors_from("chatfilesys")
            results.append(report("全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            b.close()


if __name__ == "__main__":
    code = main()
    ok = all(results) if results else False
    print("\nUI PLACEMENT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
