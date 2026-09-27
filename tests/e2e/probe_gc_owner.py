"""探针：删分支的私有组 GC —— UI 路径 vs 纯函数路径对照。

背景（2026-09-27）：`tests/e2e/test_deletes.py` 场景2 的两条红
（`删分支:树仅剩主分支+私有组 GC` / `删分支:落盘一致`，判据均含 `groups == 0`）。
静态推演（`core/branches.js:265-269` 的 GC + `:64-68` 的 `deriveOwner`）说应当归零，
与实测矛盾 ⇒ 用本探针在同一个真机现场并排取三组值，把「断言过时」与「实现缺陷」分开：

  ① 删之前：`groups` 的完整内容（含 `owner` / `floor`）+ 每条分支的 `path`（谁引用私有组）
  ② 纯函数路径：**深拷贝**模型后直接调 `core/branches.js#deleteBranch`，看 GC 是否生效
     （深拷贝 ⇒ 不污染现场，纯观察）
  ③ UI 路径：点「删除分支」按钮走 `deleteBranchFlow`，看删除后的内存与落盘

判定：
  - ② 归零而 ③ 不归零 ⇒ GC 函数本身没问题，问题在实际流程（删错对象 / 落盘回读丢字段）
  - ② 也不归零        ⇒ `owner` 实际取值与 GC 条件不匹配，看 ① 的 `ownerOf` 直接读出真值

用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_gc_owner.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx  # noqa: E402
from test_deletes import TEST_CHAR, back_to_main, build_family  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

EXT_SRC = "/scripts/extensions/third-party/chatfilesys"

DUMP_JS = """async ([src]) => {
    const ctx = SillyTavern.getContext();
    const m = ctx.chatMetadata.extensions.chatfilesys;
    const br = await import(src + '/core/branches.js');
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const out = { branches: [], groups: {}, ownerOf: {}, simulated: {} };
    out.branches = (m.branches || []).map((b) => ({ id: b.id, is_default: !!b.is_default, path: b.path }));
    out.groups = clone(m.groups || {});
    for (const gid of Object.keys(m.groups || {})) out.ownerOf[gid] = br.deriveOwner(m, gid);
    // 纯函数路径：深拷贝后删（不碰现场模型）
    const target = (m.branches || []).find((b) => !b.is_default);
    if (!target) { out.simulated = { ok: false, err: '无非默认分支可做模拟删除' }; return out; }
    const m2 = clone(m);
    try {
        br.deleteBranch(m2, target.id);
        out.simulated = {
            ok: true, target: target.id,
            branchesAfter: m2.branches.map((b) => b.id),
            groupsAfter: m2.groups,
        };
    } catch (e) {
        out.simulated = { ok: false, target: target.id, err: String((e && e.message) || e) };
    }
    return out;
}"""


def show(tag, d):
    print(f"--- {tag} ---")
    for x in d["branches"]:
        mark = "默认" if x["is_default"] else "    "
        print(f"  分支 {x['id']} [{mark}] path={json.dumps(x['path'], ensure_ascii=False)}")
    print("  groups(全量, 含 owner):", json.dumps(d["groups"], ensure_ascii=False)[:900])
    print("  deriveOwner 逐组:", json.dumps(d["ownerOf"], ensure_ascii=False))
    print("  模拟直调 deleteBranch:", json.dumps(d["simulated"], ensure_ascii=False)[:700])


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-gc-owner")
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
            r.new_chat()

            build_family(r, 5)
            back_to_main(r)

            st = r.state()
            print("① 删之前 state:", {k: st[k] for k in ("groups", "branches", "activeId", "chatLen", "domMes")})
            before = r.js(DUMP_JS, [EXT_SRC])
            show("① 删之前", before)

            # ③ UI 路径：真删
            r.pick_branch("b1")
            r.click_action("delete-branch", branch="b1")
            r.popup_ok()
            r.settle(2000)

            st2 = r.state()
            print("③ UI 删除后 state:", {k: st2[k] for k in ("groups", "branches", "activeId", "chatLen", "domMes")})
            print("③ UI 删除后 disk:", r.disk_state())
            after = r.js(DUMP_JS, [EXT_SRC])
            show("③ UI 删除后", after)

            print("\n=== 判定 ===")
            sim_zero = before["simulated"].get("ok") and not before["simulated"].get("groupsAfter")
            print("② 模拟直调是否归零:", sim_zero, "| ③ UI 删除后 groups 键:",
                  list((after["groups"] or {}).keys()))
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            if created:
                try:
                    print("cleanup:", r.delete_test_char())
                except Exception as e:
                    print("cleanup failed:", e)
            b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
