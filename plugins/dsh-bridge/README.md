# Super Agent DSH 插件

在 DeepSeek Harness 中提供独立的 Super Agent 工作区。用户在同一应用里管理工作目录、会话、任务执行、人工等待、模型与连接设置，同时保留 DSH 原生工作区、会话和模型选择。

本插件从 `agent-loop-core/clients/dsh-bridge` 迁入，包名仍为 `@super-agent/dsh-bridge`。Core 服务及其模型、工具和持久任务状态继续由原仓库维护，插件通过公开 SDK 连接服务。SDK 和协议的固定源码快照随本插件构建，因此安装插件不要求旁边另有 Core 源码；实际执行任务仍需要运行中的兼容 Core。

## 安装与运行

1. 准备 Node.js ≥ 22.19.0、npm 和 DSH，在仓库根目录执行 `npm ci`。
2. 在根目录执行 `./install.sh --plugin dsh-bridge --profile desktop`。安装器先构建并备份配置，再链接插件，保留其他插件配置。
3. 重新加载插件或重启 DSH，从 Super Agent 入口进入。选择并配对已有 HTTPS Core；未选择远端时保留原有本机 UDS 兼容连接。Core 不可用时页面说明连接状态，不伪造任务结果。

原有 `agent-loop-core/clients/dsh-bridge` 路径保留为本机兼容链接。后续源码修改、安装与发布均以本目录为准。迁移版本为 0.1.1，DSH 兼容声明为 `0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3`；新增 rc.3 声明前，已使用其实际 Session、Scope、Agent 与 V4 回放接口通过现有宿主回归。该检查不等于完整 UI 与真实模型旅程验收。

## 数据存储

以下 `<home>` 默认为 `~/.super-agent`，设置 `SUPER_AGENT_HOME` 后改用指定根目录。

| 位置 | 内容 |
|---|---|
| `<home>/run/core.sock` | 原本机 Core 连接；`SUPER_AGENT_SOCKET` 可覆盖 socket 路径。 |
| `<home>/dsh-targets.json` | HTTPS Core 入口、配对信息与选中项，包含敏感凭据，不提交或分发。 |
| `<home>/bridge/sessions.json`、`inputs.json` | 原生 Session 与 Thread／Conversation 的兼容关联及输入回执。 |
| `<home>/dsh-content-uploads/` | 本机 UDS 连接的上传候选、内容块、操作与回执。 |
| `<home>/dsh-artifact-applies/` | 本机 UDS 连接的产物回传与冲突处理日志。 |
| `<home>/targets/<摘要>/` | 各 HTTPS Core 实例的本机上传缓存和回传记录，按入口与实例隔离。 |
| DSH 浏览器 `localStorage` | `super-agent.space.v1` 及各入口后缀 key，保存界面与草稿等本机状态。 |
| 用户选择的工作目录 | 任务输入来源，以及用户明确选择回传的目标文件；插件按原有版本和冲突检查写入。 |

Core 的会话、运行、事件、配置和模型数据仍由 Core 服务在原数据目录中管理。本次迁移不移动业务数据，不改存储 key，不将文件放入仓库 `.scratch/`。清理开发材料时保留上述用户数据和恢复记录。

## 开发与验证

在本插件目录执行：

```sh
npm run check
npm test
SUPER_AGENT_SOURCE_ROOT=/absolute/path/to/agent-loop-core npm run test:core
DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:host
npm pack --dry-run
```

默认测试使用固定 SDK 与合成数据，不需要 Core 源码。`test:core` 另需已安装依赖的 Core 源码，覆盖上传恢复与真实 Core 产物回传；`test:host` 使用实际 DSH Electron Node 检查分发加载、Session／Scope 路由、取消、消息结算和 V4 回放。非标准安装位置可用 `DSH_INSTALL_ROOT` 指定实际 DSH 包根目录。浏览器交互与真实模型旅程分别报告，不包含在这些检查中。

目录边界见 [AGENTS.md](AGENTS.md)。迭代 spec 保存在本插件 `docs/YYYY-MM-DD-<主题>/spec.md`。来源和原文件哈希见 [导入记录](provenance/import-2026-10-26.json)。上游 SDK 与协议按固定快照单向更新，修改后重新构建并验证协议兼容。

## 整体产品设计

[Learning 产品设计](../../../learning/原型设计/SuperAgent插件/产品设计.md) 记录使用场景、核心功能、领域对象及关系、核心案例。实际提出的新产品需求在 Learning 的对应需求目录讨论与保存 UI 原型；开发 tickets、进度、问题和验收留在本插件 spec。
