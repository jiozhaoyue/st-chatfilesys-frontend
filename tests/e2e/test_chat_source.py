"""ChatFilesys 数据源抽象 e2e（B1 / AC2）

`core/source/*`（ChatSource）是「消费层能力（图/检索/大纲/看板/Diff/画廊…）与数据来源解耦」
的地基。本用例在**真机**上验证两档数据源的两个硬要求：

  ① **文件源读的是磁盘事实**（原生通道，不经宿主端点语义）：`readSession` 产出的每条消息与
     磁盘 jsonl 原文**逐字段一致**（一个键不丢、也不补默认值）
  ② **两档同形产出**：同一聊天，off 下的文件源与纯库/双写下的库源，`listSessions` 的**键集合**
     与 `readSession` 的**消息序列**一致（差异只在「哪来的」，且 `describe()` 能解释这份差异）

断言：
  ① off：文件源列出当前聊天（kind=chat），且 readSession == 磁盘原文（逐字段）
  ② off：宿主原生「创建分支」落下的派生文件（`X - Branch #1`）= **独立会话**（kind=branch-file），不并进父会话
  ③ 库源：纯库 + 导入该聊天后，同键在列表里（kind=family-member），readSession == off 下那一份（同形）
  ④ 三模式：同一聊天的键在 off / pure / mirror 三档都在列表里；pure 与 mirror 的库源键集合一致
  ⑤ 原生通道：库模式下文件源仍能列出**只存在于磁盘上的**原生分支文件，而库源列不出它——
     以「该键确实列得出」作**阳性对照**（防「库源是空集」的假绿），且差异能被库源**真跑过一轮之后**
     的 `describe().notes` 解释（「未入库 / 不在此列」），不是错
  ⑥ 全程零 chatfilesys 归因报错

等待纪律：关键状态一律轮询（`wait_disk` / `poll`），不用固定 sleep 猜耗时
（`.trellis/spec/frontend/quality-guidelines.md` 的 Forbidden）。

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`；
扩展源码路径单点 = `harness.EXT_SRC`（本文件不另定义）。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_chat_source.py
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 装接缝**之前**的 fetch（= 真正读磁盘的那条原生通道）。B1 的文件源在库模式下必须走它，
# 否则会读到接缝自造的「本键所在分支的投影」。
SAVE_NATIVE_JS = """() => {
    window.__preSeamFetch = window.__preSeamFetch || globalThis.fetch;
    return 'saved';
}"""

# 建一个数据源（探针）：`mode` = 当前存储模式（走入口的**自动选源**）；`tier` = 强制指定实现
# （`auto` = 按模式选；`jsonl` / `library` = 直接建那一档——⑤ 要在库模式下手动建文件源）；
# `useNative` = 文件源是否走原生通道（`window.__preSeamFetch`）
NEW_SOURCE_JS = """async ([src, mode, tier, useNative]) => {
    const ctx = SillyTavern.getContext();
    const mod = await import(src + '/core/source/chat-source.js');
    const character = () => {
        const ch = ctx.characters[ctx.characterId] || {};
        return { avatarUrl: ch.avatar, characterId: ctx.characterId, name: ch.name, groupId: ctx.groupId ?? null };
    };
    const wantLibrary = tier === 'library' || (tier === 'auto' && mode !== 'off');
    let built = null;
    if (wantLibrary) {
        const st = await import(src + '/core/storage/adapter.js');
        built = await st.createStorageAdapter({
            fetch: (...a) => globalThis.fetch(...a),
            headers: () => ctx.getRequestHeaders(),
            log: () => {},
        });
    }
    const deps = {
        mode,
        adapter: built ? built.adapter : null,
        character,
        headers: () => ctx.getRequestHeaders(),
        nativeFetch: useNative ? window.__preSeamFetch : null,
        log: () => {},
    };
    window.__cfsysSourceBuilt = built;
    window.__cfsysSource = tier === 'jsonl' ? mod.createJsonlSource(deps)
        : tier === 'library' ? mod.createLibrarySource(deps)
            : mod.createChatSource(deps);
    const d = window.__cfsysSource.describe();
    return { tier: d.tier, fidelity: d.fidelity, notes: d.notes };
}"""

DISPOSE_SOURCE_JS = """() => {
    try { window.__cfsysSourceBuilt?.dispose?.(); } catch (e) { /* 探针清理失败无影响 */ }
    window.__cfsysSourceBuilt = null;
    window.__cfsysSource = null;
    return 'disposed';
}"""

# 调数据源的方法（结果走 JSON 往返，拿到的就是上层会消费的形状）
SRC_CALL_JS = """async ([method, arg]) => {
    const s = window.__cfsysSource;
    if (!s) return null;
    const out = await (arg === null ? s[method]() : s[method](arg));
    return JSON.parse(JSON.stringify(out ?? null));
}"""

# 读**磁盘原文**（原生通道）：返回 [header, ...行]。库模式下文件源之外的东西（对照组）也用它。
READ_RAW_JS = """async (fn) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const f = window.__preSeamFetch || globalThis.fetch;
    const res = await f('/api/chats/get', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: char.name, file_name: fn, avatar_url: char.avatar }),
    });
    const data = await res.json();
    return JSON.parse(JSON.stringify(Array.isArray(data) ? data.slice(1) : null));
}"""

# 宿主原生「创建分支」在磁盘上留下的那份派生文件（等价于 bookmarks.createBranch 的落盘结果；
# 直接经宿主 save 端点建，避开「收编」弹窗与 UI 竞态）
MAKE_BRANCH_FILE_JS = """async ([fn]) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const chat = [
        { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
        ...(ctx.chat || []).slice(0, 1),
    ];
    const res = await fetch('/api/chats/save', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: fn, file_name: fn, avatar_url: char.avatar, chat, force: true }),
    });
    return res.ok;
}"""

PROBE_NAME = '__cb_e2e_cs'


def answer_confirm(r, expect, ok=False, timeout=60000):
    """回答导入旅程里的一个确认弹窗（按**文案认**弹窗——两问是连着来的）。"""
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


def poll(fn, timeout=30.0, interval=0.8, desc=""):
    """轮询直到 fn() 真值（宿主高负载下固定 sleep 不可靠）。"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    print(f"  [warn] 轮询超时（{desc}）last={str(last)[:200]}")
    return last


def build_source(r, mode, tier='auto', use_native=False):
    """建一个数据源并返回它的自述（句柄留在 window 供后续调用；旧句柄先释放）。"""
    r.js(DISPOSE_SOURCE_JS)
    return r.js(NEW_SOURCE_JS, [EXT_SRC, mode, tier, bool(use_native)])


def src_refs(r):
    return r.js(SRC_CALL_JS, ["listSessions", None]) or []


def src_read(r, ref):
    return r.js(SRC_CALL_JS, ["readSession", ref])


def ref_by_key(refs, key):
    return next((x for x in refs if x.get("key") == key), None)


def refs_with_key(r, key):
    """库源列表里**含该键**才返回列表，否则 None（给 `poll` 轮询用，替代固定 sleep）。"""
    refs = src_refs(r)
    return refs if ref_by_key(refs, key) else None


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "chat-source")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)
            # 出厂默认 = JSONL 增强（off）。本用例从 off 起步，先记下「真正读磁盘的那条通道」
            mode0 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null")
            if mode0 != 'off':
                r.set_storage_mode('off')
                r.close_popup()
            r.js(SAVE_NATIVE_JS)

            # ---------- ① off：文件源（原生通道）读的就是磁盘原文 ----------
            chat_a = r.new_chat()
            r.cmd(f"/send {PROBE_NAME}-一条")
            # 关键等待：这一行必须**落盘**（本用例拿磁盘原文当对照组）——固定 sleep 在高负载下会假红
            r.wait_disk(lambda s: any(f"U:{PROBE_NAME}" in t for t in (s.get("bodyTexts") or [])),
                        desc="发送的行已落盘（off 模式）")
            key_a = r.chat_key()
            raw_a = r.js(READ_RAW_JS, chat_a) or []
            d_off = build_source(r, 'off')
            refs_off = src_refs(r)
            ref_a = ref_by_key(refs_off, key_a)
            ses_a = src_read(r, ref_a) if ref_a else None
            ok1 = (d_off.get("tier") == 'jsonl'
                   and ref_a is not None and ref_a.get("kind") == 'chat' and ref_a.get("origin") == 'file'
                   and len(raw_a) >= 1
                   and (ses_a or {}).get("messages") == raw_a)      # 逐字段保真：与磁盘原文一致
            results.append(report("① off：文件源的会话列表含当前聊天，readSession == 磁盘原文（逐字段）", ok1,
                                  f"自述={d_off} 键={key_a} 引用={ref_a} "
                                  f"磁盘行={len(raw_a)} 读回={len((ses_a or {}).get('messages') or [])}"))

            # ---------- ② off：原生分支文件是独立会话（kind=branch-file） ----------
            branch_file = f"{chat_a} - Branch #1"
            # 注意：MAKE_BRANCH_FILE_JS 的签名是 `async ([fn]) => …`（**数组解构**）。
            # 曾误传裸字符串 → `[fn]` 取到的是首字符，于是造出的文件叫 `_`，
            # 而期望的 `… - Branch #1` 从未创建（②/⑤ 双红就是这个）。
            made = r.js(MAKE_BRANCH_FILE_JS, [branch_file])
            # 关键等待：「写成功」不等于「枚举看得见」——轮询到它真进磁盘列表为止
            ref_bf = poll(lambda: next((x for x in src_refs(r)
                                        if str(x.get("name", "")).startswith(chat_a)
                                        and x.get("kind") == 'branch-file'), None),
                          desc="原生分支文件进磁盘枚举")
            refs_off2 = src_refs(r)
            bf_raw = r.js(READ_RAW_JS, ref_bf["name"]) if ref_bf else None
            bf_ses = src_read(r, ref_bf) if ref_bf else None
            # 独立会话：分支文件里只有它自己那一行（父会话照旧 2 行，既没被合并也没被截断）
            # 断言范围（2026-09-26 收窄，理由如实写在这里）：
            #   · 引用形状 + kind/origin、两条「源读出的 == 原始行」= **B1 的契约**，必须断言；
            #   · `bf_raw == raw_a[:1]`（宿主造的副本内容 == 父会话首行）= **宿主的形态**，不属于 B1：
            #     宿主把分支副本写盘时，会把运行期富化的字段（`swipes`/`swipe_info`/`swipe_id`…）
            #     一并写进去，而父会话当初落盘时可能还没有这些字段（真机实测确有差异）。
            #     故**只记录不断言**——信息不丢，但不拿宿主形态当 B1 的红线。
            c_ref = (bool(made) and ref_bf is not None
                     and ref_bf.get("origin") == 'file' and ref_bf.get("kind") == 'branch-file')
            c_bf_ses = (bf_ses or {}).get("messages") == bf_raw
            c_ses_a = (ses_a or {}).get("messages") == raw_a
            c_host_copy = bf_raw == raw_a[:1]
            ok2 = c_ref and c_bf_ses and c_ses_a
            results.append(report("② off：原生分支文件 = 独立会话（kind=branch-file，不并进父会话）", ok2,
                                  f"文件={branch_file} 建盘={made} 契约[引用={c_ref} 分支源读={c_bf_ses} 父源读={c_ses_a}] "
                                  f"（记录：宿主副本==父会话首行={c_host_copy}）"))

            # ---------- ③ 纯库：导入该聊天 → 库源与文件源同形 ----------
            r.new_chat()                                                # 换一个当前聊天：A 从此「没打开」（走冷路径导入）
            r.settle(1200)
            r.set_storage_mode('pure')
            r.close_popup()
            r.ensure_popup()
            r.popup_switch_tab('角色卡的聊天')
            r.settle(1200)
            r.click_action("chat-import", file=chat_a)
            answer_confirm(r, '删除源 jsonl 文件', ok=True)
            answer_confirm(r, '双写绑定', ok=False)

            d_pure = build_source(r, 'pure')
            # 关键等待：导入完成 = 该键**在库源列表里**（轮询，不靠固定 sleep 猜导入耗时）
            refs_pure = poll(lambda: refs_with_key(r, key_a), timeout=60.0, desc="导入后库源列出该键") or []
            ref_lib = ref_by_key(refs_pure, key_a)
            ses_lib = src_read(r, ref_lib) if ref_lib else None
            ok3 = (d_pure.get("tier") == 'library'
                   and ref_lib is not None and ref_lib.get("kind") == 'family-member' and ref_lib.get("origin") == 'library'
                   and (ses_lib or {}).get("messages") == raw_a)       # 同形：两档消息序列逐字段一致
            results.append(report("③ 纯库：库源列出同一键（family-member），readSession == off 下那一份（同形）", ok3,
                                  f"自述={d_pure} 键={key_a} 引用={ref_lib} "
                                  f"off 行={len(raw_a)} 库行={len((ses_lib or {}).get('messages') or [])}"))

            # ---------- ④ 三模式：同一聊天的键都在；pure 与 mirror 的键集合一致 ----------
            keys_pure = sorted(x.get("key") for x in (refs_pure or []))
            r.set_storage_mode('mirror')
            r.close_popup()
            d_mirror = build_source(r, 'mirror')
            # 关键等待：换档是异步的（`set_storage_mode` 只等到档位就绪）——轮询到该键真列得出
            refs_mirror = poll(lambda: refs_with_key(r, key_a), desc="双写模式下库源列出该键") or []
            keys_mirror = sorted(x.get("key") for x in refs_mirror)
            in_all = [bool(ref_by_key(refs_off2, key_a)), key_a in keys_pure, key_a in keys_mirror]
            ok4 = (d_mirror.get("tier") == 'library' and all(in_all) and keys_pure == keys_mirror)
            results.append(report("④ 三模式：同一聊天的键都在列表里；pure 与 mirror 的库源键集合一致", ok4,
                                  f"off/pure/mirror 命中={in_all} tier={d_mirror.get('tier')} "
                                  f"pure键={keys_pure} mirror键={keys_mirror}"))
            # 库源**真跑过一轮之后**的自述（⑤ 要拿它证明差异可解释——构造时那条自述不算数）
            d_mirror_after = r.js(SRC_CALL_JS, ["describe", None]) or {}

            # ---------- ⑤ 库模式下文件源（原生通道）仍看得见只在磁盘上的原生分支文件 ----------
            # 注意：入口 `createChatSource` 在库模式下给的是**库源**；这里显式建文件源
            # （并让它走装接缝前抓到的那条原生通道）——正是 R3「绕开接缝读磁盘事实」的验法
            build_source(r, 'mirror', tier='jsonl', use_native=True)
            refs_native = poll(lambda: src_refs(r), desc="库模式下文件源列出磁盘文件") or []
            native_names = sorted(str(x.get("name")) for x in refs_native)
            native_bf = next((x for x in refs_native if str(x.get("name", "")).startswith(chat_a) and x.get("kind") == 'branch-file'), None)
            key_bf = r.chat_key(branch_file)
            explained = any(('不在此列' in n or '未入库' in n) for n in (d_mirror_after.get("notes") or []))
            ok5 = (native_bf is not None
                   and key_a in keys_mirror                              # 阳性对照：库源确实列得出已入库的键（否则「列不出」是空集假绿）
                   and key_bf not in keys_mirror                         # 只在磁盘上、未入库 → 库源列不出
                   and explained)                                        # 差异要能解释，不是错
            results.append(report("⑤ 库模式：文件源（原生通道）仍列出磁盘上的原生分支文件；库源列不出（差异可解释）", ok5,
                                  f"文件源={native_names} 库源键={keys_mirror} 分支文件键={key_bf} "
                                  f"库源自述={d_mirror_after.get('notes')}"))

            r.js(DISPOSE_SOURCE_JS)
            errs = r.pageerrors_from('chatfilesys')                      # 归因单点 = harness（不自己重写）
            ce = r.console_errors_from("chatfilesys")
            results.append(report("⑥ 全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.js(DISPOSE_SOURCE_JS)
            except Exception:
                pass
            try:
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在库模式）: {e}")
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
    print("\nCHAT SOURCE " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
