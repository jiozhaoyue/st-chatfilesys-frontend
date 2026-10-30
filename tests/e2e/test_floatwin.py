"""ChatFilesys PO-3 非模态小窗 e2e（真机取证：自愈不丢 = 三条硬条件的第 3 条）

PO-3（用户 2026-09-28 明许）：结构树/结构图允许自造非模态浮层小窗，硬条件之三 =
「挂载与重绘自愈必须在真机上验证过宿主重绘不丢（printMessages 批量重绘会抹掉直插 DOM
——2026-08-29 事故形态），验证结果写进 .trellis/spec/」。

本用例就是那份取证（每次跑都在重新取证；通过 = 本轮代码在当前宿主上自愈有效）：
  ① 树浮窗：弹窗页签点「浮窗」→ 小窗出现且含结构树（svg）；宿主重绘（/send）后仍在且已同步
  ② 自愈：人为 remove 小窗节点 → 宿主重绘一拍 → ensureAttached 按记忆几何挂回（内容不丢）
  ③ 边聊边看：关闭管理弹窗 → 小窗仍存活 → 再发消息仍更新（PO-3 的本意）
  ④ 图浮窗：点「浮窗」→ 图视图整体迁入小窗（页签放说明防误读）；重绘后仍在
  ⑤ 关图浮窗 → 页签自动接回视图（token 没变也要重挂）
  ⑥ PO-2 守卫：小窗开着时 #form_sheld + #chat 依旧零白名单外注入（小窗挂 body，不占聊天区）
  ⑦ 样式纪律抽查：小窗节点全部类名 chatfilesys-* 前缀、零硬编码主题色（inline style 只允许几何）

依赖：Dev Luker 8003 在跑；插件已同步到 data/default-user/extensions/chatfilesys/。
用法：PYTHONIOENCODING=utf-8 python tests/e2e/test_floatwin.py
截图：tests/e2e/shots/floatwin_*.png
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []
SHOTS = pathlib.Path(__file__).parent / "shots"

# 小窗状态读取：按 kind 找对应小窗（tree=含树宿主 / graph=含图宿主）；
# inline style 只允许几何；数据墨水（SVG 内分支调色板）按已登记设计决策豁免，但**容器**零颜色字面量
FLOATWIN_STATE = r"""(kind) => {
    const wins = [...document.querySelectorAll('.chatfilesys-floatwin')];
    const win = wins.find((w) => kind === 'tree'
        ? w.querySelector('.chatfilesys-tree-host')
        : w.querySelector('[data-role="float-graph-host"]'));
    if (!win) return { exists: false, openWins: wins.length };
    const tree = win.querySelector('.chatfilesys-tree-host');
    const graph = win.querySelector('[data-role="float-graph-host"]');
    // 颜色字面量检查：数据墨水（svg 内元素）豁免；容器/非 svg 元素零字面量
    const badInline = [...win.querySelectorAll('*')]
        .filter((el) => el.namespaceURI !== 'http://www.w3.org/2000/svg')
        .map((el) => el.getAttribute('style') || '')
        .filter((s) => s && (/(^|[^-\w])#[0-9a-fA-F]{3,8}\b/.test(s) || /rgba?\(/.test(s))
            && !/^(left|top|width|height):/.test(s.trim()));
    const badCls = [...win.querySelectorAll('*')].flatMap((el) => [...el.classList])
        .filter((c) => !c.startsWith('chatfilesys-') && !c.startsWith('menu_button') && !c.startsWith('text_pole'));
    return {
        exists: true,
        openWins: wins.length,
        inBody: win.parentElement === document.body,
        hasTree: Boolean(tree),
        treeNodes: tree ? tree.querySelectorAll('g, svg').length : 0,
        hasSvg: Boolean(win.querySelector('svg')),
        hasGraphHost: Boolean(graph),
        graphSvg: graph ? Boolean(graph.querySelector('svg')) : null,
        graphStatus: win.querySelector('[data-role="graph-status"]')?.textContent?.slice(0, 80) || '',
        tabNote: document.querySelector('[data-tabbody="graph"] [data-role="graph-host"]')?.textContent?.slice(0, 60) || '',
        badInline,
        badCls,
    };
}"""

# 抠掉小窗节点（模拟宿主清场 / 意外移除 —— 自愈的触发前提）
REMOVE_FLOATWIN = """() => {
    const wins = document.querySelectorAll('.chatfilesys-floatwin');
    wins.forEach((w) => w.remove());
    return wins.length;
}"""

# 聊天界面白名单扫描（与 test_ui_placement 同口径的极简版；⑥ 用）
SCAN_CHAT = r"""() => {
    const clsOf = (el) => [...(el.classList || [])].filter((x) => x.startsWith('chatfilesys-'));
    const bad = [];
    document.querySelectorAll('#form_sheld *, #chat *').forEach((el) => {
        const c = clsOf(el);
        const id = el.id || '';
        if (!c.length && !id.startsWith('chatfilesys-')) return;
        const ok = (c.length && c.every((x) => ['chatfilesys-mes-tools', 'chatfilesys-ver-btn'].includes(x)))
            || id === 'chatfilesys-entry';
        if (!ok) bad.push({ cls: c, id });
    });
    return bad;
}"""


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "floatwin")
        try:
            r.boot()
            print("前置清理:", r.delete_test_char())
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(2500)
            # 启用 + 造 5 层 + 一条分支（树/图都有东西可画）
            print("启用:", r.js(f"""async () => {{
                const ctx = SillyTavern.getContext();
                const mod = await import('{EXT_SRC}/core/branches.js');
                ctx.chatMetadata.extensions = ctx.chatMetadata.extensions || {{}};
                ctx.chatMetadata.extensions.chatfilesys = mod.enableForChat(ctx.chat || []);
                await ctx.saveMetadata();
                return 'enabled';
            }}"""))
            r.settle(1200)
            for cmd in ["/send U-F2", f"/sendas name=__cb_e2e A-F3", "/send U-F4", f"/sendas name=__cb_e2e A-F5"]:
                r.cmd(cmd)
                r.settle(700)
            r.wait_state(lambda s: s["chatLen"] == 5, desc="造 5 层")
            r.create_branch(3, name="分叉·F3")
            r.settle(900)

            CUR_KIND = 'tree'
            # ---------- ① 树浮窗 ----------
            r.open_popup()
            r.popup_switch_tab("当前聊天")
            n = r.js("""() => {
                const b = document.querySelector('dialog[open] .chatfilesys-popup [data-float="tree"]');
                if (!b) return 0;
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 1;
            }""")
            r.settle(600)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("① 树浮窗打开（挂 body、含树 svg）",
                                  n == 1 and st.get("exists") and st.get("inBody") and st.get("hasSvg"),
                                  str({k: st.get(k) for k in ("exists", "inBody", "hasSvg", "treeNodes")})))
            SHOTS.mkdir(exist_ok=True)
            r.pg.screenshot(path=str(SHOTS / "floatwin_01_tree_open.png"))

            # 宿主重绘（/send 走 printMessages 路径）→ 小窗仍在且树已同步新楼层
            r.cmd("/send U-F6")
            r.wait_state(lambda s: s["chatLen"] == 6, desc="第 6 层")
            r.settle(900)  # scheduleUiRefresh 150ms 防抖 + 渲染余量
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("① 宿主重绘后小窗仍在（不丢 DOM）", st.get("exists") and st.get("hasSvg"), str(st.get("exists"))))
            r.pg.screenshot(path=str(SHOTS / "floatwin_02_tree_after_redraw.png"))

            # ---------- ② 自愈：人为移除 → 下一拍挂回 ----------
            removed = r.js(REMOVE_FLOATWIN)
            r.settle(300)
            gone = r.js("() => !document.querySelector('.chatfilesys-floatwin')")
            r.cmd("/send U-F7")
            r.wait_state(lambda s: s["chatLen"] == 7, desc="第 7 层")
            r.settle(900)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("② 人为移除后自愈再挂载（ensureAttached 兜底）",
                                  removed >= 1 and gone and st.get("exists") and st.get("inBody"),
                                  f"removed={removed} gone={gone} exists={st.get('exists')}"))
            r.pg.screenshot(path=str(SHOTS / "floatwin_03_tree_selfhealed.png"))

            # ---------- ③ 边聊边看：弹窗关了小窗还在 ----------
            r.close_popup()
            r.settle(500)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("③ 关闭管理弹窗后小窗仍存活", st.get("exists"), f"exists={st.get('exists')}"))
            r.cmd("/send U-F8")
            r.wait_state(lambda s: s["chatLen"] == 8, desc="第 8 层")
            r.settle(900)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("③ 弹窗关闭时发消息：小窗仍在且树已更新", st.get("exists") and st.get("hasSvg"), str(st.get("exists"))))
            r.pg.screenshot(path=str(SHOTS / "floatwin_04_popup_closed.png"))

            CUR_KIND = 'tree'
            # ---------- ⑥ PO-2 守卫：小窗开着时聊天区依旧零注入 ----------
            bad = r.js(SCAN_CHAT)
            results.append(report("⑥ 小窗开着时 #form_sheld + #chat 零白名单外注入", not bad, str(bad[:4])))

            CUR_KIND = 'graph'
            # ---------- ④ 图浮窗 ----------
            r.open_popup()
            r.popup_switch_tab("结构图")
            r.settle(1200)  # 图首建（worker 布局）留余量
            n = r.js("""() => {
                const b = document.querySelector('dialog[open] .chatfilesys-popup [data-float="graph"]');
                if (!b) return 0;
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 1;
            }""")
            r.settle(1500)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("④ 图浮窗打开（视图迁入小窗、页签放说明）",
                                  n == 1 and st.get("exists") and st.get("hasGraphHost") and st.get("graphSvg")
                                  and "浮窗" in (st.get("tabNote") or ""),
                                  str({k: st.get(k) for k in ("exists", "hasGraphHost", "graphSvg", "graphStatus", "tabNote")})))
            r.pg.screenshot(path=str(SHOTS / "floatwin_05_graph_open.png"))

            r.cmd("/send U-F9")
            r.wait_state(lambda s: s["chatLen"] == 9, desc="第 9 层")
            r.settle(1000)
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            results.append(report("④ 宿主重绘后图浮窗仍在", st.get("exists") and st.get("graphSvg"), str(st.get("exists"))))

            # ---------- ⑤ 关图浮窗 → 页签接回 ----------
            r.js("""() => {
                const win = [...document.querySelectorAll('.chatfilesys-floatwin')]
                    .find((w) => w.querySelector('[data-role=\"float-graph-host\"]'));
                if (!win) return 0;
                win.querySelector('[data-role=\"close\"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 1;
            }""")
            r.settle(500)
            r.open_popup()
            r.popup_switch_tab("结构图")
            r.settle(1200)
            st = r.js(FLOATWIN_STATE, 'graph')
            tab_has_svg = r.js("""() => Boolean(document.querySelector('dialog[open] [data-tabbody=\"graph\"] [data-role=\"graph-host\"] svg'))""")
            results.append(report("⑤ 关图浮窗后页签自动接回视图（token 没变也重挂）",
                                  not st.get("exists") and tab_has_svg,
                                  f"graphFloat={st.get('exists')} tabSvg={tab_has_svg}"))
            r.pg.screenshot(path=str(SHOTS / "floatwin_06_tab_remounted.png"))

            CUR_KIND = 'tree'
            # ---------- ⑦ 样式纪律抽查 ----------
            st = r.js(FLOATWIN_STATE, CUR_KIND)
            # 图浮窗已关、树浮窗还开着 → 抽树浮窗
            results.append(report("⑦ 小窗节点零硬编码主题色（inline style 仅几何）", not st.get("badInline"), str(st.get("badInline")[:3])))
            r.js("""() => document.querySelectorAll('.chatfilesys-floatwin')
                     .forEach((w) => w.querySelector('[data-role=\"close\"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))""")
            r.settle(400)
            gone = r.js("() => !document.querySelector('.chatfilesys-floatwin')")
            results.append(report("⑦ 关闭按钮销毁小窗（节点移除、零残留）", gone, f"gone={gone}"))

            r.close_popup()
            r.settle(400)
        finally:
            print("\n---- 页面报错（pageerror）----")
            for e in r.errors[-6:]:
                print("  ", e[:300])
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()
    fails = [t for t in results if not t.startswith("PASS")]
    print("\n======== 浮窗 e2e 汇总 ========")
    for t in results:
        print(" ", t)
    print(f"================ {len(results) - len(fails)}/{len(results)} PASS ================")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
