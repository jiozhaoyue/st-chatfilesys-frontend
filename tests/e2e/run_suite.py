"""真机用例串行跑批器 —— **一次跑完、一张汇总表**。

为什么要有它：本仓的真机用例**必须串行**（同一 Dev 实例并发驱动会互相污染，
2026-09-26 已两次实证）。手敲一串命令既容易漏、也看不出「哪一条把实例留在脏状态」。

用法：
    PYTHONIOENCODING=utf-8 python tests/e2e/run_suite.py            # 默认「夜间全套」
    PYTHONIOENCODING=utf-8 python tests/e2e/run_suite.py --only night,ai
    PYTHONIOENCODING=utf-8 python tests/e2e/run_suite.py --list

退出码：全绿 = 0；有失败 = 1。
"""
import argparse
import pathlib
import subprocess
import tempfile
import sys
import time

HERE = pathlib.Path(__file__).parent

# 每条 = (短名, 脚本, 一句话说明)
SUITE: list[tuple[str, str, str]] = [
    ("db", "test_pure_db_full_journey.py", "纯库模式全旅程（拦截读→渲染→拦截写→库一致→版本号闭环）"),
    ("night", "test_night_features.py", "设置中枢 / 错误面 / 分支合并"),
    ("ai", "test_real_data_ai.py", "真实长聊天导入 + AI 链路 + 可调参数真生效"),
    ("graph", "test_graph_view.py", "结构图（B1→B2→B3→B4 整链 + 共享前缀 + 布局路径）"),
    ("ui", "test_ui_placement.py", "界面落点白名单（聊天区零注入、入口在工具排）"),
    ("main", "test_main_branch.py", "主分支不变量与切换"),
    ("deletes", "test_deletes.py", "删除与重排（三档投影一致性）"),
    ("takeover", "test_native_branch_checkpoint_takeover.py", "原生分支/检查点接管"),
    ("mirror", "test_mirror_mode.py", "双写模式（库为准 + 落标准文件）"),
    ("swipe", "test_swipe_versions.py", "每层版本管理（T7）"),
    ("compat", "test_host_compat.py", "四宿主兼容（ST / Luker / PT；串行）"),
    ("tt", "test_host_compat_tt.py", "TauriTavern 兼容（需 TT 在跑 + tauri-pilot）"),
]

# 默认跑「本轮改动最可能碰坏的那些」——全量太慢，且部分老用例本身有既存问题
DEFAULT = ["db", "night", "graph", "ui", "main"]


def run_one(short: str, script: str, why: str) -> tuple[str, bool, float, str]:
    path = HERE / script
    if not path.is_file():
        return short, False, 0.0, "脚本不存在"
    t0 = time.time()
    print(f"\n{'=' * 70}\n▶ {short} — {why}\n  {script}\n{'=' * 70}", flush=True)
    # **必须把子进程输出写文件，不要用 `capture_output=True`（管道）**：
    # 管道缓冲区满时子进程会**阻塞在写 stdout 上**，而父进程在等它结束 ⇒ 死锁。
    # 2026-09-28 实测：同一条用例单跑 3.5 分钟，经管道跑批却卡了 35 分钟没结束。
    log_path = pathlib.Path(tempfile.gettempdir()) / f"cfsys-suite-{short}.log"
    try:
        with open(log_path, "w", encoding="utf-8", errors="replace") as fh:
            p = subprocess.run([sys.executable, "-u", str(path)], cwd=str(HERE),
                               stdout=fh, stderr=subprocess.STDOUT, timeout=1800)
        out = log_path.read_text(encoding="utf-8", errors="replace")
        rc = p.returncode
    except subprocess.TimeoutExpired:
        out = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        print(out[-4000:], flush=True)
        return short, False, time.time() - t0, "超时（30 分钟）"
    print(out[-6000:], flush=True)
    tail = [ln for ln in out.strip().splitlines() if ln.strip()][-3:]
    ok = rc == 0
    return short, ok, time.time() - t0, " / ".join(tail)[:160]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="逗号分隔的短名（见 --list）")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for s, f, w in SUITE:
            print(f"  {s:<10} {f:<44} {w}")
        print(f"\n默认跑：{','.join(DEFAULT)}")
        return 0

    want = [x for x in (args.only or ",".join(DEFAULT)).split(",") if x]
    picked = [(s, f, w) for (s, f, w) in SUITE if s in want]
    missing = [x for x in want if x not in {s for s, _f, _w in picked}]
    if missing:
        print(f"[warn] 不认识的短名：{missing}（用 --list 看全部）")

    results = []
    for s, f, w in picked:
        results.append(run_one(s, f, w))

    print(f"\n{'=' * 70}\n汇总\n{'=' * 70}")
    for s, ok, secs, note in results:
        print(f"  {'✅' if ok else '❌'} {s:<10} {secs:>7.1f}s  {note}")
    bad = [s for s, ok, _t, _n in results if not ok]
    print(f"\n{'全部通过' if not bad else '失败：' + ', '.join(bad)}（{len(results)} 条）")
    return 0 if results and not bad else 1


if __name__ == "__main__":
    sys.exit(main())
