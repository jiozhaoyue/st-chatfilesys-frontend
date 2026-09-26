"""ChatFilesys 每层版本管理 e2e（T7 / R5 末段 / AC17 + AC19）

用户裁定（2026-09-25）：「我只是让你参考那个插件，不是全盘要那个插件的做法」——
**只参考交互设计，不引入第三方代码**；存法 = 库内既有形态（宿主原生
`swipes` / `swipe_info` / `swipe_id` 三件套），不另造宿主行形态。

断言（AC17 / AC19）：

  ① 版本按钮**仅该层 swipe 组数 > 1 时**出现（单组层该消息上零插件元素），
     形状 = 分叉图标 + 计数（不用左右箭头）
  ② 版本弹窗 = **官方 Popup**（无自造窗口 / 不挂 document.body），
     列出「组 × 组内版本」展平后的全部版本，标出**当前项**，预览面板**只读**显示全文
  ③ 组内版本切换 = 纯 swipe 语义：**后续楼层不变**，库内 `swipe_id` / `mes` 跟上
  ④ 别的组的版本 = **切分支**（`active_branch` 改，正文变成那条分支的投影）
  ⑤ 重排：上下移交换两个版本（正文与元数据一起搬，「当前」跟着内容走）
  ⑥ 编辑：就地改某一版正文并落库
  ⑦ 多选删除：全选时按钮置灰（**至少保留一个**）；选中 2 个删除后库里只剩 1 个版本
  ⑧ **AC19**：导出的 jsonl 与双写落出的 jsonl 里 `swipes` / `swipe_info` / `swipe_id`
     三件套与库内、与宿主原生格式一一对应（磁盘文件用**上下文级** HTTP 读，绕开页内接缝）
  ⑨ 全程零 chatfilesys 归因报错

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法：PYTHONIOENCODING=utf-8 python tests/e2e/test_swipe_versions.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC, BASE  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 版本弹窗（内容根 = .chatfilesys-versions，住在官方 Popup 的 dialog 里）
VERS = 'dialog[open]:not([closing]) .chatfilesys-versions'

# 造场景用的四条正文（0/1/2 = 当前组的三个版本；3 = 别组的版本）
TEXTS = ['V0-主线', 'V1-主线', 'V2-主线', '别组的支线']

# 数据层种子（只走官方适配器；**不经 UI**——插件不提供「造 swipe」的按钮）
SEED_JS = """async (args) => {
    const [src, chatKey, texts] = args;
    const ctx = SillyTavern.getContext();
    const adapterMod = await import(src + '/core/storage/adapter.js');
    const proj = await import(src + '/core/projection.js');
    const built = await adapterMod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(), log: () => {},
    });
    try {
        const fam = await built.adapter.loadFamily({ chatKey });
        if (!fam) return { ok: false, reason: 'no-family' };
        const fl = await built.adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
        const row = (f, g) => fl.floors.find((x) => x.floorNo === f && x.variantId === g);
        const model = fam.model;
        const active = model.branches.find((b) => b.id === model.active_branch);
        const g1 = active.path[1];
        const g2 = active.path[2];
        if (!g1 || !g2) return { ok: false, reason: 'no-floor2' };
        const base = JSON.parse(row(2, g2).content);
        // 当前组的第 2 层 → 3 个宿主原生版本（三件套齐全，与宿主自己 swipe 出来的形态一致）
        const line2 = Object.assign({}, base, {
            mes: texts[0],
            swipes: [texts[0], texts[1], texts[2]],
            swipe_id: 0,
            swipe_info: texts.slice(0, 3).map((t, i) => ({ send_date: 100 + i, extra: { v: i } })),
            extra: { v: 0 },
        });
        // 新分支 b1：第 2 层换成一个**新组 g7** → 该层成为分叉点（版本按钮的出现条件）
        const g7 = 'g7';
        model.branches.push({ id: 'b1', name: '支线', is_default: false, fork_base: 2, path: { 1: g1, 2: g7 } });
        const line7 = { name: 'AI', is_user: false, mes: texts[3], send_date: 200, extra: { v: 9 } };
        const folded = proj.groupFromLine(g7, 2, line7);
        folded.owner = 'b1';
        model.groups[g7] = folded;
        await built.adapter.saveModel({ familyId: fam.familyId, model, expectedIntegrity: fam.integrity });
        await built.adapter.saveFloors({
            familyId: fam.familyId, expectedIntegrity: null,
            floors: [
                { floorNo: 2, variantId: g2, seq: 0, content: JSON.stringify(line2), contentHash: null, sendDate: 100 },
                { floorNo: 2, variantId: g7, seq: 0, content: JSON.stringify(line7), contentHash: null, sendDate: 200 },
            ],
        });
        return { ok: true, g1, g2, g7, branch: 'b1' };
    } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
    } finally { try { built.dispose?.(); } catch (e) { /* 探针清理失败无影响 */ } }
}"""

# 只读探针：直接读库（不经接缝合成），拿楼层行的真内容与家族模型
READ_LIB_JS = """async (args) => {
    const [src, chatKey] = args;
    const ctx = SillyTavern.getContext();
    const adapterMod = await import(src + '/core/storage/adapter.js');
    const built = await adapterMod.createStorageAdapter({
        fetch: (...a) => globalThis.fetch(...a), headers: () => ctx.getRequestHeaders(), log: () => {},
    });
    try {
        const fam = await built.adapter.loadFamily({ chatKey });
        if (!fam) return null;
        const fl = await built.adapter.loadFloors({ familyId: fam.familyId, from: 0, limit: 1e9 });
        return JSON.parse(JSON.stringify({
            active: fam.model ? fam.model.active_branch : null,
            branches: (fam.model && fam.model.branches || []).map((b) => ({ id: b.id, path: b.path })),
            groups: Object.keys((fam.model && fam.model.groups) || {}),
            rows: fl.floors.map((f) => ({ floorNo: f.floorNo, variantId: f.variantId, line: JSON.parse(f.content) })),
        }));
    } finally { try { built.dispose?.(); } catch (e) { /* 探针清理失败无影响 */ } }
}"""

# 聊天界面盘点：每层有没有版本按钮、按钮文案（形状 = 分叉图标 + 计数）
MES_TOOLS_JS = """() => [...document.querySelectorAll('#chat .mes[mesid]')].map((el) => ({
    floor: Number(el.getAttribute('mesid')) + 1,
    label: (el.querySelector(':scope > .chatfilesys-mes-tools .chatfilesys-ver-btn') || {}).textContent || null,
}))"""

VER_STATE_JS = """() => {
    const root = document.querySelector('%s');
    if (!root) return null;
    const del = root.querySelector('[data-act="delete"]');
    return {
        head: (root.querySelector('.chatfilesys-ver-head') || {}).innerText || '',
        inDialog: !!root.closest('dialog[open]'),
        selfMade: [...document.querySelectorAll('.chatfilesys-versions')].filter((el) => !el.closest('dialog[open]')).length,
        items: [...root.querySelectorAll('.chatfilesys-ver-item')].map((el) => ({
            key: el.dataset.key,
            k: (el.querySelector('.chatfilesys-ver-k') || {}).innerText || '',
            current: el.classList.contains('current'),
            selected: el.classList.contains('selected'),
            check: !!el.querySelector('input[type="checkbox"]'),
            text: (el.querySelector('.chatfilesys-ver-txt') || {}).innerText || '',
        })),
        preview: (root.querySelector('.chatfilesys-ver-preview-body') || {}).innerText || '',
        error: (root.querySelector('.chatfilesys-ver-err') || {}).innerText || '',
        editBox: !!root.querySelector('[data-role="ver-edit"]'),
        deleteBtn: del ? { disabled: !!del.disabled, text: del.innerText } : null,
    };
}""" % VERS

# 打开版本弹窗：点该层消息旁的版本按钮（入口 = 消息旁版本按钮，唯一）
OPEN_VER_JS = """(floor) => {
    const el = document.querySelector('#chat .mes[mesid="' + (floor - 1) + '"]');
    const btn = el ? el.querySelector(':scope > .chatfilesys-mes-tools .chatfilesys-ver-btn') : null;
    if (!btn) return 0;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 1;
}"""

# 关闭版本弹窗：走宿主自己的关闭控件（`.popup-button-close`），**不用** dlg.close()
# （后者绕过宿主 `Popup#hide` 的 DOM 清理 → 残骸；教训见 probe_popup_residue.py）
CLOSE_VER_JS = """() => {
    const dlgs = [...document.querySelectorAll('dialog')].filter((d) => d.querySelector('.chatfilesys-versions'));
    const dlg = dlgs.find((d) => d.open) || dlgs[0];
    if (!dlg) return 'no-popup';
    const btn = dlg.querySelector('.popup-button-close');
    if (!btn) return 'no-close-button';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'closing';
}"""

CLICK_JS = """(s) => {
    const el = document.querySelector(s);
    if (!el) return 0;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 1;
}"""

CHECK_JS = """(args) => {
    const [s, want] = args;
    const el = document.querySelector(s);
    if (!el) return 0;
    el.checked = want;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
}"""

# 捕获导出：插件把 jsonl 装成 Blob 交给下载；截住它的字节（= 用户真正下载到的内容）
CAPTURE_JS = """() => {
    if (window.__cfsysCaptureArmed) return 'already';
    window.__cfsysCaptureArmed = true;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        try { blob.text().then((t) => { window.__cfsysExport = t; }); } catch (e) { /* 捕获失败不影响导出 */ }
        return orig(blob);
    };
    return 'armed';
}"""


def reload_chat(r, settle_ms=2500):
    """重载当前聊天 = 重新「打开」它（纯库模式下走接缝读库）。"""
    r.js("async () => { await SillyTavern.getContext().reloadCurrentChat(); return 'reloaded'; }")
    r.settle(settle_ms)


def read_lib(r, key):
    return r.js(READ_LIB_JS, [EXT_SRC, key])


def row_of(lib, floor, gid):
    for x in (lib or {}).get('rows', []):
        if x['floorNo'] == floor and x['variantId'] == gid:
            return x['line']
    return None


def open_versions(r, floor, timeout=15000):
    n = r.js(OPEN_VER_JS, floor)
    if not n:
        raise AssertionError(f'第 {floor} 层没有可点的版本按钮')
    r.pg.wait_for_selector(VERS, timeout=timeout)
    r.settle(400)


def close_versions(r, timeout=8000):
    r.js(CLOSE_VER_JS)
    r.pg.wait_for_function(
        "() => document.querySelectorAll('.chatfilesys-versions').length === 0", timeout=timeout)


def ver_state(r):
    return r.js(VER_STATE_JS)


def ver_click(r, act, key=None, k=None, settle=400):
    sel = f'{VERS} [data-act="{act}"]'
    if key:
        sel += f'[data-key="{key}"]'
    if k is not None:
        sel += f'[data-k="{k}"]'
    if not r.js(CLICK_JS, sel):
        raise AssertionError(f'版本弹窗里找不到控件: {sel}')
    r.settle(settle)


def ver_check(r, key, checked=True):
    sel = f'{VERS} [data-act="check"][data-key="{key}"]'
    if not r.js(CHECK_JS, [sel, checked]):
        raise AssertionError(f'版本勾选框找不到: {sel}')
    r.settle(250)


def triple_ok(line, want_swipes=None, want_id=None):
    """宿主原生三件套的一致性判据（AC19）：swipes / swipe_info / swipe_id 一一对应。"""
    if not isinstance(line, dict):
        return False, 'not-an-object'
    sw = line.get('swipes')
    info = line.get('swipe_info')
    if not isinstance(sw, list) or not sw:
        return False, f'swipes={sw!r}'
    if want_swipes is not None and sw != want_swipes:
        return False, f'swipes={sw!r} ≠ {want_swipes!r}'
    if not isinstance(info, list) or len(info) != len(sw):
        return False, f'swipe_info 长度 {len(info) if isinstance(info, list) else info!r} ≠ swipes {len(sw)}'
    if not all(isinstance(x, dict) and 'send_date' in x and 'extra' in x for x in info):
        return False, f'swipe_info 项形态不对: {info!r}'
    sid = line.get('swipe_id')
    if not isinstance(sid, int) or sid < 0 or sid >= len(sw):
        return False, f'swipe_id={sid!r}'
    if want_id is not None and sid != want_id:
        return False, f'swipe_id={sid} ≠ {want_id}'
    if line.get('mes') != sw[sid]:
        return False, f'mes={line.get("mes")!r} ≠ swipes[swipe_id]={sw[sid]!r}'
    return True, f'swipes={sw!r} swipe_id={sid} info={len(info)}'


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "swipe-versions")
        try:
            r.boot()                       # T7 不测入库提醒 → harness 默认压掉
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)

            # ---------- 准备：纯库模式 + 4 层 + 第 2 层分叉（当前组 3 个版本 / 别组 1 个版本） ----------
            r.set_storage_mode('pure')
            r.close_popup()
            chat = r.new_chat()
            r.settle(1500)
            key = r.chat_key()
            reload_chat(r)
            for _ in range(12):
                if r.model() and r.read_family(key):
                    break
                reload_chat(r, 1200)
            for cmd in ["/send U-F2", "/sendas name=__cb_e2e A-F3", "/send U-F4"]:
                r.cmd(cmd)
                r.settle(800)
            r.wait_state(lambda s: s["chatLen"] == 4, desc="造 4 层")

            seed = r.js(SEED_JS, [EXT_SRC, key, TEXTS])
            results.append(report("前置：第 2 层种成「当前组 3 个版本 + 别组 1 个版本」（宿主原生三件套）",
                                  bool(seed.get('ok')), f"chat={chat} key={key} seed={seed}"))
            if not seed.get('ok'):
                return 1
            reload_chat(r)
            st0 = r.state()
            lib0 = read_lib(r, key)
            row0 = row_of(lib0, 2, seed['g2'])
            ok0, d0 = triple_ok(row0, TEXTS[:3], 0)
            results.append(report("前置：正文 4 层，第 2 层是 3 个原生版本（库内三件套自洽）",
                                  st0["chatLen"] == 4 and ok0, f"chatLen={st0['chatLen']} {d0}"))

            # ---------- ① 版本按钮的出现条件（仅该层 swipe 组数 > 1） ----------
            rows = r.js(MES_TOOLS_JS) or []
            with_btn = {x['floor']: x['label'] for x in rows if x['label']}
            ok1 = (len(rows) == 4 and set(with_btn.keys()) == {2} and with_btn[2] == '⎇ 1/2'
                   and all(not any(ch in (x['label'] or '') for ch in '←→‹›') for x in rows))
            results.append(report("① 版本按钮仅多分叉层出现（第 2 层 = ⎇ 1/2），其余消息零插件元素、不用箭头",
                                  ok1, f"按钮={with_btn} 总层={len(rows)}"))

            # ---------- ② 版本弹窗：官方 Popup + 清单 + 当前项 + 只读预览 ----------
            open_versions(r, 2)
            vs = ver_state(r)
            ok2a = bool(vs and vs['inDialog'] and vs['selfMade'] == 0)
            results.append(report("② 版本弹窗 = 官方 Popup（内容住在 dialog 里，无自造窗口/无 body 直挂）",
                                  ok2a, f"inDialog={vs and vs['inDialog']} 游离节点={vs and vs['selfMade']}"))
            ok2b = (bool(vs) and len(vs['items']) == 4
                    and vs['items'][0]['current'] and vs['items'][0]['k'] == '版本 1/3'
                    and vs['items'][3]['key'].startswith(seed['g7'] + '#')
                    and '第 2 层' in vs['head'] and '2 个 swipe 组' in vs['head'])
            results.append(report("② 列出「组 × 组内版本」展平后的全部版本（3 + 1），标出当前项",
                                  ok2b, f"head={vs and vs['head'][:60]!r} items={[x['key'] + ':' + x['k'] + ('*' if x['current'] else '') for x in (vs or {}).get('items', [])]}"))
            ok2c = bool(vs) and vs['preview'] == TEXTS[0] and vs['items'][3]['text'] == TEXTS[3]
            results.append(report("②-2 预览只读显示当前版本全文；别的组的正文也读得到（库内行/折叠组）",
                                  ok2c, f"preview={vs and vs['preview']!r} 别组={vs and vs['items'][3]['text']!r}"))

            # 点别的行 = 只读预览（不写任何东西）
            r.js(CLICK_JS, f'{VERS} .chatfilesys-ver-item[data-key="{seed["g7"]}#0"]')
            r.settle(300)
            vs = ver_state(r)
            row_after_preview = row_of(read_lib(r, key), 2, seed['g2'])
            ok2d = bool(
                vs and vs['preview'] == TEXTS[3] and vs['items'][3]['selected']
                and row_after_preview and row0
                and row_after_preview.get('swipes') == row0.get('swipes')
                and row_after_preview.get('swipe_id') == row0.get('swipe_id')
                and row_after_preview.get('mes') == row0.get('mes')
            )
            results.append(report("②-3 点行只做预览（选中态变、库内行一字未动）",
                                  ok2d, f"preview={vs and vs['preview']!r} 行内容未变={bool(row_after_preview == row0)}"))

            # ---------- ③ 组内版本切换（纯 swipe 语义：后续楼层不变） ----------
            ver_click(r, 'switch', key=f'{seed["g2"]}#2', settle=1500)
            lib1 = read_lib(r, key)
            row1 = row_of(lib1, 2, seed['g2'])
            st1 = r.state()
            ok3, d3 = triple_ok(row1, TEXTS[:3], 2)
            results.append(report("③ 切到同组第 3 版：库内 swipe_id/mes 跟上，**后续楼层不变**",
                                  ok3 and st1["chatLen"] == 4, f"chatLen={st1['chatLen']} {d3}"))

            # ---------- ④ 别的组的版本 → 切分支 ----------
            ver_click(r, 'switch', key=f'{seed["g7"]}#0', settle=2000)
            lib2 = read_lib(r, key)
            st2 = r.state()
            ok4 = (lib2 and lib2['active'] == seed['branch'] and st2["chatLen"] == 2)
            results.append(report("④ 选别的组的版本 → 切到那条分支（active_branch 改，正文 = 该分支投影）",
                                  ok4, f"active={lib2 and lib2['active']} chatLen={st2['chatLen']}"))

            # 回到主分支（既有 UI 路径：结构树上的切换）
            close_versions(r)
            r.ensure_active('b_main')
            r.close_popup()
            r.settle(600)
            reload_chat(r)
            lib3 = read_lib(r, key)
            rows3 = r.js(MES_TOOLS_JS) or []
            floor2 = [x for x in rows3 if x['floor'] == 2]
            results.append(report("④-2 切回主分支后第 2 层仍是分叉点（版本按钮照常出现）",
                                  row_of(lib3, 2, seed['g2']) is not None
                                  and bool(floor2) and floor2[0]['label'] == '⎇ 1/2',
                                  f"按钮={[x['label'] for x in floor2]} active={lib3 and lib3['active']}"))

            # ---------- ⑤ 重排（交换两个版本，当前跟着内容走） ----------
            open_versions(r, 2)
            before5 = row_of(read_lib(r, key), 2, seed['g2'])
            ver_click(r, 'down', key=f'{seed["g2"]}#0', settle=1500)
            after5 = row_of(read_lib(r, key), 2, seed['g2'])
            ok5, d5 = triple_ok(after5)
            sw_ok = (after5 and before5 and after5['swipes'][0] == before5['swipes'][1]
                     and after5['swipes'][1] == before5['swipes'][0]
                     and after5['swipe_id'] == before5['swipe_id']
                     and len(after5['swipe_info']) == len(before5['swipe_info']))
            results.append(report("⑤ 重排：上下移交换两个版本（正文与元数据一起搬，当前跟着内容走）",
                                  bool(sw_ok) and ok5, f"before={before5 and before5.get('swipes')} after={after5 and after5.get('swipes')} swipe_id={after5 and after5.get('swipe_id')} {d5}"))

            # ---------- ⑥ 编辑（就地改某一版正文并落库） ----------
            ver_click(r, 'edit', key=f'{seed["g2"]}#0', settle=400)
            vs6 = ver_state(r)
            ok6a = bool(vs6 and vs6['editBox'])
            results.append(report("⑥ 编辑：就地文本框出现（仍在官方 Popup 内，无自造窗口）",
                                  ok6a, f"editBox={vs6 and vs6['editBox']}"))
            r.pg.fill(f'{VERS} [data-role="ver-edit"]', 'E2E-EDITED')
            ver_click(r, 'save-edit', settle=1500)
            after6 = row_of(read_lib(r, key), 2, seed['g2'])
            ok6b, d6 = triple_ok(after6)
            results.append(report("⑥-2 编辑落库：那一版的正文被改写，三件套仍一一对应",
                                  bool(ok6b) and bool(after6) and after6['swipes'][0] == 'E2E-EDITED',
                                  f"swipes={after6 and after6.get('swipes')} {d6}"))

            # ---------- ⑦ 多选删除（至少保留一个） ----------
            ver_click(r, 'select-all', settle=400)
            vs7 = ver_state(r)
            ok7a = bool(vs7 and vs7['deleteBtn'] and vs7['deleteBtn']['disabled'])
            results.append(report("⑦ 全选时删除按钮置灰 = 至少保留一个（不可删到空）",
                                  ok7a, f"deleteBtn={vs7 and vs7['deleteBtn']}"))
            ver_check(r, f'{seed["g2"]}#2', False)
            vs7b = ver_state(r)
            ok7b = bool(vs7b and vs7b['deleteBtn'] and not vs7b['deleteBtn']['disabled']
                        and '2' in vs7b['deleteBtn']['text'])
            results.append(report("⑦-2 取消一个勾选后按钮可用并显示选中数（2）",
                                  ok7b, f"deleteBtn={vs7b and vs7b['deleteBtn']}"))
            ver_click(r, 'delete', settle=2000)
            after7 = row_of(read_lib(r, key), 2, seed['g2'])
            vs7c = ver_state(r)
            ok7c, d7 = triple_ok(after7)
            results.append(report("⑦-3 删除落库：该层只剩 1 个版本（当前/正文自洽），弹窗内变 2 条（无勾选框）",
                                  bool(ok7c) and bool(after7) and len(after7.get('swipes') or []) == 1
                                  and bool(vs7c) and len(vs7c['items']) == 2
                                  and not any(x['check'] for x in (vs7c or {}).get('items', [])),
                                  f"swipes={after7 and after7.get('swipes')} items={vs7c and [x['key'] + ':' + x['k'] for x in vs7c['items']]} {d7}"))

            close_versions(r)

            # ---------- ⑧ AC19：导出的 jsonl 与双写落出的 jsonl ----------
            lib8 = read_lib(r, key)
            row8 = row_of(lib8, 2, seed['g2'])
            triple_lib, d8 = triple_ok(row8)

            r.js(CAPTURE_JS)
            r.open_popup()
            r.popup_switch_tab('当前聊天')
            r.click_action('export')
            try:
                r.pg.wait_for_function("() => typeof window.__cfsysExport === 'string'", timeout=15000)
            except Exception as e:
                print(f"  [warn] 未捕获到导出字节: {e}")
            exported = r.js("() => window.__cfsysExport || null")
            exp_line = None
            exp_header = None
            if exported:
                try:
                    parsed = [json.loads(x) for x in exported.strip().split('\n') if x.strip()]
                    exp_header = parsed[0] if parsed else None
                    exp_line = parsed[2] if len(parsed) > 2 else None
                except Exception as e:
                    print(f"  [warn] 导出内容解析失败: {e}")
            triple_exp, d_exp = triple_ok(exp_line, row8.get('swipes'), row8.get('swipe_id'))
            # 导出的是**纯标准 jsonl**：header 里不得有本插件模型（它只属于库）
            no_model = isinstance(exp_header, dict) and not ((exp_header.get('chat_metadata') or {}).get('extensions') or {}).get('chatfilesys')
            results.append(report("⑧ 导出的 jsonl：第 2 层的 swipes/swipe_info/swipe_id 与库内行一一对应（且不含本插件模型）",
                                  bool(triple_lib) and bool(triple_exp) and no_model,
                                  f"库内={d8}；导出={d_exp}；header 无插件模型={no_model}"))
            r.close_popup()

            # 双写：磁盘文件是标准 jsonl（用**上下文级** HTTP 读，绕开页内接缝）
            r.set_storage_mode('mirror')
            r.settle(2000)
            hdrs = r.js("() => SillyTavern.getContext().getRequestHeaders()")
            char = r.js("() => { const x = SillyTavern.getContext(); const ch = x.characters[x.characterId]; return { name: ch.name, avatar: ch.avatar }; }")

            def native_file(name):
                try:
                    resp = c.request.post(
                        f"{BASE}/api/chats/get",
                        headers={**hdrs, "Content-Type": "application/json"},
                        data=json.dumps({"ch_name": char["name"], "file_name": name, "avatar_url": char["avatar"]}),
                        timeout=20000,
                    )
                    return resp.json() if resp.ok else None
                except Exception as e:
                    print(f"  [warn] 磁盘文件读取失败: {e}")
                    return None

            disk = native_file(chat)
            for _ in range(20):
                if isinstance(disk, list) and len(disk) > 2:
                    break
                r.settle(1000)
                disk = native_file(chat)
            disk_line = disk[2] if isinstance(disk, list) and len(disk) > 2 else None
            disk_meta = (disk[0].get('chat_metadata') if isinstance(disk, list) and disk else None) or {}
            triple_disk, d_disk = triple_ok(disk_line, row8.get('swipes'), row8.get('swipe_id'))
            results.append(report("⑧-2 双写落出的 jsonl：同一层三件套与库内行一致，且不是本插件模型文件",
                                  bool(triple_disk) and not (disk_meta.get('extensions') or {}).get('chatfilesys'),
                                  f"磁盘={d_disk}；行数={len(disk) if isinstance(disk, list) else disk}"))

            # ---------- ⑨ 全程零 chatfilesys 归因报错 ----------
            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            ce = r.console_errors_from("chatfilesys")
            seam_reject = [t for (_ty, t, _s) in r.logs if 'chatfilesys-seam' in t and ('未应用' in t or '拒绝' in t)]
            results.append(report("⑨ 全程零 chatfilesys 归因报错、接缝零拒绝",
                                  len(errs) == 0 and not ce and not seam_reject,
                                  f"pageerror={errs[:2]} console={ce[:2]} 接缝拒绝={seam_reject[:2]}"))
            for t in [t for (_ty, t, _s) in r.logs if 'chatfilesys-seam' in t]:
                print(f"  [seam] {t[:200]}")
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.set_storage_mode('off')   # 先恢复出厂默认，再删测试角色（删角色会把界面切走）
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在库模式）: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nSWIPE VERSIONS " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
