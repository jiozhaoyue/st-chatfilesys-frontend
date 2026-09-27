"""四宿主登记表 —— 跨宿主兼容测试的**单一事实源**。

用户 2026-09-27 令：「4 种酒馆都要自动化测试，保证兼容（只要 4 个实例就好）」。
四个 Dev 实例：SillyTavern / Luker / PureTavern / TauriTavern。

**为什么要有这张表**：四个宿主共用同一套 SillyTavern 兼容 API，但**启动方式、协议、
数据目录、就绪信号各不相同**。把这些差异散在用例里，就会变成「每个用例自己判断一遍宿主」
——加一个宿主就要改一遍所有用例（L0-9 的同形问题：宿主差异只许进桥接层）。
这里的 `Host` 就是测试侧的桥接层。

**纪律**：
- 只连 `Instance/Dev/**`（L0-13 / P-11：Real 只差一个端口号，误连不可逆）
- 每个宿主跑之前**串行独占**（同一实例并发驱动会互相污染，2026-09-26 已两次实证）
- 插件同步只写目标宿主的 third-party 扩展目录；**绝不写宿主源码**
"""

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# 插件源（本仓）
REPO = Path(__file__).resolve().parents[2]
PLUGIN_SRC = REPO / "public" / "scripts" / "extensions" / "third-party" / "chatfilesys"

# 实例根
INSTANCE_DEV = Path(r"D:\Repo\Tavern-repo\Instance\Dev")

# TauriTavern 的数据**不在仓里**（桌面应用把 data 放用户目录）
TT_DATA = Path(os.environ.get("APPDATA", "")) / "com.tauritavern.client" / "data" / "default-user"

# 扩展在宿主里的 URL 前缀（四宿主一致——这是 ST 兼容面的一部分）
EXT_URL = "/scripts/extensions/third-party/chatfilesys"
ENTRY = "#chatfilesys-entry"


@dataclass
class Host:
    key: str
    label: str
    base: str
    scheme: str                       # 'http' | 'https'
    ext_dir: Path | None              # 插件同步目标；None = 另行处理（见 note）
    note: str = ""
    # 就绪信号：等待到它就说明宿主前端起来了（每个宿主不一样，实测得出）
    ready_selector: str = "#send_textarea"
    wait_ms: int = 15000              # 就绪后再给的稳定期
    pilot: bool = False               # TauriTavern 走 WebView 自动化（tauri-plugin-pilot）
    extra: dict = field(default_factory=dict)


HOSTS: dict[str, Host] = {
    "st": Host(
        key="st", label="SillyTavern",
        base="http://127.0.0.1:8001", scheme="http",
        ext_dir=INSTANCE_DEV / "SillyTavern" / "data" / "default-user" / "extensions",
        note="原版宿主；扩展目录 = data/default-user/extensions/",
    ),
    "luker": Host(
        key="luker", label="Luker",
        base="https://127.0.0.1:8003", scheme="https",
        ext_dir=INSTANCE_DEV / "Luker" / "data" / "default-user" / "extensions",
        note="Luker 深度重写分支；HTTPS + 自签证书；载入扩展多，冷启动到插件就绪实测 ~38s",
        wait_ms=30000,
    ),
    "pt": Host(
        key="pt", label="PureTavern",
        base="http://127.0.0.1:8899", scheme="http",
        ext_dir=None,
        note="Vue/Vite 现代外壳 + legacy ST 前端；**冷启动很慢**（首屏 Vite 转译）；"
             "扩展落点待现场确定（见 probe_host_recon 输出）",
        wait_ms=25000,
    ),
    "tt": Host(
        key="tt", label="TauriTavern",
        base="", scheme="tauri",
        ext_dir=TT_DATA / "extensions",
        note="Rust/Tauri 桌面宿主；用 `pnpm tauri:dev:pilot` 起（tauri-plugin-pilot 提供 WebView 自动化）；"
             "data 住 %APPDATA%/com.tauritavern.client/data/default-user",
        pilot=True,
    ),
}

# 默认跑全部四个；环境变量可只跑一个（排障用）：HOSTS=luker
ONLY = [x for x in (os.environ.get("HOSTS", "").split(",")) if x]
ORDER = ONLY or ["st", "luker", "pt", "tt"]


def host_of(key: str) -> Host:
    return HOSTS[key]


def plugin_version() -> str:
    """插件版本（来自 manifest.json；写进诊断与断言明细）。"""
    import json
    try:
        return json.loads((PLUGIN_SRC / "manifest.json").read_text(encoding="utf-8")).get("display_name", "?")
    except Exception:
        return "?"


def sync_plugin(host: Host) -> tuple[bool, str]:
    """把本仓插件同步到该宿主的扩展目录。

    **为什么必须显式同步**：e2e 驱动的是宿主加载的那份副本，不是本仓的工作区副本；
    不拷就等于在测旧代码（harness 不会替你同步）。
    """
    if host.ext_dir is None:
        return False, "该宿主的扩展落点未确定（见 host.note）"
    try:
        dest = host.ext_dir / "chatfilesys"
        if dest.is_symlink():
            # P-19：指向工作区仓的 junction/symlink 写下去会污染另一个仓——直接拒绝
            return False, f"{dest} 是符号链接/junction，拒绝写入（P-19 链接穿透）"
        shutil.copytree(PLUGIN_SRC, dest, dirs_exist_ok=True)
        return True, f"已同步到 {dest}"
    except Exception as e:            # noqa: BLE001
        return False, f"同步失败：{e}"


def reachable(base: str, timeout: float = 8.0) -> tuple[bool, str]:
    """宿主在不在（HTTP 探测；不依赖 playwright，便于「先看环境再跑用例」）。

    **必须显式禁用代理**：本机设了 `HTTP_PROXY=http://127.0.0.1:7891` 与
    `NO_PROXY=localhost,127.0.0.1`，但 **Windows 上 Python 的 `urllib` 走注册表判旁路、
    不读 `NO_PROXY`** ⇒ 回环请求被塞进代理、一律超时（2026-09-27 实测：curl 通、urllib 全灭，
    看起来像「四个宿主全没起」）。装一个空 `ProxyHandler` 才是可靠的走直连。
    """
    if not base:
        return False, "无 HTTP 端点（桌面宿主）"
    try:
        import urllib.request
        import ssl
        sslctx = ssl.create_default_context()
        sslctx.check_hostname = False
        sslctx.verify_mode = ssl.CERT_NONE
        # 空 dict = 不用任何代理（绕开上面那段 Windows 行为差异）
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=sslctx))
        try:
            with opener.open(base + "/", timeout=timeout) as r:
                return True, f"HTTP {r.status}"
        except urllib.error.HTTPError as he:
            # **302 也是「活着」**：Luker 未登录时把 `/` 重定向到登录页，而登录页又重定向回来
            # ⇒ urllib 报「redirect loop」。把它当成「宿主在响」而不是「连不上」
            # （2026-09-27 实测：Luker 因此被误判成「没起」，用例整段跳过）。
            if 300 <= he.code < 400:
                return True, f"HTTP {he.code}（重定向到登录页 = 宿主在响）"
            return True, f"HTTP {he.code}（宿主在响，非 2xx）"
    except Exception as e:            # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def start_hint(host: Host) -> str:
    """该宿主的启动命令（**只打印，不代跑**——起服务是人的决定，且各有前置）。"""
    d = INSTANCE_DEV / {"st": "SillyTavern", "luker": "Luker", "pt": "PureTavern",
                        "tt": "TauriTavern"}[host.key]
    if host.key == "tt":
        return f'cd "{d}" && pnpm tauri:dev:pilot'
    if host.key == "pt":
        return f'cd "{d}" && pnpm dev      # Vite dev server（端口 8899，strictPort）'
    return f'cd "{d}" && NODE_ENV=production node server.js'


def recon() -> int:
    """环境体检：四个宿主各自「在不在 / 插件能不能同步 / 启动命令」。

    它**不改任何东西**（只读 + 打印）。跑用例之前先跑它，能避免把「环境没起」误判成
    「用例失败」——那是本仓反复踩过的一类假红。
    """
    print(f"插件源：{PLUGIN_SRC}")
    print(f"插件：{plugin_version()}\n")
    ok_all = True
    for key in ORDER:
        h = host_of(key)
        up, how = reachable(h.base)
        sync_ok, sync_msg = (False, "未尝试") if not up else (None, "")
        if up:
            try:
                sync_ok, sync_msg = sync_plugin(h)
            except Exception as e:    # noqa: BLE001
                sync_ok, sync_msg = False, str(e)
        mark = "✅" if up else "❌"
        print(f"{mark} {h.label:<12} {h.base or '(桌面宿主)':<26} {how}")
        if up and sync_ok is not None:
            print(f"     同步：{'✅' if sync_ok else '❌'} {sync_msg}")
        print(f"     注意：{h.note}")
        if not up:
            print(f"     启动：{start_hint(h)}")
            ok_all = False
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(recon())
