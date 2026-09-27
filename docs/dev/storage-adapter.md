# 适配器契约

## 它做什么

让**三档存储**（Authority SQL / 官方通道 / IndexedDB）实现**同一个接口**。
上层——接缝、图引擎、版本管理、导入旅程——都不需要知道当前是哪一档，
差异只落在「用哪只手段把数据存下去」。

选档是**特性检测 + 逐级降级**：档 1 初始化失败就退档 2，档 2 也不行就退档 3；
三档的构造都失败时，`index.js` 接住并**退回 JSONL 增强模式**，插件其余功能照常。

## 怎么用

### 契约（全部方法）

参数与返回值是 **duck-typed** 的——没有基类、没有运行时形状校验，靠这套约定 + 单测锁住。

| 方法 | 语义 |
| --- | --- |
| `listFamilies({ characterId })` | 列出一个角色名下的家族：`[{ familyId, name, updatedAt }]` |
| `loadFamily({ familyId? , chatKey? })` | 读一个家族（含模型、聊天头保留面、键绑定）；**未接管返回 `null`**。传 `chatKey` 时若命中的是**键绑定**（原生分支/检查点键），也要返回它所属的家族 |
| `createFamily({ family })` | 导入旅程建档；`familyId` 冲突返回 `{ ok:false }` |
| `bindChatKey({ familyId, chatKey })` | 把「聊天键 → 家族」登记进索引容器（官方通道档重启后靠它重新认领） |
| `renameFamily({ familyId, newName })` | 家族改名 |
| `deleteFamily({ familyId })` | 删家族 |
| `loadFloors({ familyId, from, limit })` | 按楼层号区间读楼层行：`{ floors, hasMore }` |
| `saveFloors({ familyId, floors, expectedIntegrity })` | 整批写楼层行 |
| `applyOps({ familyId, ops, model?, branchId?, targetBranchId?, hostMetadata?, keyBindings?, expectedIntegrity })` | **主写入口**：消息补丁 |
| `saveModel({ familyId, model, hostMetadata, keyBindings, expectedIntegrity, keepCurrent })` | 存模型本体 + 同步重建结构表 |
| `moveToTrash({ source, content })` | 删源文件前先收进回收站：`{ ok, trashId }` |
| `listTrash()` | 列回收站条目 |
| `restoreFromTrash({ trashId, restoreTarget })` | 还原 |
| `deleteFromTrash({ trashId })` | 立刻清理 |

### `applyOps` 上两个容易搞混的参数

`ops` 是挂在**某条分支投影出来的消息数组**上的 RFC 6902 补丁。这里有两个不同的分支：

- **`branchId` = 投影基准分支**（补丁的下标是对着它的数组算出来的）。
  不传 = 活跃分支。**原生分支/检查点键必须传该键所在的那条分支**，
  否则在分支聊天里改消息会写错行。
- **`targetBranchId` = 结构收敛目标分支**（补丁应用完之后，正文应当等于它的投影，
  被改写的路径也记在它名下）。**切分支时两者不同**：`targetBranchId` 是目标分支，
  而 `branchId` 仍是切换**前**那条（补丁是对着旧正文算的）。不切分支时两者相同。

`model` **只在切分支时**由接缝传进来（目标分支决定重投影的结构）；不传表示以库内模型为准。
`hostMetadata` / `keyBindings` 传 `undefined` 表示「本次不动它」，传对象表示覆盖。

### 版本号（并发保护）

**家族级字符串**，每次成功写生成一个新值（形如 `c-<36进制时间戳>-<随机>`）。

- 判定规则、归一化、冲突判断**统一在一个纯模块里**（`core/integrity.js`），三档共用，
  不在各处自己写比较。
- 为什么是字符串不是数字：宿主的 `chat_metadata.integrity` 本来就是字符串。
  早期用数字形态时，接缝不得不在「本插件生成的 slug」与「宿主原生 uuid」之间做双向桥接，
  而桥接对非本插件形态的值只能放行不锁 → **两处同时改同一家族会被静默覆盖**。改字符串后不再桥接、不再放行。
- 库内历史行可能是数字（SQLite 动态类型），读取时统一归一化后比较。

## 边界与未做到

- **档 1（Authority SQL）目前实际选不到。** 编排层调 `createStorageAdapter` 时只传了
  `fetch` / `headers` / `log`，**没有传 `authorityClient`**；而档 1 的进入条件正是
  `ctx.authorityClient` 存在。所以现在无论是否装了 Authority，都会落到档 2 或档 3。
  适配器本体与它的单测（用 mock client）都在，接线步骤写在仓根 `backend-plugin-spec.md`。
  这与[三档存储与降级](/guide/storage-tiers)里的「档 1 尚未在真实环境验证过」是同一件事，
  这里写的是更精确的那一面。
- **档 3 是缓存、不是事实源**：它只服务会话内读写，浏览器数据被清即丢失。
- **回收站枚举只有档 1 有**：另两档没有列目录的接口，弹窗里会直说不可用，不假装空列表。
- **档 2 是「借宿主的聊天存储当 KV 用」**（一个隐藏聊天装一个家族），性能弱于档 1 属预期。
- 契约是 duck-typed，**没有运行时形状校验**：加一档新的，或改契约，必须靠单测兜住
  （`tests/branches/storage-adapter.test.mjs` 对三档跑同一组行为断言）。

## 失败与降级时的表现

- **档 1 初始化失败** → 一条带 `[chatfilesys-storage]` 前缀的日志，自动退档 2。
- **档 2 构建失败** → 同样一条日志，退档 3。
- **档 3 之后没有下一档** → 异常向上抛，由 `index.js` 接住：记日志、**退回 JSONL 增强模式**，
  聊天主路径不受影响。
- **写冲突（版本号不等）** → `{ ok: false, conflict: true }`，接缝映射成 **409**，
  由宿主重拉重写；这是正常语义，不是故障（见[接缝](/dev/seam)）。
- **写失败但原因是内容不符**（`test-failed`）→ 也是 409；其余失败原因 → **400**，宿主回退全量保存。
