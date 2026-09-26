"""ChatFilesys 主分支可换 e2e（T9 / R8.3 / AC22）

用户裁定（2026-09-26）：「可换默认分支，想要删除，只能换，或者删除家族」+ 选「显式『设为主分支』按钮」。

语义：**主分支 = 打开这个聊天看到的那条分支**（家族主键绑在它上面）。
断言：
  ① 面板分支管理里选中**当前主分支**时，删除按钮**变灰不可点**（「设为主分支」也灰）
  ② 「设为主分支」有明确确认（讲清主分支是什么、旧主分支可删）
  ③ 生效后库内：`is_default` 迁移到目标分支、家族活跃分支跟到同一条、
     **主键的键绑定改到目标分支**（不变式：恰一条 `is_default`，且它 = 主键绑定所在分支）
  ④ 打开该聊天（重载）看到的是**新主分支**的内容（层数与内容对齐）
  ⑤ 换过之后**旧主分支可以删**（面板按钮不再灰、删除真的生效，库里分支消失）

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_main_branch.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []


def btn_disabled(r, action):
    """面板上某个分支管理按钮的状态（弹窗须已打开）。"""
    return r.js("""(a) => {
        const b = document.querySelector('dialog[open] .chatfilesys-popup [data-action="' + a + '"]');
        return b ? { disabled: !!b.disabled, title: b.title, branch: b.dataset.branch } : null;
    }""", action)


def reload_chat(r, settle_ms=2500):
    """重载当前聊天 = 重新「打开」它（纯库模式下走接缝读库）。"""
    r.js("async () => { await SillyTavern.getContext().reloadCurrentChat(); return 'reloaded'; }")
    r.settle(settle_ms)


def top_dialog_text(r):
    """**最上层**弹窗的文本（管理弹窗一直开着，故不能取「第一个」可见 dialog）。"""
    return r.js("""() => {
        const dlgs = [...document.querySelectorAll('dialog[open]:not([closing])')];
        const d = dlgs[dlgs.length - 1];
        return d ? d.innerText.replace(/\\n+/g, ' | ') : null;
    }""") or ''


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main-branch")
        try:
            r.boot()                       # T9 不需要入库提醒 → harness 默认压掉
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)

            # ---------- 准备：纯库模式 + 一个库内家族 + 两条内容不同的分支 ----------
            r.set_storage_mode('pure')
            r.close_popup()
            chat = r.new_chat()
            r.settle(1500)
            key = r.chat_key()
            # 新聊天在纯库模式下由插件自动建档（onChatCreated → createFamily）；
            # 但**内存里的模型要重载一次**才来自库（建档只写库，不动宿主内存副本）
            reload_chat(r)
            for _ in range(12):
                if r.model() and r.read_family(key):
                    break
                reload_chat(r, 1200)
            fam0 = r.read_family(key)
            ok0 = bool(fam0) and fam0["defaults"] == ["b_main"] and fam0["keyBindings"] == {} and bool(r.model())
            results.append(report("前置：纯库模式下新聊天已建档（主分支 b_main、主键暂无绑定）", ok0,
                                  f"chat={chat} key={key} family={fam0}"))

            # 4 层：开场语 + 3 条（b_main）
            for cmd in ["/send U-F2", "/sendas name=__cb_e2e A-F3", "/send U-F4"]:
                r.cmd(cmd)
                r.settle(800)
            r.wait_state(lambda s: s["chatLen"] == 4, desc="造 4 层")
            # 在第 2 层分叉：b1 = 只含前 2 层的分支（与 b_main 的 4 层内容不同）
            nb = r.create_branch(2, name="分叉·F2", activate=False)
            r.ensure_active(nb)
            r.settle(900)
            r.ensure_active("b_main")        # 回到 b_main：设为主分支之前，这个聊天看到的是 4 层
            r.settle(900)
            st1 = r.state()
            fam1 = r.read_family(key)
            ok1 = (st1["chatLen"] == 4 and fam1 and fam1["activeBranch"] == "b_main"
                   and fam1["defaults"] == ["b_main"]
                   and {x["id"] for x in fam1["branches"]} == {"b_main", nb})
            results.append(report("前置：两条分支（b_main 4 层 / b1 2 层），当前打开 b_main", ok1,
                                  f"chatLen={st1['chatLen']} active={st1.get('activeId')} branch={nb} fam={fam1}"))

            # ---------- ① 选中当前主分支 → 删除按钮变灰 ----------
            r.open_popup()
            r.pick_branch("b_main")
            d_main = btn_disabled(r, "delete-branch")
            s_main = btn_disabled(r, "set-main-branch")
            ok2 = bool(d_main and d_main["disabled"]) and bool(s_main and s_main["disabled"])
            results.append(report("① 选中当前主分支时删除按钮变灰不可点", ok2,
                                  f"delete={d_main} setMain={s_main}"))

            # ---------- ② 选中别的分支 → 可用；点「设为主分支」 ----------
            r.pick_branch(nb)
            d_b1 = btn_disabled(r, "delete-branch")
            s_b1 = btn_disabled(r, "set-main-branch")
            ok3a = bool(d_b1 and not d_b1["disabled"]) and bool(s_b1 and not s_b1["disabled"])
            results.append(report("② 选中别的分支时两个按钮可用", ok3a, f"delete={d_b1} setMain={s_b1}"))

            r.click_action("set-main-branch", branch=nb)
            r.settle(800)
            confirm_txt = top_dialog_text(r)
            r.popup_ok()
            r.settle(3000)
            results.append(report("② 点「设为主分支」有明确确认（讲清主分支是什么、旧主分支可删）",
                                  "主分支" in confirm_txt, f"confirm={confirm_txt[:80]}"))

            # ---------- ③ 库内不变式 ----------
            fam2 = r.read_family(key)
            model2 = r.model() or {}
            defaults2 = [x["id"] for x in model2.get("branches", []) if x.get("is_default")]
            ok4 = (fam2 is not None
                   and fam2["defaults"] == [nb]
                   and fam2["activeBranch"] == nb
                   and fam2["keyBindings"].get(key, {}).get("branchId") == nb
                   and defaults2 == [nb])
            results.append(report("③ 库里：is_default 迁移 + 活跃分支跟到同一条 + 主键绑定改到目标分支", ok4,
                                  f"defaults={fam2['defaults'] if fam2 else None} active={fam2['activeBranch'] if fam2 else None} "
                                  f"bindings={fam2['keyBindings'] if fam2 else None} 路径模型={defaults2}"))

            # ---------- ④ 打开该聊天看到的是新主分支的内容 ----------
            reload_chat(r)
            st4 = r.state()
            ok5 = (st4["chatLen"] == 2 and len(st4["mesTexts"]) == 2
                   and st4["mesTexts"][-1].endswith("U-F2"))
            results.append(report("④ 打开该聊天看到新主分支的内容（b1 投影：2 层，末层 = U-F2）", ok5,
                                  f"chatLen={st4['chatLen']} mesTexts={st4['mesTexts']}"))

            r.open_popup()
            r.pick_branch(nb)
            label = r.js("""() => {
                const s = document.querySelector('dialog[open] .chatfilesys-popup [data-role="branch-picker"]');
                const o = s ? [...s.options].find(x => x.value === s.value) : null;
                return o ? o.textContent : null;
            }""")
            ok6 = bool(label and "主分支" in label)
            results.append(report("④-2 面板上该分支标注为「主分支」", ok6, f"label={label!r}"))

            # ---------- ⑤ 换过之后旧主分支可删 ----------
            r.pick_branch("b_main")
            d_old = btn_disabled(r, "delete-branch")
            ok7a = bool(d_old and not d_old["disabled"])
            results.append(report("⑤-1 旧主分支的删除按钮不再置灰", ok7a, f"delete={d_old}"))
            r.click_action("delete-branch", branch="b_main")
            r.settle(800)
            r.popup_ok()
            r.settle(3000)
            fam3 = r.read_family(key)
            model3 = r.model() or {}
            ok7b = (fam3 is not None
                    and {x["id"] for x in fam3["branches"]} == {nb}
                    and fam3["defaults"] == [nb]
                    and fam3["keyBindings"].get(key, {}).get("branchId") == nb
                    and {x["id"] for x in model3.get("branches", [])} == {nb})
            results.append(report("⑤-2 旧主分支真的删掉了，新主分支与主键绑定完好（不变式仍成立）", ok7b,
                                  f"branches={[x['id'] for x in (fam3 or {}).get('branches', [])]} "
                                  f"defaults={(fam3 or {}).get('defaults')} 路径模型={[x.get('id') for x in model3.get('branches', [])]}"))

            # ---------- ⑥ 增强（off）模式下的同一动作（模型住聊天头，没有键绑定面） ----------
            # 面板的「设为主分支」在三种模式都在；增强模式下「打开该聊天看到的内容」= 活跃分支的投影，
            # 故这条动作 = 既有切换（换内容）+ 迁移 is_default 标记，两步都要落进聊天头。
            r.close_popup()
            r.set_storage_mode('off')
            r.settle(2500)
            nb2 = r.create_branch(1, name='第二支', activate=False)
            r.settle(800)
            # 弹窗是「建时快照 + 事件驱动刷新」的：上面那次建档没有触发插件重绘，
            # 故必须**关掉再开**，否则选择器里还是旧模型（没有新分支）
            r.close_popup()
            r.settle(400)
            r.open_popup()
            r.pick_branch(nb2)
            d2 = btn_disabled(r, "delete-branch")
            r.click_action("set-main-branch", branch=nb2)
            r.settle(800)
            r.popup_ok()
            r.settle(2000)
            m6 = r.model() or {}
            st6 = r.state()
            ok8 = (bool(d2 and not d2["disabled"])
                   and [x["id"] for x in m6.get("branches", []) if x.get("is_default")] == [nb2]
                   and st6["chatLen"] == 1 and st6["mesTexts"] and st6["mesTexts"][-1].endswith("开场问候语（F1）"))
            results.append(report("⑥ 增强模式下同一动作：换内容 + 迁移 is_default（聊天头内）", ok8,
                                  f"delete={d2} isDefault={[x['id'] for x in m6.get('branches', []) if x.get('is_default')]} "
                                  f"chatLen={st6['chatLen']} texts={st6['mesTexts']}"))

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            ce = r.console_errors_from("chatfilesys")
            results.append(report("全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))

            # ---------- ⑦ 切分支不产生任何接缝拒绝（W6 验收） ----------
            # 用户 2026-09-26 实录：切分支时接缝两次拒绝 `chats/patch`
            # （`projection-incomplete｜楼层 1 的变体 g1 在库中无行`、`test-failed｜/3`），
            # 宿主随后自动重放成功（最终 200，数据正确但脏）。根因 = 接缝把补丁的**投影基准**
            # 取成了目标分支，而 ops 的下标是对着**切换前**的 body 算的。
            # 验收按「接缝日志为空」而不是「最终 200」：本用例全程含多次切分支 / 设为主分支。
            import re as _re
            logtxt = "\n".join(t for (_ty, t, _s) in r.logs)
            seam_logs = [t for (_ty, t, _s) in r.logs if 'chatfilesys-seam' in t]
            patch_status = sorted(set(_re.findall(r"path: /api/chats/patch, status: (\d+)", logtxt)))
            seam_reject = [t for t in seam_logs if '未应用' in t or '拒绝' in t]
            print(f"[INFO] chats/patch 响应码 = {patch_status or '(未捕获 FrontendFetch 日志)'}；"
                  f"接缝日志 {len(seam_logs)} 条，其中拒绝 {len(seam_reject)} 条")
            for t in seam_logs:
                print(f"  [seam] {t[:200]}")
            results.append(report("⑦ 全程接缝零拒绝（切分支/设为主分支不触发 chats/patch 未应用）",
                                  len(seam_reject) == 0,
                                  f"拒绝={len(seam_reject)} 条 {seam_reject[:2]}"))
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                # 先恢复出厂默认（增强模式）再删测试角色：删角色会把界面切走、弹窗没了，
                # 那时再切模式就切不动了（第一轮实测踩到：实例被留在纯库模式）。
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在纯库模式）: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    # 用 `code` 一起判定：断言全绿但流程中途抛异常时不得打印 PASS
    ok = bool(results) and all(results) and code == 0
    print("\nMAIN BRANCH " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
