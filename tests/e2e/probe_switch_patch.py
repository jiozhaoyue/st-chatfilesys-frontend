"""探针（W6）：切分支时宿主实际发出的 chats/patch ops + 接缝拒绝原因。

现象（用户 2026-09-26 实录）：纯库模式下切分支时接缝两次拒绝 `chats/patch`——
`projection-incomplete｜楼层 1 的变体 g1 在库中无行`、`test-failed｜/3`，宿主随后自动重放成功。

本探针在接缝安装**之后**再包一层 fetch，把出向 `chats/patch` / `chats/append` 的
body 原样记到 `window.__cbCalls`（只记录，不改写），从而看到：
  - ops 真实形态（test/remove/add 的下标）
  - 每次调用带的 `chat_metadata.extensions.chatfilesys.active_branch`（= 入向模型）
  - 库内当前 active_branch 与键绑定（读家族）
用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_switch_patch.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TAP_JS = """() => {
    if (window.__cbTapped) return 'already';
    window.__cbTapped = true;
    window.__cbCalls = [];
    const prev = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (/\\/api\\/chats\\/(patch|append|save|meta)/.test(url)) {
            let body = null;
            try {
                body = init?.body ? JSON.parse(String(init.body)) : null;
            } catch (e) { body = 'unparsable'; }
            window.__cbCalls.push({
                url: url.replace(/^https?:\\/\\/[^/]+/, ''),
                route: (url.match(/chats\\/[a-z/-]+/) || [''])[0],
                ops: body?.operations ?? null,
                msgs: body?.messages ? body.messages.length : null,
                incoming_active: body?.chat_metadata?.extensions?.chatfilesys?.active_branch ?? null,
                incoming_branch_count: (body?.chat_metadata?.extensions?.chatfilesys?.branches || []).length,
                body_chat_len: Array.isArray(body?.chat) ? body.chat.length : null,
                integrity: body?.integrity ?? null,
                force: body?.force ?? null,
            });
        }
        return prev(input, init);
    };
    return 'tapped';
}"""


def calls(r):
    return r.js("() => window.__cbCalls || []")


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-switch-patch")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)

            r.set_storage_mode('pure')
            r.close_popup()
            r.new_chat()
            r.settle(1500)
            key = r.chat_key()
            r.js("async () => { await SillyTavern.getContext().reloadCurrentChat(); }")
            r.settle(2500)

            for cmd in ["/send U-F2", "/sendas name=__cb_e2e A-F3", "/send U-F4"]:
                r.cmd(cmd)
                r.settle(900)
            r.wait_state(lambda s: s["chatLen"] == 4, desc="造 4 层")

            nb = r.create_branch(2, name='分叉·F2', activate=False)
            r.ensure_active(nb)
            r.settle(900)
            print(f"key={key} nb={nb} state={ {k: r.state()[k] for k in ('chatLen','activeId','activeFloors')} }")
            print("family=", json.dumps(r.read_family(key), ensure_ascii=False)[:600])

            # ---- 开始记录 ----
            print("tap:", r.js(TAP_JS))
            r.js("() => { window.__cbCalls = []; return 'cleared'; }")

            print("\n=== 切回主分支（b_main）===")
            r.ensure_active("b_main")
            r.settle(2000)
            for call in calls(r):
                print(json.dumps(call, ensure_ascii=False))

            print("\n=== 再切到分叉分支 ===")
            r.js("() => { window.__cbCalls = []; return 'cleared'; }")
            r.ensure_active(nb)
            r.settle(2000)
            for call in calls(r):
                print(json.dumps(call, ensure_ascii=False))

            print("\n=== 接缝日志（未应用 / 疑似 / 丢弃）===")
            for ty, txt, src in r.logs:
                if 'chatfilesys-seam' in txt:
                    print(f"  [{ty}] {txt[:400]}")

            print("\n=== 库内现状 ===")
            print(json.dumps(r.read_family(key), ensure_ascii=False)[:900])
            print("state=", {k: r.state()[k] for k in ('chatLen', 'activeId', 'activeFloors', 'mesTexts')})
            return 0
        finally:
            try:
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    sys.exit(main())
