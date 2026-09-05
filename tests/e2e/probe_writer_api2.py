"""2.4 前置探针第二轮：补测 silent 落盘、addMessages/updateMessages 元数据搭车、批量事件数。"""
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
            if not created:
                return 1
            r.open_test_char()
            r.settle(2500)

            # Q1 silent addMessages 是否落盘
            q1 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                await ctx.addMessages({ name: 'System', mes: 'Q1-静默添加', is_system: true }, { silent: true });
                await new Promise(res => setTimeout(res, 1200));
                return ctx.chat.length;
            }""")
            d1 = r.disk_state()
            print("Q1 silent add:", q1, "disk:", d1.get('bodyLen'), d1.get('bodyTexts'))
            results.append(report("Q1 silent addMessages 照常落盘",
                                  d1.get('bodyLen') == q1 and any('Q1-静默添加' in t for t in d1.get('bodyTexts', [])),
                                  str(d1.get('bodyTexts'))))

            # Q2 metadata 搭车（addMessages）
            q2 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const md = { ...(ctx.chatMetadata || {}) };
                md.extensions = { ...(md.extensions || {}), probe_ride: 'add' };
                ctx.chatMetadata = md;
                ctx.chatMetadata.tainted = true;
                await ctx.addMessages({ name: 'System', mes: 'Q2-搭车', is_system: true }, { silent: true });
                await new Promise(res => setTimeout(res, 1200));
                return 'ok';
            }""")
            d2 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', { method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }) });
                const data = await res.json();
                return Array.isArray(data) ? data[0]?.chat_metadata?.extensions?.probe_ride ?? null : null;
            }""")
            print("Q2 addMessages 元数据搭车:", d2)
            results.append(report("Q2 addMessages 携带 chat_metadata 落盘", d2 == 'add', str(d2)))

            # Q3 updateMessages 搭车 + silent deleteMessages 落盘
            q3 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const md = { ...(ctx.chatMetadata || {}) };
                md.extensions = { ...(md.extensions || {}), probe_ride: 'update' };
                ctx.chatMetadata = md;
                ctx.chatMetadata.tainted = true;
                await ctx.updateMessages({ index: ctx.chat.length - 1, patch: { mes: 'Q3-更新' } }, { silent: true });
                await new Promise(res => setTimeout(res, 1000));
                const n1 = ctx.chat.length;
                await ctx.deleteMessages(ctx.chat.length - 1, { silent: true });
                await new Promise(res => setTimeout(res, 1200));
                return { n1, n2: ctx.chat.length };
            }""")
            d3 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const res = await fetch('/api/chats/get', { method: 'POST', headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ ch_name: ctx.characters[ctx.characterId].name,
                                           file_name: ctx.getCurrentChatId(),
                                           avatar_url: ctx.characters[ctx.characterId].avatar }) });
                const data = await res.json();
                return { ride: data[0]?.chat_metadata?.extensions?.probe_ride ?? null,
                         len: data.length - 1,
                         lastMes: data[data.length - 1]?.mes };
            }""")
            print("Q3 update 搭车+silent delete 落盘:", q3, "disk:", d3)
            results.append(report("Q3 updateMessages 携带 metadata 落盘", d3.get('ride') == 'update', str(d3)))
            results.append(report("Q3 silent deleteMessages 照常落盘",
                                  d3.get('len') == q3.get('n2') and d3.get('lastMes') == 'Q1-静默添加', str(d3)))  # 更新后的 'Q3-更新' 已被删除，剩 'Q1-静默添加'

            # Q4 批量 addMessages 事件数（1 次还是 N 次）
            q4 = r.js("""async () => {
                const ctx = SillyTavern.getContext();
                const { eventSource, event_types } = await import('/script.js');
                let sent = 0, received = 0;
                const s = () => sent++, rc = () => received++;
                eventSource.on(event_types.MESSAGE_SENT, s);
                eventSource.on(event_types.MESSAGE_RECEIVED, rc);
                try {
                    await ctx.addMessages([
                        { name: 'U', mes: 'Q4-用户', is_user: true },
                        { name: 'AI', mes: 'Q4-AI', is_user: false },
                    ]);
                } finally {
                    eventSource.removeListener?.(event_types.MESSAGE_SENT, s);
                    eventSource.removeListener?.(event_types.MESSAGE_RECEIVED, rc);
                }
                await new Promise(res => setTimeout(res, 800));
                return { sent, received, len: ctx.chat.length };
            }""")
            print("Q4 批量事件:", q4)
            results.append(report("Q4 批量 addMessages 事件计数（记录）", True,
                                  f"sent={q4['sent']} received={q4['received']} len={q4['len']}"))

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
