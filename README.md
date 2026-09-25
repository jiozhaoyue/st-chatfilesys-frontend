# ChatFilesys — 聊天文件系统（SillyTavern / Luker 前端扩展）

> 接管酒馆的聊天文件系统：真正的楼层分支、纯数据库存储（jsonl 仅导出时存在）、fetch 拦截伪装无感、智能合并去重——全部作为**一个前端扩展**实现，零核心修改。

ChatFilesys 是一个 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（及 Luker 分支）的第三方前端扩展，把「分支」从整文件复制变成聊天数据内的结构化组织，把「超大 jsonl 会话文件」变成数据库分片存储：

- **真分支零复制**：分支只存增量（Swipe 组路径），共享前缀永远只有一份——百层聊天分叉不翻倍体积
- **纯数据库模式**：安装后提示「录入数据库并智能合并 → 删除 jsonl（默认删）」；此后 jsonl 只在导出时出现（branch=单 jsonl；家族=zip 包）。三档存储适配器：Authority SQL → 官方通道分片 → IndexedDB 缓存
- **生态无感**：fetch 拦截层把 `/api/chats/*` 读写转接数据库并伪造合规响应；渲染管线、原生按钮接管、其他插件操作全部照常
- **智能合并**：content_hash 指纹对齐——完全相同楼层幂等去重、最长公共前缀对齐为分叉点；跨聊天同层合并消灭文件间重复历史
- **可视化**：SVG 分支树（默认向下、可切右、可缩放拖拽）+ 消息旁 ⎇ 分叉 + 输入框上方分支徽章

## 安装

把 `public/scripts/extensions/third-party/chatfilesys/` 整个目录复制到实例的 `data/<user-handle>/extensions/chatfilesys/`，重启服务后在扩展设置中启用。

- 全局入口：扩展设置页「打开管理面板」按钮 / 斜杠命令 `/cb` / 快捷键 **Alt+B**
- 消息旁：每条消息旁的 ⎇ 按钮一键直分叉（自动创建、自动切换、自动命名「分支N」）

## 工作原理

两种形态并存，**纯数据库模式是默认形态**：

**纯数据库模式**（fetch 接缝 + 三档适配器）：插件在全局 `fetch` 上装一层接缝，拦截 `/api/chats/*` 的读/写请求，转接数据库分片并伪造合规响应——渲染管线与宿主按钮零改动，其他插件无感。

```
酒馆 UI ──fetch /api/chats/*──► 接缝层 ──► 三档适配器 ──► 家族 / 楼层 / 变体 / 分支路径
                                  │
                          非聊天请求原样透传；未接管的聊天原样透传
```

- **家族（Family）**：一个角色名下互为分支的聊天集合；**楼层（Floor）**：一条消息一层，家族内全局编号；**变体（Variant）**：楼层内内容候选（酒馆原生 swipe）；**分支（Branch）**：从分叉点起的变体引用序列，只存引用不复制内容
- 磁盘上的 jsonl 只在导出时生成；导入存量的智能合并走内容指纹（hash 去重 + 最长公共前缀分叉）

**JSONL 增强模式**（兼容形态，未启用纯库时）：

```
聊天文件（.jsonl）
├── 第 1 行 header.chat_metadata.extensions.chatfilesys   ← 分支树模型（惰性元数据）
│     { active_branch, branches:[{ id, name, fork_base, path }], groups:{ 折叠组 } }
└── 第 2 行起 = 活跃分支的楼层线性序列（body 投影）
```

- 分支切换/删层由投影层（`core/projection.js`）diff 出 RFC6902 操作，经写路径适配层（`core/chat-writer.js`）映射为**官方消息 API**（`deleteMessages`/`addMessages`/`updateMessages`）批量执行；元数据随官方持久化自动同车落盘
- 事实源在服务器聊天文件；浏览器不做任何持久化副本

机制细节见 [`docs/pure-db-mode-explained.md`](docs/pure-db-mode-explained.md)（人话说明，不写代码）。

设计文档：[`docs/pure-db-mode-explained.md`](docs/pure-db-mode-explained.md)（纯数据库模式人话说明，含界面长在哪里的分工）· [`backend-plugin-spec.md`](backend-plugin-spec.md)（Authority 后端接入指导）· [`docs/multi-chat-pr-storage-seam-proposal.md`](docs/multi-chat-pr-storage-seam-proposal.md)（多聊天 PR 存储接缝建议书，独立于插件）。

## 开发与测试

```bash
# 数据库单测（node:test，直接 import 扩展源码；含接缝/三档适配器/指纹合并/回收站/导入旅程）
node --test tests/branches/*.test.mjs   # 91 项

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

# 纯数据库模式（mock 宿主 / 真机注入 / 全旅程）
python tests/e2e/test_pure_db_mock.py          # mock 宿主读写回环
python tests/e2e/test_pure_db_devinject.py     # 真机注入接缝（安装/透传/卸载）
python tests/e2e/test_message_api_fetch.py     # 宿主持久化路径可拦截性回归
python tests/e2e/test_pure_db_full_journey.py  # UI 全旅程（库内容渲染 / 发消息入库 / 版本号闭环）
python tests/e2e/cleanup_cfsys_probes.py       # 探针隐容器清场
```

e2e 依赖本地 Luker 实例（默认 `https://127.0.0.1:8003`，可在 `tests/e2e/harness.py` 改 `BASE`）。真实验证一律在实例里做，不另做独立演示页。

## 路线图

- ✅ 一期：分支数据层 + 写路径 + 原生书签收编 + 增量导出
- ✅ 二期：UI 重构（管理弹窗 + 消息旁轻量注入）+ SVG 分支树 + 写路径迁移官方消息 API
- ✅ 三期：**纯数据库模式核心**（2026-09-24 重评定向）：fetch 拦截接缝 + 三档存储适配器（Authority SQL / 官方通道 / IndexedDB）+ 导入旅程（智能合并 + 回收站）+ 读库渲染；真机 UI 全旅程已过
- ⬜ 四期：原生「创建分支 / 创建检查点」接管 · 导出（单条走法文件 / 家族压缩包）· 解绑重绑 · 聊天改名自动索引 · 回收站界面入口 · 视图内化（插件态与独立态同源）· Authority 档真机验证 · 性能基准与多并发验证 → 记忆/剧情联动（后置）

未做到与已做到的全部差异，逐条列在 [`docs/pure-db-mode-explained.md`](docs/pure-db-mode-explained.md) 末节。

## License

[AGPL-3.0](LICENSE)——与 SillyTavern 上游一致。
