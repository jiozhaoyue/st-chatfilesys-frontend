"""ChatFilesys 布局服务 e2e（B3 / AC2）

断言：
  ① 布局出坐标：千节点图能算出坐标，尺寸合理（真 dagre，不是空壳）
  ② **确实在 worker 里算**（`via === 'worker'`）——这是**本仓对 TL 那个坑的守卫**：
     TL 用 module worker 却调 `importScripts` → 每次都抛 → 静默退回主线程，布局从未真正在 worker 里跑过
     而没人知道（`research/TL-1-engine.md` 有实测证据）。我们把它变成可断言的事实。
  ③ **主线程没被卡住**：布局期间主线程帧间隔的最大值远小于布局总耗时（用 rAF 采样）
     —— 若布局跑在主线程，最大帧间隔会≈布局总耗时
  ④ 降级可用：worker 不可用时退回主线程且如实报告（`via === 'main'`），不抛
  ⑤ 全程零 chatfilesys 归因报错
  ⑥ **回落不留白**：真机上这张千节点链**确实撑不住 dagre**（递归 dfs 爆栈）→ 走迭代分层兜底，
     此时必须能说出**为什么**（`degraded.reason`）——第一版就是 kind=layered 而原因丢失（R6）

为什么能量化「主线程卡不卡」：worker 路径下主线程只等消息，rAF 照常跑；
主线程路径下 dagre 的计算会独占主线程，rAF 被饿住 → 最大帧间隔≈计算耗时。这是**判别性**指标。

依赖：Dev Luker 8003 在跑 + 扩展已同步到实例 `data/default-user/extensions/chatfilesys/`。
用法: PYTHONIOENCODING=utf-8 python tests/e2e/test_graph_layout.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harness import Runner, browser_ctx, report, EXT_SRC  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

results = []

# 页内：加载 dagre（经典脚本，挂 self.dagre）→ 建服务 → 合成千节点图 → 采样主线程帧间隔 → 布局 → 报数
PROBE_JS = """async ([extSrc, nodeCount]) => {
    const out = { steps: [] };
    const log = (m) => out.steps.push(m);

    // ① dagre 以经典脚本加载（与 worker 内的 UMD 分支同一支）
    const loadScript = (src) => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = () => res(true); s.onerror = () => rej(new Error('script 加载失败: ' + src));
        document.head.appendChild(s);
    });
    await loadScript(extSrc + '/vendor/dagre.js');
    out.dagreKeys = Object.keys(self.dagre || {});

    const { createLayoutService } = await import(extSrc + '/core/graph/layout-service.js');

    // ② 合成一张 nodeCount 节点的链式+分叉图（确定性构造，不依赖任何聊天数据）
    const nodes = [];
    const edges = [];
    for (let i = 0; i < nodeCount; i++) nodes.push({ id: `n${i}` });
    for (let i = 0; i < nodeCount - 1; i++) edges.push({ from: `n${i}`, to: `n${i + 1}` });
    for (let i = 0; i < nodeCount - 4; i += 50) edges.push({ from: `n${i}`, to: `n${i + 3}` });   // 造些分叉
    const graph = { nodes, edges };
    out.nodes = nodes.length; out.edges = edges.length;

    // ③ rAF 采样：记录布局期间主线程帧间隔的最大值
    const frameGaps = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
        const now = performance.now();
        frameGaps.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const workerUrl = new URL(extSrc + '/core/graph/layout.worker.js', location.origin).href;
    const svc = createLayoutService({ workerUrl });
    const t0 = performance.now();
    const r = await svc.layout(graph, { direction: 'TB' });
    const t1 = performance.now();
    running = false;
    await new Promise((res) => setTimeout(res, 120));      // 让最后一帧落下来

    out.via = r ? r.via : null;
    out.kind = r ? r.kind : null;
    out.degraded = r ? (r.degraded ?? null) : null;
    out.ms = Math.round(t1 - t0);
    out.posCount = r ? Object.keys(r.positions).length : 0;
    out.size = r ? [Math.round(r.width), Math.round(r.height)] : null;
    out.maxGap = frameGaps.length ? Math.round(Math.max(...frameGaps)) : null;
    out.frames = frameGaps.length;
    out.desc = svc.describe();
    // 抽两个点验「真算出层次」：TB 下 n10 应在 n0 下方
    out.sane = Boolean(r && r.positions.n0 && r.positions.n10 && r.positions.n10.y > r.positions.n0.y);

    // ④ 降级：worker 地址给错 → 必须退回主线程并如实报告
    const bad = createLayoutService({ workerUrl: new URL('does-not-exist.worker.js', location.href).href, timeoutMs: 3000 });
    const rb = await bad.layout(graph, { direction: 'TB' });
    out.fallbackVia = rb ? rb.via : null;
    out.fallbackPos = rb ? Object.keys(rb.positions).length : 0;
    bad.dispose();
    svc.dispose();

    out.ok = true;
    return out;
}"""


def main():
    with sync_playwright() as p:
        b, c = browser_ctx(p)
        r = Runner(c.new_page(), "graph-layout")
        try:
            r.boot()
            N = 1000
            res = r.js(PROBE_JS, [EXT_SRC, N])
            print("\n".join(res.get("steps", [])))
            print(f"  事实：节点={res.get('nodes')} 边={res.get('edges')} via={res.get('via')} kind={res.get('kind')} "
                  f"布局耗时={res.get('ms')}ms 主线程最大帧间隔={res.get('maxGap')}ms 帧数={res.get('frames')} "
                  f"坐标数={res.get('posCount')} 尺寸={res.get('size')}")
            print(f"  降级原因={res.get('degraded')}")
            print(f"  服务自述={res.get('desc')} 降级：via={res.get('fallbackVia')} 坐标数={res.get('fallbackPos')}")
            print(f"  dagre 键={res.get('dagreKeys')}")

            ok1 = (res.get("posCount") == N and res.get("size") and res["size"][0] > 0 and res.get("sane"))
            results.append(report(f"① 千节点图算出坐标（{N} 个节点、真 dagre、层次正确）", bool(ok1),
                                  f"坐标数={res.get('posCount')}/{N} 尺寸={res.get('size')} 层次正确={res.get('sane')}"))

            ok2 = res.get("via") == 'worker'
            results.append(report("② **确实在 worker 里算**（via=worker；TL 的坑是它静默退回主线程）", ok2,
                                  f"via={res.get('via')} 自述={res.get('desc')}"))

            # ③ 主线程没被卡住：最大帧间隔应远小于布局总耗时。
            #    判据用「不接近总耗时」而不是绝对毫秒（机器快慢不同）：卡住时 maxGap ≈ ms。
            ms, gap = res.get("ms") or 0, res.get("maxGap")
            ok3 = bool(res.get("via") == 'worker' and gap is not None and ms > 0 and gap < max(50, ms * 0.5))
            results.append(report("③ 布局期间主线程没被卡住（最大帧间隔 << 布局总耗时）", ok3,
                                  f"布局={ms}ms 最大帧间隔={gap}ms 帧数={res.get('frames')}（阈值={max(50, ms * 0.5):.0f}ms）"))

            ok4 = (res.get("fallbackVia") == 'main' and res.get("fallbackPos") == N)
            results.append(report("④ worker 不可用 → 退回主线程且如实报告（不抛、不静默）", ok4,
                                  f"via={res.get('fallbackVia')} 坐标数={res.get('fallbackPos')}/{N}"))

            # ⑥ 回落不留白：若这次走了迭代分层兜底，必须能说出**为什么**（R6）。
            #    不硬断言 kind==='layered'——那取决于引擎栈大小；钉的是**蕴含关系**：
            #    一旦回落，原因不许是空的（真机第一版就是 kind=layered 而原因丢失）。
            kind, deg = res.get("kind"), (res.get("degraded") or {})
            ok6 = (kind != 'layered') or bool(deg.get("reason"))
            results.append(report("⑥ 撑不住回落时如实回报原因（不留白、不静默）", ok6,
                                  f"kind={kind} 回落原因={deg.get('reason') or '(无)'}"))

            errs = [e for e in r.errors if 'chatfilesys' in str(e)]
            ce = r.console_errors_from("chatfilesys")
            results.append(report("⑤ 全程零 chatfilesys 归因报错", len(errs) == 0 and not ce,
                                  f"pageerror={errs[:2]} console={ce[:2]}"))
            return 0 if all(results) else 1
        finally:
            try:
                r.set_storage_mode('off')
            except Exception:
                pass
            try:
                b.close()
            except Exception:
                pass


if __name__ == "__main__":
    code = main()
    ok = bool(results) and all(results) and code == 0
    print("\nGRAPH LAYOUT " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)
