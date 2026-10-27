# 持续目标命令与目标卡片

日期：2026-10-27。范围：DSH 插件 0.1.2。设计依据为用户已授权实施的 [Go runtime 方案](../../../../../agent-loop-core/docs/requirements/goal-command/README.md)。Core 管理目标、预算与执行，插件只调用公开 SDK，不派生协议或模型循环。

## Tickets 与验收

| ID | 范围 | 状态 | 验收条件 |
| --- | --- | --- | --- |
| G-DSH-1 | Host goal.* actions、能力检查及 SDK 快照 | 已实现 | 只走公开 client.goals；缺失 goalsV1/方法时 NOT_SUPPORTED；所有写操作必须提供 requestId 和修订 |
| G-DSH-2 | slash parser 与材料预检 | 已实现 | 创建、查询、暂停、恢复、取消、预算、修改；引号、参数、字面转义与非法数值；创建保留原材料和预检签名 |
| G-DSH-3 | 目标卡片与显式补充 | 已实现 | 展示服务状态、完成项和预算；未确认显示未知；steer 与普通新任务分开；不把回执当完成 |
| G-DSH-4 | 固定操作恢复与事件刷新 | 已实现 | 请求前持久保存原载荷；重试不改目标/修订/预算/requestId；跨目标拒绝重放；旧快照不回退；事件去重 |
| G-DSH-5 | 检查、打包及实际宿主验证 | 已完成 | 正式目录 check/test/build/pack、DSH Host smoke、合成浏览器交互分别记录 |

产品增量设计与真实组件离线原型见 [Learning 持续目标需求](../../../../../learning/原型设计/SuperAgent插件/需求/2026-10-27-持续目标/产品设计.md)。产品总文档的既有迁移内容保持原状，需求记录为已定稿、未融合。

## 接口与状态

Host 提供 `goal.create/list/get/status/update/steer/pause/resume/cancel`。其中 status 是 get 的本机别名。create 保留 preparedAttachments、selectedSkillRefs、previewId/previewSignature、materials、selectedSkillIds、fileInput/fileBranchId。所有路由经同一 Core service 和目标入口选择。

浏览器解析用户输入框里的命令。模型输出、工具结果和聊天历史不会经过解析器。创建预算必须是正安全整数；目标控制命令与 steer 不发送所选附件，避免静默遗漏材料。创建使用原附件预检流程，预检正文为解析后的目标正文。

目标卡片按服务返回的 status 显示“正在暂停”和“正在结束”。预算余额为 totalTokens - settledTokens - reservedTokens 的非负值；uncertainTokens 是 reservedTokens 子集，只单独展示，不再扣一次。estimatedTokens 是 settledTokens 子集，卡片显示“含估算 X token”，不重复扣减。缺失账本字段显示“尚未确认”。

控制命令先写入原 Core 分区浏览器存储，再发请求。超时后保存原载荷。首次明确拒绝可以释放该命令；曾经结果未确认的命令，即使后续重试能力缺失，也不能据此认定原操作未发生。后续重试始终发送原 requestId/goalId/expectedRevision。

## 来源与 Git 边界

插件原始迁移基线保存在 `/private/tmp/goal-dsh-baseline`，100 个文件、2,174,922 字节，不含 node_modules/dist、凭据或用户数据。外部仓库 origin/main 当前 ca7dbc6 不含插件，唯一远程分支为 main。配套 MR 需要明确区分迁移依赖和本次 goal 增量，不能把其他插件已有未提交改动混入。

原始导入哈希记录不覆盖。SDK 与协议固定到主仓库已提交版本 `8680492cf07b98eb44e940fb075ba6cf69e1c793`，逐文件哈希在 `provenance/sdk-goals-2026-10-27.json`，kind 为 `repository-commit-snapshot`。

## 验证记录

1. 正式插件目录 `npm run check`、`npm test` 通过。最终为 31 个 test files 通过、2 个按既有环境条件跳过；643 条测试通过、16 条跳过。目标专项 17 条覆盖解析、公开 SDK、能力缺失、原载荷重试、存储失败、材料预检、事件、卡片和 Trace Goal 节点。
2. 常规 Node 运行时跳过 10 条真实取消、1 条真实 Scope、4 条真实会话结算及 1 条 V4 回放测试。这些测试要求实际 DSH Electron Node。设置 `DSH_ELECTRON=/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` 后执行 `npm run test:host`，最终 5 个文件、121 条测试全部通过，没有跳过。
3. `npm test` 已执行正式构建。`npm pack --dry-run --json` 通过；版本 0.1.2 的分发包包含 20 个必要文件，约 310 KB，不含用户数据、凭据、node_modules 或测试材料。
4. 外部仓库根目录 `npm run check` 与 `npm test` 均通过，覆盖已登记插件的工作区集成。未改其他插件已有源码或迁移内容。
5. 使用真实 React/ReactDOM 渲染实际 GoalCard，在本机 Chromium 上分别按 1100 px 与 390 px 宽验收。两种尺寸各通过 7 项检查：预算不重复扣未确认占用；暂停操作保留目标身份和修订；回执后显示正在暂停；排空期间不提前恢复；服务确认暂停后出现恢复入口；确认暂停后允许编辑；页面无横向溢出。另验证独立离线原型可渲染。合成页面未连接真实 Core 或模型，不能代替完整原生 DSH 目标旅程。
6. 客户端和协议快照与主仓库最终公开源码一致。根锁只对本插件 version 做 0.1.1 → 0.1.2；迁移需要的 registry/lock 由独立依赖提交交付，未混入本需求。

7. 新增可选 `test:goal-host-core` 入口。设置 `SUPER_AGENT_SOURCE_ROOT=/Users/bytedance/worskpace/agent-loop-core` 与实际 `DSH_ELECTRON` 后执行 `npm run test:goal-host-core`，使用实际 DSH 0.2.1-rc.3／Electron 44.7.0、已构建插件 Host、Core 公开 server/client dist、真实 Go 子进程及 loopback 模型 fixture。2 条集成测试全部通过：真实 bash 输出 → 评估 → 独立审核 → completed，验证 4 次模型请求共 60 token、原创建回执幂等；另一条先确认公开 execution=running 且工作目录启动 marker 已写入，再取消目标，并验证原控制回执幂等。没有 mock SDK、Go runtime 或 Goal 状态。该入口与常规 test:host 分开，要求已构建的 Core 和 runtime-worker，普通测试不强制加载它。

本次没有调用外部或收费模型，也没有在用户真实会话上提交命令。完整原生 DSH UI 旅程仍需单独验收；Core 的完整持久预算、恢复和自动推进由上游另行验收。迁移前基线、goal 增量清单及补丁保存在库外临时目录，源码 MR 分别列明迁移依赖与 goal 增量。
