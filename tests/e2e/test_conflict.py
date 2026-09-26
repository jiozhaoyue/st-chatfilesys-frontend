"""e2e：409 冲突路径（双标签页）——确定性陈旧视图方案。

核心语义（Instance/Dev/Luker/public/script.js resolveChatWriteConflictForTarget）：
- 409(integrity) → 同步 current_integrity → 快照失效 → patchChatMessages 返回 false
  → 扩展回退 ctx.saveChat() 全量落盘（FE-wins）→ 收敛到最后写者的完整视图。

场景1（确定性 409）：A 先完整切换（磁盘 integrity 前移）；B 仍持陈旧视图（旧 integrity + 旧 body），
B 再切换 → patch 必然 409 → 全量兜底 → 双页收敛到同一视图。零时序竞态。
场景2（并发分叉混沌）：双页几乎同时分叉，收敛后不变量必须成立（第一期无合并语义，允许一方被拒）。
"""
import sys
import time
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def build_family(r, floors=5):
    cmds = ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]
    for c in cmds[: floors - 1]:
        r.cmd(c)
        r.settle(700)
    r.wait_state(lambda s: s["chatLen"] == floors, desc="造楼")
    # R5：插件不再提供「新建分支」按钮（生产入口 = 宿主原生「创建分支 / 创建检查点」）；
    # 测试需要精确楼层，故走数据层建分支（等价于已删除的面板分叉）
    nb = r.create_branch(3, name="分叉·F3")
    r.settle(800)
    r.ensure_active(nb)
    st = r.wait_state(lambda s: s["activeId"] != "b_main" and s["activeFloors"] == 3, desc="分叉激活")
    r.cmd("/send U-b1-F4")
    r.settle(700)
    r.cmd(f"/sendas name={TEST_CHAR} A-b1-F5")
    r.settle(700)
    r.wait_state(lambda s: s["activeFloors"] == 5, desc="b1 续楼")
    r.ensure_active("b_main")


def invariants_ok(r):
    d = r.disk_state()
    if d.get("error"):
        return False, f"disk error {d}"
    m = d.get("branches")
    if m is None:
        return False, "no model on disk"
    ids = [b["id"] for b in m]
    if len(ids) != len(set(ids)):
        return False, f"duplicate branch ids {ids}"
    if d.get("activeId") not in ids:
        return False, f"active {d.get('activeId')} not in {ids}"
    active = next(b for b in m if b["id"] == d["activeId"])
    if active["floors"] != d.get("bodyLen"):
        return False, f"body {d.get('bodyLen')} != active projection {active['floors']}"
    return True, f"branches={ids} bodyLen={d.get('bodyLen')} active={d.get('activeId')}"


B1_TEXTS = ["A:开场问候语（F1）", "U:U-F2", "A:A-F3", "U:U-b1-F4", "A:A-b1-F5"]


def scenario_deterministic_409(A, B):
    # 1) A 完整切到 b1（磁盘 integrity 前移；body 尾部换为 b1 私有层——b1 与 main 等长 5 层）
    A.ensure_active("b1")
    A.wait_state(lambda s: s["activeId"] == "b1" and s["mesTexts"] == B1_TEXTS, desc="A 本地收敛")
    A.wait_disk(lambda d: d.get("activeId") == "b1" and d.get("bodyTexts") == B1_TEXTS, desc="A 落盘")
    print("A 完成切换并落盘: b1/5")

    # 2) B 持陈旧视图（b_main/5 + 旧 integrity）→ 切 b1 → patch 必然 409 → 全量兜底
    stb0 = B.state()
    print("B 陈旧视图:", {k: stb0[k] for k in ("activeId", "chatLen")})
    assert stb0["activeId"] == "b_main" and stb0["chatLen"] == 5, f"B 应持陈旧主分支视图: {stb0}"
    B.click_action("switch", branch="b1")
    stb = B.wait_state(lambda s: s["activeId"] == "b1" and s["mesTexts"] == B1_TEXTS,
                       timeout=30000, desc="B 冲突恢复")
    print("B 恢复后:", {k: stb[k] for k in ("activeId", "chatLen", "domMes", "groups")})
    results.append(report("409:B(陈旧视图)收敛到 b1 投影", stb["chatLen"] == 5 and stb["mesTexts"] == B1_TEXTS,
                          f"len={stb['chatLen']} texts={stb['mesTexts']}"))

    # 冲突证据（核心 notifyChatWriteConflict / 扩展回退 warn；informational）
    ev = [t for t, s in B.console_errors_from("chatfilesys")] + \
         [txt for typ, txt, src in B.logs if "conflict" in txt.lower() or "409" in txt]
    print("B 冲突相关日志:", ev[:4])

    # 3) 磁盘不变量 + 双页一致
    ok, why = invariants_ok(B)
    results.append(report("409:磁盘不变量成立", ok, why))
    sta = A.state()
    results.append(report("409:双页视图一致",
                          sta["activeId"] == "b1" and sta["mesTexts"] == B1_TEXTS and stb["mesTexts"] == B1_TEXTS,
                          f"A={sta['activeId']}/{sta['chatLen']} B={stb['activeId']}/{stb['chatLen']}"))
    cb = A.pageerrors_from("chatfilesys") + B.pageerrors_from("chatfilesys")
    results.append(report("409:chatfilesys 零 pageerror", not cb, str(cb[:3])))


def scenario_concurrent_forks(A, B):
    """混沌：双页几乎同时分叉 → 收敛后磁盘不变量成立 + 双页重载同视图。"""
    A.new_chat()
    A.cmd("/send U-F2")
    A.settle(800)
    B.pg.reload(wait_until="domcontentloaded")
    B.boot()
    B.wait_state(lambda s: s["chatLen"] == 2, timeout=30000, desc="B 同步到同一聊天")
    print("B resync ok:", B.state()["chatFile"], B.state()["chatLen"])

    A.create_branch(2, name="并发·F2")
    time.sleep(0.15)
    B.create_branch(2, name="并发·F2")
    A.settle(5000)

    ok, why = invariants_ok(A)
    print("A 视角磁盘:", why)
    results.append(report("混沌:收敛后磁盘不变量", ok, why))

    for r, tag in ((A, "A"), (B, "B")):
        r.pg.reload(wait_until="domcontentloaded")
        r.boot()
        r.wait_state(lambda s: s["chatLen"] >= 1, timeout=40000, desc=f"{tag} 重载")
        r.settle(1500)
        ok, why = invariants_ok(r)
        warn = "不一致" in (r.panel_text() or "")
        results.append(report(f"混沌:{tag} 重载后一致且无警告", ok and not warn, f"{why} warn={warn}"))
        print(f"{tag} model:", [(b['id'], b['floors'], b['fork']) for b in r.state()["branches"]])

    cb = A.pageerrors_from("chatfilesys") + B.pageerrors_from("chatfilesys")
    results.append(report("混沌:chatfilesys 零 pageerror", not cb, str(cb[:3])))


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        A = Runner(c.new_page(), "A")
        B = Runner(c.new_page(), "B")
        created = False
        try:
            A.boot()
            res = A.create_test_char()
            created = res.get("status") == 200
            if not created:
                print("create char failed:", res)
                return 1
            A.open_test_char()
            A.settle(2500)
            build_family(A)

            # B 启动并落到同一聊天（拿到陈旧但同构的 b_main/5 视图）
            B.boot()
            B.wait_state(lambda s: s["chatLen"] >= 1, timeout=40000, desc="B boot")
            if TEST_CHAR not in (B.state().get("chatFile") or ""):
                B.open_test_char()
            B.wait_state(lambda s: TEST_CHAR in (s.get("chatFile") or "") and s["chatLen"] == 5,
                         timeout=30000, desc="B 落到测试聊天")
            print("B ready:", B.state()["chatFile"], B.state()["chatLen"])

            print("===== 场景1: 确定性 409（陈旧视图写回） =====")
            scenario_deterministic_409(A, B)

            print("===== 场景2: 并发分叉混沌 =====")
            scenario_concurrent_forks(A, B)

        except Exception:
            traceback.print_exc()
            results.append(report("harness 执行", False, "异常见上"))
        finally:
            if created:
                print("--- cleanup ---")
                try:
                    print("delete char:", A.delete_test_char())
                except Exception as e:
                    print("cleanup failed:", e)
            b.close()

    print("\n=== SUMMARY ===")
    print(f"pass {sum(results)}/{len(results)}")
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
