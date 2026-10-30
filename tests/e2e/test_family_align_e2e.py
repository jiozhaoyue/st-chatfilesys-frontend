"""ChatFilesys 智能家族合并真机 e2e（09-29-fuzzy-family-merge 阶段 5 / G4）
arg
用户原话（父 PRD §一）：「当历史聊天被修改，但实际大致相同，层数对得上，或是中间错误、被删层，
但是有特征可以对得上，那么仍然可以智能合并为同家族分支，被修改的层变为 swipe 或 swipe 组
让用户选择」「和原本偏移极大，实际上所有雷都踩了」。

单测（`tests/branches/family-align.test.mjs` / `family-model.test.mjs` / `importer.test.mjs`）
锁的是**纯函数层**。本用例锁的是**导入旅程那条真机链路**——「造 jsonl → 走弹窗导入 → 落到库」，
因为纯函数对而接线错的真机故障，单测一条都看不见。

断言（`__cb_e2e` 探针角色上，造 4 份 jsonl 文件 A/B/C/D）：
  (a) **同族并入（核心场景）**：A 导入建家族；B = A 但末层是「重新生成」形态
      （B 该层当前正文是新版、旧版原样留在 `swipes` 里 —— evidence §三 的真实形态）
      ⇒ 家族数仍为 1（并进去了，没新建），且该层出现可切的 swipe 版本（`swipes.length >= 2`）
  (b) **高偏移不并（假阳性闸门）**：C 与 A 内容几乎无重合 ⇒ **新建家族**（家族数 +1）
  (c) **中间删层可并**：D = A 删掉中间某一层 ⇒ 并入同族（家族数不变）
  (d) **幂等**：把同一个文件 A 再导入一次 ⇒ 家族数不翻倍
  (e) **归因零报错**：`/third-party/chatfilesys/` 的页面错误 = 0

真机纪律（`docs/dev/testing.md`「硬纪律」）：只碰探针角色 `__cb_e2e`、末尾清探针数据、
不用固定 `sleep` 做断言（走轮询 `wait_*`）、e2e 只对 Dev 实例跑。

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_family_align_e2e.py
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC, TEST_CHAR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 本用例自建的文件/家族名前缀 —— 计数家族时据此与「当前聊天的家族」等无关项隔离。
PREFIX = '__cb_e2e_fa_'
PAD = '正文正文正文正文正文正文正文正文正文正文'


def row(mes, **extra):
    """一段宿主消息行（正文够长，稳过 MIN_EVIDENCE_LEN=8 的门槛）。"""
    d = {'name': TEST_CHAR, 'is_user': False, 'mes': mes,
         'send_date': '2026-01-01T00:00:00.000Z'}
    d.update(extra)
    return d


# A：6 层互不相同的正文
A_ROWS = [row(f'{PREFIX}A{i}-{PAD}-{i}') for i in range(1, 7)]
A6 = A_ROWS[5]['mes']
# B = A 但**末层重新生成**（宿主真实形态：新版正文 + 旧版原样留在 swipes 里）
B_ROWS = A_ROWS[:5] + [row(
    f'{PREFIX}B6-新-{PAD}',
    swipes=[A6, f'{PREFIX}B6-新-{PAD}'], swipe_id=1,
)]
# C：与 A 内容几乎无重合（高偏移 ⇒ 必须判不同家族）
C_ROWS = [row(f'{PREFIX}C{i}-' + '己庚辛壬癸' * 8) for i in range(1, 7)]
# D = A 删掉中间第 3 层（4 层内容前移 ⇒ 有特征可对上）
D_ROWS = A_ROWS[:2] + A_ROWS[3:]

# 直接在磁盘上写一份聊天 jsonl（**不走插件的接缝**：用例在 off 档写，此时没有接缝）。
WRITE_CHAT_JS = """async ([fileName, rows]) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const res = await fetch('/api/chats/save', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: char.name, file_name: fileName, avatar_url: char.avatar,
            chat: [{ user_name: ctx.name1, character_name: char.name, chat_metadata: {} }, ...rows],
        }),
    });
    return res.status;
}"""

LIST_CHAT_FILES_JS = """async () => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const res = await fetch('/api/characters/chats', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: char.avatar }),
    });
    if (!res.ok) return { error: res.status };
    const d = await res.json();
    return { files: Array.isArray(d) ? d.map((x) => x.file_name) : d };
}"""

# 直读库内**某聊天键所属家族**的全部楼层行（只读探针，读完 dispose）。
# 必须带 Authority 客户端：本仓自 2026-09-27 起档1（Authority SQL）优先，不传会落到别的后端。
READ_FLOORS_JS = """async ([src, chatKey]) => {
    const ctx = SillyTavern.getContext();
    const mod = await import(src + '/core/storage/adapter.js');
    let authorityClient = null;
    try {
        const sdk = globalThis.STAuthority?.AuthoritySDK;
        if (sdk && typeof sdk.init === 'function') {
            authorityClient = await sdk.init({
                extensionId: 'third-party/chatfilesys', displayName: 'ChatFilesys',
                version: '1.0.0', installType: 'local',
                declaredPermissions: { sql: { private: true }, fs: { private: true } },
            });
        }
    } catch { /* 走降级档 */ }
    const built = await mod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(),
        log: () => {}, authorityClient,
    });
    try {
        const fam = await built.adapter.loadFamily({ chatKey });
        if (!fam) return null;
        const { floors } = await built.adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
        return JSON.parse(JSON.stringify({
            familyId: fam.familyId, name: fam.name,
            active: fam.model?.active_branch ?? null,
            branches: (fam.model?.branches || []).map((b) => ({
                id: b.id, name: b.name, is_default: !!b.is_default, path: b.path,
            })),
            groups: Object.keys(fam.model?.groups || {}),
            floors: floors.map((f) => {
                let c = null; try { c = JSON.parse(f.content); } catch { c = null; }
                return { floorNo: f.floorNo, variantId: f.variantId, mes: c?.mes ?? null,
                         swipes: c?.swipes ?? null, mesList: Array.isArray(c?.swipes) ? c.swipes : null };
            }),
        }));
    } finally { try { built.dispose?.(); } catch (e) { /* 探针清理失败无影响 */ } }
}"""

# 本角色家族计数（只计数**本用例自建前缀**的家族，与当前聊天的家族隔离）
COUNT_FAMILIES_JS = """async () => {
    const ctx = SillyTavern.getContext();
    const mod = await import('/scripts/extensions/third-party/chatfilesys/core/storage/adapter.js');
    let authorityClient = null;
    try {
        const sdk = globalThis.STAuthority?.AuthoritySDK;
        if (sdk && typeof sdk.init === 'function') {
            authorityClient = await sdk.init({
                extensionId: 'third-party/chatfilesys', displayName: 'ChatFilesys',
                version: '1.0.0', installType: 'local',
                declaredPermissions: { sql: { private: true }, fs: { private: true } },
            });
        }
    } catch { /* 走降级档 */ }
    const built = await mod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(),
        log: () => {}, authorityClient,
    });
    try {
        const fams = await built.adapter.listFamilies({ characterId: ctx.characterId }) || [];
        return JSON.parse(JSON.stringify({
            tier: built.tier,
            mine: fams.filter((f) => String(f.name || '').startsWith('__cb_e2e_fa_')),
            all: fams.map((f) => f.name),
        }));
    } finally { try { built.dispose?.(); } catch (e) { /* noop */ } }
}"""


def answer_confirm(r, expect, ok=False, timeout=60000):
    """回答导入旅程里的一个确认弹窗（按**文案认**弹窗，不靠弹窗个数——两问是连着来的）。"""
    r.pg.wait_for_function(
        """(t) => [...document.querySelectorAll('dialog[open]:not([closing])')]
            .some(d => d.innerText.includes(t))""",
        arg=expect, timeout=timeout)
    n = r.js("""([t, ok]) => {
        const d = [...document.querySelectorAll('dialog[open]:not([closing])')].find(x => x.innerText.includes(t));
        if (!d) return 0;
        const btn = d.querySelector(ok ? '.popup-button-ok' : '.popup-button-cancel');
        if (!btn) return 0;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 1;
    }""", [expect, bool(ok)])
    if not n:
        raise AssertionError(f'确认弹窗（{expect}）里没有要点的按钮')
    r.pg.wait_for_function(
        """(t) => ![...document.querySelectorAll('dialog[open]:not([closing])')]
            .some(d => d.innerText.includes(t))""",
        arg=expect, timeout=timeout)
    r.settle(400)
    return True


def count_mine(r):
    st = r.js(COUNT_FAMILIES_JS) or {}
    return st


def import_file(r, fileName):
    """在「角色卡的聊天」页签里点某一行的「转数据库」，并回答两问（**都选取消 = 保留源文件**）。

    保留源文件是刻意的：幂等那一项要把同一个文件再导一次。
    """
    r.ensure_popup()
    r.popup_switch_tab('角色卡的聊天')
    r.settle(1200)
    r.click_action("chat-import", file=fileName)
    answer_confirm(r, '删除源 jsonl 文件', ok=False)   # 取消 = 保留源 jsonl
    answer_confirm(r, '双写绑定', ok=False)            # 取消 = 不切双写
    return True


def wait_mine(r, pred, timeout=30000, desc=""):
    """轮询「本用例家族的计数/明细」直到 pred(st) 为真（不用固定 sleep 做断言）。"""
    end = time.time() + timeout / 1000
    last = None
    while time.time() < end:
        last = count_mine(r)
        try:
            if pred(last):
                return last
        except Exception:
            pass
        r.settle(500)
    raise TimeoutError(f"wait_mine 超时({desc}): last={last}")


def ws(chat_key):
    return "__cb_e2e_fa_ws" + chat_key  # 占位（未用）


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "family-align-e2e")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)

            # 出厂默认 = 增强模式（off）：此时**没有接缝**，写文件走原生 fetch。
            mode0 = r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null")
            if mode0 != 'off':
                r.set_storage_mode('off')
                r.close_popup()
            r.settle(600)

            # ---------- 前置：在磁盘上造 4 份 jsonl（A/B/C/D） ----------
            files = {'A': A_ROWS, 'B': B_ROWS, 'C': C_ROWS, 'D': D_ROWS}
            writes = {}
            for key, rows in files.items():
                writes[key] = r.js(WRITE_CHAT_JS, [f"{PREFIX}{key}.jsonl", rows])
            r.settle(1200)
            listed = r.js(LIST_CHAT_FILES_JS) or {}
            listed_files = listed.get('files') if isinstance(listed, dict) else listed
            mine_on_disk = [f for f in (listed_files or []) if str(f).startswith(PREFIX)]
            ok0 = all(v == 200 for v in writes.values()) and len(mine_on_disk) >= 4
            results.append(report("前置：磁盘上造出 4 份 jsonl（A/B/C/D），且宿主列得到它们", ok0,
                                  f"写入码={writes} 磁盘本前缀文件={sorted(mine_on_disk)}"))

            # 切纯库模式（导入旅程要求 storageState 就绪）——切完弹窗关掉，避免挡住后续
            r.set_storage_mode('pure')
            r.close_popup()
            r.settle(1200)
            c0 = count_mine(r)
            results.append(report("前置：切到纯库模式（导入旅程的前置条件），基线家族计数可取", True,
                                  f"tier={c0.get('tier')} 本前缀家族={[f['name'] for f in c0.get('mine', [])]} "
                                  f"全部家族={c0.get('all')}"))

            # ---------- (a) 导入 A → 建家族 ----------
            import_file(r, f"{PREFIX}A")
            st_a = wait_mine(r, lambda s: len(s.get('mine') or []) == 1, desc="导入 A 后 1 个家族")
            fam_a = r.js(READ_FLOORS_JS, [EXT_SRC, r.chat_key(f"{PREFIX}A")])
            ok_a1 = (len(st_a['mine']) == 1 and fam_a and len(fam_a['floors']) == 6)
            results.append(report("(a)-0 导入 A：新建 1 个家族、库里 6 层", ok_a1,
                                  f"家族={[f['name'] for f in st_a['mine']]} "
                                  f"familyId={fam_a and fam_a['familyId']} 层数={fam_a and len(fam_a['floors'])}"))

            fam_a_id = fam_a['familyId'] if fam_a else None

            # ---------- (a) 导入 B（末层「重新生成」）→ 并入同族 ----------
            import_file(r, f"{PREFIX}B")
            st_b = wait_mine(r, lambda s: len(s.get('mine') or []) == 1, timeout=25000,
                             desc="导入 B 后家族数仍为 1")
            fam_b = r.js(READ_FLOORS_JS, [EXT_SRC, r.chat_key(f"{PREFIX}B")])
            # (a)-1 家族数不增（B 并入 A，没新建家族），且 B 的键绑到同一个家族
            ok_a2 = (len(st_b['mine']) == 1
                     and fam_b is not None and fam_b['familyId'] == fam_a_id)
            results.append(report("(a)-1 导入 B 后家族数仍为 1（并入 A，未新建），且 B 的键绑到同一家族", ok_a2,
                                  f"家族={[f['name'] for f in st_b['mine']]} "
                                  f"A家族={fam_a_id} B家族={fam_b and fam_b['familyId']} "
                                  f"分支={fam_b and [x['id'] for x in fam_b['branches']]}"))

            # (a)-2 末层出现可切的 swipe 版本（两版正文都在）
            f6 = None
            if fam_b:
                for fl in fam_b['floors']:
                    if fl['floorNo'] == 6:
                        f6 = fl
            swipes = (f6 or {}).get('mesList') or []
            ok_a3 = (isinstance(swipes, list) and len(swipes) >= 2
                     and A6 in swipes and f'{PREFIX}B6-新-{PAD}' in swipes)
            results.append(report("(a)-2 该层（第 6 层）出现可切的 swipe 版本（A 版与 B 版都在）", ok_a3,
                                  f"第6层 variantId={f6 and f6['variantId']} mes={f6 and (f6['mes'] or '')[:24]!r} "
                                  f"swipes={swipes}"))

            # ---------- (b) 导入 C（与 A 几乎无重合）→ 新建家族 ----------
            import_file(r, f"{PREFIX}C")
            st_c = wait_mine(r, lambda s: len(s.get('mine') or []) == 2, timeout=30000,
                             desc="导入 C 后家族数 2")
            names_c = sorted(f['name'] for f in st_c['mine'])
            ok_b = (len(st_c['mine']) == 2 and names_c == [f'{PREFIX}A', f'{PREFIX}C'])
            results.append(report("(b) 高偏移文件 C 未被并入 ⇒ 新建家族（家族数 1→2）", ok_b,
                                  f"家族={names_c}"))

            # ---------- (c) 导入 D（A 删掉中间第 3 层）→ 并入同族 ----------
            import_file(r, f"{PREFIX}D")
            st_d = wait_mine(r, lambda s: f'{PREFIX}D' not in [x['name'] for x in (s.get('mine') or [])],
                             timeout=30000, desc="导入 D 未新建家族")
            fam_d = r.js(READ_FLOORS_JS, [EXT_SRC, r.chat_key(f"{PREFIX}D")])
            ok_c = (len(st_d['mine']) == 2
                    and fam_d is not None and fam_d['familyId'] == fam_a_id)
            results.append(report("(c) 中间删层的 D 并入同族（家族数不变，键绑到 A 家族）", ok_c,
                                  f"家族={sorted(f['name'] for f in st_d['mine'])} "
                                  f"D家族={fam_d and fam_d['familyId']} A家族={fam_a_id}"))

            # ---------- (d) 幂等：同一个文件 A 再导一次 ----------
            before_d = len(st_d['mine'])
            import_file(r, f"{PREFIX}A")
            r.settle(3000)
            st_d2 = wait_mine(r, lambda s: len(s.get('mine') or []) == before_d,
                              timeout=25000, desc="重复导入 A 后家族数不增")
            ok_d = (len(st_d2['mine']) == before_d
                    and sorted(f['name'] for f in st_d2['mine']) == sorted(f['name'] for f in st_d['mine']))
            results.append(report("(d) 重复导入同一个文件 A ⇒ 家族数不翻倍（幂等）", ok_d,
                                  f"导入前={sorted(f['name'] for f in st_d['mine'])} "
                                  f"导入后={sorted(f['name'] for f in st_d2['mine'])}"))

            # ---------- (e) 归因零报错 ----------
            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            ce = r.console_errors_from("chatfilesys")
            results.append(report("(e) 全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在库模式）: {e}")
            try:
                r.delete_test_char()   # 连聊天文件一起删（测试自产，非用户数据）
            except Exception:
                pass
            # 今晚三次实证：driver 可能在 close 时死亡/挂起，吞掉其后的判定打印——
            # 关浏览器异常必须兜住，判定与证据要落在最不可能丢的位置（2026-10-31）。
            try:
                b.close()
            except Exception as e:
                print(f"[warn] 浏览器关闭异常（不影响判定）：{str(e)[:120]}")


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nFAMILY ALIGN E2E " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
