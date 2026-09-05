"""chatfilesys e2e harness —— 驱动宿主 Luker 实例（8003）真实浏览器实测。

隔离原则：只操作自建测试角色（前缀 __cb_e2e），末尾清理；绝不触碰既有角色与聊天。
"""
import time
from playwright.sync_api import sync_playwright

BASE = "https://127.0.0.1:8003"
TEST_CHAR = "__cb_e2e"

# 二期 UI：复杂 UI 宿主 = 管理弹窗（/cb、Alt+B、设置页按钮三入口）。
# PANEL = 弹窗内容根；click_action / panel_text / ensure_active 会自动确保弹窗打开（对测试透明）。
SETTINGS = "#chatfilesys-settings"
POPUP_DIALOG = 'dialog[open]:not([closing]) .chatfilesys-popup'
PANEL = POPUP_DIALOG
# 注意：Popup 模板对非 INPUT/非 CONFIRM 类型也保留隐藏的 .popup-input/.popup-button-ok，
# 子弹窗选择器必须限定「最上层 dialog」（:last-of-type），否则会匹配管理弹窗的隐藏控件而超时。
TOPDLG = 'dialog[open]:not([closing]):last-of-type'


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
    def boot(self, timeout=120000):
        self.pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        self.pg.wait_for_selector("#send_textarea", state="attached", timeout=timeout)
        self.pg.wait_for_function(
            """() => {
                const s = document.querySelector('#chatfilesys-settings .chatfilesys-settings-status');
                return !!s && s.innerHTML.length > 0;
            }""",
            timeout=timeout,
        )
        return self

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

    # ---------- 弹窗交互（二期：复杂 UI 宿主 = 管理弹窗） ----------
    def ensure_popup(self, timeout=15000):
        """确保管理弹窗打开（/cb 入口）。幂等。"""
        if self.pg.query_selector(POPUP_DIALOG):
            return self
        self.cmd('/cb')
        self.pg.wait_for_selector(POPUP_DIALOG, timeout=timeout)
        self.pg.wait_for_timeout(300)
        return self

    def close_popup(self, timeout=8000):
        """关闭管理弹窗（点弹窗自己的 X；DISPLAY 型无确认按钮）。"""
        self.js("""() => {
            const dlg = [...document.querySelectorAll('dialog[open]')]
                .find(d => d.querySelector('.chatfilesys-popup'));
            if (!dlg) return 'no-popup';
            dlg.querySelector('.popup-close')?.click()
                || dlg.querySelector('button[class*="close"]')?.click()
                || dlg.close();
            return 'closing';
        }""")
        self.pg.wait_for_selector(POPUP_DIALOG, state="detached", timeout=timeout)
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

    def click_action(self, action, *, branch=None, floor=None, nth=0):
        """原子点击：选择器在页面内同 tick 解析并 click，避免面板重渲染产生游离节点竞态。
        弹窗未打开时自动先开（对测试透明）。"""
        self.ensure_popup()
        sel = f'{PANEL} [data-action="{action}"]'
        if branch is not None:
            sel += f'[data-branch="{branch}"]'
        if floor is not None:
            sel += f'[data-floor="{floor}"]'
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
        return self.js("""async (name) => {
            const ctx = SillyTavern.getContext();
            const headers = ctx.getRequestHeaders();
            delete headers['Content-Type'];
            const fd = new FormData();
            fd.append('ch_name', name);
            fd.append('file_name', name);
            fd.append('description', 'chatfilesys e2e 临时测试角色');
            fd.append('first_mes', '开场问候语（F1）');
            const res = await fetch('/api/characters/create', { method: 'POST', headers, body: fd });
            return { status: res.status, avatar: res.ok ? await res.text() : null };
        }""", TEST_CHAR)

    def delete_test_char(self):
        return self.js("""async (name) => {
            const ctx = SillyTavern.getContext();
            const headers = ctx.getRequestHeaders();
            const res = await fetch('/api/characters/delete', {
                method: 'POST', headers,
                body: JSON.stringify({ avatar_url: `${name}.png`, delete_chats: true }),
            });
            return { status: res.status };
        }""", TEST_CHAR)

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
