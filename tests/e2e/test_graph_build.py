"""ChatFilesys 图引擎 e2e（B2 / AC2）

`core/graph/*` 是全部消费能力（图视图 / Diff / 看板 / 大纲 / 检索 / 画廊…）的地基。
本用例在**真机**上对一条**含原生分支文件的真实聊天**建图，钉住三件事：

  ① **公共前缀是共享节点**（不是复制）：父会话与分支文件里同层同内容的那些消息，
     在图上必须是**同一个节点**（`nodes[].sessions` 两条 = 两份会话共享它）
  ② **分支点有多个后继**：共享前缀的末节点出边 ≥ 2，两条后继分别是父子会话各自的下一层
  ③ **节点数 = 消息按 (层号, 内容) 去重后的数量**：既不多（没复制）也不少（没丢会话）

另加两条真机才能验的：
  ④ **增量失效真读指纹**（分两段）：
     ④-a **冻住输入**——页内取一次 `graphInputs()`，再用**同一个 `inputs` 对象**建两次图 →
        `changed:false`、digest 相同、且**复用同一个图对象**。原写法是「同一份磁盘事实连读两遍」，
        那不保证输入不变：宿主/本插件自己写一次聊天头 → `integrity` 变 → 判定真地是「变了」，
        那是 B2 的**正确**行为（性质②），不是缺陷。冻住输入才验得着「同一份输入 ⇒ 不重建」。
     ④-b 发一条新消息**落盘**后再重新读盘建图 → `changed:true`、digest 变、不复用。
     另：页内把两次的 digest 与**逐会话分项**（ref.id / 行数 / integrity / 节点序列摘要）一并带回，
     并附一次「另读一次盘」的分项作对照 —— ④-a 万一仍红，这些分项直接指出「是谁变了」（判性质①/②）。
  ⑤ 全程零 chatfilesys 归因报错

为什么能在**不用重算哈希**的前提下断言 ③：用例自己**构造**了这条数据——
父会话 3 层（G / M2 / M3），分支文件 = 前两层逐字复制 + 第三层换个正文。
按 `(层号, 内容)` 数一遍就是 4 个不同节点（层 1、层 2 各一 + 层 3 两个），
这个数是**从构造推出来的**，不是拿实现算出来的（不是拿实现跟自己比）。
另**并附**一条页内参照实现（独立循环、只用 `identity.js` 的原语）算出的 id 集合做逐一比对——
两条路径都要对上，一个漏一个多都红。

等待纪律：关键状态一律轮询（`r.wait_disk` / `poll`），不用固定 sleep 猜耗时
（`.trellis/spec/frontend/quality-guidelines.md` 的 Forbidden）。

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`；
扩展源码路径单点 = `harness.EXT_SRC`（本文件不另定义）。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_graph_build.py
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 装接缝**之前**的 fetch（= 真正读磁盘的那条原生通道）。off 模式下缺省的 fetch 就是它，
# 但显式抓住并按 B1 的要求注入（库模式下这是唯一的正确通道）。
SAVE_NATIVE_JS = """() => {
    window.__preSeamFetch = window.__preSeamFetch || globalThis.fetch;
    return 'saved';
}"""

# 建一个**文件源**（`off` 档的 ChatSource）：会话枚举与读取都落在磁盘 jsonl 上（原生通道）。
NEW_SOURCE_JS = """async ([src, useNative]) => {
    const ctx = SillyTavern.getContext();
    const mod = await import(src + '/core/source/chat-source.js');
    const character = () => {
        const ch = ctx.characters[ctx.characterId] || {};
        return { avatarUrl: ch.avatar, characterId: ctx.characterId, name: ch.name, groupId: ctx.groupId ?? null };
    };
    window.__cfsysGraphSrc = mod.createJsonlSource({
        mode: 'off',
        character,
        headers: () => ctx.getRequestHeaders(),
        nativeFetch: useNative ? window.__preSeamFetch : null,
        log: () => {},
    });
    return window.__cfsysGraphSrc.describe();
}"""

# 取建图输入（B1 的契约；每次都真读磁盘，B1 不缓存）
GRAPH_INPUTS_JS = """async () => {
    const g = await window.__cfsysGraphSrc.graphInputs();
    return JSON.parse(JSON.stringify(g));
}"""

# 建图：`prev` 用页内上一次的 `{graph, digest}` 充当（第二次建图验「复用」）。
# 返回里带 `reused` —— **页内**比的对象引用（过 JSON 往返就比不出来了）。
BUILD_JS = """async ([src, keys]) => {
    const mod = await import(src + '/core/graph/graph.js');
    const all = await window.__cfsysGraphSrc.graphInputs();
    const picked = keys ? all.sessions.filter(s => keys.includes(s.ref.key || s.ref.id)) : all.sessions;
    const inputs = { sessions: picked, ...(all.branches ? { branches: all.branches } : {}) };
    const out = await mod.buildGraph(inputs, {
        prev: window.__cfsysGraphCache || null, log: () => {},
    });
    window.__cfsysGraphCache = { graph: out.graph, digest: out.digest };
    const prevGraph = window.__cfsysPrevGraph || null;
    window.__cfsysPrevGraph = out.graph;
    return {
        graph: JSON.parse(JSON.stringify(out.graph)),
        digest: out.digest,
        changed: out.changed,
        notes: out.notes,
        reused: prevGraph !== null && out.graph === prevGraph,   // 引用相等 = 真复用
    };
}"""

# ④-a 专用：**冻住输入**的建法 —— 页内先取**一次** `graphInputs()`，再用**同一个 `inputs` 对象**
# 连续建两次图。原来「重新读盘两遍」不保证输入不变（宿主/本插件自己写一次聊天头 → integrity 变
# → 判定真地是「变了」，那是 B2 的正确行为），冻住输入才验得着「同一份输入 ⇒ changed:false + 复用」。
# 另带回「逐会话分项」（与 build.js 的指纹分项同形：ref.id / 行数 / 版本号 / 节点序列摘要）：
# before / after 取自**同一个** inputs 对象（用来证明这份输入两段之间没被动过），
# later 取自**另一次真读盘**（用来在红的时候直接判性质①/②：分项不同 = 输入真变了 = ②）。
BUILD_TWICE_JS = """async ([src, keys]) => {
    const mod = await import(src + '/core/graph/graph.js');
    const idmod = await import(src + '/core/graph/identity.js');
    const keyOf = (s) => s.ref.key || s.ref.id;
    const pick = (all) => (all.sessions || []).filter((s) => keys.includes(keyOf(s)))
        .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
    const partsOf = async (sessions) => {
        const out = [];
        for (const s of sessions) {
            const chain = [];
            for (let i = 0; i < s.messages.length; i++) {
                chain.push(idmod.nodeIdOf(i + 1, await idmod.contentKeyOf(s.messages[i])));
            }
            out.push({
                ref: s.ref.id || s.ref.key,
                rows: s.messages.length,
                integrity: s.header?.chat_metadata?.integrity ?? null,
                chain: chain.join(',').slice(0, 28),
            });
        }
        return out;
    };

    const disk1 = await window.__cfsysGraphSrc.graphInputs();
    const inputs = { sessions: pick(disk1), ...(disk1.branches ? { branches: disk1.branches } : {}) };
    const before = await partsOf(inputs.sessions);
    const first = await mod.buildGraph(inputs, { log: () => {} });
    const second = await mod.buildGraph(inputs, { prev: first, log: () => {} });
    const after = await partsOf(inputs.sessions);

    const later = await partsOf(pick(await window.__cfsysGraphSrc.graphInputs()));
    return {
        nodes: second.graph.nodes.length,
        firstChanged: first.changed,
        secondChanged: second.changed,
        firstDigest: first.digest,
        secondDigest: second.digest,
        sameDigest: second.digest === first.digest,
        reused: second.graph === first.graph,
        before, after,
        partsSame: JSON.stringify(before) === JSON.stringify(after),
        later,
        diskChanged: JSON.stringify(before) !== JSON.stringify(later),
    };
}"""

# 页内**参照实现**（独立循环，只用身份原语）：按 (层号, 内容指纹) 从原始会话去重出 id 集合。
# 它跟 buildGraph 是两条独立写法的路径 —— 逐一比对才说明「没多也没少」。
REFERENCE_JS = """async ([src, keys]) => {
    const id = await import(src + '/core/graph/identity.js');
    const all = await window.__cfsysGraphSrc.graphInputs();
    const picked = all.sessions.filter(s => keys.includes(s.ref.key || s.ref.id));
    const ids = new Set();
    const perSession = {};
    for (const s of picked) {
        const list = [];
        for (let i = 0; i < s.messages.length; i++) {
            const key = await id.contentKeyOf(s.messages[i]);
            const nodeId = id.nodeIdOf(i + 1, key);
            ids.add(nodeId);
            list.push(nodeId);
        }
        perSession[s.ref.key || s.ref.id] = list;
    }
    return { ids: [...ids].sort(), perSession };
}"""

# 宿主原生「创建分支」在磁盘上留下的那份派生文件：**前两层逐字复制 + 第三层换个正文**
# （等价于 bookmarks.createBranch 的落盘结果；直接经宿主 save 端点建，避开弹窗与 UI 竞态）。
# 走 `window.__preSeamFetch`（装接缝之前抓到的那条原生通道）——本用例只要磁盘上**真**多一个
# 文件，不想让任何接缝逻辑参与这次写入。
MAKE_BRANCH_FILE_JS = """async ([fn, tail]) => {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    const chat = [
        { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
        ...(ctx.chat || []).slice(0, 2),
        { ...(ctx.chat || [])[2], mes: tail },
    ];
    const f = window.__preSeamFetch || globalThis.fetch;
    const res = await f('/api/chats/save', {
        method: 'POST', headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: fn, file_name: fn, avatar_url: char.avatar, chat, force: true }),
    });
    return res.ok;
}"""

PROBE = '__cb_e2e_gb'
TAIL = '分支文件上的第三条：这条正文与父会话不同。'


def poll(fn, timeout=30.0, interval=0.8, desc=""):
    """轮询直到 fn() 真值（宿主高负载下固定 sleep 不可靠）。"""
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    print(f"  [warn] 轮询超时（{desc}）last={str(last)[:200]}")
    return last


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "graph-build")
        try:
            r.boot()
            r.delete_test_char()
            r.settle(600)
            if r.create_test_char().get("status") != 200:
                print("[skip] 测试角色创建失败（登录墙？）")
                return 1
            r.open_test_char()
            r.settle(1500)
            # 本用例走 off（文件源读磁盘事实）：库模式下列不出只在磁盘上的原生分支文件
            if r.js("() => SillyTavern.getContext().extensionSettings?.chatfilesys?.storage_mode ?? null") != 'off':
                r.set_storage_mode('off')
                r.close_popup()
            r.js(SAVE_NATIVE_JS)

            # ---------- 造数据：父会话 3 层 + 一个「前两层复制、第三层不同」的原生分支文件 ----------
            chat_a = r.new_chat()
            r.cmd(f"/send {PROBE}-父会话第二条")
            r.cmd(f"/send {PROBE}-父会话第三条")
            r.wait_disk(lambda s: len(s.get("bodyTexts") or []) >= 3, desc="父会话三层已落盘")
            key_a = r.chat_key(chat_a)
            branch_file = f"{chat_a} - Branch #1"
            made = r.js(MAKE_BRANCH_FILE_JS, [branch_file, TAIL])
            key_b = r.chat_key(branch_file)
            src_desc = r.js(NEW_SOURCE_JS, [EXT_SRC, True])
            # 关键等待：分支文件写成功 ≠ 枚举看得见 —— 轮询到两份会话都在源里
            inputs = poll(lambda: (lambda g: g if len(g.get("sessions") or []) >= 2
                                   and any(key_b == (s.get("ref") or {}).get("key") for s in g["sessions"])
                                   else None)(r.js(GRAPH_INPUTS_JS)),
                          desc="文件源列出父会话与分支文件")
            assert inputs, "文件源没能列出父会话 + 原生分支文件（后续断言无从谈起）"
            keys = [key_a, key_b]
            by_key = {s["ref"]["key"]: s for s in inputs["sessions"]}
            a_n = len(by_key[key_a]["messages"])
            b_n = len(by_key[key_b]["messages"])

            # ---------- 建图（只取这两份会话：与其它遗留聊天解耦，数量断言才确定） ----------
            built = r.js(BUILD_JS, [EXT_SRC, keys])
            graph = built["graph"]
            node_of = {s["ref"]["key"]: s["nodeIds"] for s in graph["sessions"]}
            node_by_id = {n["id"]: n for n in graph["nodes"]}

            # ---------- ① 公共前缀是共享节点（不是复制） ----------
            a_ids, b_ids = node_of.get(key_a, []), node_of.get(key_b, [])
            prefix_shared = (a_ids[:2] == b_ids[:2]) if min(len(a_ids), len(b_ids)) >= 2 else False
            shared_nodes = [n for n in graph["nodes"] if len(n["sessions"]) > 1]
            shared_keys_ok = all(sorted(n["sessions"]) == sorted(keys) for n in shared_nodes)
            c1 = (len(a_ids) == a_n and len(b_ids) == b_n            # 一份会话一条不丢
                  and prefix_shared                                  # 前两层是**同一串**节点 id
                  and len(shared_nodes) == 2 and shared_keys_ok)     # 这两层各被两份会话共享
            results.append(report("① 公共前缀是共享节点（父会话与分支文件的前两层 = 同一批节点，`sessions` 两条）", c1,
                                  f"分支文件已建盘={made}；父会话 {a_n} 层 / 分支文件 {b_n} 层；共享节点 {len(shared_nodes)} 个"
                                  f"（sessions 均 = {sorted(keys)[0][:14]}… 两份）；前两层 id 相同={prefix_shared} "
                                  f"逐会话节点数对得上={len(a_ids) == a_n and len(b_ids) == b_n}"))

            # ---------- ② 分支点有多个后继 ----------
            # 分叉点 = 共享前缀的末节点（第 2 层）：出边 2 条，一条通向父会话的第 3 层、一条通向分支文件的
            fork_id = a_ids[1] if len(a_ids) >= 2 else None
            kids = r.js("""async ([src, id]) => {
                const m = await import(src + '/core/graph/graph.js');
                return m.childrenOf(window.__cfsysPrevGraph, id);
            }""", [EXT_SRC, fork_id]) if fork_id else []
            kids = kids or []
            want_kids = {a_ids[2], b_ids[2]} if len(a_ids) >= 3 and len(b_ids) >= 3 else set()
            c2 = (fork_id is not None and len(kids) >= 2 and len(set(kids)) == len(kids)
                  and set(kids) == want_kids                              # 两条后继正是两份会话各自的第 3 层
                  and len(want_kids) == 2)                                # 而它们**不是**同一个节点（内容不同）
            results.append(report("② 分支点有多个后继（共享前缀末节点出边 2 条，分别通向两份会话的第 3 层）", c2,
                                  f"分叉点={str(fork_id)[:22]}… 后继={len(kids)} 条 "
                                  f"命中两份第 3 层={len(want_kids) == 2 and set(kids) == want_kids} "
                                  f"第 3 层不是同一节点={len(want_kids) == 2}"))

            # ---------- ③ 节点数 = 消息按 (层号, 内容) 去重后的数量 ----------
            # 期望值**从构造推出**：层 1 共享 1 个、层 2 共享 1 个、层 3 两份内容不同 2 个 = 4
            expected_structural = 4
            ref = r.js(REFERENCE_JS, [EXT_SRC, keys])
            graph_ids = sorted(node_by_id.keys())
            c3 = (len(graph["nodes"]) == expected_structural
                  and graph_ids == ref["ids"]                       # 与独立参照实现逐一相等（不多不少）
                  and all(ref["perSession"][k] == node_of.get(k) for k in keys))
            results.append(report("③ 节点数 = 消息按 (层号, 内容) 去重后的数量（= 构造推出的 4；与页内参照实现逐一相等）", c3,
                                  f"节点数={len(graph['nodes'])} 期望={expected_structural} "
                                  f"参照集合相等={graph_ids == ref['ids']} 逐会话节点序列相等="
                                  f"{all(ref['perSession'][k] == node_of.get(k) for k in keys)}"))

            # ---------- ④-a 增量失效真读：**冻住输入**（同一个 inputs 对象建两次） ----------
            # 判性质先说清：`buildGraph` 的 digest 路径是它输入的纯函数（`canonicalOf` 把逐会话分项
            # 排序后 JSON → 过一次 sha256，没有时钟、没有随机、不掺会话枚举顺序），故「同一个对象
            # 建两次得到不同 digest」= 产品缺陷（性质①）；而「两次**读盘**之间输入真变了」= ②。
            # 原写法（读盘两遍）分不清这两者，故这里冻住输入。若仍红，页内带回的分项就是判因证据。
            twice = r.js(BUILD_TWICE_JS, [EXT_SRC, keys])
            c4a = (twice["firstChanged"] is True         # 没有 prev → 必须报「变了」（防「恒报没变」的假绿）
                   and twice["partsSame"] is True         # 同一个 inputs 对象，两段之间没被动过
                   and twice["secondChanged"] is False    # 同一份输入 → 判定「没变」
                   and twice["sameDigest"] is True        # digest 相同
                   and twice["reused"] is True)           # 且是真复用同一个图对象
            results.append(report("④-a 增量失效真读：同一份输入（同一个 inputs 对象）建两次 → changed:false、digest 相同、复用同一图对象", c4a,
                                  f"分项前后一致={twice['partsSame']} 第二次 changed={twice['secondChanged']} "
                                  f"digest 相同={twice['sameDigest']} 复用同一对象={twice['reused']} "
                                  f"节点数={twice['nodes']}（上一次 changed={twice['firstChanged']}）"))
            print(f"  [info] ④ 判因：冻住的那份逐会话分项（ref/行数/integrity/节点序列摘要）={twice['before']}")
            print(f"  [info] ④ 判因：另一次**真读盘**的分项={twice['later']}"
                  f"（与冻住的那份不同={twice['diskChanged']}；True = 两次读盘之间输入真变了 = 性质②）")
            print(f"  [info] ④ 判因：digest 冻住第一次={twice['firstDigest'][:16]}… "
                  f"第二次={twice['secondDigest'][:16]}…")

            # ---------- ④-b 真写一条落盘 → 重新读盘 → 必须判「变了」 ----------
            r.cmd(f"/send {PROBE}-父会话第四条")                      # 父会话真变一条
            r.wait_disk(lambda s: len(s.get("bodyTexts") or []) >= 4, desc="第四条已落盘")
            after_send = r.js(BUILD_JS, [EXT_SRC, keys])
            c4b = (after_send["changed"] is True and after_send["digest"] != built["digest"]
                   and after_send["reused"] is False
                   and len(after_send["graph"]["nodes"]) == 5)         # 多出来的是新写的那一条
            results.append(report("④-b 增量失效真读：发一条新消息落盘后再建 → changed:true、digest 变、不复用旧图", c4b,
                                  f"changed={after_send['changed']} digest变={after_send['digest'] != built['digest']} "
                                  f"复用同一对象={after_send['reused']} "
                                  f"节点数={len(after_send['graph']['nodes'])}（期望 5）"))

            # ---------- ⑤ 全量图（含其它遗留会话）里这两份照样共享 ----------
            full = r.js(BUILD_JS, [EXT_SRC, None])
            full_shared = [n for n in full["graph"]["nodes"]
                           if set(n["sessions"]) >= set(keys)]
            c5 = len(full["graph"]["nodes"]) >= 5 and len(full_shared) == 2
            results.append(report("⑤ 与其它会话混在一起建图时，这两份的共享关系照旧（多会话不干扰身份）", c5,
                                  f"全量节点数={len(full['graph']['nodes'])} 同属两份会话的节点={len(full_shared)}（期望 2）"))

            errs = r.pageerrors_from('chatfilesys')                  # 归因单点 = harness（不自己重写）
            ce = r.console_errors_from("chatfilesys")
            results.append(report("⑥ 全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))
            print(f"  [info] 文件源自述={src_desc}")
            print(f"  [info] 建图 notes={built['notes']}")
            return 0 if all(results) else 1
        except Exception:
            import traceback
            traceback.print_exc()
            return 1
        finally:
            try:
                r.js("() => { window.__cfsysGraphSrc = null; window.__cfsysGraphCache = null; window.__cfsysPrevGraph = null; }")
            except Exception:
                pass
            try:
                r.set_storage_mode('off')
            except Exception as e:
                print(f"  [warn] 恢复存储模式失败（实例可能留在库模式）: {e}")
            try:
                r.delete_test_char()
            except Exception:
                pass
            try:
                r.set_import_prompt({"never": False, "mutedKeys": []})
            except Exception:
                pass
            b.close()


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nGRAPH BUILD " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
