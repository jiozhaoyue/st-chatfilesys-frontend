"""ChatFilesys 双写模式 e2e（T2/R3，AC5）

真机验证目标：

  ① 建测试家族（official 档隐容器）→ 绑定 __cb_e2e 的权威键 → 装接缝 + 双写落盘器
  ② **自动落盘**：经接缝写一次（append）→ 1.5 秒防抖到点 → 磁盘上出现标准聊天文件
     - 文件可被原生读回（`/api/chats/get`）
     - header **不带**本插件模型（`extensions.chatfilesys` 不存在）——否则会被误认成增强模式文件
     - 正文 = 库里当前走法的投影（逐行一致）
  ③ **库为准**：直接改库（不经接缝）→ 文件暂时落后（`state.pending` 由接缝写触发；此处直改库不标脏）
     → 「与库同步一次」（`exportByChatKey`）→ 文件与库重新一致
  ④ **反向不采纳**：手工把磁盘文件改成别的内容 → 经接缝读 `chats/get` 必须仍是**库**内容
     （双写只写不读；文件 → 库是导入旅程的职责）
  ⑤ 清场：把 __cb_e2e 的原聊天文件**按测试前的快照还原**，删测试家族

L0-1 纪律：只走官方端点；`__cb_e2e` 为专用测试角色；测试前后该角色聊天文件内容一致（快照还原）。
依赖：Dev Luker 8003 在跑 + 8417 静态源在跑。
用法：python tests/e2e/test_mirror_mode.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from harness import reset_instance  # noqa: E402

BASE = "https://127.0.0.1:8003"
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"
CHAR_NAME = "__cb_e2e"
FAMILY_ID = "f_t2_mirror"

STEPS = """async (extSrc) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        const seamMod = await import(extSrc + '/core/seam.js');
        const adapterMod = await import(extSrc + '/core/storage/adapter.js');
        const mirrorMod = await import(extSrc + '/core/mirror.js');
        const nativeFetch = (...a) => window.__nativeFetch.apply(null, a);
        const H = () => window.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {};
        const { tier, adapter, dispose: disposeAdapter } = await adapterMod.createStorageAdapter({
            fetch: nativeFetch, headers: H, log: (m) => log('warn: ' + String(m).slice(0, 120)),
        });
        log('tier: ' + tier);

        const res0 = await nativeFetch('/api/characters/all', { method: 'POST', headers: H(), body: JSON.stringify({}) });
        const chars = await res0.json();
        const target = chars.find(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        if (!target) { log('char not found'); out.ok = false; return out; }

        const nativeGet = (fileName) => nativeFetch('/api/chats/get', {
            method: 'POST', headers: H(), body: JSON.stringify({ avatar_url: target.avatar, file_name: fileName }),
        }).then(r => r.json());
        const nativeSave = (fileName, arr) => nativeFetch('/api/chats/save', {
            method: 'POST', headers: H(),
            body: JSON.stringify({ ch_name: fileName, file_name: fileName, avatar_url: target.avatar, chat: arr, force: true }),
        }).then(r => r.json());
        const seamGet = (fileName) => fetch('/api/chats/get', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...H() },
            body: JSON.stringify({ avatar_url: target.avatar, file_name: fileName }),
        }).then(r => r.json());
        const seamAppend = (fileName, rows) => fetch('/api/chats/append', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...H() },
            body: JSON.stringify({ avatar_url: target.avatar, file_name: fileName, messages: rows }),
        }).then(r => r.json());

        // ⓪ 原文件快照（清场还原用；双写会覆盖这个真实角色的聊天文件）
        const origArr = await nativeGet(target.chat);
        out.__origRows = Array.isArray(origArr) ? origArr.length : 0;
        log('original file rows (with header) = ' + out.__origRows);

        await adapter.deleteFamily({ familyId: '@@FID@@' }).catch(() => {});

        // ① 建家族（2 层）+ 权威键绑定
        const family = {
            familyId: '@@FID@@', chatKey: target.avatar + '::' + target.chat, characterId: '@@CHAR@@', name: 't2-mirror',
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        };
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) { log('createFamily FAIL: ' + JSON.stringify(cr)); out.ok = false; return out; }
        await adapter.saveFloors({ familyId: '@@FID@@', expectedIntegrity: null, floors: [1, 2].map((n) => ({
            floorNo: n, variantId: 'g' + n, seq: 0,
            content: JSON.stringify({ name: n % 2 ? 'User' : 'Assistant', is_user: n % 2 === 1, mes: 'T2 探针楼层' + n, send_date: n }),
            contentHash: null, sendDate: n,
        }))});
        log('family seeded(2 floors)');

        const seamLog = [];
        let mirror = null;
        const seam = seamMod.installSeam(adapter, {
            log: (m) => seamLog.push(String(m)),
            onWrote: (evt) => mirror?.markDirty(evt),
        });
        mirror = mirrorMod.createMirror({
            adapter,
            native: (...args) => seam.native(...args),   // 落盘绕开接缝（不会自触发）
            headers: H,
            log: (m) => log('mirror warn: ' + String(m).slice(0, 140)),
            debounceMs: 1500,
        });
        out.__modeOk = true;

        // ② 自动落盘：经接缝 append 一条 → 防抖到点 → 文件更新
        const rApp = await seamAppend(target.chat, [{ name: 'Assistant', is_user: false, mes: 'T2 双写探针：自动落盘', send_date: 99 }]);
        log('seam append → ' + JSON.stringify(rApp));
        await sleep(4000); // 1.5s 防抖 + 落盘往返
        out.__autoPending = mirror.state.pending;
        out.__autoWritten = mirror.state.writeCount;
        out.__autoError = mirror.state.lastError;

        const fileArr = await nativeGet(target.chat);
        const fileMeta = fileArr?.[0]?.chat_metadata || {};
        out.__fileRows = fileArr.length - 1;
        out.__fileNoModel = !(fileMeta.extensions && fileMeta.extensions.chatfilesys);
        out.__fileLastMes = fileArr[fileArr.length - 1]?.mes;
        log('disk file after auto-mirror: rows=' + out.__fileRows + ' noPluginModel=' + out.__fileNoModel
            + ' last=' + JSON.stringify(out.__fileLastMes) + ' writeCount=' + mirror.state.writeCount
            + ' error=' + mirror.state.lastError);

        // 文件正文 == 库里当前走法的投影（逐行）
        const libArr = await seamGet(target.chat);
        out.__fileEqualsLib = JSON.stringify(fileArr.slice(1)) === JSON.stringify(libArr.slice(1));
        log('file == library projection: ' + out.__fileEqualsLib);

        // ③ 库为准 + 一键重建：直接改库（不经接缝，故文件会落后）
        await adapter.saveFloors({ familyId: '@@FID@@', expectedIntegrity: null, floors: [
            { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'Assistant', is_user: false, mes: 'T2：库内直改（文件应落后）', send_date: 100 }), contentHash: null, sendDate: 100 },
        ]});
        const beforeSync = await nativeGet(target.chat);
        out.__staleBeforeSync = !JSON.stringify(beforeSync.slice(1)).includes('库内直改');
        const syncRes = await mirror.exportByChatKey(target.avatar + '::' + target.chat);
        const afterSync = await nativeGet(target.chat);
        out.__syncOk = syncRes.ok === true && JSON.stringify(afterSync.slice(1)).includes('库内直改');
        log('one-shot resync: staleBefore=' + out.__staleBeforeSync + ' syncOk=' + out.__syncOk + ' result=' + JSON.stringify(syncRes));

        // ④ 反向不采纳：手工改磁盘文件 → 经接缝读仍是库内容
        const forged = [fileArr[0], JSON.stringify({ name: 'User', is_user: true, mes: '磁盘伪造行（不得进库）' })];
        await nativeSave(target.chat, forged);
        const readBack = await seamGet(target.chat);
        out.__diskNotAdopted = !JSON.stringify(readBack).includes('磁盘伪造行');
        out.__readIsLibrary = JSON.stringify(readBack.slice(1)).includes('库内直改');
        log('reverse (file→library) not adopted: ' + out.__diskNotAdopted + ' readIsLibrary=' + out.__readIsLibrary);

        // ⑤ 清场：还原原文件快照 → 删家族
        await nativeSave(target.chat, origArr);
        const restored = await nativeGet(target.chat);
        out.__restored = JSON.stringify(restored) === JSON.stringify(origArr);
        await adapter.deleteFamily({ familyId: '@@FID@@' }).catch(() => {});
        mirror.dispose();
        seam.dispose();
        disposeAdapter();
        seamLog.forEach((m, i) => log('seam[' + i + '] ' + m));
        log('cleaned (orig file restored=' + out.__restored + ')');

        // ── 通过判据（AC5）
        out.ok = out.__autoPending === false && out.__autoError === null && out.__autoWritten >= 1
            && out.__fileRows === 3 && out.__fileNoModel === true
            && out.__fileEqualsLib === true
            && out.__staleBeforeSync === true && out.__syncOk === true
            && out.__diskNotAdopted === true && out.__readIsLibrary === true
            && out.__restored === true;
        return out;
    } catch (e) {
        log('FAIL: ' + String(e && e.stack || e).slice(0, 600));
        out.ok = false;
        return out;
    }
}"""

STEPS = STEPS.replace("@@FID@@", FAMILY_ID).replace("@@CHAR@@", CHAR_NAME)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        # T8 起：打开一个未入库的聊天会弹入库提醒 —— 本用例不测它，先写压制记录
        # （免得模态窗挡住交互；与 harness.boot 同一做法）。
        # 本用例是独立风格（不走 Runner.boot）：先把实例复位到**干净起点**（存储模式 / 测试角色 /
        # 全新聊天 / 压制入库提醒）。否则串行跑时会被前一条用例留下的模式、旧聊天上的家族或
        # 残留弹窗带偏——三类失败同源，2026-09-26 实测。
        reset_instance(page)
        page.evaluate("() => { window.__nativeFetch = globalThis.fetch; }")
        print("[dev] 原生 fetch 引用已保存")

        result = page.evaluate(STEPS, EXT_SRC)
        print("\n".join(result.get("steps", [])))
        browser.close()

    if result.get("ok"):
        print("\nT2 MIRROR PASS: 自动落盘为标准聊天文件 + 库为准可重建 + 反向不采纳")
    else:
        print("\nT2 MIRROR FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
