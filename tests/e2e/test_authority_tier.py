"""ChatFilesys 档1（Authority SQL）接线与降级 e2e（Dev 实例 8003）

验的是**编排层的接线**——不是适配器单测那种「给个 mock client 看它跑不跑」，
而是真机上「插上 Authority 会落到档1、拔掉会落到档2、且降级要说明白为什么」。

断言：
  ① **拔掉 SDK → 落档2**：页内把 `window.STAuthority` 置空后切纯库，档位徽章 = **官方通道**；
     控制台出现带**真原因**（`sdk-missing`）的降级记录 ⇒ 降级归因确实挂在返回值上（不是只写日志）
  ② **恢复 SDK → 落档1**：档位徽章 = **Authority SQL**（`storageState.tier === 'authority'`）
  ③ **档1 独有的能力真的在**：回收站**列得出**（不是「当前存储档位不支持枚举」那句说明）。
     这是比徽章更硬的证据——`index.js` 只对 authority 档挂 `listTrash`
  ④ 全程零 chatfilesys 归因报错
  ⑤ 清场：切回 JSONL 增强模式、关弹窗

为什么用**档位徽章**做主断言：它是插件自己渲染的 DOM 事实（`data-role="storage-status"`），
且 `harness.set_storage_mode()` 本来就在等它 ⇒ 复用既有基建，不新造探针、不解析日志文本。

纪律：只连 Dev（8003，`P-11`：与 Real 只差端口）；不动任何既有角色与聊天（本用例不开聊天、不写库）。

依赖：Dev Luker 8003 在跑 + 扩展已同步到 `data/default-user/extensions/chatfilesys/`
      + Authority 后端插件已装且 core 在跑（缺任一条 ⇒ ②③ 会失败，那正是它要报的）。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_authority_tier.py
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, BASE, ENTRY, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 把宿主注入的 SDK 存起来再拔掉 / 还回去（**只动页内引用**，不碰实例文件、不卸载插件）
SAVE_SDK_JS = "() => { window.__cfsysStAuthority = window.STAuthority; return Boolean(window.__cfsysStAuthority); }"
DROP_SDK_JS = "() => { window.STAuthority = null; return String(window.STAuthority); }"
RESTORE_SDK_JS = "() => { window.STAuthority = window.__cfsysStAuthority; return Boolean(window.STAuthority?.AuthoritySDK); }"

BADGE_JS = """() => {
    const b = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup [data-role="storage-status"]');
    return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null;
}"""

TRASH_JS = """() => {
    const h = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup .chatfilesys-trash-host');
    if (!h) return { present: false, text: '', rows: 0 };
    return {
        present: true,
        text: h.innerText.replace(/\\s+/g, ' ').trim(),
        rows: h.querySelectorAll('.chatfilesys-trash-row').length,
    };
}"""

# 现场诊断：SDK 在不在、存的引用还在不在（判断「写回引用」这条路是否被页面重载弄丢）
DIAG_JS = """() => ({
    hasSdk: Boolean(window.STAuthority?.AuthoritySDK),
    hasSavedRef: Boolean(window.__cfsysStAuthority),
})"""

# 档1 数据回环（真 Authority 后端，走完整 SDK → SQL/fs）。
# 为什么另开这一条而不是只跑既有套件：既有 off 模式套件验的是离线路径，
# 而「档1 的 SQL 信封拆包 / fs 位置参数与 readDir / 父目录 / not-found」这几处
# 只有真后端能验。用 EXT_SRC（8417 静态源）import 适配器本体，client 取**同一个会话**
# （AuthoritySDK.init 按 extensionId 去重）——即插件在用的那个 client。
TIER1_ROUNDTRIP_JS = """async ([src, tag]) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    const sdk = window.STAuthority.AuthoritySDK;
    const client = await sdk.init({
        extensionId: 'third-party/chatfilesys',
        displayName: 'ChatFilesys',
        version: '1.0.0',
        installType: 'local',
        declaredPermissions: { sql: { private: true }, fs: { private: true } },
    });
    const mod = await import(src + '/core/storage/adapter.js');
    const { tier, adapter } = await mod.createStorageAdapter({ authorityClient: client, log: (m) => log('warn: ' + String(m).slice(0, 140)) });
    out.tier = tier;
    if (tier !== 'authority') return out;

    const familyId = 'f_tier1probe_' + tag;
    await adapter.deleteFamily({ familyId }).catch(() => {});

    // ① 建档（SQL INSERT）
    const created = await adapter.createFamily({
        family: {
            familyId, chatKey: 'probe::tier1', characterId: 'probe', name: 'tier1-probe', integrity: null,
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: {} }, model: { active_branch: 'b_main', branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: {} }], groups: {} },
        },
    });
    out.created = created;
    if (!created?.ok) return out;

    // ② 先落楼层行 + 模型（走过 SQL 写入路径），再读回 —— 这几步走的就是 `q()` 拆信封那条路
    const model = { active_branch: 'b_main', branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_base: 0, path: { 1: 'g1' } }], groups: { g1: [1] } };
    const saved = await adapter.saveFloors({
        familyId,
        floors: [{ floorNo: 1, variantId: 'g1', seq: 0, content: '{"mes":"tier1-hello","is_user":true}', contentHash: null, sendDate: 1 }],
        expectedIntegrity: created.integrity ?? null,
    });
    out.savedFloors = saved;
    out.savedModel = await adapter.saveModel({ familyId, model, expectedIntegrity: saved?.integrity ?? null });

    const floors = await adapter.loadFloors({ familyId, from: 0, limit: 50 });
    out.floorCount = (floors.floors || []).length;
    out.floorHasText = JSON.stringify(floors.floors || []).includes('tier1-hello');

    const fam = await adapter.loadFamily({ familyId });
    out.loaded = Boolean(fam);
    out.pathFloor = fam?.model?.branches?.[0]?.path?.[1] ?? null;
    out.listed = (await adapter.listFamilies({ characterId: 'probe' })).some((f) => f.familyId === familyId);

    // ③ 消息补丁（applyOps = seam 的主写入口）
    // 下标约定（`core/patch-rows.js`）：**消息数组的 0 基下标，不含 header** ⇒ 第 1 层是 `/0`。
    const applied = await adapter.applyOps({
        familyId, branchId: 'b_main', targetBranchId: 'b_main',
        ops: [{ op: 'replace', path: '/0/mes', value: 'tier1-patched' }],
        expectedIntegrity: out.savedModel?.integrity ?? null,
    });
    out.applied = applied;
    const after = await adapter.loadFloors({ familyId, from: 0, limit: 50 });
    out.floorPatched = JSON.stringify(after.floors || []).includes('tier1-patched');

    // ④ fs 回收站回环（真机形态：建父目录 → 写 → 列 → 读 → 删）
    const moved = await adapter.moveToTrash({ source: 'tier1-probe.jsonl', content: '{"mes":"trash-probe"}' });
    out.moved = moved;
    const trash = await adapter.listTrash();
    out.trashHasEntry = trash.some((t) => t.trashId === moved.trashId && t.source === 'tier1-probe.jsonl');
    const restored = await adapter.restoreFromTrash({ trashId: moved.trashId });
    out.restoredContent = restored?.content ?? null;
    await adapter.deleteFromTrash({ trashId: moved.trashId });
    out.trashAfterPurge = (await adapter.listTrash()).filter((t) => t.trashId === moved.trashId).length;

    // ⑤ 清场：删本探针家族（不留测试数据在 Authority 库里）
    out.deleted = await adapter.deleteFamily({ familyId });
    return out;
}"""


def poll(fn, timeout=20.0, interval=0.4, desc=""):
    """轮询到 fn() 为真值（不用固定 sleep 猜耗时；quality-guidelines 的 Forbidden）。"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
        except Exception as e:                       # noqa: BLE001
            last = f"<异常 {e}>"
        if last:
            return last
        time.sleep(interval)
    print(f"  [warn] 轮询超时（{desc}）：最后取值 = {last}")
    return last


def warn_logs(r):
    """本插件打过的所有 console 文本（warn 与 log 一起收）。"""
    return [t for _ty, t, _src in r.logs if 'chatfilesys' in t]


RESET_JS = """() => {
    const s = SillyTavern.getContext().extensionSettings;
    s.chatfilesys = s.chatfilesys || {};
    s.chatfilesys.storage_mode = 'off';
    s.chatfilesys.import_prompt = { never: false, mutedKeys: [] };
    delete s.chatfilesys.tabState;      // 页签记忆也要复位（否则后面的套件打开弹窗落在「设置」页）
    SillyTavern.getContext().saveSettingsDebounced?.();
    return JSON.parse(JSON.stringify(s.chatfilesys));
}"""


def main():
    with sync_playwright() as p:
        b, ctx = browser_ctx(p)
        page = ctx.new_page()
        r = Runner(page, label="authority-tier")

        try:
            r.boot()
            r.set_storage_mode('off')                # 已知基线

            # ---------- ① 拔掉 SDK → 必须落档2，且降级要带真原因 ----------
            assert r.js(SAVE_SDK_JS), "页内没有 window.STAuthority —— Authority SDK 未部署？"
            r.js(DROP_SDK_JS)
            r.set_storage_mode('pure')
            badge_down = poll(lambda: r.js(BADGE_JS), desc="拔 SDK 后的档位徽章")
            reason_logged = any('存储选档：authority 不可用' in t and 'sdk-missing' in t for t in warn_logs(r))
            ok1 = bool(badge_down) and '官方通道' in badge_down and reason_logged
            results.append(report("① 拔掉 SDK → 落档2（官方通道），且降级记录带真原因 sdk-missing", ok1,
                                  f"徽章={badge_down} 归因日志={[t for t in warn_logs(r) if '存储选档' in t][:2]}"))

            # ---------- ② 恢复 SDK → 必须落档1 ----------
            # 用**重载页面**恢复（而不是把存下来的引用写回去）：SDK 由宿主扩展在页面加载时装上，
            # 重载能确定性地把它装回来；而「存引用 → 写回」会被中间发生的任何页面重载弄丢。
            diag_before = r.js(DIAG_JS)
            r.pg.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            r.pg.wait_for_selector("#send_textarea", state="attached", timeout=60000)
            r.pg.wait_for_selector(ENTRY, state="attached", timeout=60000)
            r.mute_import_prompt()
            diag_after = r.js(DIAG_JS)
            r.set_storage_mode('off')                # 换档要有一个「变化」才会重跑 enablePureDb
            r.set_storage_mode('pure')
            badge_up = poll(lambda: r.js(BADGE_JS), desc="重载后的档位徽章")
            ok2 = bool(badge_up) and 'Authority SQL' in badge_up
            results.append(report("② 恢复 SDK（重载）→ 落档1（Authority SQL）", ok2,
                                  f"徽章={badge_up} | 重载前={diag_before} | 重载后={diag_after} | "
                                  f"选档日志={[t for t in warn_logs(r) if '存储选档' in t][-3:]}"))

            # ---------- ③ 档1 独有能力：回收站列得出（不是「档位不支持」） ----------
            r.close_popup()
            r.ensure_popup()                         # 重开 → 回收站页签拿全新 DOM（缓存标志随之重置）
            r.popup_switch_tab('回收站')
            st = poll(lambda: (lambda s: s if (s.get('present') and s.get('text')) else None)(r.js(TRASH_JS)),
                      desc="回收站页签内容")
            st = st if isinstance(st, dict) else (r.js(TRASH_JS) or {})
            text = str(st.get('text') or '')
            unsupported = '不支持枚举' in text or '回收站当前不可用' in text
            listed = ('回收站为空' in text) or st.get('rows', 0) > 0
            ok3 = bool(st.get('present')) and listed and not unsupported
            results.append(report("③ 档1 独有能力：回收站可枚举（不是「档位不支持」说明）", ok3,
                                  f"行数={st.get('rows')} 文本={text[:120]!r}"))

            # ---------- ④ 档1 真 SQL 数据回环（建档 / applyOps / 读回 / 列表 / fs 回收站 / 清场） ----------
            rt = r.js(TIER1_ROUNDTRIP_JS, [EXT_SRC, str(int(time.time()))]) or {}
            checks = {
                'tier=authority': rt.get('tier') == 'authority',
                '建档 ok': bool((rt.get('created') or {}).get('ok')),
                '写楼层 ok': bool((rt.get('savedFloors') or {}).get('ok')),
                '存模型 ok': bool((rt.get('savedModel') or {}).get('ok')),
                '楼层读回': (rt.get('floorCount') or 0) >= 1 and rt.get('floorHasText') is True,
                '家族读回': rt.get('loaded') is True and rt.get('pathFloor') == 'g1',
                '列表含该家族': rt.get('listed') is True,
                'applyOps ok': bool((rt.get('applied') or {}).get('ok')) and rt.get('floorPatched') is True,
                'fs 回收站写入+列出': bool((rt.get('moved') or {}).get('ok')) and rt.get('trashHasEntry') is True,
                'fs 读回+清理': 'trash-probe' in str(rt.get('restoredContent') or '') and rt.get('trashAfterPurge') == 0,
                '清场删家族': bool((rt.get('deleted') or {}).get('ok')),
            }
            bad = [k for k, v in checks.items() if not v]
            results.append(report("④ 档1 真 SQL 数据回环（建档/写补丁/读回/列表/fs 回收站/清场）", not bad,
                                  f"不满足={bad} | applied={str(rt.get('applied'))[:160]} | "
                                  f"loaded={rt.get('loaded')} pathFloor={rt.get('pathFloor')} "
                                  f"floorCount={rt.get('floorCount')} | steps={str(rt.get('steps'))[:160]}"))

            # ---------- ⑤ 归因零报错 ----------
            errs = r.pageerrors_from('chatfilesys')
            ce = r.console_errors_from('chatfilesys')
            results.append(report("⑤ 全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))

            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.set_storage_mode('off')            # 清场：先走插件自己的安全动作（会做导出一类的收尾）
            except Exception as e:                   # noqa: BLE001
                print(f"  [warn] 经 UI 切回 off 失败（改用直接复位）: {e}")
            try:
                # **兜底**：直接写设置并落盘。实测教训——只靠 UI 切换时，若宿主页面在
                # `saveSettingsDebounced` 生效前被关掉，实例会被**留在 pure 模式**，
                # 后面 off 模式的套件（如 test_deletes）前提不成立而误报失败。
                print("  收尾复位:", r.js(RESET_JS))
                r.pg.wait_for_timeout(2500)
            except Exception as e:                   # noqa: BLE001
                print(f"  [warn] 复位设置失败（实例可能留在库模式）: {e}")
            try:
                r.js(RESTORE_SDK_JS)                 # 还回页内引用（无副作用，求稳）
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nAUTHORITY TIER " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
