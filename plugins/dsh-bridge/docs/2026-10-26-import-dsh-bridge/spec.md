# Super Agent DSH 插件迁移

日期：2026-10-26。状态：已完成。

## 需求与验收标准

将 `agent-loop-core/clients/dsh-bridge` 迁入本仓库 `plugins/dsh-bridge`，保持插件身份、路由、客户端模块及用户数据位置。插件应独立安装、构建、检查和测试，并登记成熟度、skills 与来源。Learning 新增对应的整体产品设计，按四个主体模块整理已有行为，不新增业务功能。

Core 服务不迁移；SDK 和协议作为固定、可追溯的源码快照随插件构建。原路径保留兼容链接，现有 DSH profile 改用新插件路径时通过根安装器备份后切换。

## Tickets

| Ticket | 范围与验收 | 依赖 | 状态 |
|---|---|---|---|
| BRIDGE-1 | 检查原插件、上游 SDK、原数据位置和实际 profile 引用 | 无 | 已完成 |
| BRIDGE-2 | 迁移插件、保留兼容链接和来源哈希，独立构建 SDK | BRIDGE-1 | 已完成 |
| BRIDGE-3 | 更新两仓库入口、工作区和锁文件，补齐插件维护说明 | BRIDGE-2 | 已完成 |
| BRIDGE-4 | Learning 整体产品设计及总览可互相导航 | BRIDGE-1 | 已完成 |
| BRIDGE-5 | 根检查、测试、打包、Core 集成、宿主加载与 profile 切换验证 | BRIDGE-2、BRIDGE-3 | 已完成 |

## 问题与处理

- 用户所说的 `agent-core-loop` 实际为同级 `agent-loop-core`。本次只迁移主树插件，不处理 `agent-loop-core-subagent` 工作树。
- 插件原先依赖 Core 工作区隐式提供 SDK，且未声明独立构建和测试。保存客户端 SDK 与协议当前工作文件的哈希和提交，使用其公开入口构建 Host，运行包不依赖 Core 源码目录。
- 原 `check-package-builds` 用例属于 Core 仓库构建工具，移回原仓库 `scripts/test/`。上传和产物用例依赖真实 Core，实现独立 `test:core`，不将默认合成测试通过写成 Core 集成通过。
- 原目录中的两份 `.bak`／`.pre-clean` 源码临时副本保留在原仓库本机 `.tmp/dsh-bridge-migration-*`，不进入本仓库或分发包。
- Core 集成首次启动遇到 Chord 仅提供 ESM export、不能用 CommonJS `require.resolve` 解析的问题。测试配置现按包的公开 `./context` import export 解析，不使用私有实现路径；五项集成用例通过。
- 首次切换 desktop 被 DSH 0.2.1-rc.3 的兼容检查拒绝，安装器已恢复原配置。随后在实际 rc.3 的 Electron Node 中通过 Session／Scope、取消、消息结算、V4 回放及分发加载共 121 项检查，迁移版本升为 0.1.1，并在声明中增加 rc.3。重试正常安装成功，没有添加风险豁免。
- desktop 是 Electron 专属 profile，CLI `--dump-config` 拒绝导出其配置；改用受支持的 `dsh plugin --profile NAME list @super-agent/dsh-bridge --json` 查询。desktop 和 web 均确认解析到新目录，不把配置导出失败写成组合配置验收通过。

## 验证与收尾

| 检查 | 结果与范围 |
|---|---|
| 根 `npm run check` | 通过，四个插件的身份、分发和语法／类型检查。 |
| 根 `npm test` | 通过，安装器 6 项、Design 96 项、OKR 1 项、会话可视化样例与服务检查；新插件默认测试 626 项通过、16 项按宿主前提跳过。 |
| 新插件 `test:core` | 通过，真实临时 Core 上的上传恢复与产物回传共 5 项，不调用真实模型。 |
| 新插件 `test:host` | 通过，实际 DSH 0.2.1-rc.3、Electron Node 24.21.0，121 项通过、无跳过；不代表浏览器 UI 旅程。 |
| 全新目录 `npm ci`、根检查和测试 | 通过，没有同级 Core 源码、原 node_modules、dist 或本机业务数据。 |
| `npm pack --dry-run` | 0.1.1 包含 20 个文件，含 Host、全部客户端模块与 patch；不含测试、上游源码快照、导入记录、备份或业务数据。 |
| 原 Core 仓库检查 | 边界、类型、构建、全部六包的独立构建入口检查通过；移回的构建工具回归 11 项通过。未重跑范围外的全部 Core 业务测试。 |
| desktop、web profile 切换 | 均通过根安装器备份后切换到新目录；逐一比较完整 profile JSON，除插件依赖路径外其他配置和 bundle 顺序保持原样；两 profile 的实际插件包查询通过。 |
| 哈希与引用 | 原 Host、客户端和其他原测试内容保持导入哈希；仅清单、bundle 契约用例和构建工具用例归属按迁移需要调整。SDK 快照逐文件校验通过，本次相关的 31 处文档与 Learning 链接有效。 |
| 浏览器与本机历史 | 未执行完整桌面 UI／真实模型旅程，本插件也不迁入 Provider 历史；本次客户端源码未改。 |

Learning 整体产品设计位于 [SuperAgent插件/产品设计.md](../../../../../learning/原型设计/SuperAgent插件/产品设计.md)，按使用场景、核心功能、领域对象及关系、核心案例整理既有行为。实现路径、数据和迁移细节保留在本仓库；没有以纯迁移需求新增业务原型或讨论规则。

desktop 和 web 的成功切换备份分别位于本机 DSH 的 `plugin-backups/1792995222788-fa462849-9fde-4e00-8c57-b2070b4689b8`、`plugin-backups/1792995224545-450c9294-f00b-4841-bf65-8a1acca52d06`。这些恢复材料不进入 Git 或分发包。

保留本 spec、源码、必要测试、固定上游快照和来源记录；未搬入真实会话、模型凭据、运行缓存或测试截图。Core 服务及原数据位置保持原样，原插件路径的兼容链接保留。DSH 后续重新加载或重启时使用新安装路径，本轮没有主动中断正在运行的桌面会话。
