"""补丁语义探针：抓宿主真实 /api/chats/* 请求体（T0b 字段级补丁 / T0c 聊天头整体写）

目的（implement.md T0b/T0c 的「修法要点」第一句：抓真实请求体后定语义）：
  ① 宿主「编辑消息 / 改消息字段」到底发什么 op？（是否出现 `/N/field`）
  ② 宿主写聊天时 body.chat_metadata 是全量还是部分？（是否整体替换 extensions）
  ③ 分支切换（本扩展 UI 的 planSwitch → 官方消息 API）发出的 op 序列形态
  ④ 删除消息 / swipe 切换的 op 形态

只读策略：不写实例文件系统；只用自建测试角色 __cb_e2e（**不删**，它是 e2e 共用夹具）；
记录完后打印、退出。
用法：python tests/e2e/probe_patch_ops.py
"""
import json
import pathlib
import sys
import traceback

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from harness import Runner, browser_ctx  # noqa: E402

RECORDER = """() => {
    if (window.__cfsysProbe) return 'already';
    const log = [];
    const orig = window.fetch;
    window.__cfsysProbe = { log, orig };
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const path = String(url).split('?')[0];
        if (!/\\/api\\/chats\\//.test(path)) return orig.apply(this, arguments);
        let body = null;
        try {
            if (init && init.body) body = JSON.parse(String(init.body));
            else if (input instanceof Request) body = await input.clone().json();
        } catch (e) { body = { __parse_error: String(e) }; }
        const entry = { path, method: (init && init.method) || 'POST', body, ts: Date.now() };
        log.push(entry);
        try {
            const res = await orig.apply(this, arguments);
            entry.status = res.status;
            return res;
        } catch (e) { entry.status = 'throw:' + e; throw e; }
    };
    return 'installed';
}"""

DUMP = """() => {
    const log = (window.__cfsysProbe && window.__cfsysProbe.log) || [];
    return log.map((e) => {
        const b = e.body || {};
        const ops = Array.isArray(b.operations) ? b.operations : null;
        const md = b.chat_metadata && typeof b.chat_metadata === 'object' ? b.chat_metadata : null;
        return {
            path: e.path,
            status: e.status,
            keys: Object.keys(b),
            opCount: ops ? ops.length : 0,
            ops: ops,
            chatKeys: b.chat && Array.isArray(b.chat) ? b.chat.length : null,
            mdTopKeys: md ? Object.keys(md) : null,
            mdExtKeys: md && md.extensions ? Object.keys(md.extensions) : null,
            integrity: b.integrity ?? null,
            force: b.force ?? null,
        };
    });
}"""

CLEAR = "() => { if (window.__cfsysProbe) window.__cfsysProbe.log.length = 0; return true; }"


def show(label, entries, only_ops=True):
    print(f"\n########## {label} ##########")
    for e in entries:
        kind = "OPS" if e["opCount"] else "    "
        print(f"[{kind}] {e['method'] if 'method' in e else 'POST'} {e['path']} → {e['status']}")
        print(f"       body.keys={e['keys']} chatRows={e['chatKeys']} integrity={e['integrity']!r} force={e['force']!r}")
        if e["mdTopKeys"] is not None:
            print(f"       chat_metadata 顶层键={e['mdTopKeys']}")
            print(f"       chat_metadata.extensions 命名空间={e['mdExtKeys']}")
        if e["ops"]:
            print("       operations:")
            print(json.dumps(e["ops"], ensure_ascii=False, indent=8)[:4000])
        elif not only_ops:
            print(f"       (无 operations)")


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe")
        try:
            r.boot()
            print("boot ok")
            print("recorder:", r.js(RECORDER))
            # 用测试角色（不存在则建；末尾不删——它是 e2e 共用夹具）
            res = r.create_test_char()
            print("create_test_char:", res.get("status"))
            r.open_test_char()
            r.settle(2500)
            print("chat len:", r.js("() => SillyTavern.getContext().chat.length"))

            # ---- A. 编辑最后一条消息的 mes（宿主内部更新路径，等价 UI 编辑确认） ----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i = ctx.chat.length - 1;
                const before = ctx.chat[i].mes;
                await ctx.updateMessages({ index: i, patch: { mes: before + ' [编辑探针]' } });
                await new Promise(res => setTimeout(res, 1500));
                return { i, len: ctx.chat.length, disc: ctx.chat[i].mes.slice(-8) };
            }""")
            print("A updateMessages:", out)
            show("A 编辑消息字段（updateMessages → patch /N/mes）", r.js(DUMP))

            # ---- B. 改 extra 深层字段 ----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i = ctx.chat.length - 1;
                await ctx.updateMessages({ index: i, patch: { extra: { ...(ctx.chat[i].extra || {}), probe_deep: 'v1' } } });
                await new Promise(res => setTimeout(res, 1500));
                return ctx.chat[i].extra?.probe_deep;
            }""")
            print("B extra 深层:", out)
            show("B 改消息 extra 深层字段", r.js(DUMP))

            # ---- C. 第三方命名空间写入 + 宿主常规保存（T0c 证据） ----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const md = { ...(ctx.chatMetadata || {}) };
                md.extensions = { ...(md.extensions || {}), 'third-party/probe': { hello: 'world' } };
                md.main_chat = md.main_chat || 'probe_main';
                ctx.chatMetadata = md;
                ctx.chatMetadata.tainted = true;
                await ctx.addMessages({ name: 'System', mes: 'C-命名空间探针', is_system: true }, { silent: true });
                await new Promise(res => setTimeout(res, 1500));
                return { ns: Object.keys(ctx.chatMetadata.extensions || {}) };
            }""")
            print("C 命名空间+追加:", out)
            show("C 第三方命名空间 + 宿主保存", r.js(DUMP))

            # ---- D. 删除最后一条 ----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const n0 = ctx.chat.length;
                await ctx.deleteMessages(ctx.chat.length - 1, { silent: true });
                await new Promise(res => setTimeout(res, 1500));
                return { n0, n1: ctx.chat.length };
            }""")
            print("D 删除:", out)
            show("D 删除消息", r.js(DUMP))

            # ---- E. 真 UI 编辑流程（点编辑按钮 → 改文本 → 确认） ----
            r.js(CLEAR)
            try:
                r.js("""() => {
                    const nodes = document.querySelectorAll('#chat .mes');
                    const last = nodes[nodes.length - 1];
                    const btn = last && last.querySelector('.mes_edit');
                    if (btn) btn.click();
                    return !!btn;
                }""")
                r.settle(1200)
                edited = r.js("""async () => {
                    const ta = document.querySelector('#curEditTextarea') || document.querySelector('textarea[name="edit_mes_textarea"]');
                    if (!ta) return 'no-textarea';
                    ta.value = (ta.value || '') + ' [UI编辑探针]';
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    const ok = document.querySelector('#dialogue_popup_ok') || document.querySelector('.mes_edit_done');
                    if (ok) ok.click();
                    await new Promise(res => setTimeout(res, 1800));
                    return 'clicked';
                }""")
                print("E UI 编辑:", edited)
            except Exception as e:
                print("E UI 编辑异常:", e)
            show("E 真 UI 编辑消息", r.js(DUMP), only_ops=False)

            # ---- F. swipe：给最后一条加 swipe 并切换（宿主 swipe 路径） ----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i = ctx.chat.length - 1;
                const msg = ctx.chat[i];
                if (!Array.isArray(msg.swipes)) msg.swipes = [msg.mes];
                if (!Array.isArray(msg.swipe_info)) msg.swipe_info = [{}];
                msg.swipes.push(msg.mes + ' [swipe2]');
                msg.swipe_info.push({ send_date: msg.send_date });
                msg.swipe_id = msg.swipes.length - 1;
                msg.mes = msg.swipes[msg.swipe_id];
                await ctx.updateMessages({ index: i, patch: { swipes: msg.swipes, swipe_info: msg.swipe_info, swipe_id: msg.swipe_id, mes: msg.mes } });
                await new Promise(res => setTimeout(res, 1500));
                return { swipes: msg.swipes.length, id: msg.swipe_id };
            }""")
            print("F swipe:", out)
            show("F swipe 扩展与切换", r.js(DUMP))

            # ---- G. 第三方插件形态：直接改内存里的消息字段 + 让宿主保存（保真 e2e 步骤⑤）----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i = 0;
                ctx.chat[i].extra = { ...(ctx.chat[i].extra || {}), 'third-party/probe-row': { n: 42, deep: { arr: [7, 8] } } };
                await ctx.saveChat();
                await new Promise(res => setTimeout(res, 2500));
                return { extraKeys: Object.keys(ctx.chat[i].extra || {}) };
            }""")
            print("G 插件改消息字段+saveChat:", out)
            show("G 插件改消息字段 + saveChat（T0b 真实形态）", r.js(DUMP))

            # ---- H. 同形态第二次宿主写（看库里那份能否存活）----
            r.js(CLEAR)
            out = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                await ctx.addMessages({ name: 'System', mes: 'H-第二次宿主写', is_system: true }, { silent: true });
                await new Promise(res => setTimeout(res, 2000));
                return ctx.chat.length;
            }""")
            print("H 第二次宿主写:", out)
            show("H 第二次宿主写", r.js(DUMP))

        except Exception:
            traceback.print_exc()
        finally:
            # 不删测试角色：`__cb_e2e` 是 e2e 共用夹具（别的用例依赖它已有聊天），
            # 删掉会破坏它们的入口条件（delete_chats=true 会连聊天一起删）。
            b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
