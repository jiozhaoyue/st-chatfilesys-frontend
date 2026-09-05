"""冒烟：测试角色创建 → 自动建家族 → 造楼层（用户侧 + AI 回复侧）。"""
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            print("boot ok; panel:", r.panel_text())

            print("--- create test char ---")
            res = r.create_test_char()
            print("create:", res)
            created = res.get("status") == 200
            results.append(report("创建测试角色", created, str(res)))
            if not created:
                return 1

            print("--- open test char (new chat) ---")
            r.open_test_char()
            r.settle(2500)
            st = r.state()
            print("state after open:", {k: st[k] for k in ("chatLen", "domMes", "activeFloors", "chatFile", "charName", "groups")})
            print("branches:", st["branches"])
            print("panel:", r.panel_text())
            results.append(report("自动建家族（决策#6）", st["branches"] is not None and st["activeFloors"] >= 1,
                                  f"floors={st['activeFloors']} branches={st['branches']}"))

            print("--- build floors: user + AI ---")
            r.cmd("/send 用户第二层")
            r.settle(900)
            r.cmd(f"/sendas name={TEST_CHAR} AI第三层")
            r.settle(900)
            st = r.state()
            print("state:", {k: st[k] for k in ("chatLen", "domMes", "activeFloors", "groups")})
            print("mesTexts:", st["mesTexts"])
            ok = st["chatLen"] == 3 and st["activeFloors"] == 3
            results.append(report("楼层登记（用户侧+AI回复侧 syncAppendedFloors）", ok,
                                  f"chatLen={st['chatLen']} floors={st['activeFloors']}"))

            print("--- disk state ---")
            d = r.disk_state()
            print("disk:", d)
            results.append(report("落盘一致", d.get("bodyLen") == 3 and d.get("branches") is not None, str(d)[:200]))

            print("--- console errors ---")
            errs = r.console_errors()
            for e in errs[:10]:
                print("  ", e)
            print("pageerrors:", r.errors[:5])
            results.append(report("零 pageerror", len(r.errors) == 0, str(r.errors[:3])))

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
