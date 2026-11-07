#!/usr/bin/env python3
"""
e2e：web 同构工作台（纯静态页，不依赖酒馆实例）—— 任务 11-07-web-workbench-iso AC1/AC2/AC3。

前置：本仓根的静态服务器在跑（`npx --yes http-server . -p 3050 -a 127.0.0.1 -s --cors -c-1`，
PO-4 登记端口）。**真机纪律**：本用例不碰任何酒馆实例（P-11 无涉）。

判定打印先于退出（真机卫生：判定行必须在 browser 关闭前落 stdout）。
"""
import sys
import traceback

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3050/web/index.html"

results = []


def report(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def launch(p):
    """本机 playwright 驱动比已装浏览器新一版（要 1248，装到 1243）——直接指到已装的可执行文件，
    不动共享环境（playwright install 是下载动作，未经授权不做）。"""
    import glob
    import os
    for pat in (r"C:\Users\caocaobi\AppData\Local\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64\chrome-headless-shell.exe",
                r"C:\Users\caocaobi\AppData\Local\ms-playwright\chromium-*\chrome-win64\chrome.exe"):
        cands = sorted(glob.glob(pat), reverse=True)
        if cands:
            return p.chromium.launch(headless=True, executable_path=cands[0],
                                     args=["--ignore-certificate-errors"])
    return p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])


def main():
    with sync_playwright() as p:
        b = launch(p)
        page = b.new_page(viewport={"width": 1280, "height": 940})
        try:
            page.goto(BASE, wait_until="domcontentloaded")
            page.wait_for_timeout(1200)

            # AC1：五页签同源挂载
            tabs = page.eval_on_selector_all(
                "[data-tabbtn]", "els => els.map(e => e.textContent.trim())")
            report("AC1 五页签挂载", tabs == ["当前聊天", "结构图", "角色卡的聊天", "设置", "回收站"], str(tabs))

            # AC2-0：载入示例 → 家族打开（真导入路径）
            page.click("#cfsysw-sample")
            page.wait_for_timeout(1200)
            header = page.eval_on_selector(
                ".chatfilesys-popup-header", "e => e.textContent.replace(/\\s+/g, ' ').trim()")
            report("AC2 示例导入开家族", "莉莉娅" in header, header)

            # AC3-1：AI 总结隐藏（web 无生成链路）
            ai_hidden = page.evaluate(
                "() => document.querySelector('[data-action=\"ai-summary\"]')?.hidden === true")
            report("AC3 AI 总结隐藏", ai_hidden)

            # AC3-2：双写同步置灰（web 无宿主文件通道）
            mirror_disabled = page.evaluate(
                "() => document.querySelector('[data-action=\"sync-mirror\"]')?.disabled === true")
            report("AC3 双写同步置灰", mirror_disabled)

            # AC3-3：主分支删除置灰（与插件同一条护城河判据）
            del_disabled = page.evaluate(
                "() => document.querySelector('[data-action=\"delete-branch\"]')?.disabled === true")
            report("AC3 主分支删除置灰", del_disabled)

            # AC2-1：版本管理模态打开（同源 buildVersionsContent）
            page.click("#cfsysw-versions")
            page.wait_for_timeout(900)
            ver_head = page.eval_on_selector(
                ".cfsysw-modal .chatfilesys-ver-head", "e => e.textContent.replace(/\\s+/g, ' ').trim()")
            report("AC2 版本模态打开", "2 个版本" in ver_head, ver_head)
            page.evaluate("() => [...document.querySelectorAll('.cfsysw-modal button')]"
                          ".find(x => x.textContent === '关闭')?.click()")
            page.wait_for_timeout(300)

            # AC2-2：设置页签真数据（registry 生成 + 档位徽章如实）
            page.click("[data-tabbtn='settings']")
            page.wait_for_timeout(500)
            badge = page.eval_on_selector(
                "[data-tabbody='settings'] [data-role='storage-status']", "e => e.textContent.trim()")
            item_count = page.evaluate(
                "() => document.querySelectorAll('[data-tabbody=\\'settings\\'] [data-role=\\'setting\\']').length")
            report("AC2 设置页签真数据", "IndexedDB" in badge and item_count >= 20, f"{badge} · {item_count} 项")

            # AC3-4：回收站如实说明（idb 档无目录，不给假空列表）
            page.click("[data-tabbtn='trash']")
            page.wait_for_timeout(400)
            trash_note = page.eval_on_selector(
                "[data-tabbody='trash'] .chatfilesys-trash-host", "e => e.textContent.trim()")
            report("AC3 回收站如实说明", "没有回收站目录" in trash_note, trash_note[:60])

            # AC2-3：结构图页签真渲染（librarySource 接 idb）
            page.click("[data-tabbtn='graph']")
            page.wait_for_timeout(2500)
            graph_status = page.eval_on_selector(
                "[data-tabbody='graph'] [data-role='graph-status']", "e => e.textContent.trim()")
            report("AC2 结构图渲染", "节点" in graph_status and "边" in graph_status, graph_status[:80])

            # 零 JS 异常断言（归因零报错的页面级形态）：收集一遍 console errors
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1200)
            report("零页面异常", not errs, "; ".join(errs[:3]))

        except Exception as e:
            report("用例执行", False, f"{e}\n{traceback.format_exc()[-600:]}")
        finally:
            # 判定打印先于 browser.close（真机卫生纪律）
            print("---")
            ok = sum(1 for _, x, _ in results if x)
            print(f"TOTAL: {ok}/{len(results)} PASS")
            b.close()


if __name__ == "__main__":
    main()
    ok = sum(1 for _, x, _ in results if x)
    sys.exit(0 if ok == len(results) and results else 1)
