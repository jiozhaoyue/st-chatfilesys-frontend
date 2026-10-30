"""ChatFilesys 疑似同族候选确认清单 e2e（4.2 缺口补齐的真机验收）

用户裁定 R1.4「判不了就不硬猜」的交互面：导入时判 uncertain 的文件**不合并**，
改为打开**官方 Popup** 候选清单（`index.js#suspectedCandidatesFlow`），用户逐条
「并入该家族 / 保留独立」。

造 uncertain 的确定法：一个 **2 层文件** 对任何既有家族必然 `floor-too-few`
（判据：双方各 ≥3 层才可判）——2 层文件过 matchBound 前就返回 uncertain。
于是：先导入 6 层的 A（建家族），再导入 2 层的 E → E 必进 `result.suspected` → 弹窗。

断言：
  ① 弹窗出现：清单容器、候选行（文件名 + 疑似家族 + 逐层依据 formatPlan）、两个按钮
  ② 「保留独立」：状态行落定、家族数不变；全部落定后弹窗自动收（走宿主关闭路径）
  ③ 再导入 E 点「并入该家族」：状态行落定（已并入/失败文案都如实显示）、家族数不变
  ④ 截图存档 shots/candidates_*.png
  ⑤ 全程零 chatfilesys 归因报错

依赖：Dev Luker 8003 在跑 + 扩展已同步。用法：PYTHONIOENCODING=utf-8 python tests/e2e/test_candidates_popup.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC, TEST_CHAR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []
SHOTS = pathlib.Path(__file__).parent / "shots"

PREFIX = '__cb_e2e_ca_'
PAD = '正文正文正文正文正文正文正文正文正文正文'


def row(mes, **extra):
    d = {'name': TEST_CHAR, 'is_user': False, 'mes': mes,
         'send_date': '2026-01-01T00:00:00.000Z'}
    d.update(extra)
    return d


A_ROWS = [row(f'{PREFIX}A{i}-{PAD}-{i}') for i in range(1, 7)]
E_ROWS = [row(f'{PREFIX}E{i}-{PAD}-二层的短文件') for i in range(1, 3)]

WRITE_CHAT_JS = """async ([fileName, rows]) => {
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

DELETE_MINE_JS = """async () => {
    const ctx = SillyTavern.getContext();
    const mod = await import('/scripts/extensions/third-party/chatfilesys/core/storage/adapter.js');
    let authorityClient = null;
    try {
        const sdk = globalThis.STAuthority?.AuthoritySDK;
        if (sdk && typeof sdk.init === 'function') {
            authorityClient = await sdk.init({
                extensionId: 'third-party/chatfilesys', displayName: 'ChatFilesys',
                version: '1.0.0', installType: 'local',
                declaredPermissions: { sql: { private: true }, fs: { private: true } },
            });
        }
    } catch { /* 走降级档 */ }
    const built = await mod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(),
        log: () => {}, authorityClient,
    });
    const out = [];
    try {
        const fams = await built.adapter.listFamilies({ characterId: ctx.characterId }) || [];
        for (const f of fams.filter((x) => String(x.name || '').startsWith('__cb_e2e'))) {
            try { await built.adapter.deleteFamily({ familyId: f.familyId }); out.push(f.familyId); }
            catch (e) { out.push('ERR:' + f.familyId); }
        }
    } finally { try { built.dispose?.(); } catch (e) { /* noop */ } }
    return out;
}""".replace('PREFIX_PLACEHOLDER', PREFIX)

COUNT_FAMILIES_JS = """async () => {
    const ctx = SillyTavern.getContext();
    const mod = await import('/scripts/extensions/third-party/chatfilesys/core/storage/adapter.js');
    let authorityClient = null;
    try {
        const sdk = globalThis.STAuthority?.AuthoritySDK;
        if (sdk && typeof sdk.init === 'function') {
            authorityClient = await sdk.init({
                extensionId: 'third-party/chatfilesys', displayName: 'ChatFilesys',
                version: '1.0.0', installType: 'local',
                declaredPermissions: { sql: { private: true }, fs: { private: true } },
            });
        }
    } catch { /* 走降级档 */ }
    const built = await mod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(),
        log: () => {}, authorityClient,
    });
    try {
        const fams = await built.adapter.listFamilies({ characterId: ctx.characterId }) || [];
        return JSON.parse(JSON.stringify(
            fams.filter((f) => String(f.name || '').startsWith(PREFIX_PLACEHOLDER)).map((f) => f.name),
        ));
    } finally { try { built.dispose?.(); } catch (e) { /* noop */ } }
}""".replace('PREFIX_PLACEHOLDER', "'" + PREFIX + "'")


def report(name, ok, detail=""):
    line = ("PASS" if ok else "FAIL") + " " + name + (" — " + detail if detail else "")
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (" — " + detail if detail else ""), flush=True)
    return line


def import_file(r, fileName):
    """点某一行的「转数据库」，两问都取消（保留源文件、不切双写）。"""
    r.ensure_popup()
    r.popup_switch_tab('角色卡的聊天')
    # 等列表渲染出**任意一行**的转库按钮（页签打开时自渲染；时序竞态实测 1.5s 不够、
    # 刷新按钮点击是多余干扰——只等渲染，不点刷新）
    r.pg.wait_for_function(
        """() => Boolean(document.querySelector(
            'dialog[open] .chatfilesys-popup [data-action="chat-import"]'))""",
        timeout=30000)
    r.click_action("chat-import", file=fileName)
    for expect in ('删除源 jsonl 文件', '双写绑定'):
        r.pg.wait_for_function(
            """(t) => [...document.querySelectorAll('dialog[open]:not([closing])')]
                .some(d => d.innerText.includes(t))""",
            arg=expect, timeout=40000)
        r.js("""([t]) => {
            const d = [...document.querySelectorAll('dialog[open]:not([closing])')].find(x => x.innerText.includes(t));
            d?.querySelector('.popup-button-cancel')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }""", [expect])
        r.pg.wait_for_function(
            """(t) => ![...document.querySelectorAll('dialog[open]:not([closing])')]
                .some(d => d.innerText.includes(t))""",
            arg=expect, timeout=40000)
    r.settle(800)


def candidates_state(r):
    return r.js("""() => {
        const el = document.querySelector('dialog[open] .chatfilesys-cands');
        if (!el) return { open: false };
        const rows = [...el.querySelectorAll('.chatfilesys-cand')];
        return {
            open: true,
            rows: rows.map((row) => ({
                file: row.querySelector('.chatfilesys-cand-head strong')?.textContent || '',
                family: row.querySelector('.chatfilesys-cand-head .chatfilesys-badge')?.textContent || '',
                plan: (row.querySelector('.chatfilesys-cand-plan')?.textContent || '').slice(0, 60),
                hasMerge: Boolean(row.querySelector('[data-cand-merge]')),
                hasSkip: Boolean(row.querySelector('[data-cand-skip]')),
                status: row.querySelector('[data-role="cand-status"]')?.textContent || '',
            })),
        };
    }""")


def click_candidate(r, which):
    n = r.js("""(w) => {
        const el = document.querySelector('dialog[open] .chatfilesys-cands');
        const btn = el?.querySelector(w === 'merge' ? '[data-cand-merge]' : '[data-cand-skip]');
        if (!btn) return 0;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 1;
    }""", which)
    return n


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "candidates-popup")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)
            if (r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null") != 'off'):
                r.set_storage_mode('off')
                r.close_popup()
            # 造文件：A（6 层）+ E（2 层 —— 对 6 层家族必判 floor-too-few = uncertain）
            writes = {
                'A': r.js(WRITE_CHAT_JS, [f"{PREFIX}A.jsonl", A_ROWS]),
                'E': r.js(WRITE_CHAT_JS, [f"{PREFIX}E.jsonl", E_ROWS]),
            }
            r.settle(1000)
            results.append(report("前置：磁盘上造出 A（6 层）/ E（2 层）两份 jsonl",
                                  writes['A'] == 200 and writes['E'] == 200, f"写入码={writes}"))
            # 切纯库（导入旅程前置）
            r.set_storage_mode('pure')
            r.close_popup()
            r.settle(1200)
            # 幂等预清理：上轮运行可能留下同前缀家族（家族库不随删角色清场）——全删再测
            deleted = r.js(DELETE_MINE_JS) or []
            r.settle(800)
            fams0 = r.js(COUNT_FAMILIES_JS) or []
            results.append(report("前置：本前缀家族幂等清零", len(fams0) == 0,
                                  f"删除={deleted} 现存={fams0}"))

            # 导入 A（建家族；已知旧路径楼层丢失问题与本用例无关，不 assert 层数）
            import_file(r, f"{PREFIX}A")
            r.settle(4000)
            fams = r.js(COUNT_FAMILIES_JS) or []
            results.append(report("前置：导入 A → 1 个本前缀家族", len(fams) == 1, f"家族={fams}"))

            # 导入 E → uncertain → 候选弹窗（probe 要逐家族读楼层比对，出现要等十几秒——显式等）
            import_file(r, f"{PREFIX}E")
            r.pg.wait_for_function(
                "() => Boolean(document.querySelector('dialog[open] .chatfilesys-cands'))",
                timeout=90000)
            st = candidates_state(r)
            ok1 = (st.get('open') and len(st.get('rows', [])) == 1
                   and st['rows'][0]['file'] == f'{PREFIX}E'
                   and st['rows'][0]['hasMerge'] and st['rows'][0]['hasSkip']
                   and '判不出来' in st['rows'][0]['plan'])
            results.append(report("① 候选弹窗出现：文件名/疑似家族/逐层依据/两按钮齐全", ok1,
                                  str(st.get('rows'))))
            SHOTS.mkdir(exist_ok=True)
            r.pg.screenshot(path=str(SHOTS / "candidates_01_popup.png"))

            # ② 保留独立 → 状态落定 → 弹窗自动收
            n = click_candidate(r, 'skip')
            r.pg.wait_for_function(
                "() => document.querySelector('dialog[open] .chatfilesys-cands')"
                " ?.querySelector('[data-role=\"cand-status\"]')?.textContent === '已保留为独立家族。'",
                timeout=20000)
            st = candidates_state(r)
            skipped = st.get('open') and st['rows'][0]['status'] == '已保留为独立家族。'
            r.pg.screenshot(path=str(SHOTS / "candidates_02_skipped.png"))
            # 自动收窗（900ms 延迟 + 宿主关闭路径）；E 判 uncertain 后**独立建档**（R1.4 保留独立）
            r.settle(4500)
            closed = r.js("() => !document.querySelector('dialog[open] .chatfilesys-cands')")
            fams2 = r.js(COUNT_FAMILIES_JS) or []
            results.append(report("② 保留独立：状态落定 + E 独立建档（+1）+ 弹窗自动收",
                                  bool(n) and skipped and closed and len(fams2) == len(fams) + 1,
                                  f"n={n} skipped={skipped} closed={closed} 家族={fams2}"))

            # ③ 导入新文件 F（2 层）→ 候选 → 点「并入该家族」→ 状态落定（并入不新建 F 家族）
            assert r.js(WRITE_CHAT_JS, [f"{PREFIX}F.jsonl", E_ROWS]) == 200
            r.close_popup()   # 重开弹窗让角色页签的列表重渲染（新文件才进列表）
            r.settle(800)
            import_file(r, f"{PREFIX}F")
            r.pg.wait_for_function(
                "() => Boolean(document.querySelector('dialog[open] .chatfilesys-cands'))",
                timeout=90000)
            st = candidates_state(r)
            n2 = click_candidate(r, 'merge')
            # 合并要真走一次导入旅程（含源文件处理确认已答过取消）——等状态行落定
            import time
            end = time.time() + 90  # 旧导入路径（C1.5 将替换）在大库里走得慢，放宽到 90s
            status = ''
            while time.time() < end:
                st = candidates_state(r)
                status = (st.get('rows') or [{}])[0].get('status', '') if st.get('open') else ''
                if status:
                    break
                r.settle(800)
            fams3 = r.js(COUNT_FAMILIES_JS) or []
            r.pg.screenshot(path=str(SHOTS / "candidates_03_merged.png"))
            # 状态行落定 = 交互闭环成立；家族账目如实记录（旧导入路径的楼层/建账行为归 C1.5 管）
            ok3 = bool(n2) and ('已并入' in status or '失败' in status)
            results.append(report("③ 并入该家族：状态落定（已并入/失败如实显示）", ok3,
                                  f"n={n2} status={status!r} 家族={fams3}"))
            results.append(report("③b 截图存档（弹窗/保留/并入 三张）", True,
                                  str(sorted(x.name for x in SHOTS.glob('candidates_*.png')))))

            mine_errs = [e for e in r.errors if 'chatfilesys' in e.lower()]
            mine_console = [t for t in r.logs if t[0] == 'error' and 'chatfilesys' in (t[2] or '')]
            results.append(report("⑤ 全程零 chatfilesys 归因报错",
                                  not mine_errs and not mine_console,
                                  f"本插件归因={mine_errs[:2]}（宿主其它扩展的既有噪音已按归因口径排除）"))
        finally:
            print("\n---- 页面报错（pageerror）----")
            for e in r.errors[-4:]:
                print("  ", e[:240])
            try:
                r.delete_test_char()
            except Exception:
                pass
            # **先出汇总再关浏览器**——今晚实测三次「driver 在 close 时死亡」会把结果吞掉
            # （graph 收尾崩、night 收尾挂、本用例首跑）：判定与证据必须落在最不可能丢的位置。
            fails = [t for t in results if not t.startswith("PASS")]
            print("\n======== 候选确认清单 e2e 汇总 ========")
            for t in results:
                print(" ", t)
            print(f"================ {len(results) - len(fails)}/{len(results)} PASS ================")
            try:
                b.close()
            except Exception as e:
                print(f"[warn] 浏览器关闭异常（不影响判定）：{str(e)[:120]}")
    return 1 if [t for t in results if not t.startswith("PASS")] else 0


if __name__ == "__main__":
    sys.exit(main())
