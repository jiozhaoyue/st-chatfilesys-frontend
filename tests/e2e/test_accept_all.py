"""全量接管:存量聊天文件批量启用分支系统(走服务端 patch + integrity,用真实 core 模块)。

前置:chats 目录已完整备份到 backups/chats-pre-branch-20260905/。
流程:枚举角色与聊天文件 → 逐文件 GET(取 body 算模型)→ enableForChat → PATCH 纯 metadata
→ 全量验证(active 投影与 body 对齐、分支 id 唯一)。
"""
import json
import os
import sys
import time
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx

# 本地实例的 chats 目录（按自己的实例路径设置环境变量或改这里）
CHATS_DIR = os.environ.get("CHATS_DIR", "<instance>/data/default-user/chats")
results = []


def enumerate_files():
    """磁盘枚举:{avatar_dir: [file_name, ...]}(avatar_dir = avatar 去 .png)。"""
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
    print(f"待接管: {len(file_map)} 角色 / {total} 文件")

    ok = fail = skipped = 0
    failures = []

    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        try:
            r.boot()

            # 角色名映射(avatar 去 .png -> ch_name)
            name_map = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                await ctx.getCharacters();
                const m = {};
                for (const ch of ctx.characters || []) m[String(ch.avatar).replace(/\\.png$/, '')] = ch.name;
                return m;
            }""")

            # 页面内定义单文件启用函数(复用服务端在跑的 core 模块)
            r.js("""() => {
                window.__cbAccept = async (chName, avatar, fileName) => {
                    const headers = SillyTavern.getContext().getRequestHeaders();
                    const get = await fetch('/api/chats/get', {
                        method: 'POST', headers,
                        body: JSON.stringify({ ch_name: chName, file_name: fileName, avatar_url: avatar }),
                    });
                    if (!get.ok) return { ok: false, why: `get ${get.status}` };
                    const data = await get.json();
                    if (!Array.isArray(data)) return { ok: false, why: 'get shape' };
                    const header = data[0], lines = data.slice(1);
                    const md = header.chat_metadata || {};
                    if (md.extensions?.chatfilesys) return { ok: true, skipped: true };
                    const core = await import('/scripts/extensions/third-party/chatfilesys/core/branches.js');
                    const model = core.enableForChat(lines);
                    const mergedExt = { ...(md.extensions || {}), chatfilesys: model };
                    const op = { op: 'add', path: '/extensions', value: mergedExt };
                    for (let attempt = 0; attempt < 2; attempt++) {
                        const res = await fetch('/api/chats/meta/patch', {
                            method: 'POST', headers,
                            body: JSON.stringify({
                                ch_name: chName, file_name: fileName, avatar_url: avatar,
                                operations: [op], integrity: md.integrity,
                            }),
                        });
                        if (res.ok) return { ok: true, floors: lines.length };
                        if (res.status === 409) continue;  // 拉到的 integrity 过期:重取一遍
                        const t = await res.text().catch(() => '');
                        return { ok: false, why: `meta/patch ${res.status} ${t.slice(0, 80)}` };
                    }
                    return { ok: false, why: 'meta/patch 409 x2' };
                };
                return 1;
            }""")

            t0 = time.time()
            done = 0
            for avatar_dir, files in file_map.items():
                ch_name = name_map.get(avatar_dir)
                avatar = f"{avatar_dir}.png"
                if not ch_name:
                    failures.append((avatar_dir, "*", "角色名映射失败"))
                    fail += len(files)
                    done += len(files)
                    continue
                for fn in files:
                    try:
                        res = r.js("""async (args) => window.__cbAccept(args[0], args[1], args[2])""",
                                   [ch_name, avatar, fn])
                        if res.get("ok") and res.get("skipped"):
                            skipped += 1
                        elif res.get("ok"):
                            ok += 1
                        else:
                            fail += 1
                            failures.append((avatar_dir, fn, res.get("why")))
                    except Exception as e:
                        fail += 1
                        failures.append((avatar_dir, fn, str(e)[:120]))
                    done += 1
                    if done % 20 == 0 or done == total:
                        print(f"进度 {done}/{total} ok={ok} skip={skipped} fail={fail} ({time.time()-t0:.0f}s)")

        except Exception:
            traceback.print_exc()
            results.append(report("执行", False, "异常"))
        finally:
            b.close()

    print(f"\n=== 启用完成: ok={ok} skipped={skipped} fail={fail} ===")
    for f in failures[:12]:
        print("  FAIL:", f)

    # ---------- 全量验证 ----------
    print("\n=== 验证全部文件 ===")
    v_ok = v_bad = 0
    v_failures = []
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        try:
            r.boot()
            name_map = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                await ctx.getCharacters();
                const m = {};
                for (const ch of ctx.characters || []) m[String(ch.avatar).replace(/\\.png$/, '')] = ch.name;
                return m;
            }""")
            r.js("""() => {
                window.__cbVerify = async (chName, avatar, fileName) => {
                    const headers = SillyTavern.getContext().getRequestHeaders();
                    const get = await fetch('/api/chats/get', {
                        method: 'POST', headers,
                        body: JSON.stringify({ ch_name: chName, file_name: fileName, avatar_url: avatar }),
                    });
                    if (!get.ok) return { ok: false, why: `get ${get.status}` };
                    const data = await get.json();
                    if (!Array.isArray(data)) return { ok: false, why: 'shape' };
                    const header = data[0], lines = data.slice(1);
                    const m = header.chat_metadata?.extensions?.chatfilesys;
                    if (!m) return { ok: false, why: 'no model' };
                    const ids = m.branches.map(x => x.id);
                    if (new Set(ids).size !== ids.length) return { ok: false, why: 'dup ids' };
                    const active = m.branches.find(x => x.id === m.active_branch);
                    if (!active) return { ok: false, why: 'no active' };
                    const maxF = Math.max(0, ...Object.keys(active.path).map(Number));
                    if (maxF !== lines.length) return { ok: false, why: `align ${maxF}!=${lines.length}` };
                    return { ok: true, floors: lines.length, branches: ids.length };
                };
                return 1;
            }""")
            t0 = time.time()
            done = 0
            for avatar_dir, files in file_map.items():
                ch_name = name_map.get(avatar_dir)
                avatar = f"{avatar_dir}.png"
                for fn in files:
                    try:
                        res = r.js("""async (args) => window.__cbVerify(args[0], args[1], args[2])""",
                                   [ch_name, avatar, fn])
                        if res.get("ok"):
                            v_ok += 1
                        else:
                            v_bad += 1
                            v_failures.append((avatar_dir, fn, res.get("why")))
                    except Exception as e:
                        v_bad += 1
                        v_failures.append((avatar_dir, fn, str(e)[:100]))
                    done += 1
                    if done % 30 == 0 or done == total:
                        print(f"验证进度 {done}/{total} ok={v_ok} bad={v_bad} ({time.time()-t0:.0f}s)")
        except Exception:
            traceback.print_exc()
        finally:
            b.close()

    print(f"\n=== 验证完成: ok={v_ok} bad={v_bad} ===")
    for f in v_failures[:12]:
        print("  BAD:", f)

    all_pass = (fail == 0 and v_bad == 0)
    print(f"\n=== TOTALS: {'ALL PASS' if all_pass else 'HAS FAILURES'} ===")
    return 0 if all_pass else 1


def report(name, okv, detail=""):
    print(f"[{'PASS' if okv else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    return okv


if __name__ == "__main__":
    sys.exit(main())
