"""弹窗页签取证（2026-09-28）—— 逐页签截图 + **代码化结构提取**。

用途：为「页签/弹窗重组方案」提供事实。争议点是三条：
  1. 树到底渲染在几个地方（``当前聊天`` 与 ``角色卡的聊天`` 各有一个 host）
  2. 「设置存在重复」—— 逐项抽出设置行的 key/标签/分组，用重复检测给出判据
  3. 弹窗信息层级与观感（每页签只有什么、是否有溢出）

纪律：
- 只操作 ``__cb_e2e`` 探针角色，末尾清理（harness 既定隔离原则）
- **截图只落盘给用户看；主会话不读图**。事实一律走本脚本打印的结构化文本
- 结论写进任务 ``research/`` 目录（planning 路径，不受检索门禁影响）

跑法：
    PYTHONIOENCODING=utf-8 python tests/e2e/recon_popup_tabs.py
"""
import json
import os
import sys
from collections import Counter

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Runner, browser_ctx, TEST_CHAR  # noqa: E402
import hosts  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots", "tabs-0928")
RESEARCH = os.path.join(
    HERE, "..", "..", ".trellis", "tasks", "09-28-jsonl-overhaul-umbrella", "research"
)
POPUP = 'dialog[open]:not([closing]) .chatfilesys-popup'

TABS = ["当前聊天", "结构图", "角色卡的聊天", "设置", "回收站"]

# ---------------------------------------------------------------- 结构提取器
# 逐页签：骨架（深度 3）+ 关键元素计数 + 关键容器的计算样式。
DUMP_JS = r"""
(tabLabel) => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    if (!root) return { error: 'popup-not-found' };

    const cls = (el) => {
        const c = typeof el.className === 'string' ? el.className : '';
        return c.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    };
    const label = (el) => (el.tagName + (cls(el) ? '.' + cls(el) : '')).toLowerCase();

    // 骨架：深度 3，只列有意义的节点，文本截断
    const skeleton = (el, d, out) => {
        for (const ch of el.children) {
            const t = (ch.textContent || '').trim().replace(/\s+/g, ' ');
            out.push('  '.repeat(d) + label(ch) + (t ? ' :: ' + t.slice(0, 60) : ''));
            if (d < 2) skeleton(ch, d + 1, out);
        }
        return out;
    };

    // 可见的页签体：renderLukerTabs 与内置降级两种形态都认
    const bodies = [...root.querySelectorAll('.chatfilesys-tabbody, [data-tabbody]')]
        .filter((b) => !b.hidden && b.getBoundingClientRect().height > 0);
    const body = bodies[0] || root;

    const style = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
    };

    // 设置行全量抽取（「重复」判据）
    const setRows = [...body.querySelectorAll('.chatfilesys-set-row')].map((r) => {
        const ctl = r.querySelector('[data-role="setting"]');
        return {
            key: ctl?.dataset.key ?? null,
            type: ctl?.dataset.type ?? null,
            ctl: ctl ? ctl.tagName.toLowerCase() : null,
            label: r.querySelector('.chatfilesys-set-label')?.textContent.trim() ?? null,
            why: (r.querySelector('.chatfilesys-set-why')?.textContent.trim() ?? '').slice(0, 70),
        };
    });

    return {
        tab: tabLabel,
        tabBtnOrder: [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')]
            .map((b) => b.textContent.trim()),
        popupBox: box(root),
        bodyBox: body === root ? null : box(body),
        skeleton: skeleton(body, 0, []).slice(0, 40),
        counts: {
            svg: body.querySelectorAll('svg').length,
            canvas: body.querySelectorAll('canvas').length,
            button: body.querySelectorAll('button').length,
            input: body.querySelectorAll('input').length,
            select: body.querySelectorAll('select').length,
            setRow: setRows.length,
            dataRole: [...body.querySelectorAll('[data-role]')]
                .map((e) => e.dataset.role),
        },
        // 树/图的两个宿主：在哪个页签里真的渲染了内容
        treeHosts: [...root.querySelectorAll('.chatfilesys-tree-host, [data-role="tree-host"], [data-role="chat-tree-host"]')]
            .map((h) => ({
                role: h.dataset.role || null,
                cls: cls(h),
                svg: h.querySelectorAll('svg').length,
                text: (h.textContent || '').trim().slice(0, 80),
                box: box(h),
                visible: h.getBoundingClientRect().height > 0,
            })),
        styles: {
            bodyFont: style(body, 'fontSize'),
            bodyColor: style(body, 'color'),
            h5: style(body.querySelector('h5'), 'fontSize'),
            setLabel: style(body.querySelector('.chatfilesys-set-label'), 'fontSize'),
            note: style(body.querySelector('.chatfilesys-note'), 'fontSize'),
        },
        setRows,
        scrollOverflow: body ? {
            scrollH: body.scrollHeight, clientH: body.clientHeight,
            scrollW: body.scrollWidth, clientW: body.clientWidth,
        } : null,
        textLen: (body.textContent || '').trim().length,
    };
}
"""


def main():
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(RESEARCH, exist_ok=True)

    # 1) 先把仓库里的插件同步进 Dev Luker（实例里是副本，不是链接）
    h = hosts.host_of("luker")
    try:
        ok, msg = hosts.sync_plugin(h)
        print(f"插件同步: {'OK' if ok else 'FAIL'} — {msg}")
    except Exception as e:
        print(f"插件同步跳过（{e}）；继续用实例现状取证")

    result = {"base": h.base, "table": TEST_CHAR, "tabs": {}, "popupHeader": None}
    out = os.path.join(RESEARCH, "popup-recon.json")

    def save():
        """逐步骤落盘：脚本中途挂住也不丢已取到的事实（首跑挂在写盘前，白跑一次）。"""
        with open(out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "recon-tabs")
        try:
            r.boot()
            print(f"就绪: entry={r.js('() => !!document.getElementById(\"chatfilesys-entry\")')}")

            # 探针角色 + 造楼 + 一条分支（让树/图有东西可画）
            try:
                r.delete_test_char()
                r.settle(700)
            except Exception:
                pass
            r.create_test_char()
            r.open_test_char()
            r.settle(2500)
            for cmd in ["/send U-F1", f"/sendas name={TEST_CHAR} A-F2",
                        "/send U-F3", f"/sendas name={TEST_CHAR} A-F4"]:
                r.cmd(cmd)
                r.settle(600)
            try:
                r.wait_state(lambda s: s["chatLen"] >= 4, desc="造楼")
            except Exception as e:
                print("  [warn] 造楼未达预期:", e)
            try:
                r.create_branch(2, name="分叉·F2")
                r.settle(1200)
            except Exception as e:
                print("  [warn] 建分支失败:", e)
            r.close_popup()
            r.settle(500)

            # 2) 逐页签：截图 + 结构提取
            r.ensure_popup()
            r.settle(600)
            for t in TABS:
                try:
                    r.popup_switch_tab(t)
                    r.settle(900)
                except Exception as e:
                    print(f"  [skip] 页签 {t} 打不开: {e}")
                    result["tabs"][t] = {"error": str(e)}
                    continue
                el = r.pg.query_selector(POPUP)
                if el:
                    el.screenshot(path=os.path.join(SHOTS, f"tab_{TABS.index(t)}_{t}.png"))
                try:
                    result["tabs"][t] = r.js(DUMP_JS, t)
                except Exception as e:
                    result["tabs"][t] = {"error": f"dump failed: {e}"}
                save()
                print(f"  [ok] {t}")

            # 「角色卡的聊天」页签里的树要点了列表项才出来 → 补一次
            try:
                r.popup_switch_tab("角色卡的聊天")
                r.settle(600)
                clicked = r.js("""() => {
                    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                    const it = root?.querySelector('.chatfilesys-chat-item, [data-file], li button, li a');
                    if (!it) return 0;
                    it.dispatchEvent(new MouseEvent('click', {bubbles:true}));
                    return 1;
                }""")
                r.settle(1500)
                if clicked:
                    el = r.pg.query_selector(POPUP)
                    if el:
                        el.screenshot(path=os.path.join(SHOTS, "tab_2b_角色卡的聊天_点了条目.png"))
                    result["tabs"]["角色卡的聊天#点了条目"] = r.js(DUMP_JS, "角色卡的聊天#点了条目")
                    save()
                    print("  [ok] 角色卡的聊天（点条目后）")
            except Exception as e:
                print("  [warn] 角色卡的聊天点条目失败:", e)

            # 3) 弹窗头部（页签栏本身）
            try:
                result["popupHeader"] = r.js("""() => {
                    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                    const bar = root?.querySelector('.luker-tabs, .chatfilesys-tabs');
                    return {
                        tabs: [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')].map(b => ({
                            label: b.textContent.trim(),
                            active: b.classList.contains('active') || b.getAttribute('aria-selected') === 'true',
                        })),
                        barBox: bar ? (() => { const r = bar.getBoundingClientRect();
                            return {w: Math.round(r.width), h: Math.round(r.height)}; })() : null,
                        modal: (() => { const d = document.querySelector('dialog[open]:not([closing])');
                            const r = d?.getBoundingClientRect();
                            return r ? {w: Math.round(r.width), h: Math.round(r.height)} : null; })(),
                    };
                }""")
            except Exception as e:
                result["popupHeader"] = {"error": str(e)}
            save()

        finally:
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()

    # ---------------- 汇总与判据 ----------------
    save()
    print(f"\n结构取证落盘: {os.path.abspath(out)}")
    print(f"截图: {os.path.abspath(SHOTS)}")

    print("\n================ 结构化事实 ================")
    hdr = result.get("popupHeader")
    if hdr and not hdr.get("error"):
        print(f"页签栏: {[x['label'] for x in hdr.get('tabs', [])]}")
        print(f"弹窗框: {hdr.get('modal')}  页签栏: {hdr.get('barBox')}")

    for t, d in result["tabs"].items():
        if d.get("error"):
            print(f"\n[{t}] 错误: {d['error']}")
            continue
        print(f"\n[{t}] 文本 {d.get('textLen')} 字, 体框 {d.get('bodyBox')}")
        print(f"   元素: {d.get('counts')}")
        print(f"   样式: {d.get('styles')}")
        print(f"   溢出: {d.get('scrollOverflow')}")
        sv = [h for h in d.get("treeHosts", []) if h["visible"]]
        if sv:
            print(f"   ★ 可见树宿主: {sv}")
        for line in d.get("skeleton", [])[:12]:
            print("   |" + line)

    # 设置重复判据
    keys = []
    for t, d in result["tabs"].items():
        for row in d.get("setRows") or []:
            keys.append((row.get("key"), row.get("label"), t))
    if keys:
        c = Counter(k for k, _, _ in keys)
        dup = {k: n for k, n in c.items() if n > 1}
        print(f"\n设置项共 {len(keys)} 行，唯一 key {len(c)} 个")
        print(f"**重复 key**: {dup if dup else '无'}")
        for k, lb, t in keys:
            print(f"   {t} | {k} | {lb}")


if __name__ == "__main__":
    main()
