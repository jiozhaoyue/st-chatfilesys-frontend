# ChatFilesys — 聊天文件系统（SillyTavern / Luker 前端扩展）

> 接管酒馆的聊天文件系统：真正的楼层分支、纯数据库存储（jsonl 仅导出时存在）、fetch 拦截伪装无感、智能合并去重——全部作为**一个前端扩展**实现，零核心修改。

ChatFilesys 是一个 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（及 Luker 分支）的第三方前端扩展，把「分支」从整文件复制变成聊天数据内的结构化组织，把「超大 jsonl 会话文件」变成数据库分片存储：

- **真分支零复制**：分支只存增量（Swipe 组路径），共享前缀永远只有一份——百层聊天分叉不翻倍体积
- **纯数据库模式**：在弹窗「设置」页签切到「纯数据库」后，用「转库」把存量聊天录入库并智能合并（默认删源文件，副本先进回收站保留 7 天）；此后 jsonl 只在导出时出现（**导出当前分支**为一份标准 jsonl）。三档存储适配器：Authority SQL → 官方通道分片 → IndexedDB 缓存
- **生态无感**：fetch 拦截层把 `/api/chats/*` 读写转接数据库并伪造合规响应；渲染管线、原生按钮接管、其他插件操作全部照常
- **智能合并**：content_hash 指纹对齐——完全相同楼层幂等去重、最长公共前缀对齐为分叉点；跨聊天同层合并消灭文件间重复历史
- **可视化**：SVG 结构树（默认向下、可切右、可缩放拖拽，只显结构不含消息内容）；消息旁仅在**该层有多个 swipe 组**时出现一个版本按钮

## 安装

把 `public/scripts/extensions/third-party/chatfilesys/` 整个目录复制到实例的 `data/<user-handle>/extensions/chatfilesys/`，重启服务后在扩展设置中启用。

- 唯一界面 = **插件弹窗**：入口是输入框上方那排工具图标里的插件按钮，或用快捷键 **Alt+B**
- 聊天界面只有两样：上面那个入口按钮，以及消息旁的**版本按钮**（仅该层有多个 swipe 组时出现，形状是分叉图标加计数）
- 扩展设置抽屉里不放任何东西（设置项在弹窗的「设置」页签里）
- **打开一个还没入库的聊天时会弹一次入库提醒**（页面刚加载就停在某个聊天上也会弹）：两个模式短按钮「纯库」／「双写」、一个「不入库」，外加两个勾选「这个聊天不再提醒」／「全部不再提醒」。关掉窗口（右上角 X 或 Esc）等于「不入库」。压制记录只存在扩展设置里，不写进聊天记录。

## 工作原理

三种模式并存（弹窗「设置」页签里三选一；出厂默认 JSONL 增强）：

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

**双写模式**（库是事实源 + 磁盘保留标准聊天文件）：

```
库（事实源）──写成功后标脏──► 防抖 1.5 秒 ──► 原生通道写一份标准 jsonl
                                              （绕开接缝，不回环）
```

- 库改一次就同步一份标准格式的聊天文件到磁盘，别的工具与备份流程照常能看到文件
- 方向是**单向的：只写不读**——磁盘那份是副本，反向的改动不采纳（避免双向冲突）
- 「库 → 关闭」会先强制落一次文件、失败即中止切换；「双写 → 纯库」停止落文件，磁盘文件保留为快照

**两种模式都有的动作**：可显式「设为主分支」——主分支 = 打开这个聊天看到的那条分支。主分支不能直接删，要先换成别的分支再删（换成哪条就以哪条为准）；库里的家族主键绑定会跟着同一次落库改到目标分支上。

机制细节见 [`docs/pure-db-mode-explained.md`](docs/pure-db-mode-explained.md)（人话说明，不写代码）。

设计文档：[`backend-plugin-spec.md`](backend-plugin-spec.md)（Authority 后端接入指导）· [`docs/multi-chat-pr-storage-seam-proposal.md`](docs/multi-chat-pr-storage-seam-proposal.md)（多聊天 PR 存储接缝建议书，独立于插件）。

## 开发与测试

```bash
# 数据库单测（node:test，直接 import 扩展源码；含接缝/三档适配器/指纹合并/回收站/导入旅程）
node --test tests/branches/*.test.mjs   # 29 个测试文件 / 387 项

# e2e（Playwright 驱动宿主真实实例 https://127.0.0.1:8003/，测试角色前缀 __cb_e2e，自动清理）
# Windows 下必须带 PYTHONIOENCODING=utf-8（断言明细含非 GBK 字符，否则打印即崩）
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
python tests/e2e/test_chat_record_fidelity.py  # 聊天记录零丢失（聊天头整份往返 + 字段级补丁 + 命名空间不丢）
python tests/e2e/test_cold_import_header.py    # 冷导入不丢聊天头（被导入的不是当前聊天）
python tests/e2e/cleanup_cfsys_probes.py       # 探针隐容器清场

# 三模式与界面（同一台实例，**必须串行跑**：并发会互相污染）
python tests/e2e/test_native_branch_checkpoint_takeover.py  # 原生「创建分支/检查点」接管（磁盘零新 jsonl）
python tests/e2e/test_mirror_mode.py           # 双写模式（落标准文件 / 库改后一键重建 / 反向不采纳）
python tests/e2e/test_off_mode_delete_reorder.py # 增强模式下宿主原生删消息后的层号重排
python tests/e2e/test_main_branch.py           # 主分支可换（灰化 / 确认 / 库内不变式 / 旧主分支可删）
python tests/e2e/test_import_prompt.py         # 入库提醒弹窗（冷启动 / 控件 / 两个勾选 / 两条真入库）
python tests/e2e/test_ui_placement.py          # 界面分工（扩展设置抽屉零注入 / 只有入口与版本按钮 / 无逐层列举）
python tests/e2e/test_swipe_versions.py        # 每层版本管理（四项能力 / 两种切换语义 / 导出与双写落盘的三件套）
```

e2e 依赖本地 Luker 实例（默认 `https://127.0.0.1:8003`，可在 `tests/e2e/harness.py` 改 `BASE`）。真实验证一律在实例里做，不另做独立演示页。

> **串行纪律（实测教训）**：所有用例共用同一台实例。并发跑会让彼此的模式切换与聊天重载互相打断——已实测过一次 `test_main_branch.py` 的 ④ 在并发下失败、独占重跑即全绿。harness 之外，跑之前还要把插件目录同步到实例的 `data/<user-handle>/extensions/chatfilesys/`（harness 不会替你同步）。

## 路线图

- ✅ 一期：分支数据层 + 写路径 + 原生书签收编 + 增量导出
- ✅ 二期：UI 重构（管理弹窗 + 消息旁轻量注入）+ SVG 分支树 + 写路径迁移官方消息 API
- ✅ 三期：**纯数据库模式核心**（2026-09-24 重评定向）：fetch 拦截接缝 + 三档存储适配器（Authority SQL / 官方通道 / IndexedDB）+ 导入旅程（智能合并 + 回收站）+ 读库渲染；真机 UI 全旅程已过
- ⬜ 四期（进行中）：
  - ✅ 原生「创建分支 / 创建检查点」接管（点宿主原生按钮不再落复制文件，直接在库内成结构）
  - ✅ 双写模式（库为准 + 磁盘保留标准聊天文件，只写不读）
  - ✅ 入库提醒弹窗（四选择 + 冷启动也弹 + 两个压制勾选）
  - ✅ 主分支可换（「设为主分支」，主分支不可直接删）
  - ✅ 界面分工收敛（唯一界面 = 弹窗四页签；聊天界面只剩入口按钮与版本按钮；删扩展设置抽屉与 `settings.html`）
  - ✅ 每层版本按钮（仅该层有多个 swipe 组时出现）
  - ✅ 版本弹窗的四项能力（预览 / 切换 / 多选删除 / 重排；**只参考外部插件的交互设计，未引入其任何代码**）
  - ⬜ 导出：家族压缩包（单条分支导出已有）
  - ⬜ 把一个角色卡的所有聊天合并成一个家族（按原有父子关系接树 + 占位文件保活）
  - ⬜ 解绑重绑 · 聊天改名自动索引（部分已有）· 视图内化（插件态与独立态同源）
  - ⬜ 术语统一为「分支」（全仓「分支」存量待扫）
  - ⬜ 三模式行为矩阵参数化回归 + 多插件共存实测
  - ⬜ Authority 档真机验证 · 性能基准与多并发验证
  - ⬜ 首次用户旅程实测（用真实聊天走一遍导入→聊天→分支→切版本）

未做到与已做到的全部差异，逐条列在 [`docs/pure-db-mode-explained.md`](docs/pure-db-mode-explained.md) 末节。

## License

[AGPL-3.0](LICENSE)——与 SillyTavern 上游一致。
