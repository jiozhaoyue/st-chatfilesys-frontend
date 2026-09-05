# ChatFilesys — 聊天文件系统（SillyTavern / Luker 前端扩展）

> 接管酒馆的聊天文件系统：真正的楼层分支、SVG 分支树、零复制切换、纯标准 JSONL 导出——全部作为**一个前端扩展**实现，零核心修改。

ChatFilesys 是一个 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（及 Luker 分支）的第三方前端扩展，把「分支」从整文件复制变成聊天文件内的结构化数据组织方式：

- **零复制分叉**：分支只存增量（Swipe 组路径），共享前缀永远只有一份——百层聊天分叉不翻倍体积
- **零网络切换**：切换分支 = 前端内存折叠/展开，一个聊天文件内完成，不切文件、不刷新页面
- **可视化**：管理弹窗内 SVG 图形化分支树（缩放/拖拽/点击切换）+ 消息流内分叉点 ⎇ 标记 + 输入框上方分支徽章
- **原生兼容**：元数据惰性存于 `chat_metadata.extensions.chatfilesys`，vanilla SillyTavern 完全不解析、不破坏；任何时刻可导出剥离分支元数据的纯标准 JSONL
- **收编原生书签**：原生「检查点/书签」创建的复制文件可一键收编为楼层分支（零复制）并清理死引用

## 安装

把 `public/scripts/extensions/third-party/chatfilesys/` 整个目录复制到实例的 `data/<user-handle>/extensions/chatfilesys/`，重启服务后在扩展设置中启用。

- 全局入口：扩展设置页「打开管理面板」按钮 / 斜杠命令 `/cb` / 快捷键 **Alt+B**
- 消息旁：每条消息旁的 ⎇ 按钮一键直分叉（自动创建、自动切换、自动命名「分支N」）

## 工作原理

```
聊天文件（.jsonl）
├── 第 1 行 header.chat_metadata.extensions.chatfilesys   ← 分支树模型（惰性元数据）
│     { active_branch, branches:[{ id, name, fork_base, path }], groups:{ 折叠组 } }
└── 第 2 行起 = 活跃分支的楼层线性序列（body 投影）
```

- **楼层（Floor）**：一条消息一层，全局编号；**Swipe 组（Group）**：楼层内变体集合；**分支**：从分叉点起的组路径
- 分支切换/删层由投影层（`core/projection.js`）diff 出 RFC6902 操作，经写路径适配层（`core/chat-writer.js`）映射为**官方消息 API**（`deleteMessages`/`addMessages`/`updateMessages`）批量执行；元数据随官方持久化自动同车落盘
- 事实源永远在服务器聊天文件；浏览器不做任何持久化副本

更完整的设计文档见 [`system-blueprint.html`](system-blueprint.html)（决策蓝图）与 [`backend-plugin-spec.md`](backend-plugin-spec.md)（三期后端插件种子规格，另立仓库）。

## 开发与测试

```bash
# 数据层单测（node:test，直接 import 扩展源码）
node --test tests/branches/*.test.mjs

# e2e（Playwright 驱动宿主真实实例 https://127.0.0.1:8003/，测试角色前缀 __cb_e2e，自动清理）
pip install playwright && python -m playwright install chromium
python tests/e2e/smoke.py               # 冒烟
python tests/e2e/test_deletes.py        # 删层/删分支
python tests/e2e/test_conflict.py       # 并发/冲突收敛
python tests/e2e/test_adopt_export.py   # 收编/导出/自动导出
python tests/e2e/test_acceptance.py     # 一期验收回归
python tests/e2e/test_acceptance_p2.py  # 二期验收（PRD 11 条）
python tests/e2e/test_perf.py           # 百层性能
python tests/e2e/test_visual.py         # 截图（人工审查）
```

e2e 依赖本地 Luker 实例（默认 `https://127.0.0.1:8003`，可在 `tests/e2e/harness.py` 改 `BASE`）。`demo/` 目录是 UI 交互基准（静态 HTML，可直接打开）。

## 路线图

- ✅ 一期：分支数据层 + 写路径 + 原生书签收编 + 增量导出
- ✅ 二期：UI 重构（管理弹窗 + 消息旁轻量注入）+ SVG 分支树 + 写路径迁移官方消息 API
- ⬜ 三期：数据库模式（后端插件另立仓库，见 `backend-plugin-spec.md`）
- ⬜ 四期：增强 JSONL 操作 + 跨聊天家族 + 归档迁移

## License

[AGPL-3.0](LICENSE)——与 SillyTavern 上游一致。
