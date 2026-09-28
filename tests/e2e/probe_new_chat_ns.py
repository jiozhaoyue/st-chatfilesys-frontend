"""探针：测试角色开新聊天后，chatfilesys 命名空间到底有没有自动建起来。

用途：`test_deletes.py` 在 `create_branch` 处报 `ctx.chatMetadata.extensions` 为 undefined。
先分清是「扩展没自动建家族」还是「用例前提过期」——A/B 已证明改动前的构建同样失败。

用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_new_chat_ns.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, TEST_CHAR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NS_JS = """() => {
    const ctx = SillyTavern.getContext();
    const md = ctx.chatMetadata || {};
    return {
        chatFile: ctx.getCurrentChatId?.() ?? null,
        charName: ctx.characters?.[ctx.characterId]?.name ?? null,
        mdKeys: Object.keys(md),
        hasExtensions: Boolean(md.extensions),
        extKeys: md.extensions ? Object.keys(md.extensions) : null,
        mode: ctx.extensionSettings?.chatfilesys?.storage_mode ?? null,
        hasModel: Boolean(md.extensions?.chatfilesys),
    };
}"""

with sync_playwright() as p:
    b, c = browser_ctx(p)
    r = Runner(c.new_page(), "ns-probe")
    created = False
    try:
        r.boot()
        print("① 启动后:", json.dumps(r.js(NS_JS), ensure_ascii=False))
        res = r.create_test_char()
        created = res.get("status") == 200
        print("② 建测试角色:", res)
        if created:
            r.open_test_char()
            r.settle(2500)
            print("③ /go 测试角色后:", json.dumps(r.js(NS_JS), ensure_ascii=False))
            r.new_chat()
            print("④ /newchat 之后:", json.dumps(r.js(NS_JS), ensure_ascii=False))
            print("本插件日志:", [t for _ty, t, _s in r.logs if 'chatfilesys' in t][-5:])
    finally:
        if created:
            print("清理角色:", r.delete_test_char())
        b.close()
