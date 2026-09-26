# Timelines → ChatFilesys 全量迁移 PR 计划

> 状态：**待用户批准**。本文档为 PR 序列计划，不含任何产品代码改动。
> PR 形态（用户 2026-09-26 裁定）：仓内分支 PR 序列，合入 `jiozhaoyue/st-chatfilesys-frontend` 的 main。
> 纪律锚点：L1-MF-2（单一功能 PR）、L1-MF-7（测试命令固定）、L0-7（每 PR 合入即推送）、
> L0-10（样式双前缀）、L1-MF-15（E2E 只对 Dev 实例 8003）。

## 0. 前提与规模

- 源仓：`SillyTavern-Timelines`（分支 `codex-luker-chinese-refactor`，168 单测 / 11 步 E2E 全绿基线）。
- 目标仓：`ST-chatfilesys-rebuild`（main，278 单测 / e2e 5 件套基线）。
- 迁移全量：src/ 42 模块 + index.js（编排）+ settings.html + style.css + tests/（168 单测）
  + tests/e2e/（11 步）+ WIKI.md/README.md ≈ 13.8k 行代码 + 788K vendor。目标仓扩容后 ≈ 19.6k 行。
- 双仓职责：迁移 = Timelines 侧内容单向流入 ChatFilesys；ChatFilesys 存储层（分支模型/库/接缝/回收站）
  **行为零改动**。
- 每 PR 回滚：目标仓 revert 单个合并提交即可；源仓侧无代码改动（迁移是复制+适配，非移动）。

## 1. PR 序列总览（13 个 PR）

| PR | 主题 | 依赖 | 可并行批次 |
|----|------|------|-----------|
| PR-0 | 测试与目录地基 | — | — |
| PR-1 | vendor 本地依赖移植 | PR-0 | — |
| PR-2 | 宿主 API 适配层 | PR-0 | 与 PR-1 并行 |
| PR-3 | 图谱核心（graph pipeline） | PR-1 + PR-2 | — |
| PR-4 | 渐进渲染与 LOD | PR-3 | 批次 A |
| PR-5 | 检索（词法+雷达） | PR-3 | 批次 A |
| PR-5b | fetch 接缝保真（整合点①） | PR-3（建议紧随） | 批次 A |
| PR-5c | 图谱数据源适配器（整合点②） | PR-3 | 批次 A |
| PR-6 | 语义检索（Authority） | PR-2 + PR-5 | 批次 B |
| PR-7 | 多树视图 | PR-3 + PR-4 | 批次 B |
| PR-8 | Diff/采摘/大纲/看板 | PR-3 | — |
| PR-8b | 标签/书签/快照整合（整合点③） | PR-8 | — |
| PR-9 | 导出（长图/SVG/留存） | PR-3 | — |
| PR-10 | 叙事重构与 README | 全部功能 PR | — |
| PR-11 | Timelines 仓退役声明 | PR-10 | — |

**顺序不可换的理由**：PR-0~2 是地基（测试形态/vendor/宿主 API），任何功能 PR 都踩在其上；
PR-3 图谱核心是全部消费层功能的地基（PR-4/5/8/9 都消费它的元素集合）；PR-5b/5c 是融合整合点，
需图谱字段先落位才有断言对象；PR-10/11 是收尾（叙事与退役），必须最后定稿。

**并行批次**：批次 A = {PR-4, PR-5, PR-5b, PR-5c}（都只依赖 PR-3）；批次 B = {PR-6, PR-7}
（PR-6 走 PR-2+5 路径，PR-7 走 PR-3+4 路径，互不踩脚）。PR-5b 建议紧随 PR-3——越晚发现字段
失真，返工面越大。

## 2. 逐 PR 计划

### PR-0 测试与目录地基

- **目标**：在目标仓建立 Timelines 侧代码的落位目录与测试运行形态。
- **内容**：新增落位目录（命名在 PR-10 统一裁定，先用现名）；`node --test` 收集路径扩展
  （两套测试并存不互踩）；CI 脚本（若有）双套件接入。
- **验收**：ChatFilesys 既有 `node --test tests/branches/*.test.mjs` 278/278 零回归 + 目录形态落位。
- **回滚**：revert 目标仓单提交。

### PR-1 vendor 本地依赖移植

- **目标**：cytoscape 全家桶等 12 个本地依赖文件（788K）迁入目标仓。
- **内容**：vendor/ 12 文件整体复制；manifest.json 加载序核查（loading_order）。
- **验收**：文件齐 + 加载序不变 + 既有测试零回归（vendor 是纯静态资产）。
- **回滚**：revert（删 vendor 目录）。
- **决策留白**：vendor 是否随迁由本 PR 实施时单独裁定。

### PR-2 宿主 API 适配层

- **内容**：api.js / helpers.js / utils.js（导航部分）——宿主 API 桥（openCharacterChat /
  selectCharacterById / getRequestHeaders 等）。
- **验收**：node --check 语法通过 + helpers 纯函数单测（makeContextKey 等）迁移全绿。
- **回滚**：revert。

### PR-3 图谱核心（graph pipeline）

- **目标**：迁移消费层地基——图构建管线 + 编排骨架。
- **内容**：graph-builder.js / graph.js / node-data.js / node-text.js / cache.js /
  incremental-merge.js / layout-service.js / layout.worker.js / minimap.js / minimap-math.js +
  index.js 骨架（模态与打开按钮挂点 + 宿主事件接线）+ settings.html 骨架 + style.css 基础样式。
- **验收**：图谱相关既有单测迁移全绿（预期 ≥60 项）+ E2E「打开时间树、拓扑就绪」等价物在融合仓通过。
- **回滚**：revert。
- **注意**：宿主事件接线（CHAT_CHANGED 等）与 ChatFilesys 接缝的事件时序需在此 PR 核验
  （接缝伪造响应不改事件流，但时序需验证）。

### PR-4 渐进渲染与 LOD

- **内容**：lod-service.js / load-progress.js / memory-profile.js + 渐进管线编排（onBatch/onProgress）。
- **验收**：三模块既有单测迁移全绿 + 渐进加载行为 E2E 等价通过。
- **回滚**：revert。

### PR-5 检索（词法+雷达）

- **内容**：search-service.js / search-radar.js。
- **验收**：search-radar.test.mjs 全绿 + E2E 词法检索步骤等价通过。
- **注意**：多树模式下检索的跨树语义在 PR-7 迁入后回补。

### PR-5b fetch 接缝保真（整合点①）

- **目标**：Timelines 图谱字段对接缝响应的保真度保障。
- **源仓证据**：src/node-data.js:131（/api/chats/* 端点）、index.js:2223/2622（fetchData 调用点）、
  src/cache.js:80-87（scopeKey 缓存键）。
- **内容**：字段级断言用例——对被接缝接管的聊天，断言 swipe_info / chat_metadata / send_date /
  extra 等图谱消费字段与原生响应逐字段等价；失真时的诊断提示。
- **验收**：字段级保真测试全绿；发现失真则在本 PR 内修复或升级为阻塞缺陷，不得静默吞掉。
- **回滚**：revert。

### PR-5c 图谱数据源适配器（整合点②：双源构建）

- **目标**：融合价值最大的一步——图谱从两套数据源构建。
- **内容**：数据源抽象（jsonl fetch 路径 + ChatFilesys 库内家族/分支路径）；纯库/双写模式下图谱
  直读库内家族结构（family/floor/variant/branch path），不再 fetch 全量拉取；纯 jsonl 模式保持现行为。
- **验收**：双源构建用例（同一会话两源图谱同构）+ 纯库模式下图谱渲染 E2E。
- **回滚**：revert（回退后纯 jsonl 路径行为不变）。

### PR-6 语义检索（Authority）

- **内容**：adapters/authority-adapter.js / authority-http-fetch.js / embedding-provider.js /
  semantic-index-service.js / semantic-search-service.js / semantic-global-modal.js + 语义设置 UI。
- **验收**：semantic 相关单测迁移全绿 + E2E 语义步骤（构建降级/检索/弹窗）等价通过。
- **纪律**：Authority 依赖保持可选、缺省关闭（L0-11 适配器降级——未装 Authority 时纯前端全功能）。

### PR-7 多树视图

- **内容**：multi-tree.js + 多树编排（multiTreeState 单例、进入/退出、选择器 UI、横幅）+
  tests/multi-tree.test.mjs（21 用例）+ **多树语义护栏接线回补**（triggerSemanticBuild /
  maybeAutoSemanticIndex 多树拒绝的接线与单测，作为本 PR 验收子项）。
- **验收**：multi-tree 单测全绿 + E2E 多树步骤（进入/共存/无跨树边/退出）等价通过。
- **回滚**：revert。

### PR-8 Diff/采摘/大纲/看板

- **内容**：diff-modal.js / diff-service.js / merge-service.js / story-outline-modal.js /
  story-outline-service.js / analytics-modal.js / analytics-service.js。
- **验收**：diff / merge 单测迁移全绿 + E2E 对应步骤等价通过。
- **增强留白**：Diff 的「分支 vs 分支对比」（利用 ChatFilesys 家族内分支）由本 PR 实施时评估，不拍板。

### PR-8b 标签/书签/快照整合（整合点③：决策点）

- **目标**：Timelines 的 message.extra 注水体系（tag-manager.js / snapshot-service.js /
  snapshot-modal.js）与 ChatFilesys 存储层的整合方式落地。
- **选项**：
  - **a. 保留 extra 注水**（推荐）：标签/书签继续写 message.extra；纯库模式下经投影层随官方
    持久化同车落盘（ChatFilesys projection.js:43 已保留 extra 传递，机制兼容）。零回归、纯 jsonl
    用户零感知。
  - **b. 转库内原生能力**：标签/书签转为 ChatFilesys 库模型（floor/family 级元数据）。跨范式改造，
    纯 jsonl 用户失去该能力；若选 b 需另立 PR 序列，不在本计划内。
- **验收**：按裁定落地 + 标签/书签既有单测迁移全绿 + 纯库模式下标签写回链路 e2e。
- **回滚**：revert。

### PR-9 导出（长图/SVG/留存）

- **内容**：export-modal.js / export-service.js / export-history-modal.js（含 Authority 留存）。
- **验收**：export 单测全绿 + E2E 导出步骤（长图/SVG/留存 CRUD）等价通过。
- **回滚**：revert。

### PR-10 叙事重构与 README

- **目标**：融合后定位声明——「聊天文件系统 = 存储层 + 消费层」。
- **内容**：README/WIKI 重构（新增消费层章节、安装与使用整合）、改名建议（选项，用户裁定）、
  前缀冲突警示（两套 CSS 前缀 `chatfilesys-` / `timelines-` 各自独立，一致化时机单裁）。
- **验收**：文档落盘、叙事自洽。
- **回滚**：revert。

### PR-11 Timelines 仓退役声明

- **目标**：源仓退役（保留不删）。
- **内容**：Timelines 仓 README 顶部迁移声明 + 迁移指南（功能 → 新仓位置映射表）+ 停维建议
  （建议 3 个月观察期后转维护模式）。
- **验收**：声明与映射表落盘并推送到 Timelines origin。
- **回滚**：revert Timelines 仓单提交。

## 3. 风险清单与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 接缝保真失真（图谱字段被伪造响应污染） | 中 | 高 | PR-5b 字段级断言紧随 PR-3；失真即阻塞缺陷 |
| index.js 编排层一次迁入导致 PR-3 过重 | 高 | 中 | PR-3 只迁骨架，全量编排随各功能 PR 分批落 |
| CSS 前缀冲突 | 高 | 低 | L0-10 双前缀纪律：两套前缀各自独立不互改 |
| 双源构建复杂度超预期（家族模型 ≠ 消息列表） | 中 | 高 | PR-5c 独立验证；失败回退纯 jsonl 路径（行为不变） |
| 两套测试基线互踩（收集器/目录冲突） | 中 | 中 | PR-0 目录隔离 + 独立收集路径；每 PR 双基线同报 |
| 语义/多树护栏接线遗漏（分批落位） | 低 | 中 | PR-7 验收子项显式列出护栏回补 |
| 工程量误判（13.8k 行实际成本） | 高 | 中 | 1 PR = 1 Trellis 任务分批立项，失败面收敛到单 PR |

## 4. 实施拆分约定

- 计划获批后，**1 PR = 1 Trellis 轻量任务**，在目标仓（ST-chatfilesys-rebuild）立项。
- 每任务 PRD 直接复用本计划对应 PR 节的四要素（目标/内容/验收/回滚）。
- 每 PR 合入 main 后立即推送 origin（L0-7）；实施前重跑双仓基线确认起点干净。

## 5. 周期估算（概念级，非承诺）

- 地基 PR-0~2：1-2 个工作日；PR-3：1-2 天；批次 A（PR-4/5/5b/5c）：2-3 天；
  批次 B（PR-6/7）：2-3 天；PR-8/8b/9：2-3 天；PR-10/11：1 天。
- 串行合计约 **9-14 个工作日**；并行批次可压缩 2-3 天。微调权归用户。

## 6. 决策点清单（实施时逐项裁定，不打包）

1. PR-1：vendor 是否随迁。
2. PR-6：语义 Authority 依赖的可选态与缺省值（建议保持可选、缺省关闭）。
3. PR-8：Diff 增强（分支 vs 分支）是否做。
4. PR-8b：标签/书签整合选 a（保留 extra 注水，推荐）或 b（转库模型，另立线）。
5. PR-10：改名与品牌；CSS 前缀一致化时机。
6. PR-11：停维期限（建议 3 个月观察期）。

## 7. 迁移全量清单（源仓证据锚点）

- 数据与构建：node-data.js / graph-builder.js / graph.js / cache.js / incremental-merge.js /
  node-text.js / helpers.js。
- 渲染与性能：layout-service.js / layout.worker.js / minimap.js / minimap-math.js / lod-service.js /
  load-progress.js / memory-profile.js。
- 检索与语义：search-service.js / search-radar.js / semantic-index-service.js /
  semantic-search-service.js / semantic-global-modal.js / embedding-provider.js /
  authority-http-fetch.js / adapters/。
- 功能面：diff-modal/service、merge-service、story-outline-modal/service、analytics-modal/service、
  tag-manager.js、snapshot-service/modal、export-modal/service、export-history-modal.js。
- 多树：multi-tree.js + 多树编排（index.js 内）。
- 编排与资产：index.js（骨架分批落）+ settings.html + style.css + WIKI.md / README.md。
- 测试：tests/ 22 文件（168 基线）+ tests/e2e/phase0-authority.mjs（11 步）。
- vendor：12 文件（788K）——PR-1 裁定。
