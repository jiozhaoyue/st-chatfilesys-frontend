"""e2e：JSONL 增强模式（off）下宿主原生删消息后的层号重排（W1）。

背景（见 `core/floor-diff.js` 模块头）：
- `MESSAGE_DELETED` 的载荷只有 `(chat.length, {kind:'delete', ...})`——**不含被删下标**；
- off 模式下模型住在聊天文件头里，宿主不会替我们重排楼层号（纯库/双写由接缝在 `remove /N` 时排）；
- 于是靠「改动前后 body 的**对象引用差**」反推被删楼层，再 `deleteFloorEverywhere` 全局删层。

本用例走**宿主自己的删除 API**（`ctx.deleteMessages(idx)`，与用户点原生「删除消息」是同一条
`messages.js#deleteMessages` 路径：splice → patchChatMessages → emit MESSAGE_DELETED）。

断言：删中间层与删末层后，模型层数 = 聊天体行数（不变式 1）、path 仍是 1..N 连续前缀、
被删楼层的组不再被任何分支引用、**落盘（重新拉取聊天文件）与内存一致**、重载后仍自洽。

用法: python tests/e2e/test_off_mode_delete_reorder.py
"""
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def build_family(r, floors=5):
    """造 5 层家族（off 模式）+ 在 F3 分叉出一条 5 层的分支 b1，最后切回主分支。"""
    cmds = ["/send U-F2", f"/sendas name={TEST_CHAR} A-F3", "/send U-F4", f"/sendas name={TEST_CHAR} A-F5"]
    for c in cmds[: floors - 1]:
        r.cmd(c)
        r.settle(800)
    st = r.state()
    assert st["chatLen"] == floors, f"造楼失败: {st['chatLen']} != {floors}"
    assert st["branches"], "off 模式新聊天应已自动启用分支模型"
    # F3 分叉（零复制、共享前缀）+ 续 2 层私有楼层
    nb = r.create_branch(3, name="分叉·F3")
    r.settle(800)
    r.ensure_active(nb)
    r.cmd("/send U-b1-F4")
    r.settle(800)
    r.cmd(f"/sendas name={TEST_CHAR} A-b1-F5")
    r.settle(800)
    st = r.state()
    assert st["activeFloors"] == 5, f"b1 续楼失败: {st['activeFloors']}"
    r.click_action("switch", branch="b_main")
    r.settle(1500)
    st = r.state()
    assert st["activeId"] == "b_main" and st["chatLen"] == 5, f"切回主分支失败: {st['activeId']}/{st['chatLen']}"
    return st


def native_delete(r, idx):
    """宿主自己的删除路径（= 用户点原生「删除消息」）。"""
    return r.js("""async (i) => {
        const ctx = SillyTavern.getContext();
        const before = ctx.chat.length;
        await ctx.deleteMessages(i);
        return { before, after: ctx.chat.length };
    }""", idx)


def assert_contiguous(r, label):
    """不变式 1 + 2：活跃分支层数 = 聊天体行数；所有分支 path 都是 1..N 连续前缀。"""
    st = r.state()
    assert st["activeFloors"] == st["chatLen"], \
        f"{label}: 分支层数 {st['activeFloors']} != 聊天体 {st['chatLen']}（模型未重排）"
    assert st["domMes"] == st["chatLen"], f"{label}: DOM 条数 {st['domMes']} != 聊天体 {st['chatLen']}"
    for b in st["branches"]:
        keys = sorted(int(k) for k in b["path"].keys())
        assert keys == list(range(1, len(keys) + 1)), f"{label}: 分支 {b['id']} path 楼层号不连续 {keys}"
    return st


def scenario_delete_middle(r):
    """删中间层（F2）：模型所有分支失去 F2、>F2 前移，落盘一致。"""
    before = build_family(r, 5)
    gid_f2 = before["branches"][0]["path"]["2"]
    gid_f3 = before["branches"][0]["path"]["3"]

    print("native delete idx=1 →", native_delete(r, 1))
    r.settle(2000)
    st = assert_contiguous(r, "删中间层")
    results.append(report("删中间层：模型层数随聊天体重排（不变式 1）",
                          st["chatLen"] == 4 and st["activeFloors"] == 4, f"chatLen={st['chatLen']}"))
    # 前移：原 F3 的组现在挂在第 2 层
    results.append(report("删中间层：>F2 的楼层前移（第 2 层 = 原第 3 层）",
                          st["branches"][0]["path"].get("2") == gid_f3,
                          f"path[2]={st['branches'][0]['path'].get('2')} 期望 {gid_f3}"))
    # 被删楼层的组不再被任何分支引用
    still = [b["id"] for b in st["branches"] if gid_f2 in b["path"].values()]
    results.append(report("删中间层：被删楼层的组不再被引用", not still, f"仍引用 {gid_f2}: {still}"))

    # 落盘一致（重新拉取聊天文件 = 磁盘事实，不是内存副本）
    disk = r.wait_disk(lambda d: d.get("activeId") and d["bodyLen"] == 4, desc="删层后落盘")
    same = disk["branches"] and disk["branches"][0]["path"].get("2") == gid_f3
    results.append(report("删中间层：落盘模型同步重排", bool(same), f"disk path[2]={disk['branches'][0]['path'].get('2') if disk['branches'] else None}"))

    # 重载后仍自洽（模型与 body 同源读回）
    r.js("() => SillyTavern.getContext().reloadCurrentChat()")
    r.settle(3000)
    st2 = assert_contiguous(r, "删中间层后重载")
    texts = st2["mesTexts"]
    results.append(report("删中间层：重载后第 2 层内容 = 原 A-F3",
                          len(texts) == 4 and texts[1].endswith("A-F3"), f"{texts}"))
    return gid_f2


def scenario_delete_tail(r):
    """删末层（宿主 deleteMessages(chat.length-1)）：尾部前移、模型跟着缩短。"""
    st = r.state()
    n = st["chatLen"]
    print("native delete idx=%d →" % (n - 1), native_delete(r, n - 1))
    r.settle(2000)
    st = assert_contiguous(r, "删末层")
    results.append(report("删末层：模型层数跟随（不变式 1）", st["chatLen"] == n - 1 and st["activeFloors"] == n - 1,
                          f"chatLen={st['chatLen']} 期望 {n - 1}"))


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            # 本用例必须从**干净起点**出发（2026-09-26 实测定性的两条顺序敏感病因）：
            #   ① 测试角色若已存在 → `/api/characters/create` 行为不可预期，且它的 `.chat`
            #      指向旧聊天 → 新聊天带着旧消息开局，造楼断言变成「9 != 5」。
            #   ② 存储模式若被前一条用例留在 pure/mirror → 新聊天的家族**只写库、内存副本
            #      要重载才有**（`test_main_branch` 为此专门 reload + 等）→ 「off 模式新聊天
            #      应已自动启用分支模型」这条断言空手。
            r.set_storage_mode('off')
            r.settle(800)
            r.close_popup()   # set_storage_mode 会打开弹窗；留着它，后面 ensure_active 会看到建分支前的旧面板快照
            r.settle(300)
            r.delete_test_char()
            r.settle(600)
            res = r.create_test_char()
            created = res.get("status") == 200
            if not created:
                print("create char failed:", res)
                return 1
            r.open_test_char()
            r.settle(2500)

            print("===== 场景1: 删中间层（off 模式，宿主原生删除） =====")
            scenario_delete_middle(r)
            print("===== 场景2: 删末层 =====")
            scenario_delete_tail(r)

            print("===== 错误归因 =====")
            cb_page = r.pageerrors_from("chatfilesys")
            cb_console = r.console_errors_from("chatfilesys")
            print("chatfilesys pageerrors:", cb_page[:5])
            print("chatfilesys console errors:", cb_console[:5])
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
