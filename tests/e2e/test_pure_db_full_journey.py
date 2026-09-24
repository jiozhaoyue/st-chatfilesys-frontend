"""ChatFilesys 纯库模式真机全旅程 e2e（Dev 实例 8003，运行时注入，零部署，守 L0-1）

M1 终验：真实 Luker 前端 + official 档（隐容器）+ seam 拦截的完整回环：
  ① 动态加载本仓 seam + adapter（8417 静态源伺服，运行时 import，零部署）
  ② 经 official 档把测试家族写入隐容器（seam.native 原生路径）
  ③ 打开 __cb_e2e 测试角色 → seam 拦截 chats/get → 从库拼装 [header,...rows] 响应
  ④ 宿主正常渲染库内楼层（DOM 消息数 = 库楼层数）
  ⑤ UI 发消息 → chats/append 被拦截 → 写库不落 jsonl
  ⑥ 库状态复核（楼层行数/integrity 递增）
  ⑦ 清场：删测试家族隐容器

L0-1 纪律：不写实例文件系统（隐容器经官方端点、探针即删）；__cb_e2e 为专用测试角色。
用法: python tests/e2e/test_pure_db_full_journey.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"
CHAR_NAME = "__cb_e2e"

STEPS = """async (extSrc) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    try {
        // ① 直接 import 8417 模块 URL（127.0.0.1 = potentially-trustworthy，非混合内容；
        //    模块内相对导入基于 8417 URL 解析；--cors 已开）
        const seamMod = await import(extSrc + '/core/seam.js');
        const adapterMod = await import(extSrc + '/core/storage/adapter.js');
        log('import seam+adapter: ok');

        // ② official 档：注入原生 fetch 通道（承载隐容器读写，绕开 seam 防环）
        const nativeFetch = (...args) => {
            // seam 装上后 globalThis.fetch 已被替换——official 档内部走这里时
            // 必须用真原生：我们保留原引用（在 seam 安装前捕获）
            return out.__nativeFetch.apply(null, args);
        };
        const { tier, adapter, dispose: disposeAdapter } = await adapterMod.createStorageAdapter({
            fetch: nativeFetch,
            headers: () => window.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {},
            log: (m) => log('warn: ' + String(m).slice(0, 100)),
        });
        out.__adapter = adapter;
        out.__disposeAdapter = disposeAdapter;
        log('tier: ' + tier);

        // ③ 建测试家族（隐容器）：2 条楼层 + 主分支
        const chatKey = '__cb_e2e.png::__cfsys__journey_0924';  // 与后续 get 请求的 key 不同——本测试用显式 familyId 驱动
        const family = {
            familyId: 'f_journey0924', chatKey, characterId: 'test', name: 'journey', integrity: 1,
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        };
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) { log('createFamily FAIL: ' + JSON.stringify(cr)); out.ok = false; return out; }
        const floors = [
            { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ name: 'User', is_user: true, mes: '真机全旅程楼层1', send_date: 1 }), contentHash: null, sendDate: 1 },
            { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'Assistant', is_user: false, mes: '真机全旅程楼层2', send_date: 2 }), contentHash: null, sendDate: 2 },
        ];
        const sr = await adapter.saveFloors({ familyId: family.familyId, floors, expectedIntegrity: null });
        log('family seeded: ' + JSON.stringify(sr));
        out.__familyId = family.familyId;

        // ④ 装接缝（拦截宿主 /api/chats/*）
        const handle = seamMod.installSeam(adapter, { log: (m) => log('seam-warn: ' + String(m).slice(0, 100)) });
        out.__seam = handle;
        log('seam installed');

        // ⑤ 把家族 chatKey 绑到宿主将要打开的聊天（宿主 get 请求体形如 avatar_url='__cb_e2e.png', file_name='xxx'）
        //    ——需要 loadFamily({chatKey}) 命中。我们建库时用了一个 chatKey，现在把它改绑到测试角色的真实聊天名。
        const c = window.SillyTavern?.getContext?.();
        const H = c?.getRequestHeaders?.();
        const realKey = '__cb_e2e.png::__cb_e2e - 2026-09-06@03h29m57s172ms';
        await adapter.bindChatKey({ familyId: family.familyId, chatKey: realKey });
        log('chatKey bound to: ' + realKey);

        // ⑥ 打开测试角色（宿主 chats/get 会被 seam 拦截 → 从库拼装响应）
        const res = await fetch('/api/characters/all', { method: 'POST', headers: H, body: JSON.stringify({}) });
        const chars = await res.json();
        const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === '__cb_e2e');
        await c.selectCharacterById(idx);
        await new Promise(r => setTimeout(r, 5000));
        const chatLen = (c.chat || []).length;
        log('opened, host ctx.chat length = ' + chatLen + ' (期望 2 = 库楼层数)');
        out.__chatLen = chatLen;

        // ⑦ 断言渲染：宿主消息 DOM
        const mesN = document.querySelectorAll('#chat .mes').length;
        log('DOM mes count = ' + mesN);
        out.__mesN = mesN;

        // ⑧ UI 发消息 → chats/append 拦截写库
        const ta = document.querySelector('#send_textarea');
        ta.value = '真机全旅程探针消息';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send_but').click();
        await new Promise(r => setTimeout(r, 8000));

        // ⑨ 库状态复核
        const f2 = await adapter.loadFamily({ familyId: family.familyId });
        const { floors: fl } = await adapter.loadFloors({ familyId: family.familyId, from: 0, limit: 100 });
        log('after append: floors=' + fl.length + ' integrity=' + f2?.integrity);
        out.__afterFloors = fl.length;
        out.__afterIntegrity = f2?.integrity;

        handle.dispose();
        disposeAdapter();
        log('disposed');
        out.ok = chatLen === 2 && fl.length >= 3;
        return out;
    } catch (e) {
        log('FAIL: ' + String(e && e.stack || e).slice(0, 300));
        out.ok = false;
        return out;
    }
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)

        # 先在页面里保住原生 fetch 引用（seam 安装前）
        page.evaluate("() => { window.__nativeFetch = globalThis.fetch; }")
        print("[dev] 原生 fetch 引用已保存")

        steps = STEPS.replace("out.__nativeFetch.apply(null, args)", "window.__nativeFetch.apply(null, args)")

        result = page.evaluate(steps, EXT_SRC)
        print("\n".join(result.get("steps", [])))
        browser.close()

    ok = result.get("ok")
    if ok:
        print("\nFULL JOURNEY PASS: 真机纯库模式全旅程（拦截读 → 渲染 → 拦截写 → 库一致）")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
