"""ChatFilesys 聊天记录保真 e2e（T0/R0：往聊天记录里写东西的插件不得出错、自定义内容不得丢）

目标（用户 2026-09-25 明令）：「确保所有往聊天记录内写东西的插件都不会出错，必须保证自定义内容都有」。
本脚本在真实 Dev 实例上验证纯库模式下的**零丢失契约**：

  ① 建测试家族（official 档隐容器）→ 绑定 __cb_e2e 的权威键 → 装接缝
  ② **外来写入（模拟其他插件/宿主）**：
     - `chats/meta/patch` 增补外来命名空间（`extensions["third-party/e2e_probe"]`）、`main_chat`、`variables`
     - `chats/append` 追一条带自定义字段的消息行（`extra` 任意键 + `swipes` + `swipe_info`）
  ③ **读回深比对**：`chats/get` 响应的聊天头与消息行必须**逐字段一致**（T0 前这里会丢聊天头）
  ④ **宿主驱动写入后再复核**：UI 发一条消息（宿主自己走 append/save/meta-patch）→ 再读 → 外来内容仍在
  ⑤ **T0b 字段级补丁**：`add/remove /N/field` 必须落库（真机事实：插件改消息字段发的是深路径 op），
     `test` 不通过必须给 409（宿主走冲突重放，不得静默写）
  ⑥ **T0c 命名空间随写路径不丢**：插件改名空间后 append/save 送到库内，后续宿主再写仍需存活
  ⑦ 宿主渲染复核：DOM 消息数与库内楼层一致
  ⑧ 清场：删测试家族隐容器

通过判据见 STEPS 末尾 `out.ok`。

L0-1 纪律：不写实例文件系统（隐容器经官方端点、探针即删）；`__cb_e2e` 为专用测试角色。
依赖：Dev Luker 8003 在跑 + 8417 静态源在跑（.claude/launch.json 的 chatfilesys-mock-host）。
用法：python tests/e2e/test_chat_record_fidelity.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"
CHAR_NAME = "__cb_e2e"
FAMILY_ID = "f_fidelity"

STEPS = """async (extSrc) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    const PROBE_NS = 'third-party/e2e_probe';
    try {
        const seamMod = await import(extSrc + '/core/seam.js');
        const adapterMod = await import(extSrc + '/core/storage/adapter.js');
        const nativeFetch = (...a) => window.__nativeFetch.apply(null, a);
        const H = () => window.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {};
        const { tier, adapter, dispose: disposeAdapter } = await adapterMod.createStorageAdapter({
            fetch: nativeFetch, headers: H, log: (m) => log('warn: ' + String(m).slice(0, 120)),
        });
        log('tier: ' + tier);

        const familyId = '@@FID@@';
        await adapter.deleteFamily({ familyId }).catch(() => {});

        // ① 建家族（2 层）+ 权威键绑定（宿主 getChat 的键源 = characters[idx].chat/.avatar）
        const c = window.SillyTavern?.getContext?.();
        const res0 = await nativeFetch('/api/characters/all', { method: 'POST', headers: H(), body: JSON.stringify({}) });
        const chars = await res0.json();
        const target = chars.find(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        if (!target) { log('char not found'); out.ok = false; return out; }

        const family = {
            familyId, chatKey: target.avatar + '::' + target.chat, characterId: '@@CHAR@@', name: 'fidelity', integrity: 1,
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        };
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) { log('createFamily FAIL: ' + JSON.stringify(cr)); out.ok = false; return out; }
        await adapter.saveFloors({ familyId, expectedIntegrity: null, floors: [
            { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ name: 'User', is_user: true, mes: '保真探针楼层1', send_date: 1 }), contentHash: null, sendDate: 1 },
            { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'Assistant', is_user: false, mes: '保真探针楼层2', send_date: 2 }), contentHash: null, sendDate: 2 },
        ]});
        log('family seeded');

        const seamLog = [];
        const handle = seamMod.installSeam(adapter, { log: (m) => seamLog.push(String(m)) });

        // ①b 打开测试角色（宿主 chats/get 被 seam 拦截 → 渲染库内楼层）
        //     真机事实：首次 selectCharacterById 常因初始化竞态早退 → 重试直到 characterId 落位
        const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        for (let attempt = 0; attempt < 5 && String(c.characterId) !== String(idx); attempt++) {
            await c.selectCharacterById(idx);
            await new Promise(r => setTimeout(r, 3000));
        }
        await new Promise(r => setTimeout(r, 4000));
        if (String(c.characterId) !== String(idx)) { log('selectCharacterById never landed: characterId=' + c.characterId); out.ok = false; return out; }
        log('character landed: ' + c.characterId + ' chatLen=' + (c.chat || []).length);

        const postRaw = (path, body) => fetch('/api/chats/' + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(body),
        });
        const post = (path, body) => postRaw(path, body).then(r => r.json());

        const base = { avatar_url: target.avatar, file_name: target.chat };

        // ② 外来写入 A：聊天头（模拟其他插件 + 宿主的 main_chat）
        const probeNs = { flag: true, deep: { arr: [1, 2, 3], nested: { s: 'x' } } };
        const rMeta = await post('meta/patch', { ...base, operations: [
            { op: 'add', path: '/main_chat', value: 'root_chat' },
            { op: 'add', path: '/e2e_probe_top', value: { hp: 10, inventory: ['sword'] } },
            { op: 'add', path: '/extensions/third-party~1e2e_probe', value: probeNs },
        ]});
        log('meta/patch → ' + JSON.stringify(rMeta));

        // ② 外来写入 B：带自定义字段的消息行
        const probeRow = {
            name: 'User', is_user: true, mes: '保真探针：自定义字段行', send_date: 777,
            extra: { 'third-party/e2e_probe': { nested: [1, 2] }, bookmark_link: 'cp-x' },
            swipes: ['v1', 'v2'], swipe_info: [{ send_date: 1, extra: { k: 1 } }, { send_date: 2, extra: { k: 2 } }], swipe_id: 1,
        };
        const rApp = await post('append', { ...base, messages: [probeRow] });
        log('append → ' + JSON.stringify(rApp));

        // ③ 读回深比对（T0 前聊天头会丢）
        const arr = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        const meta = arr[0]?.chat_metadata || {};
        out.__mainChat = meta.main_chat;
        out.__nsOk = JSON.stringify(meta.extensions?.[PROBE_NS]) === JSON.stringify(probeNs);
        out.__topOk = JSON.stringify(meta.e2e_probe_top) === JSON.stringify({ hp: 10, inventory: ['sword'] });
        const gotRow = arr.slice(1).find(r => r && r.mes === probeRow.mes);
        out.__rowOk = JSON.stringify(gotRow) === JSON.stringify(probeRow);
        log('read-back(seam): main_chat=' + out.__mainChat + ' ns=' + out.__nsOk + ' vars=' + out.__topOk + ' probeRow=' + out.__rowOk);

        // ④ 宿主驱动写入 A：UI 发消息（宿主自己走 append/save/meta-patch）
        const ta = document.querySelector('#send_textarea');
        ta.value = '保真探针：宿主驱动消息';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send_but').click();
        await new Promise(r => setTimeout(r, 12000));

        const arr1 = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        const meta1 = arr1[0]?.chat_metadata || {};
        out.__nsAfterHost = JSON.stringify(meta1.extensions?.[PROBE_NS]) === JSON.stringify(probeNs);
        out.__topAfterHost = JSON.stringify(meta1.e2e_probe_top) === JSON.stringify({ hp: 10, inventory: ['sword'] });
        out.__rows1 = arr1.length - 1;
        log('after host send: rows=' + out.__rows1 + ' ns=' + out.__nsAfterHost + ' vars=' + out.__topAfterHost);

        // ⑤ 第三方插件写入**宿主知道的那条消息**（真实形态：改宿主内存里的消息 + 让宿主保存）
        //    真机事实（probe_patch_ops.py）：宿主差分会发**字段级** op `add /0/extra/第三方~1键`
        const c2 = window.SillyTavern.getContext();
        const probeExtra = { from: 'other-plugin', n: 42, deep: { arr: [7, 8] } };
        c2.chat[0].extra = { ...(c2.chat[0].extra || {}), [PROBE_NS]: probeExtra };
        await c2.saveChat();
        await new Promise(r => setTimeout(r, 3000));
        const arr2 = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        out.__extraAfterPlugin = JSON.stringify(arr2[1]?.extra?.[PROBE_NS]) === JSON.stringify(probeExtra);
        log('after plugin row write: extra kept=' + out.__extraAfterPlugin);

        // ⑤b T0b 直证：字段级补丁 add / remove 必须落库（旧实现窄正则整条跳过）
        const rDeep = await postRaw('patch', { ...base, operations: [
            { op: 'add', path: '/0/extra/e2e_deep', value: { lvl: [1, { x: 2 }] } },
        ] });
        const arrDeep = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        out.__deepAdd = JSON.stringify(arrDeep[1]?.extra?.e2e_deep) === JSON.stringify({ lvl: [1, { x: 2 }] });
        log('T0b 字段级 add: status=' + rDeep.status + ' landed=' + out.__deepAdd);

        await postRaw('patch', { ...base, operations: [{ op: 'remove', path: '/0/extra/e2e_deep' }] });
        const arrDeep2 = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        out.__deepRemove = arrDeep2[1]?.extra?.e2e_deep === undefined;
        log('T0b 字段级 remove: removed=' + out.__deepRemove);

        // ⑤c T0b 边界：test 不通过 → 409（宿主按冲突重放，不得静默写）
        const rTest = await postRaw('patch', { ...base, operations: [
            { op: 'test', path: '/0/mes', value: '绝不可能匹配的内容' },
        ] });
        out.__testConflict = rTest.status === 409;
        log('T0b test 不通过 → status=' + rTest.status + '（期望 409）');

        // ⑥ 宿主再写一次（再发一条）→ 上一步写入的自定义字段必须**仍然在**
        ta.value = '保真探针：第二条宿主驱动消息';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send_but').click();
        await new Promise(r => setTimeout(r, 12000));
        const arr3 = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        const meta3 = arr3[0]?.chat_metadata || {};
        out.__extraSurvives = JSON.stringify(arr3[1]?.extra?.[PROBE_NS]) === JSON.stringify(probeExtra);
        out.__nsSurvives = JSON.stringify(meta3.extensions?.[PROBE_NS]) === JSON.stringify(probeNs);
        out.__rows = arr3.length - 1;
        log('after 2nd host write: rows=' + out.__rows + ' extra survives=' + out.__extraSurvives + ' ns survives=' + out.__nsSurvives);

        // ⑥b T0c 直证：命名空间**跟着 append 进来**（真机事实：append 请求体带整份 chat_metadata）
        const lateNs = { late: true, k: 7 };
        c2.chatMetadata.extensions = { ...(c2.chatMetadata.extensions || {}), 'third-party/e2e_late': lateNs };
        await c2.addMessages({ name: 'System', mes: 'T0c-append 携带命名空间', is_system: true }, { silent: true });
        await new Promise(r => setTimeout(r, 2500));
        const arr4 = await fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
        out.__nsViaAppend = JSON.stringify(arr4[0]?.chat_metadata?.extensions?.['third-party/e2e_late']) === JSON.stringify(lateNs);
        log('T0c append 携带命名空间: landed=' + out.__nsViaAppend);

        // ⑦ 宿主渲染复核（DOM 消息数）
        out.__domMes = document.querySelectorAll('#chat .mes').length;
        out.__seamLogN = seamLog.length;
        seamLog.forEach((m, i) => log('seam[' + i + '] ' + m));
        log('DOM mes count = ' + out.__domMes + ' / seam log ' + out.__seamLogN);

        // ⑧ 清场
        await adapter.deleteFamily({ familyId }).catch(() => {});
        handle.dispose();
        disposeAdapter();
        log('cleaned + disposed');

        // ── 通过判据：① 聊天头经接缝整份往返 ② 追加行逐字段一致 ③ 宿主能渲染库内楼层
        //            ④（本轮 T0b）字段级补丁落库、test 不通过给 409 ⑤（本轮 T0c）命名空间经各写路径都不丢
        out.ok = out.__mainChat === 'root_chat'
            && out.__nsOk === true && out.__topOk === true && out.__rowOk === true
            && out.__extraAfterPlugin === true && out.__extraSurvives === true && out.__nsSurvives === true
            && out.__deepAdd === true && out.__deepRemove === true && out.__testConflict === true
            && out.__nsViaAppend === true
            && out.__domMes >= 2;
        return out;
    } catch (e) {
        log('FAIL: ' + String(e && e.stack || e).slice(0, 500));
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
        page.evaluate("() => { window.__nativeFetch = globalThis.fetch; }")
        print("[dev] 原生 fetch 引用已保存")

        result = page.evaluate(STEPS, EXT_SRC)
        print("\n".join(result.get("steps", [])))
        browser.close()

    if result.get("ok"):
        print("\nFIDELITY PASS: 聊天头整份保住 + 消息行逐字段一致 + T0b 字段级补丁落库 + T0c 命名空间各写路径不丢")
    else:
        print("\nFIDELITY FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
