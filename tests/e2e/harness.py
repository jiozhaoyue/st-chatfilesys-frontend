"""chatfilesys e2e harness —— 驱动宿主 Luker 实例（8003）真实浏览器实测。

隔离原则：只操作自建测试角色（前缀 __cb_e2e），末尾清理；绝不触碰既有角色与聊天。

**跑法：`PYTHONIOENCODING=utf-8 python tests/e2e/<用例>.py`** —— Windows 控制台默认 GBK，
用例断言明细里带 `⎇`（版本按钮形状）等非 GBK 字符，不设这个环境变量会以
`UnicodeEncodeError` 崩在打印断言那一行（不是用例失败，是编码崩；2026-09-26 踩过）。
"""
import time
from playwright.sync_api import sync_playwright

BASE = "https://127.0.0.1:8003"
TEST_CHAR = "__cb_e2e"

# 二期 UI：复杂 UI 宿主 = 管理弹窗。
# R5（2026-09-25 重裁定）后入口 = 输入框上方工具图标排里的插件按钮（`#chatfilesys-entry`）+ Alt+B；
# 扩展设置抽屉零注入（settings.html 已删除）、`/cb` 已删除。
# PANEL = 弹窗内容根；click_action / panel_text / ensure_active 会自动确保弹窗打开（对测试透明）。
ENTRY = "#chatfilesys-entry"
POPUP_DIALOG = 'dialog[open]:not([closing]) .chatfilesys-popup'
PANEL = POPUP_DIALOG
# 注意：Popup 模板对非 INPUT/非 CONFIRM 类型也保留隐藏的 .popup-input/.popup-button-ok，
# 子弹窗选择器必须限定「最上层 dialog」（:last-of-type），否则会匹配管理弹窗的隐藏控件而超时。
TOPDLG = 'dialog[open]:not([closing]):last-of-type'

EXT_SRC = "/scripts/extensions/third-party/chatfilesys"

# T8：入库提醒的压制记录（写成 `never: true` = 一律不弹）。只有专门测它的用例传 False / 不调它。
MUTE_IMPORT_PROMPT_JS = """() => {
    const s = SillyTavern.getContext().extensionSettings;
    s.chatfilesys = s.chatfilesys || {};
    s.chatfilesys.import_prompt = { never: true, mutedKeys: [] };
    return 'muted';
}"""


def mute_import_prompt(page, timeout=40000):
    """给裸 page 用（不走 `Runner.boot` 的用例：它们自己 goto / 自己装接缝）。

    **必须重试**：宿主启动时用 `Object.assign(extension_settings, settings.extension_settings)`
    **整份顶掉**外部早写进去的键（`settings.json` 里没有 `import_prompt` 这一项），
    所以在「页面刚起来」的窗口里写会被清掉。做法 = 等「扩展已就绪（入口按钮在场）+
    角色列表已载入」这两个启动完成信号 → 写 → 复核，留不住就再写。
    """
    end = time.time() + timeout / 1000
    last = 'unknown'
    while time.time() < end:
        try:
            page.wait_for_selector(ENTRY, state="attached", timeout=8000)
            page.wait_for_function(
                "() => (SillyTavern.getContext().characters || []).length > 0", timeout=8000)
            last = page.evaluate(MUTE_IMPORT_PROMPT_JS)
            page.wait_for_timeout(800)
            if page.evaluate("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.import_prompt?.never === true"):
                return 'muted'
            last = 'clobbered'
        except Exception as e:
            last = f'failed: {e}'
            break
    print(f"  [warn] 压制入库提醒未确认（{last}）——用例需自己处理弹窗")
    return last


# 建测试角色的页内脚本（**单点**：`Runner.create_test_char` 与模块级 `reset_instance` 共用）。
# 建完顺带刷一次 `ctx.getCharacters()`——否则刚建的角色不在内存列表里，调用方按名字查不到。
CREATE_TEST_CHAR_JS = """async (name) => {
    const ctx = SillyTavern.getContext();
    const headers = ctx.getRequestHeaders();
    delete headers['Content-Type'];
    const fd = new FormData();
    fd.append('ch_name', name);
    fd.append('file_name', name);
    fd.append('description', 'chatfilesys e2e 临时测试角色');
    fd.append('first_mes', '开场问候语（F1）');
    const res = await fetch('/api/characters/create', { method: 'POST', headers, body: fd });
    const body = res.ok ? await res.text() : null;
    await ctx.getCharacters();
    return { status: res.status, avatar: body };
}"""

HAS_TEST_CHAR_JS = """(name) => (SillyTavern.getContext().characters || []).some((c) => c.name === name)"""


DELETE_TEST_CHAR_JS = """async (name) => {
    const ctx = SillyTavern.getContext();
    const res = await fetch('/api/characters/delete', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: `${name}.png`, delete_chats: true }),
    });
    await ctx.getCharacters();
    return { status: res.status };
}"""

# 复位到「独立风格用例」需要的出厂设置：增强模式 + 一律不弹入库提醒。
RESET_SETTINGS_JS = """() => {
    const s = SillyTavern.getContext().extensionSettings;
    s.chatfilesys = s.chatfilesys || {};
    s.chatfilesys.storage_mode = 'off';
    s.chatfilesys.import_prompt = { never: true, mutedKeys: [] };
    return 'reset';
}"""

RUN_SLASH_JS = """async (c) => {
    const ctx = SillyTavern.getContext();
    await ctx.executeSlashCommandsWithOptions(c, { handleExecutionErrors: true });
    return 'ok';
}"""

# 把 extension_settings 落盘（宿主 boot 时用 settings.json 里的值整份顶掉内存里的那份）。
PERSIST_SETTINGS_JS = """() => { SillyTavern.getContext().saveSettingsDebounced(); return 'saved'; }"""


def reset_instance(page, timeout=120000):
    """给裸 page 用（独立风格用例）：把实例复位到**干净起点**，返回 'reset'。

    为什么必须有这一步（2026-09-26 实测定性的三类失败，同源）：
      ① 存储模式被前一条用例留在 pure/mirror → 新聊天的家族**只写库**、内存副本要重载才有；
      ② 测试角色已存在 → `/api/characters/create` 行为不可预期，且它的 `.chat` 指向**旧聊天**，
         而那个旧聊天可能已被前一条用例绑了家族 → 本用例按 `target.chat` 播的家族与之冲突，
         接缝按旧家族投影（多出楼层、变体号对不上，实测报 `projection-incomplete｜楼层 4 的变体 g4
         在库中无行`）；角色刚建、无聊天时 `.chat` 为空，同样取不到键；
      ③ 入库提醒弹窗在启动窗口弹出挡住后续交互。
    做法 = 等扩展就绪 + 角色列表载入 → 写设置并**复核**（宿主启动会用 `Object.assign` 把
    外部早写的键整份顶掉）→ 删角色（`delete_chats`，连聊天一起）→ 建角色 → `/go` 选中
    → `/newchat` 拿到一个**全新且无家族**的聊天键。
    """
    end = time.time() + timeout / 1000
    confirmed = False
    while time.time() < end:
        try:
            page.wait_for_selector(ENTRY, state="attached", timeout=15000)
            page.wait_for_function(
                "() => (SillyTavern.getContext().characters || []).length > 0", timeout=15000)
            page.evaluate(RESET_SETTINGS_JS)
            page.wait_for_timeout(800)
            if page.evaluate(
                    "() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode === 'off'"):
                confirmed = True
                break
        except Exception:
            continue
    if not confirmed:
        print("  [warn] 实例设置未确认复位（storage_mode / 压制记录）——用例可能读到脏状态")
        return 'settings-unconfirmed'

    page.evaluate(DELETE_TEST_CHAR_JS, TEST_CHAR)
    page.wait_for_timeout(600)
    page.evaluate(CREATE_TEST_CHAR_JS, TEST_CHAR)
    page.wait_for_function(HAS_TEST_CHAR_JS, arg=TEST_CHAR, timeout=30000)
    page.evaluate(RUN_SLASH_JS, f"/go {TEST_CHAR}")
    page.wait_for_function(
        "(n) => SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name === n",
        arg=TEST_CHAR, timeout=30000)
    page.evaluate(RUN_SLASH_JS, "/newchat")
    page.wait_for_timeout(2500)
    # 落盘设置后**重载页面**：宿主 boot 时没有角色被选中，于是用例自己那步「打开角色」才是
    # **一次真正的角色切换** → 宿主才 `getChat()` → 发 `chats/get` → 接缝有机会服务。
    # 真机事实（2026-09-26 实测，宿主 `script.js:2374`）：`selectCharacterById(id)` 只在
    # `String(this_chid) !== String(id)` 时才 `getChat()`，已在同一角色上时是**空操作**。
    page.evaluate(PERSIST_SETTINGS_JS)
    page.wait_for_timeout(800)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
    page.wait_for_selector(ENTRY, state="attached", timeout=60000)
    page.wait_for_function(
        "() => (SillyTavern.getContext().characters || []).length > 0", timeout=60000)
    page.wait_for_timeout(1500)
    return 'reset'


class Runner:
    def __init__(self, page, label=""):
        self.pg = page
        self.label = label
        self.logs = []          # (type, text, src_url)
        self.errors = []        # pageerror: str(stack)
        self.failed_reqs = []   # (url, failure)
        def on_console(m):
            src = (m.location or {}).get("url", "") or ""
            self.logs.append((m.type, m.text[:400], src))
        def on_pageerror(e):
            self.errors.append(str(e))
        def on_reqfail(req):
            self.failed_reqs.append((req.url[:200], req.failure))
        page.on("console", on_console)
        page.on("pageerror", on_pageerror)
        page.on("requestfailed", on_reqfail)

    # ---------- 基础 ----------
    def boot(self, timeout=120000, mute_import_prompt=True):
        """启动页面。`mute_import_prompt=True`（默认）先压掉 T8 入库提醒弹窗。

        为什么要默认压掉：T8 起「打开一个尚未入库的聊天」会弹提醒（用户 2026-09-26 明令「强制弹出」），
        而 Dev 实例默认是 JSONL 增强模式（库里什么都没有）→ 每个聊天打开都会弹一个模态窗，
        挡住其它用例要点的控件。**只有专门测这个弹窗的用例**（`test_import_prompt.py`）传 False。
        """
        self.pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        self.pg.wait_for_selector("#send_textarea", state="attached", timeout=timeout)
        # R5：入口 = 输入框上方工具图标排里的插件按钮（扩展设置抽屉零注入、/cb 已删）
        self.pg.wait_for_selector(ENTRY, state="attached", timeout=timeout)
        if mute_import_prompt:
            self.mute_import_prompt(timeout=timeout)
            self.dismiss_import_prompt(timeout=5000)   # 兜底：启动窗口里可能已经弹过一次
        return self

    def mute_import_prompt(self, timeout=40000):
        """把 T8 入库提醒的压制记录写进 extension_settings（`never: true`）——见模块级同名函数。"""
        return mute_import_prompt(self.pg, timeout=timeout)

    def js(self, expr, arg=None):
        return self.pg.evaluate(expr, arg)

    def cmd(self, command):
        """执行 slash 命令并等待完成。"""
        return self.pg.evaluate(
            """async (c) => {
                const ctx = SillyTavern.getContext();
                const r = await ctx.executeSlashCommandsWithOptions(c, { handleExecutionErrors: true });
                return r && r.pipe !== undefined ? String(r.pipe) : 'ok';
            }""",
            command,
        )

    # ---------- 状态读取 ----------
    def model(self):
        return self.js("""() => {
            const m = SillyTavern.getContext().chatMetadata?.extensions?.chatfilesys;
            return m ? JSON.parse(JSON.stringify(m)) : null;
        }""")

    def state(self):
        return self.js("""() => {
            const ctx = SillyTavern.getContext();
            const m = ctx.chatMetadata?.extensions?.chatfilesys || null;
            const active = m ? m.branches.find(b => b.id === m.active_branch) : null;
            return {
                chatLen: (ctx.chat || []).length,
                domMes: document.querySelectorAll('#chat .mes').length,
                branches: m ? m.branches.map(b => ({
                    id: b.id, name: b.name, fork: b.fork_base,
                    floors: Object.keys(b.path).length,
                    path: b.path,
                })) : null,
                activeId: m ? m.active_branch : null,
                activeFloors: active ? Object.keys(active.path).length : 0,
                groups: m ? Object.keys(m.groups || {}).length : 0,
                chatFile: ctx.getCurrentChatId ? ctx.getCurrentChatId() : null,
                charName: ctx.characters?.[ctx.characterId]?.name ?? null,
                mesTexts: (ctx.chat || []).map(x => `${x.is_user ? 'U' : 'A'}:${(x.mes||'').slice(0,24)}`),
            };
        }""")

    def panel_text(self):
        self.ensure_popup()
        return self.js(f"""() => {{
            const c = document.querySelector('{PANEL}');
            return c ? c.innerText.replace(/\\n+/g, ' | ').slice(0, 2400) : null;
        }}""")

    # ---------- 弹窗交互（唯一界面 = 管理弹窗） ----------
    def open_popup(self, timeout=15000):
        """点入口按钮打开管理弹窗（R5：入口 = 工具图标排里的插件按钮）。"""
        self.js("""() => {
            const b = document.querySelector('#chatfilesys-entry');
            if (!b) return 'no-entry';
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'clicked';
        }""")
        self.pg.wait_for_selector(POPUP_DIALOG, timeout=timeout)
        self.pg.wait_for_timeout(300)
        return self

    def ensure_popup(self, timeout=15000):
        """确保管理弹窗打开（入口按钮；缺失时退回 Alt+B）。幂等。"""
        if self.pg.query_selector(POPUP_DIALOG):
            return self
        try:
            self.open_popup(timeout=timeout)
        except Exception:
            print("  [warn] 入口按钮未打开弹窗，退回 Alt+B")
            self.js("""() => document.dispatchEvent(new KeyboardEvent('keydown', {
                altKey: true, code: 'KeyB', key: 'b', bubbles: true }))""")
            self.pg.wait_for_selector(POPUP_DIALOG, timeout=timeout)
            self.pg.wait_for_timeout(300)
        return self

    def close_popup(self, timeout=8000):
        """关闭管理弹窗——**必须走宿主自己的关闭路径**。

        DISPLAY 型弹窗可见的关闭控件 = `.popup-button-close`（`data-result="0"`）；点它 →
        宿主 `Popup#complete` → `#hide` → 关动画结束后 `dlg.close()` + `dlg.remove()`，
        弹窗节点从 DOM 彻底消失。

        2026-09-26 实测教训：早期版本这里用的是「`.popup-close` / `button[class*="close"]` 都点不到，
        最后回落 `dlg.close()`」——而 `.popup-close` 在宿主模板里**根本不存在**、关闭按钮是 div 不是
        button，于是每次都走 `dlg.close()`，绕过 `#hide` 的 DOM 清理，每开一次在 body 里留一份
        `.chatfilesys-popup` 残骸（实测连开 3 次 = 3 份），把 ③/④-1 断言判成「插件残留」。
        取证脚本：`tests/e2e/probe_popup_residue.py`。

        收尾等「页面里本插件弹窗节点数归零」——这正是 ③/③b 断言的量，不再靠 sleep 猜。
        """
        self.js("""() => {
            const dlgs = [...document.querySelectorAll('dialog')]
                .filter(d => d.querySelector('.chatfilesys-popup'));
            const dlg = dlgs.find(d => d.open) || dlgs[0];
            if (!dlg) return 'no-popup';
            const btn = dlg.querySelector('.popup-button-close');
            if (!btn) return 'no-close-button';
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'closing';
        }""")
        self.pg.wait_for_function(
            "() => document.querySelectorAll('.chatfilesys-popup').length === 0", timeout=timeout)
        return self

    def popup_switch_tab(self, label, timeout=5000):
        """切换管理弹窗 Tab（renderLukerTabs: .luker-tabs-tab；内置降级: [data-tabbtn]）。"""
        self.ensure_popup()
        n = self.js(
            """(k) => {
                const root = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup');
                if (!root) return 0;
                const btn = [...root.querySelectorAll('.luker-tabs-tab, [data-tabbtn]')]
                    .find(x => x.textContent.trim() === k);
                if (!btn) return 0;
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 1;
            }""",
            label,
        )
        self.pg.wait_for_timeout(400)
        if not n:
            raise AssertionError(f"Tab 未找到: {label}")
        return self

    def open_panel_drawer(self):
        """兼容旧名：现在等价于「打开管理弹窗」。"""
        return self.ensure_popup()

    def click_action(self, action, *, branch=None, floor=None, file=None, nth=0):
        """原子点击：选择器在页面内同 tick 解析并 click，避免面板重渲染产生游离节点竞态。
        弹窗未打开时自动先开（对测试透明）。`file` = 「角色卡的聊天」页签里那行的 data-file。"""
        self.ensure_popup()
        sel = f'{PANEL} [data-action="{action}"]'
        if branch is not None:
            sel += f'[data-branch="{branch}"]'
        if floor is not None:
            sel += f'[data-floor="{floor}"]'
        if file is not None:
            sel += f'[data-file="{file}"]'
        n = self.js(
            """([s, i]) => { const els = document.querySelectorAll(s);
                 if (!els.length) return 0;
                 // SVG 节点（图形树）没有 .click()，统一用事件分发
                 els[Math.min(i, els.length - 1)].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                 return els.length; }""",
            [sel, nth],
        )
        if not n:
            raise AssertionError(f"未找到面板按钮: {sel}")
        return self

    def pick_branch(self, branch_id):
        """在「当前聊天」页签的分支选择器里选中一条分支（= 管理按钮的作用对象）。

        R5（2026-09-25）后「改名 / 删除分支 / AI 总结」三个按钮共用一个
        `[data-role="branch-picker"]` 选择器，按钮上的 `data-branch` 跟随选择器的选中值
        （`ui/popup.js#syncBranchRefs`）——所以不能直接按 `data-branch` 找特定分支的按钮，
        必须先在选择器里选中目标分支。选择器只用于「选管理对象」，不负责切换分支
        （切换分支是结构树上 `data-action="switch"` 的节点）。
        """
        self.ensure_popup()
        n = self.js("""([sel, id]) => {
            const s = document.querySelector(sel);
            if (!s) return 0;
            if (![...s.options].some((o) => o.value === id)) return 0;
            s.value = id;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return 1;
        }""", [f'{PANEL} [data-role="branch-picker"]', branch_id])
        self.pg.wait_for_timeout(150)
        if not n:
            raise AssertionError(f"分支选择器里没有 {branch_id}（是否弹窗未打开/分支已删？）")
        return self

    # ---------- 结构操作（R5 后插件不再提供「新建分支 / 删层」按钮，测试走数据层） ----------

    def create_branch(self, floor, name=None, activate=False):
        """建分支（数据层直建），返回新分支 id。

        R5（2026-09-25）后**生产路径的新建入口 = 宿主原生「创建分支 / 创建检查点」**
        （纯库/双写走 T1 接管，增强模式走原生书签收编）；插件不再提供任何新建按钮。
        测试需要精确控制分叉楼层，故直接调 `core/branches.js#createBranch` 写模型，
        调用方随后用 `ensure_active(id)` 走 UI 切换（等价于已删除的「分叉并切换」）。
        """
        return self.js("""async ([src, fl, nm, act]) => {
            const ctx = SillyTavern.getContext();
            const mod = await import(src + '/core/branches.js');
            const m = ctx.chatMetadata.extensions.chatfilesys;
            if (!m) throw new Error('未启用分支');
            const b = mod.createBranch(m, { name: nm, forkFloor: fl, activate: act });
            const md = { ...(ctx.chatMetadata || {}) };
            md.extensions = { ...(md.extensions || {}), chatfilesys: m };
            ctx.chatMetadata = md;
            ctx.chatMetadata.tainted = true;
            await ctx.saveMetadata();
            return b.id;
        }""", [EXT_SRC, floor, name or f"分叉·F{floor}", activate])

    def delete_floor(self, floor):
        """全局删层（数据层重放），返回 operations 条数。

        R5（2026-09-25）：删消息的入口是**宿主原生按钮**，插件的删层动作已删除。
        测试仍要覆盖「全局删层」的库语义（三档 patch-rows），故按已删除实现的同一条路径重放：
        `planDeleteFloor` → ops → 官方消息 API（deleteMessages 批量）。
        """
        return self.js("""async ([src, fl]) => {
            const ctx = SillyTavern.getContext();
            const m = ctx.chatMetadata.extensions.chatfilesys;
            if (!m) throw new Error('未启用分支');
            const proj = await import(src + '/core/projection.js');
            const wmod = await import(src + '/core/chat-writer.js');
            const { operations } = proj.planDeleteFloor(m, fl, ctx.chat);
            const md = { ...(ctx.chatMetadata || {}) };
            md.extensions = { ...(md.extensions || {}), chatfilesys: m };
            ctx.chatMetadata = md;
            ctx.chatMetadata.tainted = true;
            const w = wmod.createChatWriter({
                deleteMessages: (i, o) => ctx.deleteMessages(i, o),
                addMessages: (x, o) => ctx.addMessages(x, o),
                updateMessages: (u, o) => ctx.updateMessages(u, o),
            });
            await w.applyOperations(operations);
            await ctx.saveMetadata();
            return operations.length;
        }""", [EXT_SRC, floor])

    def ensure_active(self, branch_id, tries=4, settle_ms=1600):
        """点击切换并轮询确认 active_branch，未生效则重试（对重渲染竞态自愈）。"""
        for i in range(tries):
            try:
                self.click_action("switch", branch=branch_id)
            except AssertionError:
                if i == tries - 1:
                    raise
                self.settle(600)  # 面板重渲染窗口，稍后重试
                continue
            self.settle(settle_ms)
            st = self.state()
            if st["activeId"] == branch_id:
                return st
            print(f"  [retry] switch->{branch_id} 未生效(第{i+1}次): active={st['activeId']}")
        raise AssertionError(f"切换到 {branch_id} 重试 {tries} 次仍失败")

    def popup_input(self, value, timeout=8000):
        self.pg.wait_for_selector(TOPDLG + " .popup-input", timeout=timeout)
        self.pg.fill(TOPDLG + " .popup-input", value)
        n = self._dlg_count()
        self.pg.click(TOPDLG + " .popup-button-ok")
        self.pg.wait_for_function(
            f"() => document.querySelectorAll('dialog[open]:not([closing])').length < {n}",
            timeout=timeout)
        return self

    def popup_ok(self, timeout=8000):
        self.pg.wait_for_selector(TOPDLG + " .popup-button-ok", timeout=timeout)
        n = self._dlg_count()
        self.pg.click(TOPDLG + " .popup-button-ok")
        self.pg.wait_for_function(
            f"() => document.querySelectorAll('dialog[open]:not([closing])').length < {n}",
            timeout=timeout)
        return self

    def popup_cancel(self, timeout=8000):
        self.pg.wait_for_selector(TOPDLG + " .popup-button-cancel", timeout=timeout)
        n = self._dlg_count()
        self.pg.click(TOPDLG + " .popup-button-cancel")
        self.pg.wait_for_function(
            f"() => document.querySelectorAll('dialog[open]:not([closing])').length < {n}",
            timeout=timeout)
        return self

    def _dlg_count(self):
        return self.pg.evaluate("() => document.querySelectorAll('dialog[open]:not([closing])').length")

    def popup_text(self, timeout=8000):
        """等待弹窗出现并返回其文本（不关闭）。"""
        el = self.pg.wait_for_selector("dialog[open]:not([closing])", timeout=timeout)
        return el.inner_text()[:300]

    def file_exists_on_server(self, file_name):
        """GET 200 不代表存在（不存在也回 200+{new_chat:true}），必须看 body 形态。"""
        return self.js("""async (fn) => {
            const ctx = SillyTavern.getContext();
            const char = ctx.characters[ctx.characterId];
            const res = await fetch('/api/chats/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ ch_name: char.name, file_name: fn, avatar_url: char.avatar }),
            });
            if (!res.ok) return `http-${res.status}`;
            const data = await res.json();
            if (Array.isArray(data)) return 'exists';
            if (data?.new_chat) return 'missing';
            if (data?.corrupted) return 'corrupted';
            return `other-${JSON.stringify(data).slice(0, 60)}`;
        }""", file_name)

    def fire_native_branch(self, mes_id):
        """发射原生 createBranch 但不 await——emit 会等所有监听器（含本扩展弹窗），
        若在此处 await 会死锁。promise 存 window 供后续选择性读取。"""
        return self.js("""(mesId) => {
            window.__cbBranchPromise = import('/scripts/bookmarks.js').then(m => m.createBranch(mesId))
                .catch(e => 'ERR:' + (e?.message || e));
            return 'fired';
        }""", mes_id)

    def popup_branch_name(self, timeout=15000):
        """等收编弹窗并从文本提取原生书签文件名。"""
        txt = self.popup_text(timeout)
        import re
        m = re.search(r"「(.+?)」", txt)
        return m.group(1) if m else None

    def branch_promise_settled(self, timeout=20000):
        """轮询读取 createBranch 的最终返回值（可能因后续监听器挂起而超时）。"""
        import time
        end = time.time() + timeout / 1000
        while time.time() < end:
            v = self.js("() => window.__cbBranchState ?? null")
            if v is not None:
                return v
            self.pg.wait_for_timeout(400)
        return None

    def arm_branch_promise_capture(self):
        """把 promise 的 settle 结果镜像到 window.__cbBranchState（不阻塞）。"""
        self.js("""() => {
            if (window.__cbBranchPromise && !window.__cbBranchCaptured) {
                window.__cbBranchCaptured = true;
                window.__cbBranchPromise.then(v => { window.__cbBranchState = v; })
                    .catch(e => { window.__cbBranchState = 'ERR:' + e; });
            }
            return 'armed';
        }""")

    def settle(self, ms=1200):
        self.pg.wait_for_timeout(ms)
        return self

    def wait_state(self, fn, timeout=25000, interval=350, desc=""):
        """轮询 state() 直到 fn(st) 为真；超时抛错并携带最后一次状态。"""
        import time as _t
        end = _t.time() + timeout / 1000
        last = None
        while _t.time() < end:
            last = self.state()
            try:
                if fn(last):
                    return last
            except Exception:
                pass
            self.pg.wait_for_timeout(interval)
        raise TimeoutError(f"wait_state 超时({desc}): last={ {k: last[k] for k in ('chatLen','domMes','activeId','activeFloors') if last and k in last} }")

    def wait_disk(self, fn, timeout=25000, interval=500, desc=""):
        import time as _t
        end = _t.time() + timeout / 1000
        last = None
        while _t.time() < end:
            last = self.disk_state()
            try:
                if fn(last):
                    return last
            except Exception:
                pass
            self.pg.wait_for_timeout(interval)
        raise TimeoutError(f"wait_disk 超时({desc}): last={str(last)[:300]}")

    def toastr_error(self, timeout=5000):
        """等待并返回 toastr 错误文本（无则 None）。"""
        try:
            el = self.pg.wait_for_selector("#toast-container .toast-error", timeout=timeout)
            return el.inner_text()[:120]
        except Exception:
            return None

    def toastr_success_text(self, timeout=5000):
        try:
            el = self.pg.wait_for_selector("#toast-container .toast-success", timeout=timeout)
            return el.inner_text()[:120]
        except Exception:
            return None

    def new_chat(self):
        """新建聊天（自动建家族）。返回新文件名。"""
        self.cmd("/newchat")
        self.settle(2500)
        return self.state()["chatFile"]

    # ---------- 落盘校验 ----------
    def disk_state(self):
        """从服务端重新拉取聊天文件，校验落盘内容（而非仅内存）。"""
        return self.js("""async () => {
            const ctx = SillyTavern.getContext();
            const headers = ctx.getRequestHeaders();
            const res = await fetch('/api/chats/get', {
                method: 'POST', headers,
                body: JSON.stringify({
                    ch_name: ctx.characters[ctx.characterId].name,
                    file_name: ctx.getCurrentChatId(),
                    avatar_url: ctx.characters[ctx.characterId].avatar,
                }),
            });
            if (!res.ok) return { error: res.status };
            const data = await res.json();
            const header = Array.isArray(data) ? data[0] : null;
            const lines = Array.isArray(data) ? data.slice(1) : [];
            const m = header?.chat_metadata?.extensions?.chatfilesys || null;
            return {
                bodyLen: lines.length,
                bodyTexts: lines.map(x => `${x.is_user ? 'U' : 'A'}:${(x.mes||'').slice(0,24)}`),
                branches: m ? m.branches.map(b => ({ id: b.id, name: b.name, fork: b.fork_base, floors: Object.keys(b.path).length, path: b.path })) : null,
                activeId: m ? m.active_branch : null,
                groups: m ? Object.keys(m.groups || {}).length : 0,
            };
        }""")

    # ---------- 测试角色管理 ----------
    def create_test_char(self):
        return self.js(CREATE_TEST_CHAR_JS, TEST_CHAR)

    def delete_test_char(self):
        return self.js(DELETE_TEST_CHAR_JS, TEST_CHAR)

    def open_test_char(self, timeout=30000):
        """刷新角色列表 → 选中测试角色 → 新聊天。"""
        self.js("""async (name) => {
            const ctx = SillyTavern.getContext();
            await ctx.getCharacters();
            const idx = ctx.characters.findIndex(c => c.name === name);
            if (idx < 0) throw new Error('测试角色未出现在列表: ' + name);
            return idx;
        }""", TEST_CHAR)
        self.cmd(f"/go {TEST_CHAR}")
        self.pg.wait_for_function(
            """(n) => SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name === n""",
            arg=TEST_CHAR, timeout=timeout,
        )
        return self

    # ---------- T8 入库提醒弹窗（R8.1 / AC21） ----------

    IMPORT_PROMPT_SEL = '.chatfilesys-import-prompt'

    def import_prompt_state(self):
        """入库提醒弹窗的现场：是否在场 / 在模态窗里吗 / 按钮文案 / 正文。"""
        return self.js("""() => {
            const root = document.querySelector('.chatfilesys-import-prompt');
            const dlg = root ? root.closest('dialog[open]') : null;
            return {
                visible: Boolean(root && dlg),
                inDialog: Boolean(dlg),
                buttons: dlg ? [...dlg.querySelectorAll('.popup-button-custom')].map(b => b.textContent.trim()) : [],
                text: root ? root.innerText.replace(/\\n+/g, ' | ') : null,
            };
        }""")

    def wait_import_prompt(self, want=True, timeout=15000):
        self.pg.wait_for_function(
            "([sel, want]) => Boolean(document.querySelector(sel)) === want",
            arg=[self.IMPORT_PROMPT_SEL, bool(want)], timeout=timeout)
        return self

    def import_prompt_choice(self, text, timeout=15000):
        """点入库提醒里的某个选择（按按钮文案；现行三个：「纯库」「双写」「不入库」），并等弹窗关掉。"""
        n = self.js("""(t) => {
            const root = document.querySelector('.chatfilesys-import-prompt');
            const dlg = root ? root.closest('dialog[open]') : null;
            if (!dlg) return 0;
            const btn = [...dlg.querySelectorAll('.popup-button-custom')].find(b => b.textContent.trim() === t);
            if (!btn) return 0;
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 1;
        }""", text)
        if not n:
            raise AssertionError(f'入库提醒弹窗里没有「{text}」')
        self.pg.wait_for_function(
            "() => !document.querySelector('.chatfilesys-import-prompt')", timeout=timeout)
        return self

    def dismiss_import_prompt(self, timeout=3000):
        """已经在场的提醒按「不入库」关掉（= 关闭语义；幂等）。

        F3（2026-09-26）：文案必须是 W8 现行的「不入库」——旧写法点的「继续用聊天文件」
        在 W8 的按钮改造后**根本不存在**，抛错又被这里吞成一行 warn，于是兜底变成了死代码
        （`Runner.boot` 与 `test_import_prompt.py` 的 `trigger()` / `no_prompt()` 全都受影响）。
        现在失败**不再静默**：先 warn，再把「弹窗还在场」这件事抛给调用方。
        """
        if not self.pg.query_selector(self.IMPORT_PROMPT_SEL):
            return self
        try:
            self.import_prompt_choice('不入库', timeout=timeout)
        except Exception as e:
            print(f"  [warn] 关闭入库提醒失败: {e}")
        if self.pg.query_selector(self.IMPORT_PROMPT_SEL):
            raise AssertionError('入库提醒弹窗没被关掉（「不入库」按钮未命中或宿主没关窗）——后续步骤会被它挡住')
        return self

    def set_import_prompt(self, prompt):
        """写压制记录（用例重置现场用；与插件读的是同一个 `extension_settings` 对象）。"""
        return self.js("""(p) => {
            const s = SillyTavern.getContext().extensionSettings;
            s.chatfilesys = s.chatfilesys || {};
            s.chatfilesys.import_prompt = p;
            return JSON.parse(JSON.stringify(s.chatfilesys.import_prompt));
        }""", prompt)

    def get_import_prompt(self):
        return self.js("""() => {
            const p = SillyTavern.getContext().extensionSettings?.chatfilesys?.import_prompt ?? null;
            return p ? JSON.parse(JSON.stringify(p)) : null;
        }""")

    def fire_chat_changed(self, settle_ms=1200):
        """重放 CHAT_CHANGED = 「打开聊天」这一步（T8 提醒与 W3 分支解析都挂在这条事件上）。

        真实操作里「打开聊天」靠点列表项，e2e 里既脆又慢；插件行为完全由这个事件驱动，
        直接发事件既确定又等价（宿主自己也是这么发的）。
        """
        self.js("""async () => {
            const ctx = SillyTavern.getContext();
            await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, ctx.getCurrentChatId());
            return 'emitted';
        }""")
        self.settle(settle_ms)
        return self

    # ---------- T9 主分支（R8.3 / AC22） ----------

    def chat_key(self, file_name=None):
        """聊天键 `角色头像::文件名`（规则单点 = `core/seam.js#normalizeChatKey`，这里不自己拼）。"""
        return self.js("""async ([src, fn]) => {
            const ctx = SillyTavern.getContext();
            const mod = await import(src + '/core/seam.js');
            return mod.normalizeChatKey(ctx.characters[ctx.characterId].avatar, fn || ctx.getCurrentChatId());
        }""", [EXT_SRC, file_name])

    def read_family(self, chat_key):
        """从**库**里直读一个家族（只读探针，不改数据）。

        聊天头里的 `extensions.chatfilesys` 是服务端**合成**的模型视图，里面没有键绑定；
        「主键绑在哪条分支」只有库里有，故临时建一个适配器实例直查（读完 dispose）。
        顺带带回 `hostMetadata` 与楼层行数——聊天头保留面与库内楼层只能用这条路核实。
        """
        return self.js("""async ([src, chatKey]) => {
            const ctx = SillyTavern.getContext();
            const mod = await import(src + '/core/storage/adapter.js');
            const built = await mod.createStorageAdapter({
                fetch: (...a) => globalThis.fetch(...a),
                headers: () => ctx.getRequestHeaders(),
                log: () => {},
            });
            try {
                const fam = await built.adapter.loadFamily({ chatKey });
                if (!fam) return null;
                const fl = await built.adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
                return JSON.parse(JSON.stringify({
                    familyId: fam.familyId, chatKey: fam.chatKey, integrity: fam.integrity,
                    activeBranch: fam.model?.active_branch ?? null,
                    defaults: (fam.model?.branches || []).filter(b => b.is_default).map(b => b.id),
                    branches: (fam.model?.branches || []).map(b => ({
                        id: b.id, name: b.name, isDefault: !!b.is_default,
                        floors: Object.keys(b.path || {}).length,
                    })),
                    keyBindings: fam.keyBindings || {},
                    hostMetadata: fam.hostMetadata ?? null,
                    floorRows: fl.floors.length,
                }));
            } finally { try { built.dispose?.(); } catch (e) { /* 探针清理失败无影响 */ } }
        }""", [EXT_SRC, chat_key])

    def set_storage_mode(self, mode, timeout=30000):
        """经弹窗「设置」页签切存储模式（走插件自己的安全动作），并等它**真的就绪**。

        就绪信号取设置页的档位徽章：`storageState` 未建好时徽章里带「未就绪」，
        仅看 `extension_settings.storage_mode` 会早于适配器构造完成（换模式是异步的）。
        """
        want = {'pure': '纯库', 'mirror': '双写', 'off': 'JSONL 增强'}.get(mode, mode)
        self.ensure_popup()
        self.popup_switch_tab('设置')
        n = self.js("""([sel, m]) => {
            const s = document.querySelector(sel);
            if (!s) return 0;
            s.value = m;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return 1;
        }""", [f'{PANEL} [data-role="storage-mode"]', mode])
        if not n:
            raise AssertionError('设置页签里没有存储模式选择器')
        self.pg.wait_for_function(
            "(m) => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode === m",
            arg=mode, timeout=timeout)
        try:
            self.pg.wait_for_function(
                """(w) => {
                    const b = document.querySelector('dialog[open] .chatfilesys-popup [data-role="storage-status"]');
                    return Boolean(b && b.innerText.includes(w) && !b.innerText.includes('未就绪'));
                }""", arg=want, timeout=timeout)
        except Exception as e:
            print(f"  [warn] 存储档位徽章未更新到「{want}」: {e}")
        self.settle(400)
        return self

    # ---------- 断言 ----------
    def console_errors(self):
        return [(t, txt, src) for t, txt, src in self.logs if t == "error"]

    @staticmethod
    def _src_of(stack: str) -> str:
        """从错误栈提取来源扩展名（chatfilesys / 其他扩展名 / 'other'）。"""
        import re
        m = re.search(r"/third-party/([A-Za-z0-9_.-]+)/", stack or "")
        return m.group(1) if m else "other"

    def pageerrors_from(self, ext: str):
        """归因到指定扩展的 pageerror 列表。"""
        return [s for s in self.errors if self._src_of(s) == ext]

    def console_errors_from(self, ext: str):
        out = []
        for t, txt, src in self.console_errors():
            if ext in src:
                out.append((txt, src))
        return out


def report(name, ok, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def browser_ctx(p, headless=True):
    b = p.chromium.launch(headless=headless, args=["--ignore-certificate-errors"])
    c = b.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1100},
                      accept_downloads=True)
    return b, c
