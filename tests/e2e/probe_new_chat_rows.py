"""探针（W6 附）：新聊天家族从建档到首行落库的每一步——库里到底有哪些行。

`projection-incomplete｜楼层 1 的变体 g1 在库中无行` 说明新建家族的模型声明了楼层 1 的组 g1，
但库里没有对应行。本探针逐步打印「宿主 body / 库内行 (floorNo#variantId) / 模型 path」，
定位首行是在哪一步、经哪条端点落库（或根本没落）。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_new_chat_rows.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DUMP_JS = """async ([src, chatKey]) => {
    const ctx = SillyTavern.getContext();
    const mod = await import(src + '/core/storage/adapter.js');
    const built = await mod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(), log: () => {},
    });
    try {
        const fam = await built.adapter.loadFamily({ chatKey });
        if (!fam) return { family: null };
        const fl = await built.adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
        return {
            model: { active: fam.model?.active_branch, paths: (fam.model?.branches || []).map(b => ({ id: b.id, path: b.path })) },
            rowKeys: fl.floors.map(r => `${r.floorNo}#${r.variantId}`),
            rowTexts: fl.floors.map(r => {
                try { const o = JSON.parse(r.content); return `${r.floorNo}#${r.variantId}:${(o.mes||'').slice(0,14)}`; } catch { return '??'; }
            }),
        };
    } finally { try { built.dispose?.(); } catch (e) {} }
}"""

TAP_JS = """() => {
    if (window.__cbTapped2) return 'already';
    window.__cbTapped2 = true;
    window.__cbCalls2 = [];
    const prev = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (/\\/api\\/chats\\/(patch|append|save|meta)/.test(url)) {
            let body = null;
            try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch (e) {}
            const isHidden = String(body?.avatar_url || '').startsWith('__cfsys__');
            if (!isHidden) {
                window.__cbCalls2.push({
                    route: (url.match(/chats\\/[a-z/-]+/) || [''])[0],
                    file: body?.file_name || body?.chatfile || null,
                    ops: body?.operations ?? null,
                    msgs: body?.messages ? body.messages.map(m => (m.mes||'').slice(0,12)) : null,
                    chatLen: Array.isArray(body?.chat) ? body.chat.length : null,
                    active: body?.chat_metadata?.extensions?.chatfilesys?.active_branch ?? null,
                });
            }
        }
        return prev(input, init);
    };
    return 'tapped';
}"""


def dump(r, key, tag):
    d = r.js(DUMP_JS, ["/scripts/extensions/third-party/chatfilesys", key])
    st = r.state()
    print(f"\n--- {tag} ---")
    print(f"  host: chatLen={st['chatLen']} active={st['activeId']} texts={st['mesTexts']}")
    print(f"  lib : {json.dumps(d, ensure_ascii=False)}")


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-new-chat-rows")
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
            print("tap:", r.js(TAP_JS))

            r.js("() => { window.__cbCalls2 = []; return 'cleared'; }")
            chat = r.new_chat()
            r.settle(2000)
            key = r.chat_key()
            print(f"\nchat={chat} key={key}")
            print("calls:", json.dumps(r.js("() => window.__cbCalls2 || []"), ensure_ascii=False))
            dump(r, key, "建新聊天后（未重载）")

            r.js("() => { window.__cbCalls2 = []; return 'cleared'; }")
            r.js("async () => { await SillyTavern.getContext().reloadCurrentChat(); }")
            r.settle(2500)
            print("reload calls:", json.dumps(r.js("() => window.__cbCalls2 || []"), ensure_ascii=False))
            dump(r, key, "重载后")

            r.js("() => { window.__cbCalls2 = []; return 'cleared'; }")
            r.cmd("/send U-F2")
            r.settle(1500)
            print("send calls:", json.dumps(r.js("() => window.__cbCalls2 || []"), ensure_ascii=False))
            dump(r, key, "发第一条后")

            for cmd in ["/sendas name=__cb_e2e A-F3", "/send U-F4"]:
                r.cmd(cmd)
                r.settle(900)
            dump(r, key, "发到 4 层")

            print("\n=== 接缝日志 ===")
            for ty, txt, src in r.logs:
                if 'chatfilesys-seam' in txt:
                    print(f"  [{ty}] {txt[:300]}")
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
