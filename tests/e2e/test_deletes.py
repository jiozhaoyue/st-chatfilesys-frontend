"""e2e：删层（deleteFloorFlow）/ 删分支（deleteBranchFlow）/ 保护路径（默认·活跃分支）。

前提语义（core/branches.js + projection.js）：
- 删层 F：所有分支失去 F，>F 楼层/fork_base/groups.floor 前移；活跃分支 body 配对 remove。
- 删分支：仅 GC 私有组（无引用）；默认分支不可删；活跃分支不可删（先切走）。
"""
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def build_family(r, floors):
    """造 5 层家族：F1 开场(A) → U-F2 → A-F3 → U-F4 → A-F5；再 F3 分叉出 b1 并续 2 层。"""
    cmds = ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]
    for c in cmds[: floors - 1]:
        r.cmd(c)
        r.settle(800)
    st = r.state()
    assert st["chatLen"] == floors, f"造楼失败: {st['chatLen']} != {floors}"
    # F3 分叉（b1 自动激活，body 折叠到 3 层）
    r.click_action("fork", floor=3)
    r.popup_ok()
    r.settle(1500)
    st = r.state()
    assert st["activeId"] != "b_main" and st["activeFloors"] == 3, f"分叉未激活: {st['activeId']}/{st['activeFloors']}"
    # b1 续 2 层（私有 g6/g7）
    r.cmd("/send U-b1-F4")
    r.settle(800)
    r.cmd(f"/sendas name={TEST_CHAR} A-b1-F5")
    r.settle(800)
    st = r.state()
    assert st["activeFloors"] == 5, f"b1 续楼失败: {st['activeFloors']}"
    return st


def back_to_main(r):
    r.click_action("switch", branch="b_main")
    r.settle(1500)
    st = r.state()
    assert st["activeId"] == "b_main" and st["chatLen"] == 5, f"切回主分支失败: {st['activeId']}/{st['chatLen']}"


def scenario_delete_floor(r):
    """删层：切回主分支后删 F2，验证重编号 + fork_base 平移 + 落盘一致。"""
    build_family(r, 5)
    back_to_main(r)

    r.click_action("delete-floor", floor=2)
    r.popup_ok()
    r.settle(2000)

    st = r.state()
    print("state:", {k: st[k] for k in ("chatLen", "domMes", "activeFloors", "groups")})
    print("mesTexts:", st["mesTexts"])
    print("branches:", st["branches"])

    b_main = next(b for b in st["branches"] if b["id"] == "b_main")
    b1 = next(b for b in st["branches"] if b["id"] != "b_main")
    ok_body = st["chatLen"] == 4 and st["domMes"] == 4
    ok_texts = st["mesTexts"] == ["A:开场问候语（F1）", "A:A-F3", "U:U-F4", "A:A-F5"]
    ok_main = b_main["path"] == {"1": "g1", "2": "g3", "3": "g4", "4": "g5"}
    ok_b1 = b1["fork"] == 2 and b1["path"] == {"1": "g1", "2": "g3", "3": "g6", "4": "g7"}
    results.append(report("删层:body 重绘+文本前移", ok_body and ok_texts,
                          f"{st['mesTexts']}"))
    results.append(report("删层:模型重编号（path/fork_base 平移）", ok_main and ok_b1,
                          f"main={b_main['path']} b1={b1['path']} fork={b1['fork']}"))
    results.append(report("删层:groups.floor 前移", st["groups"] == 2, f"groups={st['groups']}"))

    d = r.disk_state()
    print("disk:", d)
    ok_disk = (d.get("bodyLen") == 4
               and d.get("bodyTexts") == ["A:开场问候语（F1）", "A:A-F3", "U:U-F4", "A:A-F5"]
               and d.get("activeId") == "b_main"
               and {b["id"]: b["path"] for b in d["branches"]} == {
                   "b_main": {"1": "g1", "2": "g3", "3": "g4", "4": "g5"},
                   next(b["id"] for b in d["branches"] if b["id"] != "b_main"): {"1": "g1", "2": "g3", "3": "g6", "4": "g7"},
               })
    results.append(report("删层:落盘一致（重编号已持久化）", ok_disk, str(d)[:260]))

    # 面板重绘一致性：楼层视图应显示 4 层
    pt = r.panel_text()
    results.append(report("删层:面板无一致性警告", "不一致" not in pt, pt[:160]))


def scenario_delete_branch(r):
    """删分支：私有组 GC、共享组保留、默认分支无删除按钮。"""
    build_family(r, 5)
    back_to_main(r)

    # 默认分支不应渲染删除按钮
    n = r.js(f"""() => document.querySelectorAll('{PANEL_SEL} [data-action="delete-branch"][data-branch="b_main"]').length""")
    results.append(report("删分支:默认分支无删除按钮", n == 0, f"count={n}"))

    r.click_action("delete-branch", branch="b1")
    r.popup_ok()
    r.settle(2000)

    st = r.state()
    print("state:", {k: st[k] for k in ("chatLen", "domMes", "groups", "branches", "activeId")})
    ok = (st["activeId"] == "b_main" and st["chatLen"] == 5 and st["domMes"] == 5
          and len(st["branches"]) == 1 and st["groups"] == 0)
    results.append(report("删分支:树仅剩主分支+私有组 GC", ok, str(st["branches"])))

    d = r.disk_state()
    print("disk:", d)
    ok_disk = (d.get("bodyLen") == 5 and len(d.get("branches") or []) == 1
               and d.get("groups") == 0 and d.get("activeId") == "b_main")
    results.append(report("删分支:落盘一致", ok_disk, str(d)[:200]))


def scenario_delete_branch_guard(r):
    """保护路径：删除活跃分支 → 拒绝（toastr 错误 + 数据不变）。"""
    build_family(r, 5)  # 分叉后 b1 即活跃
    st0 = r.state()

    r.click_action("delete-branch", branch="b1")
    r.popup_ok()
    err = r.toastr_error()
    r.settle(800)
    st = r.state()
    print("toastr:", err, "| branches:", len(st["branches"]))
    results.append(report("删分支:活跃分支拒绝", err is not None and len(st["branches"]) == 2,
                          f"toast={err} branches={len(st['branches'])}"))
    ok_same = st["activeId"] == st0["activeId"] and st["activeFloors"] == 5
    results.append(report("删分支:拒绝后数据不变", ok_same, f"active={st['activeId']} floors={st['activeFloors']}"))
    # 默认分支删除的 core 守卫已由单测覆盖（UI 不渲染入口，无浏览器路径）


PANEL_SEL = 'dialog[open]:not([closing]) .chatfilesys-popup'


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            res = r.create_test_char()
            created = res.get("status") == 200
            if not created:
                print("create char failed:", res)
                return 1
            r.open_test_char()
            r.settle(2500)

            print("===== 场景1: 删层 =====")
            scenario_delete_floor(r)
            print("===== 场景2: 删分支 =====")
            r.new_chat()
            scenario_delete_branch(r)
            print("===== 场景3: 保护路径 =====")
            r.new_chat()
            scenario_delete_branch_guard(r)

            print("===== 错误归因 =====")
            cb_page = r.pageerrors_from("chatfilesys")
            cb_console = r.console_errors_from("chatfilesys")
            print("chatfilesys pageerrors:", cb_page[:5])
            print("chatfilesys console errors:", cb_console[:5])
            other = [s.split("\n")[0][:120] for s in r.errors if Runner._src_of(s) != "chatfilesys"]
            print("其他来源 pageerror（环境噪音）:", other[:5])
            results.append(report("chatfilesys 零错误（归因过滤）", not cb_page and not cb_console,
                                  f"page={cb_page[:2]} console={cb_console[:2]}"))

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
