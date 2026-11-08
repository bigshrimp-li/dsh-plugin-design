# Super Agent DSH 插件

在 DeepSeek Harness 中提供独立的 Super Agent 工作区。用户在同一应用里管理工作目录、会话、任务执行、人工等待、模型与连接设置，同时保留 DSH 原生工作区、会话和模型选择。

本插件从 `agent-loop-core/clients/dsh-bridge` 迁入，包名仍为 `@super-agent/dsh-bridge`。Core 服务及其模型、工具和持久任务状态继续由原仓库维护，插件通过公开 SDK 连接服务。SDK 和协议的固定源码快照随插件构建。发行包含当前平台的 Go 二进制。Host 启动时探测、拉起并连接 Runtime。

插件支持 DSH 0.2.1-rc.5。连接支持后台任务的 Go Core 后，在 Conversation 的“后台任务”区域可转后台、查看退出码和分流日志、停止任务或创建有限期的周期检查。服务关闭新建时，已有任务仍可查看和停止。参见[宿主验收与操作说明](docs/2026-11-05-background-tasks/spec.md)和[后台任务 SDK 来源](provenance/sdk-background-tasks-2026-11-05.json)。

Go 提供 `delegationsV1` 时，可以在父任务详情中查看单条真实委派、区分子任务状态和报告交付，并仅取消选中的委派。见[委派管理与验收](docs/2026-11-07-delegation-details/spec.md)和[当前 SDK 快照](provenance/sdk-local-runtime.json)。

当前桌面的升级路径、14 张 ticket 和复验入口见[工作区 UI 与 Go 发布验收](docs/2026-11-07-workspace-ui/spec.md)。

## 安装与启动

用户安装当前系统和 CPU 对应的发行包后，打开 DSH 即可使用 Super Agent。DSH 自动启动本机 Go Runtime，通过同一 Unix 域套接字发送短 HTTP 请求并订阅 WebSocket。多个窗口、多个工作区共用一个 Go 服务。模型和凭据可在 Super Agent 设置中配置。

1. 将平台发行包 `.tgz` 解压到长期保留的插件目录。安装需要已安装的 DSH、PATH 中的 `dsh` 和 Node.js ≥ 22.19.0。发行包包含 Host、SDK 和平台 Go 可执行文件。
2. 进入解压后的 `package/`，执行 `node install.mjs --profile desktop`。脚本核对平台和二进制 SHA-256，备份并登记选定 profile 的 bundle。DSH 链接到该目录。测试 Web 版可将 profile 改为 `web`。
3. 重新打开 DSH，进入 Super Agent 并选择工作区。默认服务使用 `~/.super-agent/run/core.sock`。已有服务会被复用。显式停止服务后，重新加载插件可再次启动。启动日志在 `<home>/logs/runtime-launch.log`。

源码开发从仓库根执行 `./install.sh --plugin dsh-bridge --profile desktop`。生成新的发行包时，在插件目录设置 `SUPER_AGENT_RUNTIME_BINARY` 为对应平台 Go 可执行文件的绝对路径再执行 `npm pack`。开发者也可指定 `SUPER_AGENT_SOURCE_ROOT` 由 Go 与 C 编译器构建。已有分发目录可直接重新打包。当清单缺失且未指定来源时，构建脚本从相邻的 `agent-loop-core` 构建。

后续源码修改、安装与发布均以本目录为准。本地 Go 发行版本为 0.2.0。rc.5 已通过实际 Electron Host 下的 Session、Scope、取消、消息结算和 V4 回放回归。

## 数据存储

以下 `<home>` 默认为 `~/.super-agent`，设置 `SUPER_AGENT_HOME` 后改用指定根目录。

| 位置 | 内容 |
|---|---|
| `<home>/run/core.sock` | 本机 Go Runtime 的 HTTP/WS 连接；`SUPER_AGENT_SOCKET` 可覆盖 socket 路径。 |
| `<home>/dsh-targets.json` | 原 HTTPS 目标的归档记录，包含敏感凭据，升级保留。 |
| `<home>/bridge/sessions.json`、`inputs.json` | 原生 Session 与 Thread／Conversation 的兼容关联及输入回执。 |
| `<home>/dsh-content-uploads/` | 本机 UDS 连接的上传候选、内容块、操作与回执。 |
| `<home>/dsh-artifact-applies/` | 本机 UDS 连接的产物回传与冲突处理日志。 |
| `<home>/targets/<摘要>/` | 按持久实例标识分区的本机上传缓存和回传记录。 |
| `<home>/task-receipts/`、`<home>/targets/<摘要>/task-receipts/` | 按实例隔离的后台命令回执缓存。Host 保存已接收的回执摘要，读取时重新向 Core 核对当前身份及资源归属。 |
| DSH 浏览器 `localStorage` | `super-agent.space.v1` 及各入口后缀 key，保存界面与草稿等本机状态。 |
| `<home>/logs/runtime-launch.log` | Go 启动诊断，包括二进制和锁错误。 |
| 用户选择的工作目录 | 任务输入来源，以及用户明确选择回传的目标文件；插件按原有版本和冲突检查写入。 |

Core 的会话、运行、事件、配置和模型数据仍由 Core 服务在原数据目录中管理。本次迁移不移动业务数据，不改存储 key，不将文件放入仓库 `.scratch/`。清理开发材料时保留上述用户数据和恢复记录。

设置使用与任务执行相同的本地 UDS 读取和修改配置。查看或修改模型时核对当前目标和基于的版本；版本冲突后重新审阅保留的草稿。丢失配置回执时使用“查询原操作”，界面读回同一实例的激活版本后再显示成功。

周期检查默认创建后立即开始，也可选择等待一个间隔。提交前界面将原授权、绝对截止时间和请求编号保存在当前操作分区。结果待确认时可先查询原回执，或明确选择重试原操作；页面刷新不会替用户重新发送命令。本地服务按持久实例和操作者分开保存回执。服务重启后仍可核对原操作。

## 持续目标

版本 0.1.2 增加 Go runtime 的持久目标入口。Core 必须明确声明 `runtimeFeatures.goalsV1`；不支持该功能的旧 Core 返回 `NOT_SUPPORTED`，插件保留草稿。

1. 在输入框发送 `/goal 修复登录并通过测试 --budget 200000`。预算是整个目标的累计 token 上限。创建目标沿用已选择的附件、Skill、上下文预检与文件输入。
2. 使用 `/goal status` 查看目标。目标卡片显示阶段、当前任务、完成项、下一步、已结算用量、预留和未确认占用。暂停或取消的请求回执只表示服务已接收，卡片等服务确认状态后更新。
3. 使用 `/goal pause`、`/goal resume`、`/goal cancel` 控制当前目标。`/goal budget +100000` 提高累计上限，之后显式恢复；`/goal update 新说明` 修改已暂停目标。已完成、已取消和失败目标不会重新打开。
4. 选择“补充当前目标”后发送文字，插件调用独立 steer API。选择“发送新任务并暂停目标”后，文字仍是普通新任务。目标控制和补充不隐式丢弃当前所选材料；需要先处理材料。

以保留子命令开头的目标可写成 `/goal --budget 200000 -- status 检查与修复`。`//goal status` 发送字面文字。创建目标必须有正整数预算，非法参数会保留草稿并说明原因。

未确认的目标操作保存于原 `super-agent.space.v1` 浏览器存储及原 Core 入口分区。重试沿用原 goalId、requestId、expectedRevision 和完整载荷，不能将原命令转交给新目标或另一个服务。

实现与验收见 [持续目标 spec](docs/2026-10-27-goal-command/spec.md)。

## 开发与验证

在本插件目录执行：

```sh
npm run check
npm test
SUPER_AGENT_SOURCE_ROOT=/absolute/path/to/agent-loop-core npm run test:core
SUPER_AGENT_SOURCE_ROOT=/absolute/path/to/built-agent-loop-core DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:goal-host-core
SUPER_AGENT_SOURCE_ROOT=/absolute/path/to/built-agent-loop-core DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:background-host-core
SUPER_AGENT_SOURCE_ROOT=/absolute/path/to/built-agent-loop-core DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:settings-host-core
DSH_ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" npm run test:host
npm run test:local-startup
npm pack --dry-run
```

默认测试使用固定 SDK 与合成数据，不需要 Core 源码。`test:core` 另需包含独立 Go 服务二进制的 Core 工作树，覆盖上传恢复与真实 Core 产物回传；`test:host` 使用实际 DSH Electron Node 检查分发加载、Session／Scope 路由、取消、消息结算和 V4 回放。非标准安装位置可用 `DSH_INSTALL_ROOT` 指定实际 DSH 包根目录。浏览器交互与真实模型旅程分别报告，不包含在这些检查中。

`test:goal-host-core` 额外要求 Core 的`go-runtime/bin/super-agent-runtime` 已构建。该检查在真实 DSH Electron Node 中，通过插件 Host 与公开 SDK 调用真实 Go Goal；模型只连接本机合成 fixture，覆盖工具证据、评估、独立审核、完成与运行中取消，不产生外部模型费用。

`test:local-startup` 从真实 npm 发行包向临时 DSH profile 安装，启动两个 DSH 进程，验证同一服务上的两个工作区、事件过滤以及关闭和重开。验证范围见[本地 Go Runtime 迭代说明](docs/2026-11-08-local-go-runtime/spec.md)。

目录边界见 [AGENTS.md](AGENTS.md)。迭代 spec 保存在本插件 `docs/YYYY-MM-DD-<主题>/spec.md`。来源和原文件哈希见 [导入记录](provenance/import-2026-10-26.json)。上游 SDK 与协议按固定快照单向更新，修改后重新构建并验证协议兼容。

## 整体产品设计

[Learning 产品设计](../../../learning/原型设计/SuperAgent插件/产品设计.md) 记录使用场景、核心功能、领域对象及关系、核心案例。实际提出的新产品需求在 Learning 的对应需求目录讨论与保存 UI 原型；开发 tickets、进度、问题和验收留在本插件 spec。
