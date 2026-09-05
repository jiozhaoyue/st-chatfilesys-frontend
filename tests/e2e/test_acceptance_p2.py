"""二期验收（PRD 11 条逐条实测，2026-09-06）。

对应 prd.md「二期验收标准」：
  1  设置页只有设置项 + 打开按钮            → AC1
  2  管理弹窗三入口可达 + Tabs 分页完整      → AC2
  3  SVG 图形树（节点/边/标注/点击切换）     → AC3
  4  消息旁 ⎇ 一键直分叉 + 分叉点标记        → AC4
  5  分支徽章显示当前分支名 + 点击开弹窗     → AC5
  6  核心重渲染后消息旁元素自愈              → AC6
  7  写路径零弃用 API（全部官方消息 API）    → AC7（运行时源码断言）
  8  元数据键 extensions.chatfilesys         → AC8（新聊天落盘断言）
  9  一期验收回归全绿                        → test_acceptance.py（13/13，另跑）
  10 能力检测生效、弹窗可用                  → AC10（console 能力检测日志 + 弹窗可用）
  11 全程零控制台报错（chatfilesys 归因）    → AC11
"""
import sys
import time
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR, PANEL

results = []


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            res = r.create_test_char()
            created = res.get("status") == 200
            if not created:
                return 1
            r.open_test_char()
            r.settle(2500)

            # ---------- AC1 设置页结构 ----------
            ac1 = r.js("""() => {
                const root = document.querySelector('#chatfilesys-settings .chatfilesys-settings-content');
                if (!root) return null;
                const actions = [...root.querySelectorAll('[data-action]')].map(x => x.dataset.action);
                return { actions, hasExport: !!root.querySelector('#chatfilesys-auto-export'),
                         hasStatus: !!root.querySelector('.chatfilesys-settings-status'),
                         text: root.innerText };
            }""")
            ok1 = ac1 and set(ac1['actions']) <= {'open-popup'} and ac1['hasExport'] and ac1['hasStatus']
            results.append(report("AC1 设置页仅设置项+打开按钮", bool(ok1), str(ac1 and ac1['actions'])))

            # ---------- AC2 三入口 ----------
            # 入口1：/cb（全程被 harness 使用，这里显式验证一次）
            r.ensure_popup()
            ok_cb = bool(r.pg.query_selector(PANEL))
            r.close_popup()
            # 入口2：Alt+B（headless 下浏览器会吞原生 Alt 组合键，用合成 KeyboardEvent
            # 走同一 document keydown 处理器；真实浏览器原生按键可达）
            r.js("""() => document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true, code: 'KeyB', key: 'b', bubbles: true }))""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            ok_altb = bool(r.pg.query_selector(PANEL))
            r.close_popup()
            # 入口3：设置页按钮
            r.js("""() => document
                .querySelector('#chatfilesys-settings [data-action="open-popup"]')
                .dispatchEvent(new MouseEvent('click', { bubbles: true }))""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            ok_btn = bool(r.pg.query_selector(PANEL))
            # Tabs 分页完整
            tabs = r.js(f"""() => {{
                const root = document.querySelector('{PANEL}');
                return [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map(x => x.textContent.trim());
            }}""")
            r.close_popup()
            results.append(report("AC2 三入口可达（/cb、Alt+B、设置页按钮）", ok_cb and ok_altb and ok_btn,
                                  f"/cb={ok_cb} Alt+B={ok_altb} 按钮={ok_btn}"))
            results.append(report("AC2 Tabs 分页完整", set(tabs) == {'分支树', '楼层', '批量操作', '导出'}, str(tabs)))

            # ---------- 造楼层 + 分叉（后续用） ----------
            for t in ["U-F2", "U-F4"]:
                r.cmd(f"/send {t}")
                r.settle(700)
            r.cmd(f"/sendas name={TEST_CHAR} A-F3")
            r.settle(700)
            r.cmd(f"/sendas name={TEST_CHAR} A-F5")
            r.settle(700)
            st = r.wait_state(lambda s: s["chatLen"] == 5, desc="造 5 层")

            # 弹窗内 F3 后分叉（命名弹窗）
            r.click_action("fork", floor=3)
            r.popup_input("验收·F3")
            r.wait_state(lambda s: s["activeId"] and len(s["branches"]) == 2, desc="分叉建分支")
            r.ensure_active("b_main")
            r.close_popup()

            # ---------- AC3 SVG 图形树 ----------
            r.ensure_popup()
            r.popup_switch_tab("分支树")
            ac3 = r.js(f"""() => {{
                const root = document.querySelector('{PANEL}');
                const svg = root.querySelector('svg.chatfilesys-tree');
                const nodes = [...root.querySelectorAll('.chatfilesys-tnode')];
                const edges = [...root.querySelectorAll('.chatfilesys-edge-label')].map(x => x.textContent.trim());
                return {{ hasSvg: !!svg,
                         nodes: nodes.map(n => ({{ branch: n.dataset.branch,
                                                  name: n.querySelector('.chatfilesys-tnode-name')?.textContent,
                                                  meta: n.querySelector('.chatfilesys-tnode-meta')?.textContent }})),
                         edges,
                         activeNode: root.querySelector('.chatfilesys-tnode.active')?.dataset.branch }};
            }}""")
            ok3 = (ac3 and ac3['hasSvg'] and len(ac3['nodes']) == 2
                   and any('⎇F3' in e for e in ac3['edges'])
                   and all(n['meta'] and '层' in n['meta'] for n in ac3['nodes']))
            results.append(report("AC3 SVG 树：节点=分支+边标注分叉楼层+楼层数", bool(ok3), str(ac3)))
            # 点击节点切换
            r.js(f"""() => {{
                const n = [...document.querySelectorAll('{PANEL} .chatfilesys-tnode')]
                    .find(x => x.dataset.branch === 'b1');
                n.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true }}));
            }}""")
            st = r.wait_state(lambda s: s["activeId"] == "b1", desc="AC3 点击节点切换")
            r.settle(500)  # 弹窗刷新走 150ms 防抖，等 DOM 重绘后再读高亮
            ac3_active = r.js(f"""() => document.querySelector('{PANEL} .chatfilesys-tnode.active')?.dataset.branch""")
            results.append(report("AC3 点击节点切换+active 高亮", st["activeId"] == "b1" and ac3_active == "b1",
                                  f"active={st['activeId']} node={ac3_active}"))

            # b1 延展一层（制造与 main 的分叉差异 → main 视角 F4 起多组）
            r.cmd("/send U-b1-F4")
            r.settle(900)

            # ---------- AC4 消息旁：注入 + 标记 + 一键直分叉 ----------
            # （b1 已延展 U-b1-F4：main 视角 F4 起 b1 的组折叠进 groups → F4 为多组楼层）
            r.ensure_active("b_main")
            r.settle(600)
            ac4 = r.js("""() => ({
                forks: [...document.querySelectorAll('#chat .mes .chatfilesys-mes-fork')].length,
                marks: [...document.querySelectorAll('#chat .mes .chatfilesys-mes-forkmark')].map(x => x.textContent.trim()),
                mesCount: document.querySelectorAll('#chat .mes').length,
            })""")
            ok4a = ac4['forks'] == ac4['mesCount'] and ac4['mesCount'] >= 5
            results.append(report("AC4 消息旁 ⎇ 分叉按钮注入（每层）", bool(ok4a), str(ac4)))
            results.append(report("AC4 分叉点 ⎇ 标记（多组楼层 F4）", len(ac4['marks']) >= 1,
                                  f"marks={ac4['marks']}"))

            # 一键直分叉：点 F2 的按钮 → 自动建「分支N」+ 自动切换
            name_before = r.state()["activeId"]
            branches_before = r.state()["branches"]
            r.js("""() => {
                const mes = [...document.querySelectorAll('#chat .mes')][1];  // F2
                mes.querySelector('.chatfilesys-mes-fork')
                   .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }""")
            st = r.wait_state(lambda s: len(s["branches"]) == 3 and s["activeId"] not in ("b_main", "b1"),
                              desc="AC4 一键直分叉")
            new_b = next(x for x in st["branches"] if x["id"] not in [b["id"] for b in branches_before])
            ok4b = st["activeId"] == new_b["id"] and new_b["fork"] == 2 and new_b["name"].startswith("分支")
            results.append(report("AC4 一键直分叉（自动命名+自动切换，F2）", bool(ok4b),
                                  f"new={new_b} active={st['activeId']}"))
            r.ensure_active("b_main")
            r.settle(800)

            # ---------- AC5 分支徽章 ----------
            ac5 = r.js("""() => {
                const b = document.getElementById('chatfilesys-badge');
                return { hidden: b ? b.hidden : null, text: b ? b.textContent.trim() : null };
            }""")
            results.append(report("AC5 徽章显示当前分支名", ac5['hidden'] is False and ac5['text'] == '⎇ 主分支',
                                  str(ac5)))
            r.js("""() => document.getElementById('chatfilesys-badge').click()""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            ok5b = bool(r.pg.query_selector(PANEL))
            r.close_popup()
            results.append(report("AC5 点击徽章打开管理弹窗", ok5b, f"opened={ok5b}"))

            # ---------- AC6 重渲染后消息旁自愈 ----------
            r.ensure_active("b1")   # 触发 clearChat+printMessages 全量重绘
            ac6 = r.js("""() => ({
                forks: [...document.querySelectorAll('#chat .mes .chatfilesys-mes-fork')].length,
                mes: document.querySelectorAll('#chat .mes').length,
            })""")
            ok6 = ac6['mes'] >= 3 and ac6['forks'] == ac6['mes']
            results.append(report("AC6 切换重绘后消息旁元素自愈", bool(ok6), str(ac6)))
            r.ensure_active("b_main")

            # ---------- AC7 写路径零弃用 API（运行时拉取模块源码断言） ----------
            ac7 = r.js("""async () => {
                const files = ['index.js', 'core/branches.js', 'core/projection.js', 'core/chat-writer.js',
                               'ui/common.js', 'ui/popup.js', 'ui/tree.js', 'ui/marker.js', 'ui/badge.js'];
                const bad = [];
                const srcs = {};
                for (const f of files) {
                    const res = await fetch(`/scripts/extensions/third-party/chatfilesys/${f}`);
                    if (!res.ok) { bad.push(`${f}: HTTP ${res.status}`); continue; }
                    const src = await res.text();
                    srcs[f] = src;
                    if (/patchChatMessages\\s*\\(/.test(src)) bad.push(`${f}: patchChatMessages 调用`);
                    if (/appendChatMessages\\s*\\(/.test(src)) bad.push(`${f}: appendChatMessages 调用`);
                    if (/import\\s*\\{[^}]*patchChatMessages/.test(src)) bad.push(`${f}: patchChatMessages 导入`);
                    if (/import\\s*\\{[^}]*appendChatMessages/.test(src)) bad.push(`${f}: appendChatMessages 导入`);
                }
                const usesOfficial = Object.values(srcs).some(s =>
                    s.includes('deleteMessages') && s.includes('addMessages') && s.includes('updateMessages'));
                return { bad, usesOfficial };
            }""")
            results.append(report("AC7 写路径零弃用 API（源码级断言）",
                                  ac7['bad'] == [] and ac7['usesOfficial'] is True, str(ac7)))

            # ---------- AC8 新聊天元数据键 ----------
            chat_id = r.state()["chatFile"]
            ac8 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const data = await res.json();
                const ext = data[0]?.chat_metadata?.extensions || {};
                return { chatfilesys: ext.chatfilesys ? 'present' : 'missing',
                         legacyBranches: ext.branches ? 'LEGACY' : 'none' };
            }""")
            results.append(report("AC8 元数据键 extensions.chatfilesys（无 legacy branches）",
                                  ac8['chatfilesys'] == 'present' and ac8['legacyBranches'] == 'none', str(ac8)))

            # ---------- AC10 能力检测 ----------
            cap_log = [txt for (t, txt, src) in r.logs if '能力检测' in txt]
            ac10 = any('popupClass' in x and 'true' in x for x in cap_log)
            results.append(report("AC10 能力检测生效（弹窗/事件/斜杠可用）", ac10,
                                  str(cap_log[:1])))

            # ---------- AC11 全程零归因报错 ----------
            pe = r.pageerrors_from("chatfilesys")
            ce = r.console_errors_from("chatfilesys")
            results.append(report("AC11 全程 chatfilesys 零报错", pe == [] and ce == [],
                                  f"pageerror={pe[:2]} console={ce[:2]}"))

        except Exception:
            traceback.print_exc()
            results.append(report("harness 执行", False, "异常见上"))
        finally:
            if created:
                print("--- cleanup ---")
                try:
                    print("delete char:", r.delete_test_char())
                except Exception as e:
                    print("cleanup failed:", e)
            b.close()

    print("\n=== SUMMARY ===")
    print(f"pass {sum(results)}/{len(results)}")
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
