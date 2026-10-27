# Super Agent DSH 插件维护规则

继承根 [AGENTS.md](../../AGENTS.md)。先读 [README.md](README.md) 和 Learning 的 [整体产品设计](../../../learning/原型设计/SuperAgent插件/产品设计.md)。本目录维护 DSH 客户端，不承接 Core 服务实现。

## 目录职责

| 路径 | 内容与维护入口 |
|---|---|
| `src/host/` | DSH Host 路由、Core 连接、Session 关联、上传与产物回传。 |
| `src/client/` | 浏览器模块、独立工作区、任务轨迹、设置与文件决策界面。 |
| `upstream/client/`、`upstream/protocol/` | Core 公开 SDK 与协议的固定源码快照，只按确定版本从原仓库单向同步，不在插件中派生协议。 |
| `scripts/` | 独立构建、语法检查及 Core 集成测试入口。历史 `install-alc-profile.sh` 只供隔离 profile 回归；日常安装使用根 `install.sh`。 |
| `test/` | 客户端和 Host 合成测试；依赖真实 Core 实现的两个文件由 `test:core` 单独运行。 |
| `dist/` | Host 与 SDK 的构建产物，不手改、不提交。客户端模块仍由原路径提供。 |
| `docs/` | 本插件的迭代 spec、tickets、进度、问题与验证结果。 |
| `provenance/` | 原插件及 SDK 快照的来源、提交与文件哈希。 |

## 边界与数据

1. 保留包名与客户端 ID `@super-agent/dsh-bridge`、Loader ID `super-agent-bridge`、`/super-agent` 路由、现有 slot key 和 `super-agent.space.v1` 存储 key。
2. 默认数据根目录为 `~/.super-agent/`，可用 `SUPER_AGENT_HOME` 覆盖；socket 可用 `SUPER_AGENT_SOCKET` 覆盖。连接凭据、会话关联、上传缓存和产物回传记录的具体位置见 README，不放 `.scratch/`，不进入 Git 或分发包。
3. Host 对 Core 的依赖只经公开 SDK；Core 的持久业务状态、模型和工具循环继续在 `agent-loop-core` 管理，不搬入插件。修改接口时先核对上游 SDK 与协议，再更新快照和来源记录。
4. 保留原生 DSH 工作区、Agent 和模型选择；独立 Super Agent 工作区不得接管原生会话。状态变更沿用调用方生成的 `requestId`，不得因传输重试创建新操作。
5. `unknown` 结果、人工等待、上传恢复和产物冲突保留原有边界，不将请求已接收当作任务完成，不以当前来源替代已捕获的上传内容。

## 验证与收尾

1. 根目录执行 `npm run check` 与 `npm test`；本目录可执行 `npm test`。默认测试不要求 Core 源码、真实历史或模型服务。
2. 改动 SDK、上传或产物回传时，设置 `SUPER_AGENT_SOURCE_ROOT` 后在本目录执行 `npm run test:core`，该检查启动临时 Core 并使用合成文件，不调用真实模型。
3. 修改打包或 Host 入口时，执行 `npm run build`、`npm pack --dry-run`，并用 `DSH_ELECTRON` 指定实际 DSH 可执行文件运行 `npm run test:host`。该检查验证实际宿主 Node 加载及 Session／Scope、取消、消息结算与 V4 回放接口，不代表完整 UI 旅程通过。扩展宿主兼容版本前先运行对应版本的实际接口回归，不使用风险豁免替代兼容验证。
4. UI 和真实 Core／模型旅程按变更范围单独验证。结果写入本插件 spec；长期产品规则进入 Learning，具体接口、存储和部署说明留在本仓库。
