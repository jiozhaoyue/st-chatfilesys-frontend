"""ChatFilesys 入库提醒弹窗 e2e（T8 / R8.1 / R8.2 / AC21 · W7 冷启动 · W8 按钮改造）

用户裁定（2026-09-26）：
  · 「默认是增强，但是强制弹出弹窗，提醒装库流程，选择是否转换到数据库，然后继续走」
  · 按钮摆法重裁定：「两个模式短按钮『纯库』/『双写』+ 小字次按钮『不入库』+ 两个小勾选
    『这个聊天不再提醒』『全部不再提醒』；关闭（X / Esc）= 不入库」
  · 「补，冷启动也弹」（页面刚加载就停在一个聊天上时也要弹一次）

断言：
  ① **冷启动**（整页重载、不重放任何事件）就弹出提醒
  ② 弹窗控件 = 两个模式短按钮 + 「不入库」+ 两个小勾选（文案与勾选态都能读到）
  ③ 「不入库」：本次不转、不写压制记录、聊天照常可用
  ④ 关窗 = 「不入库」（**插件自己画的 X**（宿主自带的那个对 TEXT 型弹窗恒不可见，已钉住）
     与 Esc 两条都测）
  ⑤ 勾「这个聊天不再提醒」+ 不入库 → 该键进 `mutedKeys`；该聊天不再弹、**别的聊天照弹**
  ⑥ 勾「全部不再提醒」+ 不入库 → `never = true`；此后**任何**聊天都不弹
  ⑦ 「纯库」按钮 → 真的切到纯库模式并把该聊天录进数据库（库里家族 + 楼层数对齐）
  ⑧ 「双写」按钮 → 真的切到双写模式、录进数据库、**磁盘聊天文件保留**
  ⑨ 压制记录只住 `extension_settings`，**不写进聊天记录**（聊天头里查不到）

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_import_prompt.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, BASE  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

MODES = ['纯库', '双写', '不入库']
CHECK_LABELS = ['这个聊天不再提醒', '全部不再提醒']
CHECK_ID = {'这个聊天不再提醒': 'chatfilesys-ip-mute-key', '全部不再提醒': 'chatfilesys-ip-mute-all'}

STATE_JS = """() => {
    const root = document.querySelector('.chatfilesys-import-prompt');
    const dlg = root ? root.closest('dialog[open]') : null;
    return {
        visible: Boolean(root && dlg),
        buttons: dlg ? [...dlg.querySelectorAll('.popup-button-custom')].map(b => b.textContent.trim()) : [],
        checkLabels: root ? [...root.querySelectorAll('.chatfilesys-ip-checks label')].map(l => l.innerText.trim()) : [],
        checked: root ? Object.fromEntries([...root.querySelectorAll('input[type=checkbox]')].map(x => [x.id, x.checked])) : {},
        text: root ? root.innerText.replace(/\\n+/g, ' | ') : null,
    };
}"""


def prompt_state(r):
    return r.js(STATE_JS)


def trigger(r):
    """清掉残留提醒 → 重放「打开聊天」→ 返回弹窗现场。"""
    r.dismiss_import_prompt()
    r.settle(300)
    r.fire_chat_changed()
    return prompt_state(r)


def no_prompt(r):
    """同一个动作，断言「这次不弹」。"""
    r.dismiss_import_prompt()
    r.settle(300)
    r.fire_chat_changed()
    return prompt_state(r)


def choose(r, button, checks=(), timeout=15000):
    """勾好小勾选 → 点某个按钮（按文案）→ 等弹窗关掉。"""
    for c in checks:
        n = r.js("""(id) => {
            const el = document.getElementById(id);
            if (!el) return 0;
            if (!el.checked) el.click();
            return el.checked ? 1 : 0;
        }""", CHECK_ID[c])
        if not n:
            raise AssertionError(f'勾选失败：{c}')
    n = r.js("""(t) => {
        const root = document.querySelector('.chatfilesys-import-prompt');
        const dlg = root ? root.closest('dialog[open]') : null;
        if (!dlg) return 0;
        const btn = [...dlg.querySelectorAll('.popup-button-custom')].find(b => b.textContent.trim() === t);
        if (!btn) return 0;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 1;
    }""", button)
    if not n:
        raise AssertionError(f'入库提醒弹窗里没有「{button}」')
    r.pg.wait_for_function("() => !document.querySelector('.chatfilesys-import-prompt')", timeout=timeout)
    r.settle(400)
    return True


OWN_X_SEL = '.chatfilesys-import-prompt .chatfilesys-ip-x'


def close_probe(r):
    """弹窗右上角的两个「关闭」控件：插件自己画的那个（应可见）/ 宿主自带的那个（TEXT 型恒藏）。

    `getClientRects()` 为空 = 元素或任一祖先 `display:none`（比只读 style 更严格）。
    """
    return r.js("""() => {
        const root = document.querySelector('.chatfilesys-import-prompt');
        const dlg = root ? root.closest('dialog[open]') : null;
        const own = root ? root.querySelector('.chatfilesys-ip-x') : null;
        const host = dlg ? dlg.querySelector('.popup-button-close') : null;
        const shown = (el) => Boolean(el) && el.getClientRects().length > 0;
        return { own: !!own, ownVisible: shown(own), host: !!host, hostVisible: shown(host) };
    }""")


def close_with(r, how, timeout=8000):
    """关窗：X = **插件自己画的那个**（真实可见元素的真实点击）；Esc = 键盘（路径不变）。"""
    assert prompt_state(r)["visible"], "预期提醒在场"
    if how == 'x':
        # 宿主对 TEXT 型弹窗一律先把自带的 .popup-button-close 置 display:none（真机那个 X 不存在），
        # 所以这里只能点我们在弹窗内容里画的那个 —— 用 Playwright 真点（不是 JS dispatch）
        r.pg.click(OWN_X_SEL, timeout=timeout)
    else:
        r.pg.keyboard.press("Escape")
    r.pg.wait_for_function("() => !document.querySelector('.chatfilesys-import-prompt')", timeout=timeout)
    r.settle(400)
    return True


def answer_confirm(r, expect, ok=False, timeout=60000):
    """回答导入旅程里的确认弹窗（按**文案认**弹窗，不靠弹窗个数——两问可能连着来）。"""
    r.pg.wait_for_function(
        """(t) => [...document.querySelectorAll('dialog[open]:not([closing])')]
            .some(d => d.innerText.includes(t))""",
        arg=expect, timeout=timeout)
    n = r.js("""([t, ok]) => {
        const d = [...document.querySelectorAll('dialog[open]:not([closing])')].find(x => x.innerText.includes(t));
        if (!d) return 0;
        const btn = d.querySelector(ok ? '.popup-button-ok' : '.popup-button-cancel');
        if (!btn) return 0;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 1;
    }""", [expect, bool(ok)])
    if not n:
        raise AssertionError(f'确认弹窗（{expect}）里没有要点的按钮')
    r.pg.wait_for_function(
        """(t) => ![...document.querySelectorAll('dialog[open]:not([closing])')]
            .some(d => d.innerText.includes(t))""",
        arg=expect, timeout=timeout)
    r.settle(400)
    return True


def set_mutes(r, prompt):
    """写压制记录 + **落盘**（冷启动用例整页重载，必须持久化才能复现真实设置）。"""
    r.set_import_prompt(prompt)
    r.js("() => { SillyTavern.getContext().saveSettingsDebounced(); return 'saved'; }")
    r.settle(500)


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "import-prompt")
        try:
            # T8 用例**不能**压掉提醒（唯一专门测它的用例）
            r.boot(mute_import_prompt=False)
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)

            # 现场复位：模式回出厂默认「JSONL 增强」；压制记录清空并落盘
            mode0 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null")
            if mode0 != 'off':
                r.set_storage_mode('off')
                r.close_popup()
            set_mutes(r, {"never": False, "mutedKeys": []})
            chat_a = r.new_chat()
            r.cmd("/send U-提醒前一条")
            r.settle(1200)
            key_a = r.chat_key()
            print("现场：", {"mode": mode0, "chatA": chat_a, "keyA": key_a})

            # ---------- ① W7 冷启动：整页重载也不重放任何事件，提醒自己弹出来 ----------
            r.pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            r.pg.wait_for_selector("#chatfilesys-entry", state="attached", timeout=60000)
            cold_text = None
            try:
                r.pg.wait_for_selector('.chatfilesys-import-prompt', state="attached", timeout=25000)
                cold_text = prompt_state(r)["text"]
            except Exception as e:
                cold_text = f'(未弹出: {e})'
            st_cold = r.state()
            ok1 = bool(cold_text) and not str(cold_text).startswith('(未弹出')
            results.append(report("① W7 冷启动（整页重载、零事件重放）就弹出提醒", ok1,
                                  f"当前聊天={st_cold['chatFile']} 弹窗={(str(cold_text) or '')[:80]}"))

            # ---------- ② W8 控件摆法 ----------
            ps = prompt_state(r)
            ok2 = (ps["visible"]
                   and set(ps["buttons"]) == set(MODES)
                   and ps["checkLabels"] == CHECK_LABELS
                   and list(ps["checked"].keys()) == [CHECK_ID[CHECK_LABELS[0]], CHECK_ID[CHECK_LABELS[1]]]
                   and all(v is False for v in ps["checked"].values())
                   and '纯库' in (ps["text"] or ''))
            results.append(report("② 控件 = 两个模式短按钮 + 「不入库」+ 两个小勾选（默认都不勾）", ok2,
                                  f"buttons={ps['buttons']} checks={ps['checkLabels']} checked={ps['checked']}"))

            # ---------- ③ 「不入库」= 本次不转 ----------
            assert prompt_state(r)["visible"], "预期提醒在场"
            choose(r, '不入库')
            r.settle(600)
            mode1 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode")
            p1 = r.get_import_prompt()
            ok3a = mode1 == 'off' and p1 == {"never": False, "mutedKeys": []}
            results.append(report("③-1 「不入库」：不转模式、不留压制记录", ok3a, f"mode={mode1} prompt={p1}"))
            r.cmd("/send U-不入库后照聊")
            r.settle(1000)
            st3 = r.state()
            ok3b = st3["chatLen"] == 3 and st3["domMes"] == 3
            results.append(report("③-2 关掉提醒后聊天照常可用（发一条消息，前台渲染同步）", ok3b,
                                  f"chatLen={st3['chatLen']} domMes={st3['domMes']}"))

            # ---------- ④ 关窗 = 「不入库」（X / Esc 两条） ----------
            ps = trigger(r)
            assert ps["visible"], "预期提醒在场"
            cp4 = close_probe(r)          # 点之前先取证：两个关闭控件各自可见吗
            close_with(r, 'x')
            p4a = r.get_import_prompt()
            fam4 = r.read_family(key_a)   # 真的没入库（不是只看模式）
            mode4a = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode")
            ok4a = (cp4["ownVisible"] and not cp4["hostVisible"] and fam4 is None
                    and mode4a == 'off' and p4a == {"never": False, "mutedKeys": []})
            results.append(report("④-1 插件自己画的 X（宿主自带的对 TEXT 弹窗不可见）关窗 = 不入库（不写压制、没入库）",
                                  ok4a, f"关闭控件={cp4} 家族={fam4} mode={mode4a} prompt={p4a}"))

            ps = trigger(r)
            assert ps["visible"], "预期提醒在场"
            close_with(r, 'esc')
            p4b = r.get_import_prompt()
            results.append(report("④-2 Esc 关窗 = 不入库（同上）",
                                  p4b == {"never": False, "mutedKeys": []}, f"prompt={p4b}"))

            # ---------- ⑤ 勾「这个聊天不再提醒」+ 不入库 ----------
            ps = trigger(r)
            assert ps["visible"], "预期提醒在场"
            choose(r, '不入库', checks=['这个聊天不再提醒'])
            r.settle(600)
            p5 = r.get_import_prompt() or {}
            ok5a = p5.get("mutedKeys") == [key_a] and p5.get("never") is False
            results.append(report("⑤-1 「这个聊天不再提醒」只把该键记进 mutedKeys", ok5a, f"prompt={p5}"))
            ps5 = no_prompt(r)
            results.append(report("⑤-2 该聊天不再弹", not ps5["visible"], f"visible={ps5['visible']}"))

            chat_b = r.new_chat()
            key_b = r.chat_key()
            ps5c = no_prompt(r)
            results.append(report("⑤-3 别的聊天照弹（压制只作用于该键）", ps5c["visible"] and chat_b != chat_a,
                                  f"chatB={chat_b} keyB={key_b} visible={ps5c['visible']}"))

            # ---------- ⑥ 勾「全部不再提醒」+ 不入库 ----------
            ps = trigger(r)
            assert ps["visible"], "预期提醒在场"
            choose(r, '不入库', checks=['全部不再提醒'])
            r.settle(600)
            p6 = r.get_import_prompt() or {}
            ok6a = p6.get("never") is True
            results.append(report("⑥-1 「全部不再提醒」置 never=true", ok6a, f"prompt={p6}"))
            ps6b = no_prompt(r)
            chat_c = r.new_chat()
            ps6c = no_prompt(r)
            ok6b = (not ps6b["visible"]) and (not ps6c["visible"]) and chat_c not in (chat_a, chat_b)
            results.append(report("⑥-2 一律不弹（含从未弹过的新聊天）", ok6b,
                                  f"老键 visible={ps6b['visible']} 新聊天 {chat_c} visible={ps6c['visible']}"))

            # ---------- ⑦ 「纯库」按钮：真的切纯库 + 真的入库 ----------
            set_mutes(r, {"never": False, "mutedKeys": []})
            chat_d = r.new_chat()
            r.cmd("/send U-纯库入库前一条")
            r.settle(1200)
            key_d = r.chat_key()
            ps = trigger(r)
            assert ps["visible"], f"预期提醒在场（chatD={chat_d}）"
            choose(r, '纯库')
            # 纯库：源文件本来要删 → 保留 PARDON 删除确认（选取消 = 保留源文件）
            q1 = answer_confirm(r, '删除源 jsonl 文件', ok=False)
            r.settle(3500)
            mode7 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode")
            fam_d = r.read_family(key_d)
            floors_d = (fam_d or {}).get("floorRows")
            # chatD = 开场语 1 层 + 「U-纯库入库前一条」1 层
            ok7 = (mode7 == 'pure') and bool(fam_d) and floors_d == 2
            results.append(report("⑦ 「纯库」按钮 → 切纯库 + 真的入库（库里有家族、楼层数对齐）", ok7,
                                  f"mode={mode7} floors={floors_d} 确认={str(q1)[:40]} "
                                  f"familyId={(fam_d or {}).get('familyId')}"))
            ps7 = no_prompt(r)
            results.append(report("⑦-2 入库后同一聊天不再弹（它已经是库里的家族）", not ps7["visible"],
                                  f"visible={ps7['visible']}"))

            # ---------- ⑧ 「双写」按钮：切双写 + 入库 + 磁盘文件保留 ----------
            # 从**出厂默认（增强）**出发才是这条按钮的真实入口：库模式下的新聊天会被
            # `onChatCreated` 即时建档、不该再弹提醒（见 index.js#schedulePromptImport）。
            r.set_storage_mode('off')
            r.close_popup()
            r.settle(1500)
            chat_e = r.new_chat()
            r.cmd("/send U-双写入库前一条")
            r.settle(1200)
            key_e = r.chat_key()
            ps = trigger(r)
            assert ps["visible"], f"预期提醒在场（chatE={chat_e}）"
            choose(r, '双写')
            r.settle(4000)   # 双写不问两问（源文件保留、无删除动作）
            mode8 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode")
            fam_e = r.read_family(key_e)
            floors_e = (fam_e or {}).get("floorRows")
            on_disk = r.js("""async (fn) => {
                const ctx = SillyTavern.getContext();
                const char = ctx.characters[ctx.characterId];
                const res = await fetch('/api/chats/search', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ query: '', avatar_url: char.avatar }),
                });
                if (!res.ok) return 'http-' + res.status;
                return (await res.json()).map(x => x.file_name).filter(n => n.startsWith(fn));
            }""", chat_e)
            ok8 = (mode8 == 'mirror') and bool(fam_e) and floors_e == 2 and bool(on_disk)
            st8 = r.state()
            results.append(report("⑧ 「双写」按钮 → 切双写 + 入库 + 磁盘聊天文件保留", ok8,
                                  f"mode={mode8} floors={floors_e} host层数={st8['chatLen']} 磁盘文件={on_disk}"))

            # ---------- ⑨ 压制记录不写进聊天记录 ----------
            in_chat = r.js("""() => {
                const md = SillyTavern.getContext().chatMetadata || {};
                return { top: md.import_prompt ?? null,
                         ext: md.extensions?.chatfilesys?.import_prompt ?? null };
            }""")
            ok9 = in_chat.get("top") is None and in_chat.get("ext") is None
            results.append(report("⑨ 压制记录不写进聊天记录（聊天头里没有它）", ok9, str(in_chat)))

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
            try:
                # 恢复出厂默认（增强模式）再删测试角色——见 test_main_branch.py 同处的说明
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在库模式）: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            try:
                # 压制记录恢复**出厂值**（不压任何东西）并落盘：T8 是「强制弹出」的引导，
                # 若被测试留成 never=true，人工验证这个功能时会看不到弹窗。
                set_mutes(r, {"never": False, "mutedKeys": []})
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nIMPORT PROMPT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
