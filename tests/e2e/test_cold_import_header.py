"""ChatFilesys 冷导入聊天头 e2e（W5 / R0 / AC13）

用户 2026-09-26 裁定：把一份存量 jsonl 录入数据库时，源文件头里的 `chat_metadata`
（其他插件的命名空间、`main_chat` 线索……）必须**完整进库**。冷路径（导入一个**当前没打开的**
聊天）下宿主内存那份 metadata 帮不上忙，源文件就是唯一来源。

上一轮那条真机用例之所以没暴露缺口：它导入的正是**当前打开**的聊天，宿主内存那份 metadata
随后经 `chats/meta` 回填，把缺口掩盖了。本用例刻意让被导入的聊天**不是当前聊天**。

断言：
  ① 前置：A（要导入的聊天）写入了探针命名空间 + `main_chat` + 顶层键，且**已落盘到它的 jsonl**
  ② 前置：A 不在库里；导入时**当前打开的是 B**（= 真冷路径）
  ③ 导入 A 之后：库里 A 家族的 `hostMetadata` 完整含三个探针键
  ④ 经宿主端点读回 A：`chat_metadata` 里那三个键原样存在（接缝整份回显），楼层数对齐
  ⑤ 对照：B 的探针键没串到 A 的家族里（B 的键是导入后才写的，A 家族里不该有）

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_cold_import_header.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

PROBE_TOP = '__w5_top'
PROBE_NS = '__w5_plugin'
PROBE_PARENT = '__w5_parent'

# 往**当前聊天的聊天头**写探针内容（原生形态：宿主自己 + 第三方插件都这么写）
WRITE_PROBE_JS = """async ([tag]) => {
    const ctx = SillyTavern.getContext();
    const md = ctx.chatMetadata || {};
    md.__w5_top = tag;
    md.main_chat = '__w5_parent';
    md.extensions = { ...(md.extensions || {}), '__w5_plugin': { tag, n: tag.length } };
    ctx.chatMetadata = md;
    ctx.chatMetadata.tainted = true;
    await ctx.saveMetadata();
    return { top: md.__w5_top, ns: md.extensions['__w5_plugin'] };
}"""

# 经宿主端点读某聊天的 header（纯库模式下走接缝 = 库里合成的那一份；增强模式下 = 磁盘那一份）
READ_HEADER_JS = """async (fn) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const res = await fetch('/api/chats/get', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: char.name, file_name: fn, avatar_url: char.avatar }),
    });
    if (!res.ok) return { error: res.status };
    const data = await res.json();
    if (!Array.isArray(data)) return { error: 'not-array', data };
    const md = data[0]?.chat_metadata || {};
    return {
        bodyLen: data.length - 1,
        top: md.__w5_top ?? null,
        parent: md.main_chat ?? null,
        ns: md.extensions?.['__w5_plugin'] ?? null,
        hasModel: Boolean(md.extensions?.chatfilesys),
        envNs: md.extensions?.['__w5_env'] ?? null,
    };
}"""


def answer_confirm(r, expect, ok=False, timeout=60000):
    """回答导入旅程里的一个确认弹窗（按**文案认**弹窗，不靠弹窗个数——两问是连着来的）。"""
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
    r.settle(500)
    return True


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "cold-import-header")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)
            # 出厂默认 = 增强模式（off）：探针内容先只存在于磁盘 jsonl 里
            mode0 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null")
            if mode0 != 'off':
                r.set_storage_mode('off')
                r.close_popup()

            # ---------- ① 造 A：写探针聊天头 + 一条消息 → 落盘 ----------
            chat_a = r.new_chat()
            r.cmd("/send A-冷导入一条")
            r.settle(1200)
            key_a = r.chat_key()
            wrote = r.js(WRITE_PROBE_JS, [chat_a])
            r.settle(800)
            disk_a = r.js(READ_HEADER_JS, chat_a)
            ok1 = (wrote.get("top") == chat_a
                   and disk_a.get("top") == chat_a
                   and disk_a.get("parent") == PROBE_PARENT
                   and disk_a.get("ns") == {"tag": chat_a, "n": len(chat_a)}
                   and disk_a.get("bodyLen", 0) >= 2)
            results.append(report("① 前置：A 的聊天头探针已落盘（主聊天线索 + 第三方命名空间 + 顶层键）", ok1,
                                  f"chatA={chat_a} 磁盘读回={disk_a}"))

            # ---------- ② 造 B 并切过去（A 从此「没打开」） ----------
            # 记下装接缝**之前**的 fetch（= 真正读磁盘的那条通道），供随后对照
            r.js("() => { window.__preSeamFetch = globalThis.fetch; return 'saved'; }")
            chat_b = r.new_chat()
            key_b = r.chat_key()
            r.js(WRITE_PROBE_JS, [chat_b])
            r.settle(800)
            r.set_storage_mode('pure')
            r.close_popup()
            r.settle(800)
            # 诊断：装接缝后，A 的磁盘原文还能不能读到（对比 native 通道与接缝通道）
            diag = r.js("""async ([fn, probe]) => {
                const ctx = SillyTavern.getContext();
                const char = ctx.characters[ctx.characterId];
                const body = JSON.stringify({ ch_name: char.name, file_name: fn, avatar_url: char.avatar });
                const init = { method: 'POST', headers: ctx.getRequestHeaders(), body };
                const raw = await window.__preSeamFetch('/api/chats/get', init);
                const viaRaw = await raw.json();
                const seam = await globalThis.fetch('/api/chats/get', init);
                const viaSeam = await seam.json();
                return {
                    rawLen: Array.isArray(viaRaw) ? viaRaw.length : viaRaw,
                    seamLen: Array.isArray(viaSeam) ? viaSeam.length : viaSeam,
                    probe,
                };
            }""", [chat_a, "after-pure"])
            print(f"  诊断（装接缝后读 A）：{json.dumps(diag, ensure_ascii=False)[:300]}")
            fam_a_before = r.read_family(key_a)
            fam_b = r.read_family(key_b)
            st = r.state()
            # B 在增强模式下建的档，切到纯库后**不会自动入库**（这正是要导入 A 的理由）；
            # 断言只要求：A 不在库里 + 当前打开的是 B（A 确实没被打开）。
            ok2 = (fam_a_before is None and st["chatFile"] == chat_b
                   and chat_b != chat_a and key_a != key_b)
            results.append(report("② 前置：A 不在库里、当前打开的是 B（真冷路径）", ok2,
                                  f"chatA={chat_a} chatB={chat_b} 当前={st['chatFile']} "
                                  f"A家族={fam_a_before} B家族={'有' if fam_b else '无(增强模式建档)'}"))

            # ---------- ③ 经「角色卡的聊天」页签把 A 转进数据库 ----------
            r.ensure_popup()
            r.popup_switch_tab('角色卡的聊天')
            r.settle(1200)
            rows = r.js("""() => [...document.querySelectorAll('dialog[open] .chatfilesys-popup .chatfilesys-chat-row')]
                .map(x => ({ file: x.dataset.file, state: x.querySelector('.state')?.textContent }))""")
            print(f"  角色卡的聊天行：{json.dumps(rows, ensure_ascii=False)[:300]}")
            r.click_action("chat-import", file=chat_a)
            answer_confirm(r, '删除源 jsonl 文件', ok=True)
            answer_confirm(r, '双写绑定', ok=False)
            r.settle(3500)

            fam_a = r.read_family(key_a)
            host = (fam_a or {}).get("hostMetadata") or {}
            ext = (host.get("extensions") or {})
            ok3 = (bool(fam_a)
                   and host.get(PROBE_TOP) == chat_a
                   and host.get("main_chat") == PROBE_PARENT
                   and ext.get(PROBE_NS) == {"tag": chat_a, "n": len(chat_a)})
            results.append(report("③ 库里 A 家族的 hostMetadata 完整含三个探针键（W5 修点）", ok3,
                                  f"top={host.get(PROBE_TOP)!r} main_chat={host.get('main_chat')!r} "
                                  f"ns={ext.get(PROBE_NS)!r} "
                                  f"分支={[(b['id'], b['floors']) for b in (fam_a or {}).get('branches', [])]} "
                                  f"楼层行={fam_a.get('floorRows') if fam_a else None}"))

            # ---------- ④ 经宿主端点读回 A（接缝整份回显 + 楼层对齐） ----------
            back = r.js(READ_HEADER_JS, chat_a)
            ok4 = (back.get("top") == chat_a
                   and back.get("parent") == PROBE_PARENT
                   and back.get("ns") == {"tag": chat_a, "n": len(chat_a)}
                   and back.get("hasModel") is True
                   and back.get("bodyLen", 0) >= 2)
            results.append(report("④ 经 /api/chats/get 读回 A：聊天头整份回显 + 接缝已接管", ok4,
                                  f"读回={back}"))

            # ---------- ⑤ 对照：B 的探针没串进 A 的家族 ----------
            b_ns = r.js("""() => {
                const md = SillyTavern.getContext().chatMetadata || {};
                return md.extensions?.['__w5_plugin'] ?? null;
            }""")
            ok5 = (fam_a is not None and fam_a["chatKey"] == key_a and b_ns == {"tag": chat_b, "n": len(chat_b)})
            results.append(report("⑤ 对照：A 家族的键 = A（B 的探针只是 B 自己的聊天头）", ok5,
                                  f"A键={fam_a['chatKey'] if fam_a else None} B探针={b_ns}"))

            # ---------- ⑥ 源文件真进了回收站（导入旅程的既有语义没被破坏） ----------
            # 判据必须走 `/api/chats/search`：它**不在接缝路由内**（读磁盘 = 磁盘事实）。
            # 不能再用 `/api/chats/get`——A 已被接缝接管，那个端点读的是库，永远回数组。
            listing = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const char = ctx.characters[ctx.characterId];
                const res = await fetch('/api/chats/search', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ query: '', avatar_url: char.avatar }),
                });
                if (!res.ok) return { error: res.status };
                return (await res.json()).map(x => x.file_name);
            }""")
            gone = isinstance(listing, list) and not any(str(x).startswith(chat_a) for x in listing)
            results.append(report("⑥ 导入后 A 的磁盘文件已消失（源文件按确认进回收站）", gone,
                                  f"磁盘列表={listing}"))

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
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在纯库模式）: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            try:
                r.set_import_prompt({"never": False, "mutedKeys": []})
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nCOLD IMPORT HEADER " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
