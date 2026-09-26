"""UI 契约验收（R5 2026-09-25 重裁定版，取代原「二期验收」中的已废除条目）。

对应用户 2026-09-25 裁定的界面契约（prd.md R5 / AC7 / AC20）与仍然成立的旧验收项：
  AC1  扩展设置抽屉**零插件注入**（settings.html 已删除；设置项搬进弹窗「设置」页签）
  AC2  入口可达：输入框上方工具图标排里的插件按钮 + Alt+B；弹窗四页签完整；`/cb` 已删除
  AC3  SVG 结构树：节点 = 走法（序号/走法名 + 层数）+ 边标注分叉楼层 + 点击节点切换
  AC4  走法管理（改名 / 删除走法）在「当前聊天」页签可用
  AC5  该层 swipe 组数 > 1 时该消息出现**版本按钮**，点击打开「该层版本」弹窗
  AC6  切换走法（全量重绘）后版本按钮自愈
  AC7  写路径零弃用 API（运行时源码断言）
  AC8  元数据键 extensions.chatfilesys（无 legacy branches）
  AC10 能力检测生效（弹窗类 + RENDERED 事件）
  AC11 全程零控制台报错（chatfilesys 归因）

已废除并**不再断言**（无包袱铁律）：设置页结构白名单、`/cb` 入口、`分支树/楼层/批量操作/导出` 四页签、
消息旁 ⎇ 分叉按钮、分叉点 ⎇ 记号、输入框上方分支徽章（点击开面板）。
"""
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR, PANEL  # noqa: E402

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

            # ---------- AC1 扩展设置抽屉零注入 ----------
            ac1 = r.js("""() => ({
                settingsEls: [...document.querySelectorAll(
                    '#extensions_settings *, #extensions_settings2 *')].filter((el) => {
                    const cls = [...(el.classList || [])].some((x) => x.startsWith('chatfilesys-'));
                    return cls || (el.id || '').startsWith('chatfilesys-');
                }).map((el) => (el.id || '-') + '|' + el.tagName),
                legacyDrawer: !!document.querySelector('#chatfilesys-settings'),
                entryBtn: !!document.getElementById('chatfilesys-entry'),
            })""")
            ok1 = (ac1['settingsEls'] == [] and not ac1['legacyDrawer'] and ac1['entryBtn'])
            results.append(report("AC1 扩展设置抽屉零插件元素（旧设置抽屉已删除）", bool(ok1), str(ac1)))

            # ---------- AC2 入口可达 + 四页签 ----------
            r.open_popup()
            ok_btn = bool(r.pg.query_selector(PANEL))
            tabs = r.js(f"""() => [...document.querySelectorAll('{PANEL} .luker-tabs-tab, {PANEL} [data-tabbtn]')]
                .map(x => x.textContent.trim())""")
            r.close_popup()
            r.settle(500)
            r.js("""() => document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true, code: 'KeyB', key: 'b', bubbles: true }))""")
            r.pg.wait_for_selector(PANEL, timeout=8000)
            ok_altb = bool(r.pg.query_selector(PANEL))
            r.close_popup()
            r.settle(500)
            r.cmd("/cb")
            r.settle(1000)
            ok_cb_gone = not r.pg.query_selector(PANEL)
            results.append(report("AC2 入口 = 工具图标排按钮 + Alt+B；/cb 已删除",
                                  ok_btn and ok_altb and ok_cb_gone,
                                  f"按钮={ok_btn} Alt+B={ok_altb} /cb无弹窗={ok_cb_gone}"))
            results.append(report("AC2 弹窗四页签 = 当前聊天/角色卡的聊天/设置/回收站",
                                  set(tabs) == {'当前聊天', '角色卡的聊天', '设置', '回收站'}, str(tabs)))

            # ---------- 造楼层 + 走法（F3 分叉） ----------
            for cmd in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
                r.cmd(cmd)
                r.settle(700)
            st = r.wait_state(lambda s: s["chatLen"] == 5, desc="造 5 层")
            new_b = r.create_branch(3, name="验收·F3")
            r.settle(800)
            r.wait_state(lambda s: len(s["branches"]) == 2, desc="建走法")

            # ---------- AC3 SVG 结构树 ----------
            r.ensure_popup()
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
            results.append(report("AC3 SVG 结构树：节点=走法+边标注分叉楼层+层数", bool(ok3), str(ac3)))
            # 点击节点切换
            r.js(f"""() => {{
                const n = [...document.querySelectorAll('{PANEL} .chatfilesys-tnode')]
                    .find(x => x.dataset.branch === '{new_b}');
                n.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true }}));
            }}""")
            st = r.wait_state(lambda s: s["activeId"] == new_b, desc="AC3 点击节点切换")
            r.settle(600)
            ac3_active = r.js(f"""() => document.querySelector('{PANEL} .chatfilesys-tnode.active')?.dataset.branch""")
            results.append(report("AC3 点击节点切换+active 高亮", st["activeId"] == new_b and ac3_active == new_b,
                                  f"active={st['activeId']} node={ac3_active}"))

            # 新走法延展一层（制造与 b_main 在 F4 的分叉 → F4 两个 swipe 组）
            r.cmd("/send U-b1-F4")
            r.settle(900)
            r.ensure_active("b_main")
            r.settle(900)
            r.close_popup()
            r.settle(600)

            # ---------- AC4 走法管理：改名 ----------
            # 管理按钮的作用对象 = 走法选择器选中的那条（R5 后三按钮共用一个选择器；
            # 按钮的 data-branch 跟随选择值 → 必须先 pick，不能直接按 data-branch 找按钮）
            r.pick_branch(new_b)
            r.click_action("rename", branch=new_b)
            r.popup_input("验收改名")
            r.settle(1200)
            renamed = next((x for x in r.state()["branches"] if x["id"] == new_b), None)
            results.append(report("AC4 走法管理：改名生效", bool(renamed and renamed["name"] == "验收改名"),
                                  str(renamed)))
            # 删除走法（先切回默认走法；默认走法不可删 → 由 core 守卫拒绝）
            r.pick_branch(new_b)
            r.click_action("delete-branch", branch=new_b)
            r.popup_ok()
            r.settle(1500)
            st = r.state()
            ok4b = len(st["branches"]) == 1 and all(x["id"] != new_b for x in st["branches"])
            results.append(report("AC4 走法管理：删除走法（其私有组一并回收）", ok4b,
                                  f"branches={[x['id'] for x in st['branches']]}"))
            # 默认走法不可删：选中默认走法点删除 → core 守卫拒绝（toastr 错误 + 走法数不变）
            r.pick_branch("b_main")
            r.click_action("delete-branch", branch="b_main")
            r.popup_ok()
            err_default = r.toastr_error()
            r.settle(800)
            n_after = len(r.state()["branches"])
            results.append(report("AC4 走法管理：默认走法不可删（守卫拒绝）",
                                  bool(err_default) and "默认分支" in str(err_default) and n_after == 1,
                                  f"toast={err_default} branches={n_after}"))
            r.close_popup()
            r.settle(600)

            # 复原一个分叉（供 AC5/AC6 用）：F3 建走法 → 切过去续一层 → 切回 → F4 两组
            nb2 = r.create_branch(3, name="版本样本")
            r.settle(800)
            r.ensure_active(nb2)
            r.cmd("/send U-b1-F4")
            r.settle(900)
            r.ensure_active("b_main")
            r.settle(900)
            r.close_popup()
            r.settle(600)

            # ---------- AC5 版本按钮 + 该层版本弹窗 ----------
            ac5 = r.js("""() => {
                const rows = [...document.querySelectorAll('#chat .mes')].map((mes) => {
                    const tools = mes.querySelector(':scope > .chatfilesys-mes-tools');
                    const btn = tools?.querySelector('.chatfilesys-ver-btn');
                    return { floor: Number(mes.getAttribute('mesid')) + 1, has: !!btn,
                             label: btn ? btn.textContent.trim() : null };
                });
                return { rows, total: rows.length, withBtn: rows.filter(x => x.has).map(x => x.floor) };
            }""")
            # 组数对照（数据层）
            grp = r.js("""async () => {
                const c = SillyTavern.getContext();
                const mod = await import('/scripts/extensions/third-party/chatfilesys/ui/common.js');
                const m = c.chatMetadata.extensions.chatfilesys;
                const maxF = Math.max(0, ...m.branches.flatMap(b => Object.keys(b.path).map(Number)));
                const out = {};
                for (let f = 1; f <= maxF; f++) out[f] = mod.swipeGroupsAt(m, f, c.chat || []).length;
                return out;
            }""")
            expect = sorted(int(f) for f, n in (grp or {}).items() if n > 1)
            ok5a = (ac5['withBtn'] == expect and len(expect) >= 1 and ac5['total'] > len(expect))
            results.append(report("AC5 版本按钮仅多分叉层出现（与 swipeGroupsAt 一致）", bool(ok5a),
                                  f"按钮层={ac5['withBtn']} 组数={grp}"))
            # 期望值**独立**给出（不抄实现）：F3 建走法 + 该走法延展一层 → 只有第 4 层是多组（分叉点）
            results.append(report("AC5 多组楼层 = 第 4 层（独立期望值，非抄 swipeGroupsAt）",
                                  expect == [4], f"多组层={expect}"))
            # 点击版本按钮 → 该层版本弹窗列出该层全部组
            floor = expect[0]
            r.js("""(f) => {
                const mes = document.querySelector(`#chat .mes[mesid="${f - 1}"]`);
                mes.querySelector('.chatfilesys-ver-btn')
                   .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }""", floor)
            r.pg.wait_for_selector('.chatfilesys-versions', timeout=8000)
            vp = r.js("""() => {
                const root = document.querySelector('.chatfilesys-versions');
                return { groups: root.querySelectorAll('.chatfilesys-ver-group').length,
                         text: root.innerText.replace(/\\n+/g, ' | ').slice(0, 300) };
            }""")
            ok5b = vp['groups'] == (grp or {}).get(str(floor)) and vp['groups'] >= 2
            results.append(report(f"AC5 版本弹窗列出第 {floor} 层全部 swipe 组", bool(ok5b), str(vp)))
            r.js("""() => { [...document.querySelectorAll('dialog[open]')]
                .find(d => d.querySelector('.chatfilesys-versions'))?.close(); }""")
            r.settle(600)

            # ---------- AC6 切换走法后版本按钮自愈 ----------
            r.ensure_active(nb2)
            r.settle(1200)
            healed = r.js("""() => document.querySelectorAll('#chat .chatfilesys-ver-btn').length""")
            r.ensure_active("b_main")
            r.settle(1200)
            results.append(report("AC6 切换走法（全量重绘）后版本按钮自愈", healed >= 1, f"count={healed}"))
            r.settle(600)

            # ---------- AC7 写路径零弃用 API（运行时拉取模块源码断言） ----------
            ac7 = r.js("""async () => {
                const files = ['index.js', 'core/branches.js', 'core/projection.js', 'core/chat-writer.js',
                               'core/key-bindings.js', 'ui/common.js', 'ui/popup.js', 'ui/tree.js',
                               'ui/marker.js', 'ui/versions.js'];
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

            # ---------- AC8 元数据键 ----------
            ac8 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const data = await res.json();
                const ext = (Array.isArray(data) ? data[0] : data)?.chat_metadata?.extensions || {};
                return { chatfilesys: ext.chatfilesys ? 'present' : 'missing',
                         legacyBranches: ext.branches ? 'LEGACY' : 'none' };
            }""")
            results.append(report("AC8 元数据键 extensions.chatfilesys（无 legacy branches）",
                                  ac8['chatfilesys'] == 'present' and ac8['legacyBranches'] == 'none', str(ac8)))

            # ---------- AC10 能力检测 ----------
            # （N5 2026-09-26：`CAP.popupClass` 只写不读已删，能力检测只剩 RENDERED 事件这一项）
            cap_log = [txt for (t, txt, src) in r.logs if '能力检测' in txt]
            ac10 = any('renderedEvents' in x and 'true' in x for x in cap_log)
            results.append(report("AC10 能力检测生效（RENDERED 事件）", ac10, str(cap_log[:1])))

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
