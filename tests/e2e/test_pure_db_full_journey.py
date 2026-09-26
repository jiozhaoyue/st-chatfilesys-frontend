"""ChatFilesys 纯库模式真机全旅程 e2e v4（Dev 实例 8003，运行时注入，零部署，守 L0-1）

M1 终验：真实 Luker 前端 + official 档（隐容器）+ seam 拦截的完整回环：
  ① 动态加载本仓 seam + adapter（8417 静态源伺服，运行时 import，零部署）
  ② 经 official 档把测试家族写入隐容器（seam.native 原生路径）
  ③ 绑定键从 characters/all 现取（.chat/.avatar = 宿主 getChat 的权威键源，零猜测）
  ④ 打开 __cb_e2e 测试角色 → seam 拦截 chats/get → 从库拼装 [header,...rows] 响应
  ⑤ 宿主正常渲染库内楼层（ctx.chat = 库楼层）
  ⑥ UI 发消息 → chats/append 被拦截 → 写库不落 jsonl
  ⑦ 库状态复核（楼层行数/integrity 递增）+ integrity slug 往返验证
  ⑧ 清场：删测试家族隐容器

v4 关键修复（v3 rendered=false 根因）：
  - v3 硬编码猜测键绑定（主聊天名），但宿主 getChat 用 characters[this_chid].chat
    （服务端「最近聊天」）作 file_name → 键不命中 → seam 透传 → 渲染真实 jsonl。
  - official 档 bindChatKey 是重绑语义（一家族一键），v3 绑两键实为后键覆盖前键。
  - 宿主 chat_metadata.integrity 是字符串 slug（uuid 自造），库**曾是**数字计数器——
    v4 起 seam 边界桥接（`cfsys:<n>`），get 响应带 integrity 防 saveChatInternal 拒存。
    **T1/N19 已改**：版本号统一为 `c-<36进制时间戳>-<随机>` 字符串，slug 桥接删除、入向值
    必须与库内值**字符串相等**才允许写（见 `core/integrity.js`）。

L0-1 纪律：不写实例文件系统（隐容器经官方端点、探针即删）；__cb_e2e 为专用测试角色。
用法: python tests/e2e/test_pure_db_full_journey.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from harness import reset_instance  # noqa: E402

BASE = "https://127.0.0.1:8003"
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"
CHAR_NAME = "__cb_e2e"
FAMILY_ID = "f_v4journey"

STEPS = """async (extSrc) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    try {
        // ① 动态 import 8417 模块（127.0.0.1 = potentially-trustworthy，非混合内容）
        const seamMod = await import(extSrc + '/core/seam.js');
        const adapterMod = await import(extSrc + '/core/storage/adapter.js');
        log('import seam+adapter: ok');

        // ② official 档：原生 fetch 通道（承载隐容器读写，绕开 seam 防环）
        const nativeFetch = (...args) => window.__nativeFetch.apply(null, args);
        const { tier, adapter, dispose: disposeAdapter } = await adapterMod.createStorageAdapter({
            fetch: nativeFetch,
            headers: () => window.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {},
            log: (m) => log('warn: ' + String(m).slice(0, 120)),
        });
        out.__tier = tier;
        log('tier: ' + tier);

        // ③ 清残留（上轮测试可能留了同 familyId 容器）：幂等删
        await adapter.deleteFamily({ familyId: '@@FID@@' }).catch(() => {});
        const familyId = '@@FID@@';

        // ④ 建测试家族（隐容器）：2 条楼层 + 主分支
        const chatKey0 = '__cb_e2e.png::placeholder';
        const family = {
            familyId, chatKey: chatKey0, characterId: '__cb_e2e', name: 'v4journey', integrity: 1,
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: { 1: 'g1', 2: 'g2' } },
        };
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) { log('createFamily FAIL: ' + JSON.stringify(cr)); out.ok = false; return out; }
        const floors = [
            { floorNo: 1, variantId: 'g1', seq: 0, content: JSON.stringify({ name: 'User', is_user: true, mes: '真机全旅程v4楼层1', send_date: 1 }), contentHash: null, sendDate: 1 },
            { floorNo: 2, variantId: 'g2', seq: 0, content: JSON.stringify({ name: 'Assistant', is_user: false, mes: '真机全旅程v4楼层2', send_date: 2 }), contentHash: null, sendDate: 2 },
        ];
        const sr = await adapter.saveFloors({ familyId, floors, expectedIntegrity: null });
        log('family seeded: ' + JSON.stringify(sr));
        out.__familyId = familyId;

        // ⑤ 绑定键 = characters/all 现取（宿主 getChat 用 characters[this_chid].chat 作
        //    file_name、.avatar 作 avatar_url——这就是权威键源，零猜测）
        const H = window.SillyTavern?.getContext?.()?.getRequestHeaders?.();
        const res0 = await nativeFetch('/api/characters/all', { method: 'POST', headers: H, body: JSON.stringify({}) });
        const chars = await res0.json();
        const target = chars.find(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        if (!target) { log('char not found: __cb_e2e'); out.ok = false; return out; }
        const realKey = target.avatar + '::' + target.chat;
        await adapter.bindChatKey({ familyId, chatKey: realKey });
        log('bound to authoritative key: avatar=' + target.avatar + ' chat=' + target.chat);

        // ⑥ 装接缝 + 记录器（记录 /api/chats/* 拦截命中，验证宿主请求确实走到 fetch）
        const seamLog = [];
        const handle = seamMod.installSeam(adapter, {
            log: (m) => seamLog.push(String(m).slice(0, 120)),
        });
        out.__seam = handle;
        log('seam installed');

        // ⑦ 打开测试角色（宿主 chats/get 被 seam 拦截 → 从库拼装响应）
        //    真机事实：首次 selectCharacterById 常因初始化竞态早退（characterId 不变）——
        //    重试直到 characterId 落位（宿主才会真正 getChat）
        const c = window.SillyTavern?.getContext?.();
        const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        for (let attempt = 0; attempt < 5 && String(c.characterId) !== String(idx); attempt++) {
            await c.selectCharacterById(idx);
            await new Promise(r => setTimeout(r, 3000));
        }
        await new Promise(r => setTimeout(r, 4000));
        if (String(c.characterId) !== String(idx)) { log('selectCharacterById never landed: characterId=' + c.characterId); out.ok = false; return out; }
        log('character landed: ' + c.characterId);

        // ⑧ 强制经接缝读一次。
        //    为什么必须显式重载：`reset_instance` 已经把测试角色选中了，且那个聊天就是它刚
        //    `/newchat` 出来的——宿主内存里**已经有**这份聊天，于是上面那个「characterId 未落位
        //    才重试」的循环体一次都不执行，宿主也就**不会**发 `chats/get`，接缝没机会服务
        //    （实测症状：`opened: chatLen=1` = 内存里那份 first_mes，而不是库内投影）。
        await c.reloadCurrentChat();
        await new Promise(r => setTimeout(r, 3000));

        const chatArr = c.chat || [];
        const chatLen = chatArr.length;
        const mes1 = String(chatArr[0]?.mes || '');
        const integrity0 = c.chatMetadata?.integrity;
        log('opened: chatLen=' + chatLen + ' (期望 2) first=' + mes1.slice(0, 24) + ' integrity=' + integrity0);
        out.__chatLen = chatLen;
        out.__mes1 = mes1;
        out.__integrity0 = integrity0;

        // ⑧ 断言渲染：宿主消息 DOM
        const mesN = document.querySelectorAll('#chat .mes').length;
        log('DOM mes count = ' + mesN);
        out.__mesN = mesN;

        // ⑨ UI 发消息 → chats/append 拦截写库
        const ta = document.querySelector('#send_textarea');
        ta.value = '真机全旅程v4探针消息';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send_but').click();
        await new Promise(r => setTimeout(r, 10000));

        // ⑩ 库状态复核 + seam 拦截记录
        const f2 = await adapter.loadFamily({ familyId });
        const { floors: fl } = await adapter.loadFloors({ familyId, from: 0, limit: 100 });
        const liveIntegrity = c.chatMetadata?.integrity;
        log('after append: floors=' + fl.length + ' integrity=' + f2?.integrity + ' hostIntegrity=' + liveIntegrity);
        log('seam log (' + seamLog.length + '): ' + seamLog.slice(0, 5).join(' | '));
        out.__afterFloors = fl.length;
        out.__afterIntegrity = f2?.integrity;
        out.__hostIntegrity = liveIntegrity;
        out.__seamLogN = seamLog.length;

        handle.dispose();
        disposeAdapter();
        log('disposed');
        out.ok = chatLen === 2
            && mes1.includes('v4楼层1')
            && mesN >= 2
            && fl.length >= 3
            // T1/N19 起版本号是 `c-<36进制时间戳>-<随机>` 字符串（`core/integrity.js`），
            // 不再是 T0 时代的 `cfsys:<n>` slug 桥接形态——旧断言必须随之更新。
            && typeof integrity0 === 'string' && integrity0.startsWith('c-')
            && typeof liveIntegrity === 'string' && liveIntegrity.startsWith('c-')
            // 闭环：写成功之后宿主锁住的那份 = 库内那份
            && liveIntegrity === f2?.integrity;
        return out;
    } catch (e) {
        log('FAIL: ' + String(e && e.stack || e).slice(0, 400));
        out.ok = false;
        return out;
    }
}"""

# familyId 与角色名注入（占位符替换，避免 f-string 与 JS 花括号冲突）
STEPS = STEPS.replace("@@FID@@", FAMILY_ID).replace("@@CHAR@@", CHAR_NAME)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        # T8 起：打开一个未入库的聊天会弹入库提醒（默认增强模式下库里什么都没有）——
        # 本用例不测它，先写压制记录，免得模态窗挡住后续交互（与 harness.boot 同一做法）。
        # 本用例是独立风格（不走 Runner.boot）：先把实例复位到**干净起点**（存储模式 / 测试角色 /
        # 全新聊天 / 压制入库提醒）。否则串行跑时会被前一条用例留下的模式、旧聊天上的家族或
        # 残留弹窗带偏——三类失败同源，2026-09-26 实测。
        reset_instance(page)

        # 先在页面里保住原生 fetch 引用（seam 安装前）
        page.evaluate("() => { window.__nativeFetch = globalThis.fetch; }")
        print("[dev] 原生 fetch 引用已保存")

        steps = STEPS.replace("out.__nativeFetch.apply(null, args)", "window.__nativeFetch.apply(null, args)")

        result = page.evaluate(steps, EXT_SRC)
        print("\n".join(result.get("steps", [])))
        browser.close()

    ok = result.get("ok")
    if ok:
        print("\nFULL JOURNEY PASS: 真机纯库模式全旅程（拦截读 → 渲染 → 拦截写 → 库一致 → 版本号闭环）")
    else:
        # 失败必须留下诊断：过去这里只有 `sys.exit(1)`，而页内那条复合断言（`out.ok = ...`）
        # 失败时一行都不打 → 用例变成**静默失败**（2026-09-26 踩到：只看到 exit=1）。
        print("\nFULL JOURNEY FAIL: 页内断言未通过")
        print("  诊断字段: " + ", ".join(f"{k}={v!r}" for k, v in result.items() if k != "steps"))
        sys.exit(1)


if __name__ == "__main__":
    main()
