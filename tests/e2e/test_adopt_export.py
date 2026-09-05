"""e2e：阶段四原生书签收编（决策 #8）+ 阶段五增量导出（决策 #9）。

收编：原生 createBranch 整文件复制 → CHAT_BRANCH_CREATED → 校验前缀 → 确认收编
      → 转楼层分支（零复制）+ 删复制文件 + extra.branches 引用清理。
不收编：取消 → 复制文件原样保留。
导出：导出当前分支 = 纯标准 JSONL（第一行 header 无 extensions.chatfilesys）；
      自动导出开关开启后发消息触发下载。
"""
import json
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def build_5_floors(r):
    for c in ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]:
        r.cmd(c)
        r.settle(700)
    r.wait_state(lambda s: s["chatLen"] == 5, desc="造楼")


def scenario_adopt(r):
    build_5_floors(r)

    # --- 收编路径（发射后不管：emit 会等本扩展弹窗，不能同步 await） ---
    r.fire_native_branch(2)  # 截断于第 3 层（mesId=2）
    name = r.popup_branch_name()
    print("native branch (from popup):", name)
    assert name, "收编弹窗未出现或未提取到文件名"
    r.arm_branch_promise_capture()
    r.popup_ok()    # 点击「收编」
    r.settle(2500)

    st = r.state()
    print("state:", {k: st[k] for k in ("chatLen", "groups")}, "branches:", st["branches"])
    adopted = next((b for b in st["branches"] if b["id"] != "b_main"), None)
    ok_adopt = (adopted is not None and adopted["fork"] == 3
                and adopted["path"] == {"1": "g1", "2": "g2", "3": "g3"})
    results.append(report("收编:树多一个共享前缀分支（零复制）", ok_adopt, str(st["branches"])))

    status = r.file_exists_on_server(name)
    results.append(report("收编:复制文件已删除", status == "missing", f"get {name} -> {status}"))

    # 原生 createBranch 在 emit 后同步 push 引用，扩展延后一拍再清——轮询到清干净
    ref_clean = False
    for _ in range(10):
        ex = r.js("() => SillyTavern.getContext().chat[2]?.extra?.branches ?? null")
        if ex == []:
            ref_clean = True
            break
        r.settle(700)
    results.append(report("收编:原生书签引用已清理", ref_clean, f"extra={ex}"))

    d = r.disk_state()
    results.append(report("收编:落盘一致（新分支持久化）",
                          len(d.get("branches") or []) == 2 and d.get("bodyLen") == 5,
                          f"branches={len(d.get('branches') or [])} body={d.get('bodyLen')}"))

    # --- 不收编路径 ---
    r.fire_native_branch(1)  # 截断于第 2 层
    name2 = r.popup_branch_name()
    assert name2, "收编弹窗未出现"
    r.popup_cancel()  # 点击「保留」
    r.settle(1500)
    st2 = r.state()
    status2 = r.file_exists_on_server(name2)
    results.append(report("不收编:复制文件原样保留", status2 == "exists", f"get {name2} -> {status2}"))
    results.append(report("不收编:树不变", len(st2["branches"]) == 2, f"branches={len(st2['branches'])}"))

    # 面板应显示 2 分支（收编的 + 主分支），复制文件独立存在但未收编
    results.append(report("不收编:弹窗后无残留 pageerror",
                          not r.pageerrors_from("chatfilesys"), str(r.pageerrors_from("chatfilesys")[:2])))
    return name2


def scenario_export(r, keep_file):
    # 手动导出（当前 b_main）
    st0 = r.state()
    with r.pg.expect_download(timeout=20000) as dl_info:
        r.click_action("export")
    dl = dl_info.value
    path = dl.path()
    raw = open(path, "rb").read().decode("utf-8")
    lines = [json.loads(x) for x in raw.strip().split("\n")]
    header, body = lines[0], lines[1:]
    print("export file:", dl.suggested_filename, "| lines:", len(body))
    print("header keys:", sorted(header.get("chat_metadata", {}).get("extensions", {}).keys()))
    ok_meta = "branches" not in (header.get("chat_metadata", {}).get("extensions") or {})
    results.append(report("导出:header 无分支元数据", ok_meta,
                          str(header.get("chat_metadata", {}).get("extensions", {}).keys())))
    ok_body = len(body) == st0["chatLen"] and all(
        body[i].get("mes") is not None for i in range(len(body)))
    results.append(report("导出:body = 当前分支投影（纯标准 JSONL）", ok_body, f"lines={len(body)}"))
    ok_name = dl.suggested_filename.endswith(".jsonl")
    results.append(report("导出:文件名 .jsonl 结尾", ok_name, dl.suggested_filename))

    # 自动导出：开启开关（点击 → 轮询确认 setting 持久化；被重渲染重置则重点）
    auto_on = False
    last = None
    for _ in range(12):
        r.js("() => document.querySelector('#chatfilesys-auto-export')?.click()")
        for _ in range(6):
            last = r.js("""() => {
                const el = document.querySelector('#chatfilesys-auto-export');
                return { checked: el?.checked ?? null,
                         setting: SillyTavern.getContext().extensionSettings?.['chatfilesys']?.auto_export ?? null };
            }""")
            if last["checked"] and last["setting"] is True:
                break
            r.settle(400)
        if last["checked"] and last["setting"] is True:
            auto_on = True
            break
    results.append(report("自动导出:开关可勾选", auto_on, str(last)))

    with r.pg.expect_download(timeout=25000) as dl2:
        r.cmd("/send 自动导出触发层")
    dl2v = dl2.value
    raw2 = open(dl2v.path(), "rb").read().decode("utf-8")
    body2 = [json.loads(x) for x in raw2.strip().split("\n")][1:]
    results.append(report("自动导出:发消息后自动下载", len(body2) == 6, f"lines={len(body2)}"))

    # 关闭开关，避免后续测试误触发
    r.js("""() => document.querySelector('#chatfilesys-auto-export')?.click()""")
    r.settle(400)

    # vanilla 兼容抽查：导出物不含分支元数据，且行序与磁盘 body 一致
    d = r.disk_state()
    ok_align = [x.get("mes") for x in body2] == [dict(mes=t.split(":",1)[1]) and t.split(":",1)[1] for t in d["bodyTexts"]]
    results.append(report("自动导出:内容与磁盘一致", ok_align, str(d["bodyTexts"])[:160]))
    _ = keep_file


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            try:
                r.delete_test_char()  # 清理上次中断残留的测试角色（含其聊天）
                r.js("""async () => { await SillyTavern.getContext().getCharacters(); return 1; }""")
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

            print("===== 场景1: 收编 / 不收编 =====")
            keep = scenario_adopt(r)
            print("===== 场景2: 导出 + 自动导出 =====")
            scenario_export(r, keep)

            print("===== 错误归因 =====")
            cb = r.pageerrors_from("chatfilesys")
            cbe = r.console_errors_from("chatfilesys")
            results.append(report("chatfilesys 零错误", not cb and not cbe, f"{cb[:2]} {cbe[:2]}"))

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
