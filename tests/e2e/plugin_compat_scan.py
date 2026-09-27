"""实例插件兼容盘点 —— 「依赖聊天数据的插件在纯库模式下会不会坏」的**体检器**。

用户 2026-09-27 令：「看实例里的插件，也要做适配，也要使他们正常（总结出一整套规律、方法论，
为之后不断增加依赖 jsonl 的插件都要正常）」。

本脚本 = 那套方法论的**执行部分**：静态扫描实例里的第三方扩展，按「它怎么碰聊天数据」分类，
给出每一类的处置与理由。它**只读**（不改任何插件、不连实例），可在任何时候重跑。

── 为什么要分类而不是逐个看 ──
插件有几十个且会不断增加；逐个读源码不可持续。而**决定兼容性的只有一件事**：
「这份数据它是从哪拿的」。渠道一共就几种，每种在纯库模式下的命运是**确定的**（见 CLASSES）。
于是新插件进来只要问一句「你走哪个渠道」，就有答案。

用法：
    PYTHONIOENCODING=utf-8 python tests/e2e/plugin_compat_scan.py            # Luker Dev（默认）
    PYTHONIOENCODING=utf-8 python tests/e2e/plugin_compat_scan.py st         # SillyTavern Dev
    PYTHONIOENCODING=utf-8 python tests/e2e/plugin_compat_scan.py st --json  # 机器可读
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hosts import HOSTS  # noqa: E402

# 跳过扫描的目录（依赖/构建产物；不是插件源码）
SKIP_DIRS = {"node_modules", "dist", "build", ".git", "vendor", "__pycache__", "lib"}
# 只看这些后缀
CODE_EXT = {".js", ".mjs", ".ts", ".jsx", ".tsx", ".vue", ".svelte"}

# ── 渠道正则（每条 = 一种「它怎么碰聊天数据」） ──
# 顺序有意义：**先匹配到的渠道优先**（更具体的在前）
CHANNELS = [
    ("raw-jsonl-endpoint", "直读聊天文件端点", re.compile(
        r"/api/chats/(get|search|save|delete|rename|export|import)"
        r"|/api/characters/chats|/api/chats\.json|file_name\s*\+?\s*['\"]\.jsonl")),
    ("host-api", "走宿主消息/元数据 API", re.compile(
        r"\b(addMessages|deleteMessages|updateMessages|saveChat|saveChatDebounced|saveMetadata"
        r"|reloadCurrentChat|clearChat|printMessages|generateQuietPrompt|generateRaw)\b")),
    ("ctx-chat-direct", "直接读写 ctx.chat / chat_metadata", re.compile(
        r"\bchat_metadata\b|\bchatMetadata\b|getContext\(\)\s*\.chat\b|ctx\.chat\b|\bcontext\.chat\b")),
    ("own-backend", "走自己的后端 / 独立存储", re.compile(
        r"/api/plugins/|/api/backends/|localStorage|indexedDB|IDBDatabase|chrome\.storage")),
]

# ── 五类处置（方法论的核心；每类都写清「为什么」与「怎么办」） ──
CLASSES = {
    "raw-jsonl": {
        "label": "① 直读聊天文件（**最需要适配**）",
        "why": "纯库模式下内容只住库、磁盘 jsonl 可能已删；而宿主端点 `/api/chats/get` 被接缝接管后，"
               "返回的是「**本键所在分支的投影**」而不是整份文件。这类插件会读少、读错或读空。",
        "what": "接缝已为它服务（拿到投影，通常比它自己解析文件更准）；若它绕开端点直接读磁盘路径，"
                "则会读不到。**判据**：它在纯库模式下报「读取失败/空聊天」而库里有内容。",
        "fix": "优先让它走宿主端点（多数插件本就如此，无需改）；确实直读磁盘的，走本插件的导出面"
               "（把库落成标准 jsonl 再让它读）或改用双写模式。",
    },
    "host-api": {
        "label": "② 走宿主消息 API（**天然兼容**）",
        "why": "宿主 API 最终都走 fetch 到那几个聊天端点，**已在接缝的 9 条路由内**——写路径会被转写进库。",
        "what": "无需适配。",
        "fix": "无。",
    },
    "ctx-direct": {
        "label": "③ 直接改 ctx.chat / chat_metadata",
        "why": "内存里的对象与库是**同一份投影的两面**；它改内存后由宿主保存（走接缝回库）。"
               "风险点只有一个：它往 `chat_metadata` 里写的键会不会与我们的模型打架。",
        "what": "本插件只自管 `chat_metadata.extensions.chatfilesys` 与 `integrity` 两项，其余键**整份保留**"
                "（`core/chat-meta.js` 的合并语义）。故共存通常无问题。",
        "fix": "无。若发现某插件也写 `extensions.chatfilesys`，那是**键名冲突**，需改名或协商。",
    },
    "own-backend": {
        "label": "④ 走自己的后端 / 浏览器存储（**无关**）",
        "why": "数据本来就不在聊天文件里。",
        "what": "与本插件无交集。",
        "fix": "无。",
    },
    "unknown": {
        "label": "⑤ 扫描不到相关调用（**待人工判断**）",
        "why": "静态扫描看不到（可能是动态拼接的端点、或压缩过的产物）。",
        "what": "不能因「扫不到」就断定兼容。",
        "fix": "真机跑一次它，看纯库模式下是否有异常；把它加进真机体检清单。",
    },
}

# 本插件自己的键（用于检出「键名冲突」）
OUR_KEYS = re.compile(r"extensions\.chatfilesys|\bchatfilesys\b")


def iter_source_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if Path(fn).suffix.lower() in CODE_EXT:
                yield Path(dirpath) / fn


def scan_plugin(root: Path) -> dict:
    """扫一个插件目录 → 渠道命中与证据。"""
    hits = {k: [] for k, _l, _r in CHANNELS}
    conflicts = []
    total_bytes = 0
    files = 0
    for f in iter_source_files(root):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:            # noqa: BLE001
            continue
        files += 1
        total_bytes += len(text)
        rel = str(f.relative_to(root))
        for key, _label, rx in CHANNELS:
            m = rx.search(text)
            if m:
                hits[key].append(f"{rel}: {m.group(0)[:40]}")
        if OUR_KEYS.search(text):
            conflicts.append(rel)
    # 渠道优先序 = CHANNELS 的声明顺序（更具体的在前）
    primary = next((k for k, _l, _r in CHANNELS if hits[k]), "unknown")
    return {
        "files": files,
        "bytes": total_bytes,
        "channels": {k: v[:3] for k, v in hits.items() if v},
        "primary": primary,
        "touchesOurKeys": sorted(set(conflicts))[:5],
    }


CLASS_OF_CHANNEL = {
    "raw-jsonl-endpoint": "raw-jsonl",
    "host-api": "host-api",
    "ctx-chat-direct": "ctx-direct",
    "own-backend": "own-backend",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("host", nargs="?", default="luker", choices=list(HOSTS.keys()))
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    ap.add_argument("--limit", type=int, default=0, help="只扫前 N 个（排障用）")
    args = ap.parse_args()

    host = HOSTS[args.host]
    base = host.ext_dir
    if base is None:
        print(f"{host.label} 的扩展目录未知（该宿主不扫目录）")
        return 2
    if not base.is_dir():
        print(f"扩展目录不存在：{base}")
        return 2

    plugins = sorted([p for p in base.iterdir() if p.is_dir()])
    if args.limit:
        plugins = plugins[:args.limit]

    report = []
    for p in plugins:
        if p.is_symlink():
            report.append({"name": p.name, "kind": "symlink->" + os.readlink(p), "skipped": True,
                           "note": "符号链接：指向工作区仓，**不扫也不写**（P-19 链接穿透）"})
            continue
        info = scan_plugin(p)
        info["name"] = p.name
        info["kind"] = "plugin"
        report.append(info)

    if args.json:
        print(json.dumps({"host": host.key, "dir": str(base), "plugins": report,
                          "classes": {k: v["label"] for k, v in CLASSES.items()}},
                         ensure_ascii=False, indent=1))
        return 0

    print(f"宿主：{host.label}　扩展目录：{base}")
    print(f"共 {len(report)} 个条目\n")
    buckets = {}
    for r in report:
        if r.get("skipped"):
            buckets.setdefault("skipped", []).append(r)
            continue
        cls = CLASS_OF_CHANNEL.get(r["primary"], "unknown")
        buckets.setdefault(cls, []).append(r)

    order = ["raw-jsonl", "host-api", "ctx-direct", "own-backend", "unknown", "skipped"]
    for cls in order:
        items = buckets.get(cls, [])
        if not items:
            continue
        meta = CLASSES.get(cls, {"label": "⏭ 符号链接（跳过）", "why": "", "what": "", "fix": ""})
        print(f"── {meta['label']}（{len(items)} 个）")
        if meta.get("why"):
            print(f"   为什么：{meta['why']}")
            print(f"   结论  ：{meta['what']}")
            print(f"   怎么办：{meta['fix']}")
        for r in items:
            ev = "; ".join(next(iter(r.get("channels", {}).values()), []))[:70] if r.get("channels") else r.get("note", "")
            flag = "  ⚠ 碰到我们的键" if r.get("touchesOurKeys") else ""
            print(f"     · {r['name']:<34} {ev}{flag}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
