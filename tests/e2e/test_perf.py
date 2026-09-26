"""阶段六性能抽查：百层聊天 × 多分支的切换耗时与 patch 载荷。

流程：直写 99 层进 ctx.chat → saveChat → 重载（触发一次性登记 100 层）
→ F50 分叉（中段分叉=折叠 50 层尾部）→ 主/分支持续切换 ×5 测均值与载荷 → 删层 F50。
"""
import sys
import time
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        patches = []  # (url, payload_len)

        def on_req(req):
            if "/api/chats/patch" in req.url and req.method == "POST":
                patches.append(len(req.post_data or ""))
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

            # 直写 99 层（绕开逐条 /send 的 UI 往返，单次全量落盘）
            t0 = time.time()
            r.js("""() => {
                const ctx = SillyTavern.getContext();
                for (let i = 2; i <= 100; i++) {
                    ctx.chat.push({
                        name: i % 2 ? 'perf-user' : 'perf-ai',
                        is_user: Boolean(i % 2), is_system: false,
                        send_date: Date.now(), mes: `perf层${i}`, extra: {},
                    });
                }
                return ctx.chat.length;
            }""")
            r.js("async () => { await SillyTavern.getContext().saveChat(); return 1; }")
            print(f"bulk push+save: {(time.time()-t0)*1000:.0f}ms")

            # 重载 → CHAT_CHANGED 一次性登记 100 层
            t0 = time.time()
            r.pg.reload(wait_until="domcontentloaded")
            r.wait_state(lambda s: s["chatLen"] >= 1, timeout=60000, desc="重载")
            r.wait_state(lambda s: s["activeFloors"] == 100, timeout=30000, desc="百层登记")
            reg_ms = (time.time() - t0) * 1000
            st = r.state()
            results.append(report("百层:登记 100 层（重载→注册）", st["activeFloors"] == 100,
                                  f"耗时={reg_ms:.0f}ms dom={st['domMes']}"))
            print(f"register 100 floors: {reg_ms:.0f}ms")

            # F50 中段分叉（折叠 50 层尾部）
            # R5：插件不再提供「新建分支」按钮（生产入口 = 宿主原生「创建分支 / 创建检查点」）
            r.pg.on("request", on_req)
            t0 = time.time()
            nb = r.create_branch(50, name="分叉·F50")
            r.settle(600)
            r.ensure_active(nb, tries=3, settle_ms=300)
            r.wait_state(lambda s: s["activeId"] != "b_main" and s["activeFloors"] == 50 and s["chatLen"] == 50,
                         timeout=30000, desc="中段分叉")
            fork_ms = (time.time() - t0) * 1000
            results.append(report("百层:F50 中段分叉（折叠 50 层）", True, f"耗时={fork_ms:.0f}ms"))
            print(f"fork@50: {fork_ms:.0f}ms")

            # 切换 ×5：折叠/展开 50 层尾部
            times = []
            for i in range(5):
                tgt = "b_main" if i % 2 == 0 else "b1"
                patches.clear()
                t0 = time.time()
                r.ensure_active(tgt, tries=3, settle_ms=300)
                r.wait_state(lambda s: s["activeId"] == tgt and s["chatLen"] == (100 if tgt == "b_main" else 50),
                             timeout=30000, desc=f"切换{tgt}")
                times.append((time.time() - t0) * 1000)
            avg = sum(times) / len(times)
            max_payload = max(patches) if patches else 0
            results.append(report("百层:切换 ×5 均值（50 层折叠/展开 diff）", avg < 5000,
                                  f"均值={avg:.0f}ms 最差={max(times):.0f}ms patch载荷峰值={max_payload}B"))
            print("switch times:", [f"{t:.0f}" for t in times], "payload peak:", max_payload)

            # 删层 F50（全局重编号；R5：删消息入口 = 宿主原生按钮，测试按数据层同路径重放）
            patches.clear()
            t0 = time.time()
            r.delete_floor(50)
            r.wait_state(lambda s: s["chatLen"] == 99, timeout=30000, desc="删层F50")
            del_ms = (time.time() - t0) * 1000
            results.append(report("百层:删层 F50（全局重编号）", True, f"耗时={del_ms:.0f}ms"))

            # 面板渲染耗时（重渲染一次 99 层视图）
            t0 = time.time()
            r.js(f"""() => {{
                const el = document.querySelector('dialog[open] .chatfilesys-popup .chatfilesys-tree-host');
                el.innerHTML = el.innerHTML; // 触发重排基准
            }}""")
            render_ms = (time.time() - t0) * 1000
            print(f"panel noop: {render_ms:.0f}ms")

            cb = r.pageerrors_from("chatfilesys")
            results.append(report("百层:chatfilesys 零错误", not cb, str(cb[:3])))

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
