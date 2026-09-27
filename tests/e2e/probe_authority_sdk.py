"""探针：Authority SDK 的 probe / init 现场（一次性诊断，不是回归套件）。

回答一个问题：**装好的 Authority 为什么没被 chatfilesys 用上**——
是 SDK 不在、probe 不过、还是 init 被拒（权限/503）。

用法: PYTHONIOENCODING=utf-8 python tests/e2e/probe_authority_sdk.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROBE_JS = """async () => {
    const out = { hasSdkGlobal: Boolean(window.STAuthority),
                  hasAuthoritySDK: Boolean(window.STAuthority?.AuthoritySDK),
                  hasProbe: typeof window.STAuthority?.AuthoritySDK?.probe,
                  hasInit: typeof window.STAuthority?.AuthoritySDK?.init };
    try {
        out.probe = await window.STAuthority.AuthoritySDK.probe();
    } catch (e) {
        out.probe = { __threw: String(e?.message || e), name: e?.name, category: e?.category };
    }
    try {
        const client = await window.STAuthority.AuthoritySDK.init({
            extensionId: 'third-party/chatfilesys',
            displayName: 'ChatFilesys',
            version: '1.0.0',
            installType: 'local',
            declaredPermissions: { sql: { private: true }, fs: { private: true } },
        });
        out.init = { ok: true, hasSql: Boolean(client?.sql), hasFs: Boolean(client?.fs) };
        try {
            out.sqlProbe = await client.sql.query({ database: 'chatfilesys', statement: 'SELECT 1 AS one' });
        } catch (e) {
            out.sqlProbe = { __threw: String(e?.message || e), name: e?.name, category: e?.category };
        }
    } catch (e) {
        out.init = { ok: false, __threw: String(e?.message || e), name: e?.name, category: e?.category,
                     stack: String(e?.stack || '').split('\\n').slice(0, 4) };
    }
    return out;
}"""

SWITCH_JS = """async (m) => {
    const sel = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup [data-role="storage-mode"]');
    if (!sel) return { sel: false };
    const before = SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode;
    sel.value = m;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 8000));
    const after = SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode;
    const toasts = [...document.querySelectorAll('.toast, #toast-container .toast-message, #toast-container > div')]
        .map(x => x.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
    const badge = document.querySelector('dialog[open]:not([closing]) .chatfilesys-popup [data-role="storage-status"]');
    return { sel: true, before, after, toasts, badge: badge ? badge.innerText.replace(/\\s+/g, ' ').trim() : null };
}"""

ERR_JS = """async () => {
    const sdk = window.STAuthority.AuthoritySDK;
    const client = await sdk.init({
        extensionId: 'third-party/chatfilesys',
        displayName: 'ChatFilesys',
        version: '1.0.0',
        installType: 'local',
        declaredPermissions: { sql: { private: true }, fs: { private: true } },
    });
    const dump = (e) => {
        if (e === null || e === undefined) return { __value: String(e) };
        if (typeof e !== 'object') return { __typeof: typeof e, __value: String(e) };
        const out = { __ctor: e.constructor?.name, __message: e.message, __code: e.code,
                      __category: e.category, __status: e.status,
                      __keys: Object.keys(e).slice(0, 12),
                      __payload: e.payload ? JSON.stringify(e.payload).slice(0, 300) : null,
                      __details: e.details ? JSON.stringify(e.details).slice(0, 200) : null };
        return out;
    };
    const out = {};
    try { out.readDirMissing = { ok: true, entries: await client.fs.readDir('trash-不存在的目录') }; }
    catch (e) { out.readDirMissing = dump(e); }
    try { await client.fs.writeFile('t1/a.jsonl', 'x'); out.writeNoParent = 'ok'; }
    catch (e) { out.writeNoParent = dump(e); }
    try { await client.fs.mkdir('t2/sub', { recursive: true }); out.mkdir = 'ok'; }
    catch (e) { out.mkdir = dump(e); }
    try {
        await client.fs.writeFile('t2/sub/a.txt', 'hi');
        const r = await client.fs.readFile('t2/sub/a.txt');
        out.roundTrip = { content: typeof r === 'string' ? r : r?.content, keys: Object.keys(r || {}) };
        out.listDir = await client.fs.readDir('t2');
        await client.fs.delete('t2', { recursive: true });
        out.afterDelete = await client.fs.readDir('t2').then((x) => ({ leftover: x })).catch((e) => dump(e));
    } catch (e) { out.roundTrip = dump(e); }
    return out;
}"""

with sync_playwright() as p:
    b, c = browser_ctx(p)
    r = Runner(c.new_page(), "authority-probe")
    try:
        r.boot()
        print("错误对象与 fs 往返:", json.dumps(r.js(ERR_JS), ensure_ascii=False, indent=2, default=str))
    finally:
        b.close()
