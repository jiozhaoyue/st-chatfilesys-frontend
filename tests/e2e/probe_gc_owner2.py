"""探针 2：重放 planSwitch，对比「实机切换落的 owner」与「planSwitch 现算的 owner」。

背景（2026-09-27，探针 1 结论）：
  删 b1 之前 groups 里存的是 `owner: null`（g6/g7），而在同一份模型上**现算**
  `deriveOwner(model, 'g6')` 却得 `'b1'` ⇒ 写 owner 的那一刻与现在的分支引用关系不一致。
  `core/projection.js:135` 的折叠是唯一写 owner 的地方，故本探针在「b1 活跃（尚未切回）」这个
  现场上**深拷贝模型后重放一次 `planSwitch(m2,'b_main',body)`**，看它算出的 owner 是什么：

  - 重放得 `'b1'` ⇒ `planSwitch` 本身正确，实机那次切换**没走** planSwitch（或传参不同）
    → 去看 `index.js` 的 `switchBranchFlow` 调用链
  - 重放同样得 `null` ⇒ 问题在 `planSwitch` 内部（即 model 在折叠时已不含该引用）
    → 看 `planSwitch` 的内联状态与调用方传入的 `curId`

顺带打印「b1 活跃时」的完整现场（各分支 path、groups、body 长度），以及实机切回 main 后再取一次真值。

用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_gc_owner2.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx  # noqa: E402
from test_deletes import back_to_main, build_family  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

EXT_SRC = "/scripts/extensions/third-party/chatfilesys"

REPLAY_JS = """async ([src]) => {
    const ctx = SillyTavern.getContext();
    const m = ctx.chatMetadata.extensions.chatfilesys;
    const br = await import(src + '/core/branches.js');
    const proj = await import(src + '/core/projection.js');
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const out = {};
    out.active = m.active_branch;
    out.bodyLen = (ctx.chat || []).length;
    out.branches = m.branches.map((b) => ({ id: b.id, is_default: !!b.is_default, path: b.path }));
    out.groups = clone(m.groups || {});
    out.ownerNow = {};
    for (const gid of Object.keys(m.groups || {})) out.ownerNow[gid] = br.deriveOwner(m, gid);
    // 重放：深拷贝后按 planSwitch 切回 b_main（不碰现场）
    const m2 = clone(m);
    try {
        const res = proj.planSwitch(m2, 'b_main', (ctx.chat || []).slice());
        out.replayed = {
            ok: true,
            ops: (res.operations || []).length,
            switchedTo: res.switchedTo,
            branches: m2.branches.map((b) => ({ id: b.id, path: b.path })),
            groups: m2.groups,
            owners: Object.fromEntries(Object.keys(m2.groups || {}).map((gid) => [gid, m2.groups[gid].owner ?? '(无 owner 字段)'])),
        };
    } catch (e) {
        out.replayed = { ok: false, err: String((e && e.message) || e) };
    }
    return out;
}"""


def show(tag, d):
    print(f"--- {tag} ---")
    print("  active:", d.get("active"), "| bodyLen:", d.get("bodyLen"))
    for x in d.get("branches", []):
        print(f"  分支 {x['id']}{' [默认]' if x['is_default'] else ''} path={json.dumps(x['path'], ensure_ascii=False)}")
    print("  groups(存值 owner):", json.dumps({k: (v.get("owner") if isinstance(v, dict) else v) for k, v in (d.get("groups") or {}).items()}, ensure_ascii=False))
    print("  现算 deriveOwner:", json.dumps(d.get("ownerNow"), ensure_ascii=False))
    rp = d.get("replayed", {})
    if rp.get("ok"):
        print("  重放 planSwitch → ops:", rp.get("ops"), "switchedTo:", rp.get("switchedTo"))
        print("    重放后 groups 的 owner:", json.dumps(rp.get("owners"), ensure_ascii=False))
        print("    重放后 groups 键:", list((rp.get("groups") or {}).keys()))
    else:
        print("  重放 planSwitch 失败:", rp.get("err"))


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-gc-owner2")
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

            build_family(r, 5)  # b1 活跃、续了 2 层私有组，尚未切回
            show("A. b1 活跃态（实机）", r.js(REPLAY_JS, [EXT_SRC]))

            back_to_main(r)     # 实机切换
            show("B. 实机切回 b_main 之后", r.js(REPLAY_JS, [EXT_SRC]))

            st = r.state()
            print("B. state:", {k: st[k] for k in ("groups", "activeId", "chatLen", "domMes")})
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
