"""一次性收尾：把 Dev 实例的 chatfilesys 设置恢复出厂（增强模式 + 不压制入库提醒）。

为什么需要：e2e 用例会把 `extension_settings` 落盘（harness 为了不弹入库提醒写 `never:true`、
T9 用例切过存储模式），宿主的 `saveSettingsDebounced` 又会把中途状态写进 settings.json。
收尾跑一次本脚本，保证人工验证时看到的是出厂行为。

注意（踩过）：宿主启动时用 `Object.assign(extension_settings, settings.extension_settings)` 整份顶掉，
**必须等扩展就绪 + 角色列表载入之后再写**，否则写完立刻被顶回旧值。

用法: PYTHONIOENCODING=utf-8 python tests/e2e/reset_chatfilesys_settings.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import ENTRY  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = "https://127.0.0.1:8003"

WRITE = """() => {
    const s = SillyTavern.getContext().extensionSettings;
    s.chatfilesys = s.chatfilesys || {};
    s.chatfilesys.storage_mode = 'off';
    s.chatfilesys.import_prompt = { never: false, mutedKeys: [] };
    return JSON.parse(JSON.stringify(s.chatfilesys));
}"""
READ = "() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode"
SAVE = "() => { SillyTavern.getContext().saveSettingsDebounced?.(); return 'saved'; }"

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--ignore-certificate-errors"])
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#send_textarea", state="attached", timeout=60000)
    page.wait_for_selector(ENTRY, state="attached", timeout=60000)
    page.wait_for_function("() => (SillyTavern.getContext().characters || []).length > 0", timeout=60000)
    cur = None
    for _ in range(6):
        page.evaluate(WRITE)
        page.wait_for_timeout(900)
        cur = page.evaluate(READ)
        if cur == 'off':
            break
    page.evaluate(WRITE)          # 再写一次，然后落盘（避免中间被顶回）
    page.wait_for_timeout(300)
    page.evaluate(SAVE)
    page.wait_for_timeout(2500)
    out = page.evaluate("() => JSON.parse(JSON.stringify(SillyTavern.getContext().extensionSettings.chatfilesys))")
    browser.close()

print("chatfilesys 设置（内存）:", out)
if out.get("storage_mode") != "off" or out.get("import_prompt", {}).get("never") is not False:
    print("RESET FAIL：没能恢复出厂")
    sys.exit(1)
print("RESET DONE")
