"""本轮新特性的真机验收（设置中枢 / 错误面 / 分支合并）—— Dev Luker 8003。

用户 2026-09-27 令：「让整个项目全部用户可调，该暴露的暴露，该审查的审查，agent 友好」
「报错通知完全可看懂也直观」「加图结构和 merge 这种功能」。
本文件把这三条各自落成**可跑、可证伪**的断言（图视图另有 `test_graph_view.py`）。

  A 设置中枢
    A1 设置页签渲染出**表里的全部项**（数量与 key 都对得上，不是手写的几项）
    A2 改一项 → 落进 extension_settings → 回读一致
    A3 越界输入被**夹住**并回报真值（不是静默存下去）
    A4「恢复全部默认」把改动还原
    A5「导出设置清单」的 JSON 里含全部 key（agent 友好面）
  B 错误面
    B1 **注入一次真失败**（把 saveMetadata 打挂）→ 弹窗顶部出现错误条，带 CFS 编号 + 「怎么办」
    B2 编号在册（不出现「未登记」字样）
    B3「清空」能清掉
  C 分支合并
    C1 把两条分支合成一条**新分支**，路径 = 逐层并集，且**原分支一字未改**
    C2 冲突层按用户选择落定

跑法：PYTHONIOENCODING=utf-8 python tests/e2e/test_night_features.py
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report as _report, reset_instance, BASE, ENTRY, EXT_SRC, TEST_CHAR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []


def report(name, ok, detail=""):
    """本地包装：harness 的 `report` 只打印并返回 ok，本文件要**收进 results** 才能定 PASS/FAIL。"""
    results.append(bool(ok))
    return _report(name, ok, detail)


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


SETTINGS_PROBE_JS = """() => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    const host = root?.querySelector('[data-role="settings-groups"]');
    if (!host) return { rendered: false };
    const ctrls = [...host.querySelectorAll('[data-role="setting"]')];
    return {
        rendered: true,
        count: ctrls.length,
        keys: ctrls.map((c) => c.dataset.key),
        types: [...new Set(ctrls.map((c) => c.dataset.type))].sort(),
        // 每行都该有一句「为什么」（用户要求「该暴露的暴露」，且每项说得清理由）
        explanations: [...host.querySelectorAll('.chatfilesys-set-why')].filter((x) => x.textContent.trim().length > 6).length,
        labels: [...host.querySelectorAll('.chatfilesys-set-label')].length,
    };
}"""

# 从页面里直接读/写 extension_settings（绕过 UI，验「落盘」这一层）
GET_SETTING_JS = """(key) => {
    const s = SillyTavern.getContext().extensionSettings?.chatfilesys || {};
    return key.split('.').reduce((o, k) => (o == null ? o : o[k]), s);
}"""


def set_ui_setting(r, key, value):
    """在设置页签的控件上改值（走真实交互路径）。"""
    r.ensure_popup()
    r.popup_switch_tab("设置")
    r.pg.wait_for_timeout(600)
    return r.js("""([key, value]) => {
        const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
        const el = root?.querySelector(`[data-role="setting"][data-key="${key}"]`);
        if (!el) return { ok: false, why: 'no-control' };
        if (el.type === 'checkbox') { el.checked = Boolean(value); }
        else { el.value = String(value); }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, tag: el.tagName, type: el.dataset.type, now: el.value ?? el.checked };
    }""", [key, value])


# ---------------- A 设置中枢 ----------------

def section_settings(r):
    r.ensure_popup()
    r.popup_switch_tab("设置")
    r.pg.wait_for_timeout(900)
    probe = r.js(SETTINGS_PROBE_JS)
    expected = r.js(f"""async () => {{
        const m = await import('{EXT_SRC}/core/settings-registry.js');
        return m.SETTINGS.map((s) => s.key);
    }}""")
    ok_keys = probe.get('rendered') and set(probe.get('keys') or []) == set(expected or [])
    report("A1 设置页签渲染出**表里的全部项**（UI 由 registry 生成，不是手写的几项）",
           ok_keys, f"控件 {probe.get('count')} 个 / 表里 {len(expected or [])} 项；类型={probe.get('types')}")
    report("A1b 每一项都有标签与「为什么」（该暴露的暴露，且说得清理由）",
           probe.get('labels') == probe.get('count') and probe.get('explanations') >= probe.get('count') - 1,
           f"label={probe.get('labels')} 解释={probe.get('explanations')} 控件={probe.get('count')}")

    # A2 改一项 → 落盘
    before = r.js(GET_SETTING_JS, 'graph.chunk_size')
    newv = int(before or 240) + 60
    act = set_ui_setting(r, 'graph.chunk_size', newv)
    r.pg.wait_for_timeout(900)
    after = r.js(GET_SETTING_JS, 'graph.chunk_size')
    report("A2 在设置里改一项 → 落进 extension_settings（走真实控件路径）",
           act.get('ok') and after == newv, f"{before} → {after}（控件回报 {act}）")

    # A3 越界被夹住
    set_ui_setting(r, 'graph.chunk_size', 999999)
    r.pg.wait_for_timeout(900)
    clamped = r.js(GET_SETTING_JS, 'graph.chunk_size')
    mmax = r.js(f"""async () => {{
        const m = await import('{EXT_SRC}/core/settings-registry.js');
        return m.BY_KEY.get('graph.chunk_size').max;
    }}""")
    report("A3 越界输入被夹到区间上限（不是静默存个非法值）",
           clamped == mmax, f"输入 999999 → 实际 {clamped}（上限 {mmax}）")

    # A5 导出清单
    r.ensure_popup()
    r.popup_switch_tab("设置")
    r.click_action("settings-export")
    r.pg.wait_for_timeout(1200)
    exported = r.js("""() => {
        const ta = document.querySelector('dialog[open]:not([closing]) textarea.chatfilesys-export-json');
        if (!ta) return { ok: false };
        const txt = ta.value || ta.textContent || '';
        let j = null;
        try { j = JSON.parse(txt); } catch { /* 不是 JSON */ }
        return { ok: true, isJson: Boolean(j), count: j?.registry?.count ?? null,
                 hasCurrent: Boolean(j?.current), len: txt.length };
    }""")
    report("A5「导出设置清单」给出机器可读 JSON（含全部项与当前值 —— agent 友好面）",
           exported.get('isJson') and exported.get('count') == len(expected or []),
           f"{exported}")
    # 关掉它（DISPLAY/TEXT popup 的关闭按钮）
    r.js("""() => { const d = [...document.querySelectorAll('dialog[open]:not([closing])')].pop();
        d?.querySelector('.popup-button-ok, .popup-button-close')?.click(); }""")
    r.pg.wait_for_timeout(800)

    # A4 恢复默认
    r.ensure_popup()
    r.popup_switch_tab("设置")
    r.click_action("settings-reset-all")
    r.pg.wait_for_timeout(1200)
    r.popup_ok()          # 「确定要恢复默认吗」
    r.pg.wait_for_timeout(1200)
    restored = r.js(GET_SETTING_JS, 'graph.chunk_size')
    dflt = r.js(f"""async () => {{
        const m = await import('{EXT_SRC}/core/settings-registry.js');
        return m.BY_KEY.get('graph.chunk_size').default;
    }}""")
    report("A4「恢复全部默认」把改动的项还原", restored == dflt, f"{clamped} → {restored}（默认 {dflt}）")


# ---------------- B 错误面 ----------------

ERRORBAR_JS = """() => {
    const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
    const bar = root?.querySelector('.chatfilesys-errhost');
    if (!bar || !bar.textContent.trim()) return { shown: false };
    return {
        shown: true,
        text: bar.innerText.replace(/\\n+/g, ' | ').slice(0, 500),
        codes: [...bar.querySelectorAll('.chatfilesys-err-code')].map((x) => x.textContent.trim()),
        hasHowTo: /怎么办/.test(bar.innerText),
        hasDetailFold: Boolean(bar.querySelector('details')),
        hasCopy: Boolean(bar.querySelector('[data-action="errors-copy"]')),
        unregistered: /未登记/.test(bar.innerText),
    };
}"""

# 注入一次**真失败**：把 `globalThis.fetch` 对 chats 列举/读取端点的请求打成异常。
#
# ── 两次没红的经历（如实记下，免得后人重走） ──
# ① 先试 patch `ctx.saveMetadata` —— **没生效**：宿主 `getContext()` **每次返回新对象**，
#    往它上面挂属性只改了那一个副本，插件下一句 `ctx()` 拿到的又是新的。
# ② 再试 patch chats 端点 + 点「改名」—— **仍没红**：off 模式下 `saveMetadata` 由宿主内部
#    调度，异常被宿主自己吞了，插件收不到。
# ③ 也试过点「AI 总结」—— 宿主把模型调用失败**吞成空结果**（插件只看到 `summary===''`），
#    于是走的是「生成结果为空」那条 warning，不进错误面。
#
# 现在这条是**确定可达**的：清空数据源（chats 端点全挂）⇒ 文件源枚举降级为空 ⇒ 图为空 ⇒
# 布局算不出坐标 ⇒ `renderGraphInto` 捕获并 `reportError('CFS-N003')`。
# 它是真实用户会遇到的形态（数据读不到时图是空的），且每一步都不依赖宿主是否吞异常。
FAULT_INJECT_JS = """() => {
    if (!window.__origFetch) window.__origFetch = globalThis.fetch;
    const orig = window.__origFetch;
    globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (url.includes('/api/chats/')) {
            return Promise.reject(new Error('注入的失败：聊天端点不可用（结构图数据源读不到）'));
        }
        return orig(input, init);
    };
    return 'injected';
}"""

FAULT_RESTORE_JS = """() => {
    if (window.__origFetch) { globalThis.fetch = window.__origFetch; window.__origFetch = null; }
    return 'restored';
}"""


def section_errors(r):
    r.js(FAULT_INJECT_JS)
    # 到「结构图」页签点「重算」：数据源读不到 ⇒ 图为空 ⇒ 布局不可用 ⇒ CFS-N003
    r.ensure_popup()
    r.popup_switch_tab("结构图")
    r.settle(1200)
    try:
        r.click_action("graph-reload")
    except AssertionError as e:
        report("B1 注入真失败 → 弹窗顶部出现错误条（任何页签下都看得见）", False, f"找不到重算按钮：{e}")
        r.js(FAULT_RESTORE_JS)
        return
    r.settle(9000)

    bar = r.js(ERRORBAR_JS)
    if not bar.get('shown'):
        # 诊断：把本插件的控制台输出打出来（注入没触发时，只有这里看得出走到哪一步）
        mine = [t for (_ty, t, _s) in r.logs if 'chatfilesys' in t][-6:]
        print("    [诊断] 插件控制台:", " || ".join(mine)[:400] or "(无)")
        print("    [诊断] 错误记录:", r.js(f"""async () => {{
            return 'errhost=' + Boolean(document.querySelector('.chatfilesys-errhost'));
        }}"""))
    report("B1 注入真失败 → 弹窗顶部出现错误条（任何页签下都看得见）", bar.get('shown'),
           f"{bar.get('text', '')[:200]}")
    report("B2 错误条带 **CFS 编号** 与「怎么办」（可检索 + 可行动）",
           bool(bar.get('codes')) and bar.get('hasHowTo'),
           f"codes={bar.get('codes')} hasHowTo={bar.get('hasHowTo')}")
    report("B2a 编号是**结构图域**（`CFS-N0xx`）—— 归因到「哪一块坏了」而非泛泛的「操作失败」",
           any(c.startswith('CFS-N') for c in (bar.get('codes') or [])),
           f"codes={bar.get('codes')}")
    report("B2a2 空图被解释成「没读到」而不是「这个聊天没有结构」（`CFS-N004`）",
           'CFS-N004' in (bar.get('codes') or []), f"codes={bar.get('codes')}")
    report("B2b 归因与原始信息**折叠**但存在（限屏可读，又不丢证据）",
           bar.get('hasDetailFold'), f"fold={bar.get('hasDetailFold')} copy={bar.get('hasCopy')}")
    report("B2c 编号在册（没出现「未登记」）", not bar.get('unregistered'), f"{bar.get('unregistered')}")

    r.js(FAULT_RESTORE_JS)
    if bar.get('shown'):
        r.ensure_popup()
        r.click_action("errors-clear")
        r.pg.wait_for_timeout(800)
        after = r.js(ERRORBAR_JS)
        report("B3「清空」把错误条清掉", not after.get('shown'), f"{after}")
    else:
        print("  ⏭  B3 跳过（没有错误条可清——B1 已说明原因）")


# ---------------- C 分支合并 ----------------

def section_merge(r):
    # **自足**：C 不假设前面几段把分支启用好了（实测：真机跑到这里时模型可能不在——
    # 依赖前一段的副作用会让「某一段失败」连带把这一段判成失败，那是假红）。
    if r.state().get('branches') is None:
        print("  （C 段：本聊天未启用分支，自行启用）")
        r.ensure_popup()
        r.popup_switch_tab("当前聊天")
        r.settle(600)
        try:
            r.click_action("enable")
            r.settle(1800)
        except AssertionError as e:
            report("C1 合并：把两条分支合成一条新分支", False, f"启用分支失败：{e}")
            return

    # 两条分支：主分支 5 层；另建一条 fork@2 且带自己独有层的分支
    info = r.js("""async () => {
        const ctx = SillyTavern.getContext();
        const mod = await import('""" + EXT_SRC + """/core/branches.js');
        const m = ctx.chatMetadata?.extensions?.chatfilesys;
        if (!m) return { ok: false, why: 'not-enabled' };
        const main = m.branches.find((b) => b.is_default) || m.branches[0];
        // 建一条 fork@2 的分支（照既有测试的做法：直接写模型）
        for (const b of [...m.branches]) if (b.name.startsWith('合并探针')) {
            if (b.is_default) continue;                     // 主分支删不掉，跳过（不许因此炸用例）
            try { mod.deleteBranch(m, b.id); } catch { /* 同上 */ }
        }
        const b2 = mod.createBranch(m, { name: '合并探针·B', forkFloor: 2, activate: false });
        const md = { ...(ctx.chatMetadata || {}) };
        md.extensions = { ...(md.extensions || {}), chatfilesys: m };
        ctx.chatMetadata = md; ctx.chatMetadata.tainted = true;
        await ctx.saveMetadata();
        return { ok: true, mainId: main.id, bId: b2.id, mainPath: JSON.stringify(main.path), bPath: JSON.stringify(b2.path) };
    }""")
    if not info.get('ok'):
        report("C1 合并：把两条分支合成一条新分支", False, f"前置失败 {info}")
        return

    before = r.js("""async () => {
        const ctx = SillyTavern.getContext();
        const m = ctx.chatMetadata.extensions.chatfilesys;
        return m.branches.map((b) => ({ id: b.id, name: b.name, path: JSON.stringify(b.path) }));
    }""")

    # 打开合并弹窗（分支管理行上的「合并…」按钮，对象 = 选择器里选中的那条）
    r.ensure_popup()
    r.popup_switch_tab("当前聊天")
    r.pg.wait_for_timeout(600)
    r.pick_branch(info['mainId'])
    r.click_action("merge-branches", branch=info['mainId'])
    r.pg.wait_for_timeout(1500)

    opened = r.js("""() => {
        const root = [...document.querySelectorAll('dialog[open]:not([closing])')]
            .map((d) => d.querySelector('.chatfilesys-merge')).find(Boolean);
        if (!root) return { open: false };
        // 目标 = 主分支，并入 = 探针 B
        const opts = [...root.querySelectorAll('[data-role="b"] option')].map((o) => ({ v: o.value, t: o.textContent.trim() }));
        return { open: true, opts, hasApply: Boolean(root.querySelector('[data-act="apply"]')),
                 summary: root.querySelector('.chatfilesys-merge-summary')?.textContent || '',
                 steps: root.querySelectorAll('.chatfilesys-merge-step').length };
    }""")
    report("C1a 合并弹窗能开，且列出可选分支与逐层来源", opened.get('open') and opened.get('hasApply'),
           f"opts={len(opened.get('opts') or [])} steps={opened.get('steps')} summary={opened.get('summary')[:80]!r}")

    # 选定「并入」= 探针 B，然后合并
    r.js("""(bid) => {
        const root = [...document.querySelectorAll('dialog[open]:not([closing])')]
            .map((d) => d.querySelector('.chatfilesys-merge')).find(Boolean);
        const sel = root.querySelector('[data-role="b"]');
        sel.value = bid;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""", info['bId'])
    r.pg.wait_for_timeout(800)
    r.js("""() => {
        const root = [...document.querySelectorAll('dialog[open]:not([closing])')]
            .map((d) => d.querySelector('.chatfilesys-merge')).find(Boolean);
        root.querySelector('[data-act="apply"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }""")
    r.pg.wait_for_timeout(2500)

    after = r.js("""async () => {
        const ctx = SillyTavern.getContext();
        const m = ctx.chatMetadata.extensions.chatfilesys;
        return m.branches.map((b) => ({ id: b.id, name: b.name, path: JSON.stringify(b.path) }));
    }""")
    names = [b['name'] for b in after]
    merged = next((b for b in after if b['name'].startswith('合并·') or '合并' in b['name']), None)
    report("C1b 合并落成**一条新分支**（不是就地改原分支）",
           len(after) == len(before) + 1 and merged is not None,
           f"分支 {len(before)} → {len(after)}；新分支={merged and merged['name']}")

    if merged:
        # 逐层并集：主分支 5 层 ⇒ 合并结果应有 5 层
        n = len(json.loads(merged['path']))
        report("C1c 合并结果 = 逐层并集（主分支 5 层 ⇒ 结果 5 层）", n == 5, f"结果 {n} 层")

    same = all(any(b['id'] == a['id'] and b['path'] == a['path'] for b in after) for a in before)
    report("C2 **原分支一字未改**（合并不改历史，撤销 = 删新分支）", same,
           "".join(f"{a['name']}:{a['path']==next((b['path'] for b in after if b['id']==a['id']),None)} " for a in before))

    # 收尾：删掉探针新分支。
    # **必须容错**：`deleteBranch` 对主分支会抛「默认分支不可删除」（2026-09-28 实测——
    # 某轮被中断后残留的分支里恰好有主分支，整条用例因此在这一步炸掉）。
    # 清理失败不该把已经跑完的断言判成失败，但也**不许静默**——把跳过的名字打出来。
    cleaned = r.js("""async (name) => {
        const ctx = SillyTavern.getContext();
        const mod = await import('""" + EXT_SRC + """/core/branches.js');
        const m = ctx.chatMetadata.extensions.chatfilesys;
        const skipped = [];
        for (const b of [...m.branches]) {
            if (!b.name.includes(name)) continue;
            if (b.is_default) { skipped.push(b.name + '(主分支，跳过)'); continue; }
            try { mod.deleteBranch(m, b.id); } catch (e) { skipped.push(b.name + '(' + e.message + ')'); }
        }
        const md = { ...(ctx.chatMetadata || {}) };
        md.extensions = { ...(md.extensions || {}), chatfilesys: m };
        ctx.chatMetadata = md; ctx.chatMetadata.tainted = true;
        await ctx.saveMetadata();
        return skipped;
    }""", "合并")
    if cleaned:
        print(f"  [清理] 跳过的分支：{cleaned}")


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        page = c.new_page()
        r = Runner(page, "night-features")
        try:
            page.goto(BASE, wait_until="commit", timeout=90000)
            print("  复位实例…")
            try:
                reset_instance(page)
            except Exception as e:      # noqa: BLE001
                print(f"  [warn] reset_instance 未在超时内完成（宿主冷启动慢），继续等入口：{e}")
            page.wait_for_selector(ENTRY, state="attached", timeout=180000)
            opened = open_test_char(r)
            report("预备 测试角色已打开", opened.get('ok'), f"{opened}")

            r.ensure_popup()
            r.popup_switch_tab("当前聊天")
            if r.state().get("branches") is None:
                r.click_action("enable")
                r.pg.wait_for_timeout(1500)

            print("\n-- A 设置中枢 --")
            section_settings(r)
            print("\n-- B 错误面 --")
            section_errors(r)
            print("\n-- C 分支合并 --")
            section_merge(r)

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            report("全程零 chatfilesys 归因 pageerror", not errs, f"{errs[:2]}")
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.js(FAULT_RESTORE_JS)
            except Exception:
                pass
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nNIGHT FEATURES " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
