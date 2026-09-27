---
layout: home

hero:
  name: ChatFilesys
  text: 聊天文件系统
  tagline: 把「分支」从整文件复制变成聊天数据内的结构化组织 —— SillyTavern（及 Luker 分支）第三方前端扩展，零核心修改
  actions:
    - theme: brand
      text: 指南
      link: /guide/
    - theme: alt
      text: 开发文档
      link: /dev/

features:
  - title: 分支是数据，不是文件副本
    details: 原生「创建分支 / 创建检查点」会被接管：不再复制整份聊天文件，而是在同一份聊天数据内记成一棵树上的结构关系。
  - title: 三种存储模式
    details: JSONL 增强（事实源是磁盘上的标准文件）/ 纯数据库（事实源在库，可只存引用）/ 双写（库为准，同时维持一份标准文件）。弹窗里三选一。
  - title: 三档存储后端，自动降级
    details: Authority SQL（真分片库）→ 官方通道（隐藏聊天容器）→ IndexedDB（仅缓存）。任一层不可用都不阻断使用。
  - title: 导出仍是纯标准 JSONL
    details: 导出的文件就是原生酒馆能直接打开的标准聊天文件——不引入私有格式。
---

## 这个文档站是什么

这里是 ChatFilesys 的完整文档：**每个功能一页**，每页都写清它做什么、怎么用、
**边界与未做到**、以及失败或降级时的表现。

> 本页是站点首页。功能文档在[指南](/guide/)，架构与开发说明在[开发](/dev/)。
> 已有的几份长文档（纯数据库模式说明、迁移计划等）在左侧「其他文档」里。