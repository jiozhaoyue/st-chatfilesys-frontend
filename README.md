# ChatFilesys — 聊天文件系统（SillyTavern / Luker 前端扩展）

> 接管酒馆的聊天文件系统：真正的楼层分支、纯数据库存储（jsonl 仅导出时存在）、fetch 拦截伪装无感、智能合并去重——全部作为**一个前端扩展**实现，零核心修改。

ChatFilesys 是一个 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（及 Luker 分支）的第三方前端扩展，把「分支」从整文件复制变成聊天数据内的结构化组织，把「超大 jsonl 会话文件」变成数据库分片存储：

- **真分支零复制**：分支只存增量（Swipe 组路径），共享前缀永远只有一份——百层聊天分叉不翻倍体积
- **纯数据库模式（重写方向）**：安装后提示「录入数据库并智能合并 → 删除 jsonl（默认删）」；此后 jsonl 只在导出时出现（branch=单 jsonl；家族=zip 包）。三档存储适配器：Authority SQL → 官方通道分片 → IndexedDB 缓存
- **生态无感**：fetch 拦截层把 `/api/chats/*` 读写转接数据库并伪造合规响应；渲染管线、原生按钮接管、其他插件操作全部照常
- **智能合并**：content_hash 指纹对齐——完全相同楼层幂等去重、最长公共前缀对齐为分叉点；跨聊天同层合并消灭文件间重复历史
- **可视化**：SVG 分支树（默认向下、可切右、可缩放拖拽）+ 消息旁 ⎇ 分叉 + 输入框上方分支徽章

## 安装

把 `public/scripts/extensions/third-party/chatfilesys/` 整个目录复制到实例的 `data/<user-handle>/extensions/chatfilesys/`，重启服务后在扩展设置中启用。

- 全局入口：扩展设置页「打开管理面板」按钮 / 斜杠命令 `/cb` / 快捷键 **Alt+B**
- 消息旁：每条消息旁的 ⎇ 按钮一键直分叉（自动创建、自动切换、自动命名「分支N」）

## 工作原理（现交付形态：JSONL 增强模式；纯库模式见路线图）

```
聊天文件（.jsonl）
├── 第 1 行 header.chat_metadata.extensions.chatfilesys   ← 分支树模型（惰性元数据）
│     { active_branch, branches:[{ id, name, fork_base, path }], groups:{ 折叠组 } }
└── 第 2 行起 = 活跃分支的楼层线性序列（body 投影）
```

- **楼层（Floor）**：一条消息一层，全局编号；**Swipe 组（Group）**：楼层内变体集合；**分支**：从分叉点起的组路径。swipe 是楼层内容候选（不影响剧情叙事），只有 branch 是真分支
- 分支切换/删层由投影层（`core/projection.js`）diff 出 RFC6902 操作，经写路径适配层（`core/chat-writer.js`）映射为**官方消息 API**（`deleteMessages`/`addMessages`/`updateMessages`）批量执行；元数据随官方持久化自动同车落盘
- 事实源在服务器聊天文件；浏览器不做任何持久化副本

设计文档：[`system-blueprint.html`](system-blueprint.html)（纯库模式蓝图，2026-09-24 重评对齐版）· [`.trellis/tasks/09-24-realign-pure-db/prd.md`](.trellis/tasks/09-24-realign-pure-db/prd.md)（N1–N18 裁定）· [`backend-plugin-spec.md`](backend-plugin-spec.md)（Authority 后端接入指导）· [`docs/multi-chat-pr-storage-seam-proposal.md`](docs/multi-chat-pr-storage-seam-proposal.md)（多聊天 PR 存储接缝建议书，独立于插件）。

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
- ⬜ 三期：**纯数据库模式重写**（2026-09-24 重评定向，N1–N18）：fetch 拦截接缝 + 三档存储适配器（Authority SQL / 官方通道 / IndexedDB）+ 导入旅程（智能合并 + 回收站）+ 树状图读库
- ⬜ 四期：导出与家族管理（branch/家族导出、重命名索引、解绑重绑）→ 性能基准与多并发验证 → 记忆/剧情联动（后置）

## License

[AGPL-3.0](LICENSE)——与 SillyTavern 上游一致。
