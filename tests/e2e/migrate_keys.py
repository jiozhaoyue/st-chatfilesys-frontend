"""2.1 命名迁移:存量聊天文件 extensions.branches → extensions.chatfilesys(一次性,零兼容)。

前置:chats 目录已完整备份到 backups/chats-pre-rename-20260905/。
流程:磁盘枚举 → 逐文件 GET(取 header.chat_metadata)→ extensions 存在则 replace /extensions
(值 = 原 extensions,branches 键改名 chatfilesys,其余扩展元数据原样保留)→ meta/patch + integrity。
跳过:无 branches 键(未接管)或已迁移(chatfilesys 键存在)。
"""
import json
import os
import time
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx

# 本地实例的 chats 目录（按自己的实例路径设置环境变量或改这里）
CHATS_DIR = os.environ.get("CHATS_DIR", "<instance>/data/default-user/chats")


def enumerate_files():
    out = {}
    for d in sorted(os.listdir(CHATS_DIR)):
        p = os.path.join(CHATS_DIR, d)
        if os.path.isdir(p):
            files = [f[:-6] for f in os.listdir(p) if f.endswith(".jsonl")]
            if files:
                out[d] = sorted(files)
    return out


def main():
    file_map = enumerate_files()
    total = sum(len(v) for v in file_map.values())
    print(f"待处理: {len(file_map)} 角色 / {total} 文件")

    ok = fail = skipped = 0
    failures = []

    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "migrate")
        r.boot()

        name_map = r.js("""async () => {
            const ctx = SillyTavern.getContext();
            await ctx.getCharacters();
            const m = {};
            for (const ch of ctx.characters || []) m[String(ch.avatar).replace(/\\.png$/, '')] = ch.name;
            return m;
        }""")

        r.js("""() => {
            window.__migrateOne = async (chName, avatar, fileName) => {
                const headers = SillyTavern.getContext().getRequestHeaders();
                for (let round = 0; round < 3; round++) {
                    const get = await fetch('/api/chats/get', {
                        method: 'POST', headers,
                        body: JSON.stringify({ ch_name: chName, file_name: fileName, avatar_url: avatar }),
                    });
                    if (!get.ok) return { ok: false, why: `get ${get.status}` };
                    const data = await get.json();
                    if (!Array.isArray(data)) return { ok: false, why: 'get shape' };
                    const md = data[0].chat_metadata || {};
                    const ext = md.extensions || null;
                    if (!ext) return { ok: true, skipped: 'no-extensions' };
                    if (ext.chatfilesys && !ext.branches) return { ok: true, skipped: 'already' };
                    if (!ext.branches) return { ok: true, skipped: 'not-adopted' };
                    const merged = { ...ext, chatfilesys: ext.branches };
                    delete merged.branches;
                    const op = { op: 'replace', path: '/extensions', value: merged };
                    const res = await fetch('/api/chats/meta/patch', {
                        method: 'POST', headers,
                        body: JSON.stringify({
                            ch_name: chName, file_name: fileName, avatar_url: avatar,
                            operations: [op], integrity: md.integrity,
                        }),
                    });
                    if (res.ok) return { ok: true, floors: data.length - 1 };
                    if (res.status === 409) continue;  // integrity 过期 → 重拉重放
                    return { ok: false, why: `patch ${res.status}: ${await res.text().catch(() => '')}` };
                }
                return { ok: false, why: '409 x3' };
            };
        }""")

        t0 = time.time()
        for avatar_dir, files in file_map.items():
            ch_name = name_map.get(avatar_dir)
            if not ch_name:
                print(f"[SKIP] {avatar_dir}: 角色未加载(孤儿目录)")
                skipped += len(files)
                continue
            for fn in files:
                try:
                    res = r.js(
                        "([c, a, f]) => window.__migrateOne(c, a, f)",
                        [ch_name, f"{avatar_dir}.png", fn],
                    )
                    if not res or not res.get("ok"):
                        fail += 1
                        failures.append((avatar_dir, fn, res))
                        print(f"[FAIL] {avatar_dir}/{fn}: {res}")
                    elif res.get("skipped"):
                        skipped += 1
                    else:
                        ok += 1
                        if ok % 20 == 0:
                            print(f"  ...{ok} migrated ({time.time()-t0:.0f}s)")
                except Exception as e:
                    fail += 1
                    failures.append((avatar_dir, fn, str(e)[:200]))
                    print(f"[ERR] {avatar_dir}/{fn}: {e}")

    print(f"\n=== 迁移完成 === ok={ok} skipped={skipped} fail={fail} ({time.time()-t0:.0f}s)")
    for f in failures:
        print("  FAIL:", f)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
