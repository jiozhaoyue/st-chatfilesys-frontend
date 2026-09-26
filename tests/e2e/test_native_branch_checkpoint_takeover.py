"""ChatFilesys 原生「创建分支 / 创建检查点」接管 e2e（T1/R2.1，AC2 + AC3 + AC11）

真机验证目标（用户 2026-09-25 明令「三种模式都能用」，纯库模式必须能正常分叉/用检查点）：

  ① 建测试家族（official 档隐容器）→ 绑定 __cb_e2e 的权威键 → 装接缝
  ② 打开角色（宿主 chats/get 被接缝拦截 → 渲染库内楼层）
  ③ **原生「创建分支」**：点消息上的宿主按钮（`Branch: Start alternate story path`）
     - 磁盘**零新 jsonl**（`/api/chats/search` 前后文件列表一致）
     - 库内多出一条分支（fork_base = 点击层数、path = 父分支前缀，零复制）
     - 键绑定登记新键 + mainChat（AC11 的驱动源）
     - 宿主切过去后看到的是**截断快照**（DOM 楼层数 = 该层数）
  ④ **原生「创建检查点」**：点旗格按钮（`Checkpoint: Create story checkpoint`），弹窗输入**自定义名**
     - 磁盘零新 jsonl；库内多出一条分支且带 `is_checkpoint` / `marker_floor`
     - **不切换**（宿主仍留在原聊天）
  ⑤ **导航**：点消息上的旗标 → 打开检查点聊天 → 看到「到该层为止」的快照（Q2=A）
     - `chat_metadata.main_chat` 按键回显（检查点键有、根键没有）
     - 左侧「返回父聊天」可用 → 点回根聊天 → 内容完整
  ⑥ 清场：删测试家族；宿主切回原聊天键

L0-1 纪律：只走官方端点（隐容器），不写实例文件系统；`__cb_e2e` 为专用测试角色。
依赖：Dev Luker 8003 在跑 + 8417 静态源在跑（.claude/launch.json 的 chatfilesys-mock-host）。
用法：python tests/e2e/test_native_branch_checkpoint_takeover.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from harness import reset_instance  # noqa: E402

BASE = "https://127.0.0.1:8003"
EXT_SRC = "http://127.0.0.1:8417/public/scripts/extensions/third-party/chatfilesys"
CHAR_NAME = "__cb_e2e"
FAMILY_ID = "f_t1_takeover"
CHECKPOINT_NAME = "T1 检查点·打斗前"

STEPS = """async (extSrc) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        const seamMod = await import(extSrc + '/core/seam.js');
        const adapterMod = await import(extSrc + '/core/storage/adapter.js');
        const nativeFetch = (...a) => window.__nativeFetch.apply(null, a);
        const H = () => window.SillyTavern?.getContext?.()?.getRequestHeaders?.() || {};
        const c = window.SillyTavern.getContext();
        const { tier, adapter, dispose: disposeAdapter } = await adapterMod.createStorageAdapter({
            fetch: nativeFetch, headers: H, log: (m) => log('warn: ' + String(m).slice(0, 120)),
        });
        log('tier: ' + tier);

        const familyId = '@@FID@@';
        await adapter.deleteFamily({ familyId }).catch(() => {});

        const res0 = await nativeFetch('/api/characters/all', { method: 'POST', headers: H(), body: JSON.stringify({}) });
        const chars = await res0.json();
        const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === '@@CHAR@@');
        const target = chars[idx];
        if (!target) { log('char not found'); out.ok = false; return out; }
        out.__originalChat = target.chat;
        log('original chat key = ' + target.chat);

        // 磁盘文件枚举（原生通道；接缝不拦 chats/search）——「零新 jsonl」的判据
        const listFiles = async () => {
            const r = await nativeFetch('/api/chats/search', {
                method: 'POST', headers: H(), body: JSON.stringify({ query: '', avatar_url: target.avatar }),
            });
            const arr = await r.json();
            return (Array.isArray(arr) ? arr : []).map(x => String(x && x.file_name || x));
        };
        const filesBefore0 = await listFiles();
        log('disk files before: ' + JSON.stringify(filesBefore0));

        // ① 建家族（3 层）+ 权威键绑定
        const family = {
            familyId, chatKey: target.avatar + '::' + target.chat, characterId: '@@CHAR@@', name: 't1-takeover',
            branches: [{ id: 'b_main', name: '主分支', is_default: true, fork_floor: 0 }],
            branchPaths: { b_main: { 1: 'g1', 2: 'g2', 3: 'g3' } },
        };
        const cr = await adapter.createFamily({ family });
        if (!cr?.ok) { log('createFamily FAIL: ' + JSON.stringify(cr)); out.ok = false; return out; }
        await adapter.saveFloors({ familyId, expectedIntegrity: null, floors: [1, 2, 3].map((n) => ({
            floorNo: n, variantId: 'g' + n, seq: 0,
            content: JSON.stringify({ name: n % 2 ? 'User' : 'Assistant', is_user: n % 2 === 1, mes: 'T1 探针楼层' + n, send_date: n }),
            contentHash: null, sendDate: n,
        }))});
        log('family seeded(3 floors)');

        const seamLog = [];
        const handle = seamMod.installSeam(adapter, { log: (m) => seamLog.push(String(m)) });

        const postRaw = (path, body) => fetch('/api/chats/' + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(body),
        });
        const getChatArr = (fileName) => postRaw('get', { avatar_url: target.avatar, file_name: fileName })
            .then(r => r.json());
        const familyState = () => adapter.loadFamily({ familyId });

        // ② 打开角色（真机事实：首次 selectCharacterById 常因竞态早退 → 重试直到落位）
        for (let attempt = 0; attempt < 5 && String(c.characterId) !== String(idx); attempt++) {
            await c.selectCharacterById(idx);
            await sleep(3000);
        }
        await sleep(4000);
        if (String(c.characterId) !== String(idx)) { log('selectCharacterById never landed'); out.ok = false; return out; }
        // `reset_instance` 已经把测试角色选中了，且那个聊天是它刚 `/newchat` 出来的——宿主内存里
        // 已经有这份聊天，于是上面「未落位才重试」的循环体一次都不执行，宿主**不会**发 `chats/get`，
        // 接缝没机会服务。此处显式重载一次，强制走「读库 → 投影」。
        await c.reloadCurrentChat();
        await sleep(3000);
        out.__rootDom = document.querySelectorAll('#chat .mes').length;
        log('character landed: chatLen=' + (c.chat || []).length + ' DOM=' + out.__rootDom + ' chatId=' + c.chatId);

        // 宿主 DOM 里的原生按钮（诊断用：确认宿主入口存在）
        out.__btns = {
            branch: document.querySelectorAll('.mes_create_branch').length,
            bookmark: document.querySelectorAll('.mes_create_bookmark').length,
            flag: document.querySelectorAll('.mes_bookmark').length,
        };
        log('native buttons on messages: ' + JSON.stringify(out.__btns));

        const clickIn = (mesId, sel) => {
            const el = document.querySelector('#chat .mes[mesid="' + mesId + '"] ' + sel);
            if (!el) return false;
            el.click();
            return true;
        };
        const fillTopDialog = (text) => {
            const dlg = document.querySelector('dialog[open]:not([closing]):last-of-type');
            if (!dlg) return 'no-dialog';
            const inp = dlg.querySelector('input');
            if (!inp) return 'no-input: ' + dlg.innerHTML.slice(0, 200);
            inp.value = text;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const ok = dlg.querySelector('.popup-button-ok') || dlg.querySelector('button[value="1"]');
            if (!ok) return 'no-ok: ' + dlg.innerHTML.slice(0, 200);
            ok.click();
            return 'ok';
        };

        // ─────────── ③ 原生「创建分支」（在第 2 层分叉 → 快照 = 前 2 层）───────────
        const filesBeforeBranch = await listFiles();
        if (!clickIn(1, '.mes_create_branch')) { log('原生分支按钮不存在（宿主 UI 形态变了？）'); out.ok = false; return out; }
        await sleep(6000);

        const filesAfterBranch = await listFiles();
        const newFiles = filesAfterBranch.filter(f => !filesBeforeBranch.includes(f));
        out.__branchNoNewFile = newFiles.length === 0;
        log('after branch: new disk files = ' + JSON.stringify(newFiles));

        const famA = await familyState();
        const branchesA = famA?.model?.branches || [];
        const added = branchesA.filter(b => b.fork_base === 2);
        out.__branchAdded = branchesA.length === 2;
        out.__branchFork = added.length > 0;
        out.__branchPath = JSON.stringify(added[0]?.path) === JSON.stringify({ 1: 'g1', 2: 'g2' });
        const bindKeys = Object.keys(famA?.keyBindings || {});
        const boundNew = bindKeys.map(k => famA.keyBindings[k]).find(b => b.branchId === added[0]?.id);
        out.__branchBound = Boolean(boundNew);
        out.__branchMainChat = boundNew?.mainChat === target.chat;
        log('library: branches=' + branchesA.length + ' added=' + JSON.stringify(added[0]?.name)
            + ' path=' + JSON.stringify(added[0]?.path) + ' binding=' + JSON.stringify(boundNew) + ' bindKeys=' + JSON.stringify(bindKeys));

        // 宿主应已切到分支聊天；看到的是截断快照
        const branchKey = bindKeys.find(k => famA.keyBindings[k].branchId === added[0]?.id);
        const branchFileName = String(branchKey || '').split('::').pop();
        for (let i = 0; i < 10 && String(c.chatId) !== branchFileName; i++) await sleep(1000);
        out.__switched = String(c.chatId) === branchFileName;
        await sleep(2500);
        out.__branchDom = document.querySelectorAll('#chat .mes').length;
        out.__branchRows = (c.chat || []).length;
        log('host switched to branch: chatId=' + c.chatId + ' (want ' + branchFileName + ') DOM=' + out.__branchDom + ' rows=' + out.__branchRows);

        // 读路径直证：新键 = 截断；根键 = 完整；main_chat 按键回显
        const arrBranch = await getChatArr(branchFileName);
        const arrRoot = await getChatArr(target.chat);
        out.__branchRead = arrBranch.length === 3;      // [header, 层1, 层2]
        out.__rootRead = arrRoot.length === 4;          // [header, 层1..3]
        out.__branchMainChatRead = arrBranch[0]?.chat_metadata?.main_chat === target.chat;
        out.__rootNoMainChat = !arrRoot[0]?.chat_metadata?.main_chat;
        log('read: branch=' + arrBranch.length + ' root=' + arrRoot.length
            + ' branch.main_chat=' + JSON.stringify(arrBranch[0]?.chat_metadata?.main_chat)
            + ' root.main_chat=' + JSON.stringify(arrRoot[0]?.chat_metadata?.main_chat));

        // ④「返回父聊天」：宿主左侧菜单入口存在且可用 → 回到根聊天看到完整内容
        out.__backBtn = Boolean(document.querySelector('#option_back_to_main'));
        const backVisible = (() => {
            const el = document.querySelector('#option_back_to_main');
            return Boolean(el && el.offsetParent !== null);
        })();
        out.__backVisible = backVisible;
        log('back-to-parent entry: exists=' + out.__backBtn + ' visible=' + backVisible);

        // 用宿主自己的返回动作（DOM 点击）；不可见则用原生聊天切换兜底
        if (backVisible) {
            document.querySelector('#option_back_to_main').click();
        } else {
            await c.openCharacterChat(target.chat);
        }
        for (let i = 0; i < 10 && String(c.chatId) !== String(target.chat); i++) await sleep(1000);
        await sleep(2500);
        out.__backRows = (c.chat || []).length;
        out.__backOk = String(c.chatId) === String(target.chat) && out.__backRows === 3;
        log('back to parent: chatId=' + c.chatId + ' rows=' + out.__backRows);

        // ─────────── ④ 原生「创建检查点」（自定义名；在第 3 层）───────────
        const filesBeforeCp = await listFiles();
        if (!clickIn(2, '.mes_create_bookmark')) { log('原生检查点按钮不存在'); out.ok = false; return out; }
        await sleep(2500);
        const filled = fillTopDialog('@@CPNAME@@');
        log('checkpoint name dialog: ' + filled);
        await sleep(6000);

        const filesAfterCp = await listFiles();
        const newFilesCp = filesAfterCp.filter(f => !filesBeforeCp.includes(f));
        out.__cpNoNewFile = newFilesCp.length === 0;
        log('after checkpoint: new disk files = ' + JSON.stringify(newFilesCp));

        const famB = await familyState();
        const branchesB = famB?.model?.branches || [];
        const cpBranch = branchesB.find(b => b.name === '@@CPNAME@@');
        out.__cpAdded = Boolean(cpBranch);
        out.__cpFlagged = cpBranch?.is_checkpoint === true && cpBranch?.marker_floor === 3;
        out.__cpNotSwitched = String(famB?.model?.active_branch) === String(famA?.model?.active_branch);
        const cpBind = Object.entries(famB?.keyBindings || {}).find(([, v]) => v.branchId === cpBranch?.id);
        out.__cpBound = Boolean(cpBind);
        out.__cpMainChat = cpBind?.[1]?.mainChat === target.chat;
        out.__cpRootNoMainChat = !(famB?.hostMetadata || {}).main_chat; // 按键自管，不得混进家族级
        log('checkpoint branch: added=' + out.__cpAdded + ' flagged=' + out.__cpFlagged
            + ' notSwitched=' + out.__cpNotSwitched + ' binding=' + JSON.stringify(cpBind?.[1])
            + ' active=' + famB?.model?.active_branch);

        // ⑤ 导航：旗标存在（宿主自己按 extra.bookmark_link 渲染）→ 打开检查点聊天
        out.__flagAfterCreate = document.querySelectorAll('.mes_bookmark').length;
        const cpFileName = String(cpBind?.[0] || '').split('::').pop();
        const arrCp = await getChatArr(cpFileName);
        out.__cpRead = arrCp.length === 4; // [header, 层1..3]（在第 3 层做的检查点）
        log('checkpoint read: ' + arrCp.length + ' rows (want 4) file=' + cpFileName);

        if (document.querySelectorAll('.mes_bookmark').length) {
            document.querySelectorAll('.mes_bookmark')[document.querySelectorAll('.mes_bookmark').length - 1].click();
            for (let i = 0; i < 10 && String(c.chatId) !== cpFileName; i++) await sleep(1000);
            await sleep(2500);
        }
        out.__cpDom = document.querySelectorAll('#chat .mes').length;
        out.__cpOpened = String(c.chatId) === cpFileName;
        out.__cpBackVisible = (() => {
            const el = document.querySelector('#option_back_to_main');
            return Boolean(el && el.offsetParent !== null);
        })();
        log('checkpoint navigation: opened=' + out.__cpOpened + ' DOM=' + out.__cpDom + ' backVisible=' + out.__cpBackVisible);

        // ⑥ 清场：切回原聊天 → 删家族 → 释放接缝
        try { await c.openCharacterChat(target.chat); await sleep(2500); } catch (e) { log('restore chat warn: ' + e); }
        await adapter.deleteFamily({ familyId }).catch(() => {});
        const filesEnd = await listFiles();
        out.__cleanDisk = filesEnd.length === filesBefore0.length;
        handle.dispose();
        disposeAdapter();
        seamLog.forEach((m, i) => log('seam[' + i + '] ' + m));
        log('cleaned + disposed; disk files at end = ' + filesEnd.length + ' (start ' + filesBefore0.length + ')');

        // ── 通过判据（AC2 / AC3 / AC11）
        out.ok = out.__branchNoNewFile === true && out.__branchAdded === true && out.__branchFork === true
            && out.__branchPath === true && out.__branchBound === true && out.__branchMainChat === true
            && out.__switched === true && out.__branchRead === true && out.__rootRead === true
            && out.__branchMainChatRead === true && out.__rootNoMainChat === true
            && out.__backVisible === true && out.__backOk === true
            && out.__cpNoNewFile === true && out.__cpAdded === true && out.__cpFlagged === true
            && out.__cpNotSwitched === true && out.__cpBound === true && out.__cpMainChat === true
            && out.__cpRootNoMainChat === true && out.__cpRead === true
            && out.__cpOpened === true && out.__cpDom === 3;
        return out;
    } catch (e) {
        log('FAIL: ' + String(e && e.stack || e).slice(0, 600));
        out.ok = false;
        return out;
    }
}"""

STEPS = STEPS.replace("@@FID@@", FAMILY_ID).replace("@@CHAR@@", CHAR_NAME).replace("@@CPNAME@@", CHECKPOINT_NAME)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
        # T8 起：打开一个未入库的聊天会弹入库提醒（本用例要点宿主的原生按钮，模态窗会挡住它）
        # → 先写压制记录（与 harness.boot 同一做法）。
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
        print("\nT1 TAKEOVER PASS: 原生分支/检查点均在库内成结构、磁盘零新 jsonl、检查点导航看到快照、返回父聊天可用")
    else:
        print("\nT1 TAKEOVER FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
