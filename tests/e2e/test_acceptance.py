"""阶段六：PRD 第一期验收 8 条 —— 单文件全旅程（一个脚本走完）。

1 原生流程无感知聊天  2 分叉零复制  3 双分支互不串扰  4 切换零网络+UI高亮
5 关插件 vanilla 兼容+重启用自愈  6 增量导出纯标准 JSONL  7 编辑/删除/swipe 原生一致
8 全程无报错 + round-trip 无损
"""
import json
import sys
import time
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR, PANEL

results = []


def boot_vanilla(r, timeout=90000):
    r.pg.reload(wait_until="domcontentloaded")
    r.pg.wait_for_selector("#send_textarea", state="attached", timeout=timeout)
    r.settle(3000)


def scenario(r):
    # ---------- 1 原生流程无感知聊天 ----------
    for cmd in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
        r.cmd(cmd)
        r.settle(650)
    st = r.wait_state(lambda s: s["chatLen"] == 5 and s["activeFloors"] == 5, desc="验收1 造楼")
    results.append(report("验收1:原生流程聊天无感知（自动登记）",
                          st["domMes"] == 5 and st["branches"] is not None, f"{st['chatLen']}/{st['domMes']}"))

    # ---------- 2 任意楼层分叉零复制 ----------
    r.click_action("fork", floor=3)
    r.popup_ok()
    r.settle(1500)
    st = r.wait_state(lambda s: s["activeId"] != "b_main" and s["activeFloors"] == 3, desc="验收2 分叉")
    d = r.disk_state()
    shared = all(st["branches"][0]["path"].get(f) == st["branches"][1]["path"].get(f)
                 for f in ("1", "2", "3"))
    # 零复制 = body 折叠到分叉点（3 行）、原尾部进 groups 只存一份、两分支前缀 gid 相同
    results.append(report("验收2:分叉零复制（body=分叉点+尾部折叠进 groups+前缀共享）",
                          d["bodyLen"] == 3 and d["groups"] == 2 and len(st["branches"]) == 2 and shared,
                          f"body={d['bodyLen']} groups={d['groups']} branches={len(st['branches'])} shared={shared}"))

    # ---------- 3 双分支各自续聊互不串扰 ----------
    r.cmd("/send U-b1-F4")
    r.settle(650)
    r.cmd(f"/sendas name={TEST_CHAR} A-b1-F5")
    r.settle(650)
    r.ensure_active("b_main")
    r.cmd("/send U-main-F6")
    r.settle(800)
    st = r.wait_state(lambda s: s["chatLen"] == 6, desc="验收3 main续聊")
    b1 = next(b for b in st["branches"] if b["id"] == "b1")
    bmain = next(b for b in st["branches"] if b["id"] == "b_main")
    no_cross = (b1["floors"] == 5 and bmain["floors"] == 6
                and b1["path"].get("4") == "g6" and bmain["path"].get("4") == "g4")
    texts = st["mesTexts"]
    results.append(report("验收3:双分支互不串扰", no_cross and "U:U-b1-F4" not in texts and "U:U-main-F6" in texts,
                          f"b1={b1['floors']}层 main={bmain['floors']}层 texts={texts}"))

    # ---------- 4 切换零网络 + UI 高亮 ----------
    chat_id = st["chatFile"]
    writes = []
    def on_req(req):
        if "/api/chats/" in req.url and req.method == "POST":
            body = req.post_data or ""
            if chat_id.split(" - ")[0] in body or chat_id in body:
                writes.append(req.url.split("/api/chats/")[-1].split("?")[0])
    r.pg.on("request", on_req)
    writes.clear()
    t0 = time.time()
    r.ensure_active("b1")
    switch_ms = (time.time() - t0) * 1000
    r.settle(1200)
    st = r.wait_state(lambda s: s["activeId"] == "b1" and s["chatLen"] == 5, desc="验收4 切换")
    # 2.4 写路径迁移后：切换 = 移除批（deleteMessages→patch）+ 追加批（addMessages→append）
    # 两次官方写（metadata 随每次持久化搭车），无全量 save 回退、无多余 get
    n_patch = sum(1 for w in writes if w in ("patch", "save", "append"))
    has_full_save = "save" in writes
    active_el = r.js(f"""() => {{
        const el = document.querySelector('{PANEL} .chatfilesys-branch.active');
        return el ? el.querySelector('.name')?.textContent?.trim() : null;
    }}""")
    results.append(report("验收4:切换最小写入（官方 API 移除批+追加批，无全量回退）", n_patch <= 2 and not has_full_save,
                          f"writes={writes} 耗时={switch_ms:.0f}ms"))
    results.append(report("验收4:UI 高亮正确", active_el is not None and "b1" in (active_el or "") or (active_el or "").startswith("分叉"),
                          f"active={active_el}"))

    # ---------- 5 关插件 vanilla + 重启用自愈 ----------
    r.js("""async (file) => {
        const m = await import('/scripts/extensions.js');
        await m.disableExtension('third-party/chatfilesys', false);
        const sm = await import('/script.js');
        await sm.openCharacterChat(file);
        return 'disabled+opened';
    }""", chat_id)
    boot_vanilla(r)
    # 验收4 后活跃分支 = b1（5 层），文件 body 即 b1 投影
    r.wait_state(lambda s: s["chatLen"] == 5, timeout=40000, desc="vanilla 打开聊天")
    vanilla = r.js("""() => ({
        panelGone: !document.querySelector('#chatfilesys-settings') ||
                   !document.querySelector('#chatfilesys-settings .chatfilesys-settings-status')?.innerHTML,
        domMes: document.querySelectorAll('#chat .mes').length,
        model: SillyTavern.getContext().chatMetadata?.extensions?.chatfilesys ?
               JSON.parse(JSON.stringify(SillyTavern.getContext().chatMetadata.extensions.chatfilesys)) : null,
    })""")
    r.cmd("/send U-vanilla-F6")
    r.settle(1200)
    vanilla_after = r.js("""() => ({
        chatLen: SillyTavern.getContext().chat.length,
        modelFloors: Object.keys(SillyTavern.getContext().chatMetadata?.extensions?.chatfilesys?.branches
            ?.find(b => b.id === 'b_main')?.path || {}).length,
    })""")
    results.append(report("验收5:vanilla 打开分支完好+元数据保留",
                          vanilla["panelGone"] and vanilla["domMes"] == 5 and vanilla["model"] is not None
                          and vanilla_after["chatLen"] == 6 and vanilla_after["modelFloors"] == 6,
                          f"panelGone={vanilla['panelGone']} domMes={vanilla['domMes']} chatLen={vanilla_after['chatLen']} mainFloors={vanilla_after['modelFloors']}"))

    # 重启用 → 自愈登记 vanilla 期间新增楼层（b1: 5 → 6）
    r.js("""async () => {
        const m = await import('/scripts/extensions.js');
        await m.enableExtension('third-party/chatfilesys', false);
        return 'enabled';
    }""")
    boot_vanilla(r)
    r.js("""async (file) => {
        const sm = await import('/script.js');
        await sm.openCharacterChat(file);
        return 'opened';
    }""", chat_id)
    r.wait_state(lambda s: s["chatLen"] == 6, timeout=40000, desc="重启用")
    st = r.wait_state(lambda s: s["activeFloors"] == 6, timeout=20000, desc="自愈登记")
    results.append(report("验收5:重启用后自愈登记楼层", st["activeFloors"] == 6,
                          f"floors={st['activeFloors']}"))

    # ---------- 6 增量导出纯标准 JSONL ----------
    with r.pg.expect_download(timeout=20000) as dl:
        r.click_action("export")
    raw = open(dl.value.path(), "rb").read().decode("utf-8")
    lines = [json.loads(x) for x in raw.strip().split("\n")]
    header = lines[0]
    ok_export = ("branches" not in (header.get("chat_metadata", {}).get("extensions") or {})
                 and len(lines) - 1 == 6
                 and all(isinstance(x.get("mes"), str) for x in lines[1:]))
    results.append(report("验收6:增量导出纯标准 JSONL", ok_export,
                          f"lines={len(lines)-1} ext={list(header.get('chat_metadata', {}).get('extensions', {}).keys())}"))

    # ---------- 7 编辑/删除/swipe 与原生一致 ----------
    # 编辑（原生数据形态 + 官方事件流）
    r.js("""() => {
        const ctx = SillyTavern.getContext();
        ctx.chat[2].mes = '编辑后的F3';
        ctx.saveChat();
        window.eventSource = null;
        return 1;
    }""")
    r.settle(400)
    r.js("""async () => {
        const m = await import('/script.js');
        await m.eventSource.emit(m.event_types.MESSAGE_EDITED, 2);
        return 1;
    }""")
    r.settle(1200)
    r.popup_switch_tab("楼层")  # 楼层视图住 Tab 里（二期弹窗化），innerText 只含可见 Tab
    pt = r.panel_text() or ""
    results.append(report("验收7:编辑后面板同步", "编辑后的F3" in pt, pt[-150:]))

    # swipe（原生 swipes 数据形态：mes = 当前活跃变体）
    r.js("""async () => {
        const ctx = SillyTavern.getContext();
        const line = ctx.chat[5];
        line.swipes = [line.mes, 'swipe变体B'];
        line.swipe_info = [null, {}];
        line.swipe_id = 1;
        line.mes = line.swipes[1];
        await ctx.saveChat();
        const m = await import('/script.js');
        await m.eventSource.emit(m.event_types.MESSAGE_SWIPED, 5);
        return 1;
    }""")
    r.settle(1200)
    sw = r.js(f"""() => {{
        const el = [...document.querySelectorAll('{PANEL} .chatfilesys-floor .swipes')];
        return el.map(x => x.textContent.trim()).join(',');
    }}""")
    results.append(report("验收7:swipe 面板显示变体数", "swipe 2/2" in sw, f"sw={sw}"))

    # 删除（面板路径，全局重编号：位置 F6 同时离开两个分支）
    r.click_action("delete-floor", floor=6)
    r.popup_ok()
    r.wait_state(lambda s: s["chatLen"] == 5, timeout=20000, desc="验收7 删层")
    st = r.state()
    bmain = next(b for b in st["branches"] if b["id"] == "b_main")
    results.append(report("验收7:删除楼层全局重编号", st["chatLen"] == 5 and bmain["floors"] == 5,
                          f"chatLen={st['chatLen']} main={bmain['floors']}层 texts={st['mesTexts']}"))

    # ---------- 8 round-trip 无损 + 无报错 ----------
    r.pg.reload(wait_until="domcontentloaded")
    r.wait_state(lambda s: s["chatLen"] >= 5, timeout=40000, desc="重载")
    r.settle(1500)
    mem = r.js("""() => {
        const ctx = SillyTavern.getContext();
        return { model: JSON.stringify(ctx.chatMetadata.extensions.chatfilesys),
                 texts: ctx.chat.map(x => `${x.is_user ? 'U' : 'A'}:${x.mes}`) };
    }""")
    d = r.disk_state()
    disk_texts = d["bodyTexts"]
    ok_rt = (json.loads(mem["model"])["active_branch"] == d["activeId"]
             and mem["texts"] == disk_texts
             and len(d["branches"]) == 2)
    results.append(report("验收8:round-trip 无损（内存=磁盘）", ok_rt,
                          f"mem={len(mem['texts'])} disk={len(disk_texts)}"))


def main():
    errs = []
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            try:
                r.delete_test_char()
                r.settle(800)
            except Exception:
                pass
            res = r.create_test_char()
            created = res.get("status") == 200
            if not created:
                print("create char failed:", res)
                return 1
            r.open_test_char()
            r.settle(2500)

            scenario(r)

            cb_page = r.pageerrors_from("chatfilesys")
            cb_console = r.console_errors_from("chatfilesys")
            errs = cb_page + [t for t, s in cb_console]
            results.append(report("验收8:全程 chatfilesys 零报错", not errs, str(errs[:4])))

        except Exception:
            traceback.print_exc()
            results.append(report("harness 执行", False, "异常见上"))
        finally:
            if created:
                print("--- cleanup ---")
                try:
                    print("delete char:", r.delete_test_char())
                except Exception as e:
                    print("cleanup failed:", e)
            b.close()

    print("\n=== SUMMARY ===")
    print(f"pass {sum(results)}/{len(results)}")
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
