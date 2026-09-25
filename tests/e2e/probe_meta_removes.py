"""对照探针：**原生模式**（不装接缝）下，第三方直接写进聊天头的键会不会被宿主抹掉。

背景：T0c 在纯库模式观察到「host 一次写 → 别的插件命名空间没了」。纯库下抓到的 op 形态是
`meta/patch` 里的 `remove /main_chat`、`remove /e2e_probe_top` 等（宿主快照与内存副本不一致时
它自己发出删除）。本探针回答一个判定性问题：

    同样的序列，在**原生 jsonl 聊天**上（服务端就是文件本体）会不会同样被删？
      · 同样被删 → 属宿主行为（本插件照服务端语义执行即可，不算我们的缺陷）
      · 原生不删 → 属本插件接缝引入的偏差（必须修）

序列（与 test_chat_record_fidelity.py 同形）：
  ① 打开 __cb_e2e 聊天（宿主加载内存副本，此时这些键还不存在）
  ② 走原生 `/api/chats/meta/patch` 直接写进聊天头：main_chat / 顶层键 / extensions 命名空间
  ③ 读回确认已写入
  ④ UI 发一条消息（宿主自己保存）
  ⑤ 再读 → 这些键还在吗（本次读的是**服务端文件**，非接缝）

用法：python tests/e2e/probe_meta_removes.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from harness import Runner, browser_ctx  # noqa: E402

CHAR_NAME = "__cb_e2e"

STEPS = """async (charName) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);
    const H = () => window.SillyTavern.getContext().getRequestHeaders();
    const c = window.SillyTavern.getContext();
    const res0 = await fetch('/api/characters/all', { method: 'POST', headers: H(), body: '{}' });
    const chars = await res0.json();
    const target = chars.find(x => String(x.avatar || '').replace(/\\.png$/i, '') === charName);
    if (!target) { log('char not found'); return out; }
    const base = { avatar_url: target.avatar, file_name: target.chat };
    const get = () => fetch('/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(base) }).then(r => r.json());
    const post = (path, body) => fetch('/api/chats/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...H() }, body: JSON.stringify(body) });
    out.file = target.chat;

    // ① 打开聊天（宿主加载内存副本）
    const idx = chars.findIndex(x => String(x.avatar || '').replace(/\\.png$/i, '') === charName);
    for (let attempt = 0; attempt < 5 && String(c.characterId) !== String(idx); attempt++) {
        await c.selectCharacterById(idx);
        await new Promise(r => setTimeout(r, 3000));
    }
    await new Promise(r => setTimeout(r, 4000));
    log('opened: chatLen=' + (c.chat || []).length + ' memKeys=' + JSON.stringify(Object.keys(c.chatMetadata || {})));

    // ② 原生 meta/patch 直接写进聊天头（绕过宿主内存）
    const r = await post('meta/patch', { ...base, operations: [
        { op: 'add', path: '/main_chat', value: 'native_root' },
        { op: 'add', path: '/native_probe_top', value: { hp: 3 } },
        { op: 'add', path: '/extensions/third-party~1native_probe', value: { flag: true } },
    ] });
    log('meta/patch status=' + r.status + ' → ' + JSON.stringify(await r.json()));

    // ③ 读回确认
    const a1 = await get();
    const m1 = a1[0]?.chat_metadata || {};
    log('after write: main_chat=' + m1.main_chat + ' top=' + JSON.stringify(m1.native_probe_top) + ' ns=' + JSON.stringify(m1.extensions?.['third-party/native_probe']));

    // ④ UI 发一条消息（宿主自己保存）
    const ta = document.querySelector('#send_textarea');
    ta.value = '原生对照探针：宿主驱动消息';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but').click();
    await new Promise(r2 => setTimeout(r2, 12000));

    // ⑤ 再读（服务端文件真身）
    const a2 = await get();
    const m2 = a2[0]?.chat_metadata || {};
    out.mainChatSurvives = m2.main_chat === 'native_root';
    out.topSurvives = JSON.stringify(m2.native_probe_top) === JSON.stringify({ hp: 3 });
    out.nsSurvives = JSON.stringify(m2.extensions?.['third-party/native_probe']) === JSON.stringify({ flag: true });
    log('after host send: main_chat=' + m2.main_chat + ' top=' + JSON.stringify(m2.native_probe_top) + ' ns=' + JSON.stringify(m2.extensions?.['third-party/native_probe']));
    log('SURVIVE main=' + out.mainChatSurvives + ' top=' + out.topSurvives + ' ns=' + out.nsSurvives);
    return out;
}"""


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "probe-meta")
        try:
            r.boot()
            print("boot ok")
            result = r.js(STEPS, CHAR_NAME)
            for line in result.get("steps", []):
                print(line)
            print("\n=== 原生模式对照结论 ===")
            print("main_chat 存活:", result.get("mainChatSurvives"))
            print("顶层键存活  :", result.get("topSurvives"))
            print("命名空间存活:", result.get("nsSurvives"))
        finally:
            b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
