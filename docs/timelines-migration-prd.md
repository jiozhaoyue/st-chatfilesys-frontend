# Timelines→ChatFilesys 全量迁移 PR 计划

## Goal

产出一份**分阶段、单一功能 PR 序列**的迁移计划文档（`research/migration-plan.md`），将
SillyTavern-Timelines 的全部插件内容（图谱/Diff/采摘/大纲/看板/检索/语义/多树/导出/标签书签等）
迁入 ST-chatfilesys-rebuild（仓 `jiozhaoyue/st-chatfilesys-frontend`，分支 PR 序列合入 main）。

**本任务只交付计划文档，不写任何产品代码。**

## Background

- 用户 2026-09-26 裁定：Timelines 插件内容「全部转向」chatfilesys-rebuild；PR 形态＝仓内分支
  PR 序列（用户选定）。被取代的「三连打磨」任务已归档（09-26-l4-triple-polish）。
- 定位融合：Timelines 是 jsonl 消费层（看/搜/析，L4 温和线），ChatFilesys 是存储层（存/接管/合并，
  激进线）；融合后「聊天文件系统」叙事完整覆盖存储与消费两层。
- 规模事实：Timelines src+index ≈ 13.8k 行 / 42 模块 + vendor 788K（cytoscape 全家桶等 12 文件）；
  ChatFilesys ≈ 5.8k 行。迁移后仓 ≈ 19.6k 行。
- 关键风险：Timelines 数据获取走 `/api/chats/*`（src/node-data.js:131）——恰在 ChatFilesys fetch
  接缝（core/seam.js installSeam）拦截范围内，融合后图谱数据保真必须作为独立 PR 处理。

## Requirements

- R1（PR 序列形态）：每 PR 单一功能、可独立 review、可回滚（L1-MF-2）；给出 PR 依赖序与
  合并顺序不可换的理由。
- R2（每 PR 齐备四要素）：目标 / 内容清单（模块/文件级）/ 验收（单测+E2E 基线增量，命令固定
  ——Timelines 侧 `node --test tests/*.test.mjs`（基线 168）、E2E `BASE_URL=https://127.0.0.1:8003`；
  ChatFilesys 侧 `node --test tests/branches/*.test.mjs`（基线 278）/ 回滚方案（双仓 commit 范围）。
- R3（地基先行）：PR-0~PR-2 为地基（测试基线与目录形态移植、vendor 本地依赖移植、宿主 API
  适配层），功能 PR 在地基之后按依赖序迁入。
- R4（整合点显式建模）：
  - R4.1 图谱数据源适配器：融合后图谱须能从两套数据源构建（纯 jsonl 会话 + 库内家族/分支路径）；
    纯库/双写模式下图谱直读库内家族结构而非 fetch 全量拉取——独立 PR，融合价值最大的一步。
  - R4.2 fetch 接缝保真：Timelines 图谱字段（swipe_info/chat_metadata/send_date 等）对接缝响应
    的保真度极敏感，需字段级断言用例。
  - R4.3 标签/书签/快照与 ChatFilesys 分支模型的整合：Timelines 的 message.extra 注水体系与
    ChatFilesys 存储层并存时如何呈现（保留 extra 注水 / 转原生能力），计划需给出选项与推荐，
    最终由用户在对应实施 PR 裁定。
- R5（顺序与并行性）：多树依赖图谱核心先落；语义依赖 Authority 适配层先落；两者互不依赖可并行。
- R6（叙事与命名）：含 README/叙事重构 PR（融合后定位声明）；改名建议仅作选项供用户裁定，
  本计划不拍板；需警示前缀冲突（`chatfilesys-` vs `timelines-`）。
- R7（Timelines 仓退役策略）：迁移完成后 Timelines 仓保留不删（历史与存量用户），README 顶部
  迁移声明 + 停维计划；此为序列的收尾 PR。
- R8（铁律合规）：L1-MF-2（单一功能 PR）、L1-MF-7（测试命令固定）、L0-7（每 PR 合入即推送
  origin）、L0-10（样式双前缀纪律随迁保持）。
- R9（实施拆分）：计划获批后，1 PR = 1 Trellis 轻量任务，另行立项。

## Acceptance Criteria

- [x] AC-1：`research/migration-plan.md` 存在且自包含——每 PR 四要素齐备（目标/清单/验收/回滚），
      含 Timelines 侧 file:line 证据与双仓回滚 commit 范围，无需回读源仓即可评审。
- [x] AC-2：PR 依赖序显式（依赖图或顺序表），合并顺序不可换的理由成立；地基 PR（PR-0~2）先行
      理由成立。
- [x] AC-3：R4 三个整合点各有独立 PR 且验收含字段级断言（接缝保真）/双源构建用例（图谱适配器）/
      选项与推荐（标签书签整合）。
- [x] AC-4：多树与语义的迁移顺序、并行批次判据明确（R5）。
- [x] AC-5：PR 总数、周期估算、风险清单与缓解齐备；总数为估值非承诺，微调权归用户（R6 同理）。
- [x] AC-6：Timelines 仓退役 PR 方案齐备（README 转向声明 + 迁移指南 + 停维建议）。
- [x] AC-7：计划全文合规 R8 铁律（PR 拆分/验收命令/推送/样式纪律逐条可查）。
- [x] AC-8：本任务为纯规划——交付物仅 `.trellis/` 下文档，产品代码零改动（git 工作区无非
      trellis 路径改动）。
- [x] AC-9：计划含「1 PR = 1 Trellis 任务」的实施拆分约定（R9）。

## Out of Scope

- 任何产品代码改动（含两仓）。
- 改名/品牌决策的拍板（仅列选项）。
- 标签书签整合方案的最终拍板（仅列选项与推荐）。

## Notes

- 本任务为规划型复杂任务：交付物是文档，但按复杂度需谨慎对齐两仓事实（已对齐 remote/分支/规模/
  依赖形态/接缝风险）。
- 迁移内容全量清单：src/ 42 模块 + index.js + settings.html + style.css + tests/（22 文件 168 单测）
  + tests/e2e/（11 步）+ WIKI.md/README.md；vendor 是否随迁由 PR-1 裁定。
