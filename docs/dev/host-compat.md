# 宿主兼容

## 它做什么

本扩展的目标宿主是 **SillyTavern 及 Luker 分支**。本页把「用到宿主的哪些能力、缺了会怎样」
集中说清：平台差异只在这里和 `index.js` 的能力检测里处理，**不散落到业务层**。

启动路径：宿主加载器读扩展的 `manifest.json`，看到 `hooks.activate` 指向 `init`，
动态 `import` 本扩展后调用这个命名导出——Luker 与 ST 都走 `callExtensionHook` 这条路。

## 怎么用

### 用到的宿主能力与缺失时的表现

| 能力 | 用在 | 缺失时 |
| --- | --- | --- |
| `USER_MESSAGE_RENDERED` / `CHARACTER_MESSAGE_RENDERED` | 消息旁注入版本按钮 | **不注入**，其余照常（启动时记一次能力检测结果） |
| `renderLukerTabs` | 管理弹窗的四个页签 | 降级成**内置 Tab** 实现（记一条日志） |
| `generateQuietPrompt` / `generateRaw` | 分支树上的 AI 总结按钮 | **按钮不出现**（宁可不给，也不给一个点了没反应的） |
| `Popup`（`DISPLAY` + `wide` / `large`） | 管理弹窗本体 | 无降级路径——弹窗是本插件唯一的界面 |
| `/api/chats/*` | 官方通道档的读写 | 退到 IndexedDB 档 |
| `window.STAuthority.AuthoritySDK`（Authority 后端插件） | 库模式的档 1（SQL + 私有文件） | **退档 2 / 档 3**，只记一条带真原因的日志；插件其余功能照常 |
| `getRequestHeaders()` | 官方通道档的请求头 | 传空对象 |
| `extension_settings` / `chat_metadata` | 设置项、聊天头保留面 | 无降级——这两个是宿主原生存储 |

**一处实测补正**：`*_MESSAGE_RENDERED` 事件**只在追加消息那条路径上触发**；
宿主批量重绘（`printMessages`）不触发。所以消息旁的按钮走的是「渲染事件 + 主动补一遍」两条路，
而不是只等事件。

### API 事实以官方文档为准（硬纪律）

- 查宿主 API 事实，**先查 Luker 官方文档站**（开发文档与 extension-api 全部子页）。
- **禁止靠阅读宿主源码去「发现」API 用法**。源码只允许用于排查「官方文档写了却不生效」的 bug。
- **运行时行为可以用探针实测**，但契约以文档为准。
- 抓下来的官方文档快照与已经沉淀的 API 事实，属于**机向规范**（见[文档政策](/dev/docs-policy)）。

### 禁用项

- **弃用 API**：`patchChatMessages` / `appendChatMessages`——官方已弃用。
  一律用消息 API：`addMessages` / `updateMessages`（批量合并成一次持久化）/ `deleteMessages` / `saveChatMetadata`。
  e2e 里有**源码级断言**守着这条（不允许它们重新出现在代码里）。
- **Authority 的 Host Bridge 禁用**：本插件是跨宿主形态，需要服务端能力时**只能用 Authority 的可移植子集**
  （这里实际用到的是 `client.sql` 与 `client.fs` 两项公开面），**不得**走「逐宿主打补丁」的 Host Bridge 路径——
  那条路按宿主版本号设门禁、补丁面在宿主间分叉，Luker 上实测会被版本门禁拒绝，
  表现是**功能时好时坏而不是直接报错**，极难排查。
- **样式不许泄漏**：注入宿主的每条 CSS 规则都必须带 `chatfilesys-` 前缀，
  禁止裸选择器（`body` / `:root` / `*` / 宿主全站类名），配色继承宿主变量。这条有真实事故前科。

## 四宿主自动化兼容测试（2026-09-27 新增）

「兼容」不能靠读文档声称，得**跑**。`tests/e2e/hosts.py` 是四个宿主差异的**单一登记处**
（地址、协议、扩展落点、加载方式、就绪信号），`tests/e2e/test_host_compat.py` 是同一套
九条断言跑在四宿主上：

| 宿主 | Dev 地址 | 装配方式 | 实测状态 |
| --- | --- | --- | --- |
| SillyTavern | `http://127.0.0.1:8001` | 扫扩展目录 | ✅ 9/9 |
| Luker | `https://127.0.0.1:8003` | 扫扩展目录 | ✅ 9/9 |
| PureTavern | `http://127.0.0.1:8899` | **`installExtension(zipUrl)`**（不扫目录） | ✅ 9/9 |
| TauriTavern | 无 HTTP 端点（桌面） | `tauri:dev:pilot` + `tauri-pilot` CLI | ✅ 9/9 |

断言覆盖的是**跨宿主真正会碎的东西**（装配与协议），不是把功能用例再跑一遍：
静态面可取且内容真是我们的 / 装得上 / 入口出现（说明宿主真调到了 `init`）/ 弹窗与五页签 /
关窗无残留 / 零本插件归因报错 / 落点白名单。

**三条被真机打出来的坑**（都写进了 `spec/frontend/host-compat.md`）：
1. **宿主冷启动慢是常态**——Luker 从页面开始到插件入口出现实测 **38 秒**；
   超时余量不足会以「插件加载失败」的形态出现（假红）。
2. **PureTavern 的 SPA 回退会返回 200 + HTML**（实测 743107 字节）——
   只看状态码会把「扩展已就位」判成真，判据必须查**内容是不是我们的**。
3. **Windows 上 Python 的 `urllib` 不读 `NO_PROXY`**（走注册表）⇒ 回环探测被塞进代理、
   四宿主看起来「全没起」；必须显式装空 `ProxyHandler`。另：**302 也是「活着」**
   （Luker 未登录时重定向到登录页，`urllib` 报 redirect loop）。

**TauriTavern** 是 Rust/Tauri 桌面宿主，没有 HTTP 端口。自动化路径（TT 官方 README 指定）：
`pnpm tauri:dev:pilot` 起应用（启用 `tauri-plugin-pilot`）+ `cargo install tauri-pilot-cli`
装驱动，再用 `tauri-pilot eval "<js>"` 在页面里求值——于是能复用与浏览器版同形的断言。
四条实测要点：
- **必须用 MSVC 工具链**：GNU/mingw 下 TT **自己编不过**（`ld: export ordinal too large: 344970`，
  是 TT 在该工具链下的限制，不是插件的问题）。设
  `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc` 即可，**不必改默认工具链**。
- **`eval` 按表达式求值**：顶层 `await` 报 `await is not defined`；异步要挂 `window.__probe` 再轮询。
- **读回时 CLI 的输出已被解析过一遍**：判据只认「字符串」会永远判超时（值其实早写回了）。
- **同步插件后必须重载页面**：TT 只在启动时扫扩展目录。
另：首次编译整个 Rust workspace 很慢；中途被打断会留下占着 **1430** 端口的
`node scripts/tauri-dev-server.mjs` 残留进程，使下一次以 `EADDRINUSE :::1430` 失败。

## 边界与未做到

- **四宿主的兼容用例只覆盖「装配与协议」**：静态面、装得上、入口出现、弹窗与页签、
  关窗无残留、零本插件归因报错、落点白名单。**功能语义**的跨宿主覆盖仍以 Luker 的真机用例
  （`test_pure_db_full_journey` / `test_night_features` / `test_graph_view`）为主，
  另外三宿主尚未各跑一遍完整功能套件。
- **界面落点依赖宿主 DOM 的一处结构**：入口按钮挂在输入框那排工具图标（`#leftSendForm`），
  依据是 Luker 自己的扩展菜单按钮也挂在那里。宿主改这处结构会影响入口按钮（届时只影响入口，
  不影响弹窗与数据）。`Alt+B` 是不依赖 DOM 结构的那条路。
- **纯库模式下的「列举聊天」缺口**：接缝拦的是九条**按聊天键寻址**的路由；
  **列举类**（`/api/chats/search`、`/api/characters/chats`）不在其中——
  纯库模式下源文件已移入回收站，依赖列举的第三方插件会看到「零个聊天」。
  处置方向见[插件生态](/guide/plugin-ecosystem)。
- **多插件共存实测未做**（含「别的插件也补 `fetch`」的情形）→ 见[路线图](/dev/roadmap)。
- **宿主状态机制的对比评估在进行中**：本仓存储是否该改走宿主官方的聊天 / 楼层 / 角色状态机制，
  还没定论（关联仓的在途工作，不在本仓）。

## 失败与降级时的表现

- 能力检测在启动时跑一次并打印结果（`[chatfilesys] 能力检测: {...}`）。
- **缺什么降什么，一律不阻断加载**：任何一处检测失败都只记一条带前缀的日志，
  插件其余功能照常——被装进一个能力不全、甚至没联网的宿主时也必须能用。
- 降级必须**带原因**：不允许只留一个「降级了」的标记而不说为什么。原因挂在返回值上，
  不能只交给回调——回调在 worker 里没有接收者，那样会让故障看起来像一切正常。
