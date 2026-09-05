"""2.4 前置探针：官方消息 API 语义实测（Luker 宿主 8003，真实浏览器）。

实测问题（结果回写 design.md「二期实测事实」）：
  P1 API 存在性与签名（updateMessages/deleteMessages/addMessages/saveChatMetadata/saveMetadata）
  P2 addMessages 单条/批量返回值 + 落盘（含 swipes 字段透传 P8）
  P3 deleteMessages 批量升序索引 → 自动偏移 + 返回被删对象
  P4 元数据搭车：metadata 改动（tainted）后 deleteMessages → 服务端文件是否带上新 metadata
  P5 silent 选项是否抑制事件（MESSAGE_SENT/RECEIVED/DELETED/EDITED）
  P6 updateMessages patch 合并语义（深合并 vs 整字段替换；新顶层字段；嵌套 extra）
  P7 陈旧状态下的冲突行为（核心是否内部消化 409：调用 resolve 不抛、结果收敛）
"""
import sys
import traceback
from playwright.sync_api import sync_playwright
from harness import Runner, browser_ctx, report, TEST_CHAR

results = []


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "main")
        created = False
        try:
            r.boot()
            res = r.create_test_char()
            created = res.get("status") == 200
            results.append(report("创建测试角色", created, str(res)))
            if not created:
                return 1
            r.open_test_char()
            r.settle(2500)

            # ---------- P1 存在性与签名 ----------
            p1 = r.js("""() => {
                const ctx = SillyTavern.getContext();
                const names = ['updateMessages','deleteMessages','addMessages','saveChatMetadata',
                               'saveMetadata','saveMetadataDebounced','getMessage','getMessageCount'];
                const out = {};
                for (const n of names) out[n] = typeof ctx[n];
                return out;
            }""")
            print("P1 API 存在性:", p1)
            results.append(report("P1 API 存在性",
                                  p1.get('updateMessages') == 'function' and p1.get('deleteMessages') == 'function'
                                  and p1.get('addMessages') == 'function',
                                  str(p1)))

            # ---------- P2 addMessages：单条返回索引 + swipes 透传（P8） ----------
            p2 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i1 = await ctx.addMessages({ name: 'System', mes: '探针-单条', is_system: true });
                const idxs = await ctx.addMessages([
                    { name: 'U', mes: '探针-批量用户', is_user: true },
                    { name: 'AI', mes: '探针-批量AI', is_user: false,
                      swipes: ['探针-批量AI', '探针-swipe1'], swipe_id: 1,
                      swipe_info: [{ send_date: 111, extra: {} }, { send_date: 222, extra: { note: 'v1' } }] },
                ]);
                await new Promise(res => setTimeout(res, 800));
                const last = JSON.parse(JSON.stringify(ctx.chat[ctx.chat.length - 1]));
                return { i1, idxs, len: ctx.chat.length, last };
            }""")
            print("P2 addMessages:", {k: p2[k] for k in ('i1', 'idxs', 'len')})
            print("P8 last 行 swipes 字段:", {k: p2['last'].get(k) for k in ('mes', 'swipes', 'swipe_id')})
            results.append(report("P2 addMessages 返回值", p2.get('i1') == 1 and p2.get('idxs') == [2, 3] and p2.get('len') == 4,
                                  f"i1={p2.get('i1')} idxs={p2.get('idxs')} len={p2.get('len')}"))
            sw = p2['last']
            results.append(report("P8 swipes 字段透传",
                                  sw.get('swipes') == ['探针-批量AI', '探针-swipe1'] and sw.get('swipe_id') == 1
                                  and isinstance(sw.get('swipe_info'), list) and len(sw.get('swipe_info')) == 2,
                                  str({k: sw.get(k) for k in ('swipes', 'swipe_id', 'swipe_info')})[:200]))

            # P2 落盘核对
            d = r.disk_state()
            results.append(report("P2 addMessages 落盘", d.get('bodyLen') == 4, f"bodyLen={d.get('bodyLen')} texts={d.get('bodyTexts')}"))

            # ---------- P3 deleteMessages 批量升序 + 返回值 ----------
            p3 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const before = ctx.chat.map(x => x.mes);
                // 删除索引 1 与 3（升序传原始索引；批量应自动偏移）
                const del = await ctx.deleteMessages([1, 3]);
                await new Promise(res => setTimeout(res, 800));
                return { del: JSON.parse(JSON.stringify(del)), after: ctx.chat.map(x => x.mes), len: ctx.chat.length };
            }""")
            print("P3 deleteMessages:", p3)
            results.append(report("P3 批量删除自动偏移",
                                  p3.get('after') == ['开场问候语（F1）', '探针-批量用户'] and p3.get('len') == 2,
                                  f"after={p3.get('after')}"))
            results.append(report("P3 返回被删对象",
                                  isinstance(p3.get('del'), list) and len(p3.get('del')) == 2
                                  and p3['del'][0].get('mes') == '探针-单条' and p3['del'][1].get('mes') == '探针-批量AI',
                                  str([x.get('mes') for x in (p3.get('del') or [])])))

            # ---------- P5 silent 事件抑制 ----------
            p5 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const { eventSource, event_types } = await import('/script.js');
                const hits = { sent: 0, received: 0, deleted: 0, edited: 0 };
                const mk = (k) => () => { hits[k]++; };
                const ons = [
                    [event_types.MESSAGE_SENT, mk('sent')],
                    [event_types.MESSAGE_RECEIVED, mk('received')],
                    [event_types.MESSAGE_DELETED, mk('deleted')],
                    [event_types.MESSAGE_EDITED, mk('edited')],
                ];
                ons.forEach(([e, f]) => eventSource.on(e, f));
                try {
                    await ctx.addMessages({ name: 'System', mes: '探针-带事件', is_system: true });
                    await ctx.addMessages({ name: 'System', mes: '探针-静默添加', is_system: true }, { silent: true });
                    await ctx.deleteMessages(ctx.chat.length - 1, { silent: true });
                    await ctx.updateMessages({ index: ctx.chat.length - 1, patch: { mes: '探针-静默更新' } }, { silent: true });
                    await new Promise(res => setTimeout(res, 600));
                } finally {
                    ons.forEach(([e, f]) => eventSource.removeListener?.(e, f) ?? eventSource.off?.(e, f));
                }
                return { hits, len: ctx.chat.length, lastMes: ctx.chat[ctx.chat.length - 1].mes };
            }""")
            print("P5 silent 事件计数:", p5)
            results.append(report("P5 非静默触发事件", p5['hits']['received'] >= 1,
                                  str(p5['hits'])))
            results.append(report("P5 silent 抑制事件",
                                  p5['hits']['deleted'] == 0 and p5['hits']['edited'] == 0 and p5['hits']['sent'] == 0 and p5['hits']['received'] == 1,
                                  # is_system 非静默 add 只触发 MESSAGE_RECEIVED；其余三个调用全部 silent
                                  str(p5['hits']) + f" lastMes={p5.get('lastMes')}"))

            # ---------- P6 updateMessages patch 合并语义 ----------
            p6 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const i = await ctx.addMessages({ name: 'AI', mes: '探针-合并', is_user: false,
                    extra: { alpha: 1, beta: { deep: 'v1', keep: 'yes' } } });
                const before = JSON.parse(JSON.stringify(ctx.chat[i].extra));
                await ctx.updateMessages({ index: i, patch: { extra: { beta: { deep: 'v2' } } } });
                await new Promise(res => setTimeout(res, 600));
                const after = JSON.parse(JSON.stringify(ctx.chat[i].extra));
                // 顶层新字段
                await ctx.updateMessages({ index: i, patch: { custom_probe: 'x1' } });
                await new Promise(res => setTimeout(res, 400));
                const hasNew = ctx.chat[i].custom_probe === 'x1';
                // 整字段替换测试：patch.mes 应替换而非合并
                await ctx.updateMessages({ index: i, patch: { mes: '探针-合并v2' } });
                await new Promise(res => setTimeout(res, 400));
                return { before, after, hasNew, mes: ctx.chat[i].mes };
            }""")
            print("P6 patch 合并:", p6)
            deep_merged = p6['after'].get('alpha') == 1 and p6['after'].get('beta', {}).get('deep') == 'v2' and p6['after'].get('beta', {}).get('keep') == 'yes'
            shallow_replaced = p6['after'].get('beta', {}).get('deep') == 'v2' and 'alpha' not in p6['after']
            print(f"   → 语义判定: {'深合并' if deep_merged else ('整字段替换' if shallow_replaced else '其他')}")
            results.append(report("P6 updateMessages patch 语义（记录）", deep_merged or shallow_replaced,
                                  f"deep_merged={deep_merged} shallow={shallow_replaced} before={p6['before']} after={p6['after']}"))
            results.append(report("P6 顶层新字段可加", p6.get('hasNew') is True, f"hasNew={p6.get('hasNew')}"))

            # ---------- P4 元数据搭车（deleteMessages 持久化是否携带 chat_metadata） ----------
            p4 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                // 直接改内存 metadata（模拟 setModel 行为：替换对象 + tainted）
                const md = { ...(ctx.chatMetadata || {}) };
                md.extensions = { ...(md.extensions || {}), chatfilesys_probe: { marker: 'P4', ts: 1 } };
                ctx.chatMetadata = md;
                ctx.chatMetadata.tainted = true;
                await ctx.deleteMessages(ctx.chat.length - 1);  // 触发 patch 持久化
                await new Promise(res => setTimeout(res, 1200));
                return 'done';
            }""")
            d4 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const data = await res.json();
                const md = Array.isArray(data) ? data[0]?.chat_metadata : null;
                return { probe: md?.extensions?.chatfilesys_probe ?? null,
                         cf: md?.extensions?.chatfilesys ? 'present' : 'missing' };
            }""")
            print("P4 元数据搭车:", p4, "服务端 metadata:", d4)
            results.append(report("P4 deleteMessages 携带 chat_metadata 落盘",
                                  d4.get('probe') == {'marker': 'P4', 'ts': 1},
                                  str(d4)))
            # 清理探针标记
            r.js("""() => {
                const ctx = SillyTavern.getContext();
                const md = { ...(ctx.chatMetadata || {}) };
                if (md.extensions) delete md.extensions.chatfilesys_probe;
                ctx.chatMetadata = md;
                ctx.chatMetadata.tainted = true;
                return 'cleaned';
            }""")
            r.js("""async () => { await SillyTavern.getContext().saveMetadata?.(); return 'saved'; }""")
            r.settle(800)

            # ---------- P7 陈旧状态冲突行为 ----------
            p7 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                // 1) 用服务端直写（正确 integrity）制造本地陈旧
                const cur = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const file = await cur.json();
                const integrity = file[0]?.chat_metadata?.integrity;
                const st = await fetch('/api/chats/meta/patch', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar,
                                           operations: [{ op: 'add', path: '/extensions/stale_probe', value: 'v1' }],
                                           chat_metadata: file[0].chat_metadata, integrity }),
                });
                const staleMade = st.status;
                // 2) 本地已陈旧 → 官方 API 写入（触发核心内部冲突处理）
                let outcome = 'no-throw', err = null;
                try {
                    await ctx.addMessages({ name: 'System', mes: '探针-陈旧写入', is_system: true });
                } catch (e) { outcome = 'throw'; err = String(e?.message || e); }
                await new Promise(res => setTimeout(res, 1500));
                // 3) 收敛核对：服务端是否包含本页写入的消息
                const chk = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const f2 = await chk.json();
                const texts = f2.slice(1).map(x => x.mes);
                return { staleMade, outcome, err, converged: texts.includes('探针-陈旧写入'),
                         diskLen: f2.length - 1, memLen: ctx.chat.length };
            }""")
            print("P7 冲突行为:", p7)
            results.append(report("P7 官方 API 陈旧写入不抛错（核心内部消化）", p7.get('outcome') == 'no-throw',
                                  str(p7)))
            results.append(report("P7 写入最终落盘收敛", p7.get('converged') is True,
                                  f"converged={p7.get('converged')} diskLen={p7.get('diskLen')} memLen={p7.get('memLen')}"))

            # ---------- saveChatMetadata(withMetadata) 形态 ----------
            p9 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                if (typeof ctx.saveChatMetadata !== 'function') return { exists: false };
                const ok = await ctx.saveChatMetadata({ chatfilesys_probe2: { via: 'withMetadata' } });
                await new Promise(res => setTimeout(res, 900));
                return { exists: true, ok, inMem: ctx.chatMetadata?.chatfilesys_probe2 ?? null };
            }""")
            print("P9 saveChatMetadata(withMetadata):", p9)
            d9 = r.disk_state()
            # disk_state 不含 probe2 —— 单独查
            d9b = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', {
                    method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }),
                });
                const data = await res.json();
                return Array.isArray(data) ? data[0]?.chat_metadata?.chatfilesys_probe2 ?? null : null;
            }""")
            print("P9 服务端核对:", d9b)
            results.append(report("P9 saveChatMetadata(withMetadata) 合并保存",
                                  p9.get('exists') is True and d9b == {'via': 'withMetadata'},
                                  f"p9={p9} disk={d9b}"))

            # ---------- console/pageerror ----------
            errs = r.console_errors()
            print("console errors:", errs[:8])
            print("pageerrors:", r.errors[:5])
            results.append(report("零 pageerror", len(r.errors) == 0, str(r.errors[:3])))

        except Exception:
            traceback.print_exc()
            results.append(report("harness 执行", False, "异常见上"))
        finally:
            if created:
                print("--- cleanup ---")
                try:
                    print("delete char:", r.delete_test_char())
                except Exception as e:
                    print("cleanup failed:", e)
            b.close()

    print("\n=== SUMMARY ===")
    print(f"pass {sum(results)}/{len(results)}")
    return 0 if all(results) and results else 1


if __name__ == "__main__":
    sys.exit(main())
