# Authority 后端接入指导（ChatFilesys 纯数据库模式）

> 本文档是 ChatFilesys 接入 [ST-Delegation-of-authority](https://github.com/Youzini-afk/ST-Delegation-of-authority)（下称 Authority）作为纯库模式第一档存储后端的指导书。
> 定位依据：任务 09-24-realign-pure-db 裁定 N3/N9/N11——Authority 为三档适配器的档1（性能最佳、真分片库），**不绑定**（实测瓶颈则弃用，降级档2/档3 照常工作）。
> 写作时间：2026-09-24。API 事实以 Authority 仓 README 与官方文档为准，接入时若与本文件冲突，以官方为准并回改本文件。

## 一、Authority 是什么（对本插件的意义）

Authority 是 ST 服务端插件，给第三方扩展提供统一后端能力 + 权限治理。对本插件关键的能力面：

| 能力 | SDK 入口 | 对纯库模式的价值 |
|------|---------|----------------|
| SQL 数据库 | `client.sql.*` | **档1 核心**：按用户×按扩展隔离的 SQLite，支持 migration/transaction/分页查询 |
| 私有文件 | `client.fs.*` | **回收站（N15）落点**：按用户×扩展隔离的文件目录，jsonl 删除前移入、一键还原 |
| 后台任务 | `client.jobs.*` | 导入旅程（大文件智能合并）、回收站过期清理的异步执行器 |
| 事件流 | `client.events.subscribe()` | 多并发/多页签同步信号（SSE 推送） |
| Trivium 图库 | `client.trivium.*` | 远期图结构（愿景低优先级）候选，MVP 不用 |
| KV/Blob/HTTP | 其余 | 本插件 MVP 不使用 |

## 二、接入姿态（权限与初始化）

```js
// 插件启动时初始化（可移植子集，禁用 Host Bridge —— AGENTS.md L0-12）
const client = await window.STAuthority.AuthoritySDK.init({
  extensionId: 'third-party/chatfilesys',
  displayName: 'ChatFilesys',
  version: '<插件版本>',
  installType: 'local',
  declaredPermissions: {
    sql: { private: true },
    fs: { private: true },   // 回收站目录
    jobs: {}                  // 导入/清理后台任务
  }
});
```

- **特性检测顺序（N11 降级链）**：启动时依次探测 Authority SDK 存在 → init 成功 → `sql` 权限获批；任一失败 → 降级档2（官方通道分片）→ 档3（IndexedDB 缓存）。降级仅 `console.warn`，不阻断插件加载（L0-11/L0-12）。
- **跨宿主纪律**：只用 Authority 可移植子集（SQL/fs/jobs/events 公开 API），禁用 Host Bridge（逐宿主打补丁机制，Luker 实测被版本门禁拒绝）。显式标注所用能力的宿主可用性。
- **权限弹窗**：用户首次使用纯库模式时，Authority Security Center 弹权限请求；拒绝则走档2，UI 提示「数据库模式降级为官方通道」。

## 三、档1 SQL 适配器设计要点

### 3.1 库与迁移
- 每用户一个 `chatfilesys` 库（Authority 按用户×扩展隔离）。
- 建表走 `client.sql.migrate`，schema 以本任务 [design.md](.trellis/tasks/09-24-realign-pure-db/design.md) §2 为准（families / floors / branches / branch_paths 四表 + content_hash 索引）。
- 迁移按无包袱铁律：版本升级时 schema 可破坏性变更 + `sql.backup` job 先行备份，不做旧格式兼容层。

### 3.2 查询纪律（并发与性能红线）
- **禁止逐楼层查询**：加载一律按 floor_no 区间分页（`loadFloors(familyId, {from, limit})`），一次往返取一页。
- **批量写分块提交**：导入/合并/重建类批量写按几百行一事务分块，禁止单事务长持写锁，防交互写被顶到 busy_timeout。
- **长查询进 jobs**：全局扫描/搜索类查询走 `client.jobs` 或分页，不得阻塞交互路径。
- **写队列串行化**：适配器内单写队列，交互写优先插队（多并发原则 N18）。

### 3.3 事务与一致性
- 结构操作（分叉/切换/删层）= 单事务内「投影 diff → 库写 → integrity 自增」原子完成。
- integrity 乐观锁沿用宿主语义：冲突返回 409 → 前端重拉重放（design.md §3.4）。

## 四、回收站（N15）落 Authority fs

- 位置：Authority 扩展私有目录 `trash/<character>/<原文件名>`（按用户×扩展隔离，天然满足「插件管理的服务端回收站」）。
- 生命周期：导入完成后移入 → 保留 N 天（默认 7，设置项）→ 过期自动清理（jobs 定时扫描）→ 期间管理界面一键还原。
- 还原 = 从 fs 复制回宿主聊天目录对应的聊天（经官方通道或引导用户手动放回）。还原后该聊天脱离纯库接管，回到原生形态。
- 注意：Authority fs 是扩展私有沙箱，**不能**直接写宿主 `data/chats/` 目录；「还原到宿主目录」需经下载/导出动作或宿主端点，接入时实测确认路径。

## 五、导入旅程（N2+N10+N15）中的 Authority 角色

1. 检测存量：前端枚举宿主聊天列表（官方端点）+ 读各 jsonl（官方 `/api/chats/get`）。
2. 智能合并：指纹对齐（content_hash + LCP，design.md §5）→ 库写入（§3.2 纪律）。
3. jsonl 处置：移入 Authority fs 回收站（N15）；用户在旅程中可改「不删/双写」。
4. 全程异步可取消，进度条 + 完成后「已合并 N 条，跨 M 个聊天」结果弹窗。

## 六、性能基准（M3 校验点，N3 弃用判据）

接入后必须实测并留档（M3 任务）：
- 分片读 vs jsonl 整读（不同楼层量级：100/1k/10k 层）
- fetch 往返粒度：单页 200 层加载延迟
- 批量写吞吐（导入万层聊天）
- 判据：Authority SQL 档若在这些基准上劣于档2（官方通道分片），按 N3 弃用或降优先档序。

## 七、数据主权与卸载（Open-14 未决项提示）

- 库与回收站都是 Authority 扩展私有资产。卸载 Authority 或本插件后，聊天数据仍在 Authority 数据目录，需经「导出 jsonl/zip」归还。
- 接入时需在管理界面提供「全量导出/脱离 Authority」入口（M2 导出功能的延伸）。
- 本节为设计约束提醒，最终交互形态待 M2 实施时与用户对齐。

## 八、接入步骤清单（M1-b 任务用）

- [ ] 读 Authority 仓 README + `third-party/st-authority-sdk` 文档，核对 SQL/fs/jobs API 签名（本文档 §1/§2 的 API 事实复核）
- [ ] SQL 适配器实现（design.md §2 schema + §3 纪律）
- [ ] fs 回收站模块（N15）
- [ ] 特性检测 + 降级链（§2）
- [ ] e2e：权限弹窗→授权→入库→聊天→还原 全旅程（对 Dev 实例）
- [ ] 权限被拒 / Authority 未装 / SDK 版本不匹配 三条降级路径实测
