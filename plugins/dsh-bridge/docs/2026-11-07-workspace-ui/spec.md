# DSH 工作区：使用 Go 能力完成一次任务

用户从 DSH 左栏进入 Super Agent，选择模型和工作目录，发送输入，在所属 Run 旁回答问题或批准动作。结束后可以从同一条消息查看文件差异、回传产物、打开 Trace，再返回原位置。DSH 的原生会话仍可使用。

## 兼容与安装

| 插件 | 官方宿主 | 行为 |
|---|---|---|
| 0.1.2 | 0.2.1-rc.3 | 历史升级起点。 |
| 0.1.2 | 0.2.1-rc.5 | 版本声明不匹配，宿主拒绝注册。不放宽检查。 |
| 0.1.3 | 0.2.1-rc.5 | 本次验收组合。插件公开分发入口保留原身份；执行、输入和控制按当前 Go 实例实际能力开放。 |

1. 先构建 Core 和插件。仓库根执行 `./install.sh --plugin dsh-bridge --profile desktop`，安装到当前 DSH。安装器备份 profile，再更新插件链接。保留其他插件与原生会话。
2. 重新加载 DSH。从左栏进入 Super Agent，在设置中选择实际执行目标。有可用的本机 UDS 时可以执行会话；修改实例配置需要已配对的 HTTPS。当旧实例不可达或配对失效时，修复该连接或添加一个可用的 Go 连接。新连接不会迁移或删除旧实例业务数据。
3. 升级前保留原插件、安装器生成的备份及原服务数据。需要回退时，按原安装记录恢复插件链接和 profile 配置，使用与旧版兼容的宿主；不要清空 DSH profile、Core 数据或草稿存储。在 rc.5 退到 0.1.2 会重新触发版本拒绝。

## Ticket 与验收依据

运行状态以 Core 持久事实为准。命令成功回执表示接收；产生文件、完成任务、报告到达父任务或设置生效都需要分别回读。

| Ticket | 用户可以验证的结果 | 验证路径 |
|---|---|---|
| SA-01 安装 | 当前 rc.5 有独立入口，原生会话仍可打开；历史版本不豁免。 | 当前桌面；正式旧版与候选包的安装升级检查。 |
| SA-02 无实现的动作 | 旧诊断面板的启动、重启、打开配置目录、模型/权限切换、查看/取消委派七个入口移除。模型与权限在输入区调整；委派从真实父任务进入。 | 正式入口、键盘可达性与配置冻结回归。 |
| SA-03 等待 | 在输入区按轮次定位问题、审批或补件。焦点只在用户选择后移动；动作和回执按原 waitId 处理。 | 当前桌面问答、允许与拒绝；同 Thread 的两条 Conversation、重新连接及控件测试。 |
| SA-04 Thread | 暂停、恢复、停止明确作用于整个 Thread。确认列出现有 Run、等待和计划；未知数量不推测。恢复按用户选择继续或处理排队输入。 | 当前 Go 双 Conversation 同时等待，pause/resume 两项排队输入，stop 后两项等待与计划全部取消。 |
| SA-05 Goal | 能力缺失时保留草稿；支持时可创建、暂停、补充、调预算、恢复和永久取消。永久取消需确认具体目标。 | 当前 Go 暂停、补充、调预算和取消后重连；真实 DSH Host 执行工具、审核与完成回归。 |
| SA-06 主题和窄面板 | 等待、Goal、Trace 与输入区使用宿主色值；实际内容宽 390px 时也能选版本、文件、用途并提交。 | 正式 rc.5 组件、深浅主题、1200×800、390×844、宽宿主内 390px 面板；正文、次要文字、说明与占位符实测均高于 4.5∶1。 |
| SA-07 输入 | 附件、项目文件、Skill、预检分别判定；读取失败可重试，换实例废弃旧响应。排队新任务与补充已有任务分开。 | 真实桌面选模型、挂载文件、Go 预检和最终回答；能力组合与目标 Run 选择回归。 |
| SA-08 设置 | UDS 执行连接和 HTTPS 管理连接分别显示。配置基于版本提交；冲突保留草稿，丢回执查询原操作，激活后再报成功。 | [真实设置 Host 用例](../../test/host/settings-host-core.test.mjs)。 |
| SA-09 后台任务 | 读取、创建和单条记录的动作分别检查。创建关闭时仍可读取旧计划。stdout/stderr 分流、游标独立、退出码取服务事实。 | [后台任务说明与真实断线回归](../2026-11-05-background-tasks/spec.md)。 |
| SA-10 周期计划 | 持久保存原请求和绝对到期时间，重连先核对，未确认不自动重放。详情同步暂停、恢复、取消。 | 当前 Go 丢失创建回执后只出现一个计划，最终卡片与详情一致，已取消且没有下次检查。 |
| SA-11 标题和分支 | 标题优先用服务显式值，否则由主对话最早的用户输入产生。分支标出来源，可一步回主对话，草稿按 Conversation 保留。 | [两个独立客户端访问同一 Go Thread](../../test/host/workspace-navigation-host-core.test.mjs)。 |
| SA-12 文件与 Trace | 消息旁直接打开所属 Run 的快照。回传前指定目的地，本机冲突可另存；返回 Diff/Trace 时还原草稿及触发按钮焦点。 | 当前桌面真实写入和拒绝、逐行差异、回传、Trace 返回；两个 Run 的不同快照及回传冲突回归。 |
| SA-13 发布验收 | 原生桌面、Host 与 Go、组件宽度验证分别记录；普通用户路径使用当前桌面。历史升级和故障注入另用专用数据。 | 本页验证命令和发布检查；历史评审截图不计为本次通过。 |
| SA-14 委派 | 在父任务查看真实委派的子任务状态与报告交付，按 Go 返回的 allowedActions 操作单条记录。 | [委派接口、权限和回执](../2026-11-07-delegation-details/spec.md)；[Core 配套 MR](https://github.com/bigshrimp-li/agent-loop-core/pull/6)。 |

## 复验

- 仓库根：`npm run check`、`npm test`。插件目录：`npm pack --dry-run`。
- 使用已构建的 Core checkout 设置 `SUPER_AGENT_SOURCE_ROOT`；使用官方 DSH Electron 设置 `DSH_ELECTRON`。在插件目录分别执行 `npm run test:host`、`npm run test:core`、`npm run test:goal-host-core`、`npm run test:background-host-core`、`npm run test:settings-host-core`、`npm run test:workspace-host-core`、`npm run test:delegation-host-core`。这些入口与默认单测分别执行。
- 日常人工复验使用当前 DSH 的目标和模型。选择合成附件，检查预检后发送，处理问题与写入审批，从已完成消息查看差异、回传、Trace 并返回。另起一轮拒绝写入，在所属 Run 的产物清单核对零项。
- 历史升级要在官方 rc.3 写入旧草稿，再用相同的历史 profile 在 rc.5 运行；不能降级正在使用的个人桌面。按[原生分发验证说明](../../test/desktop/README.md)执行 `npm run test:desktop-install`：全新 rc.5 的输入框向专用 Go 发消息，核对回复的持久 Run；再检查旧版拒绝和原数据保留。设置冲突与故障注入使用测试记录。真实界面截图、个人历史、模型凭据不进入 Git 或分发包。

### 正式桌面所选 HTTPS Go 服务的控制回读

2026-11-07 在桌面当前配对的本机 7444 HTTPS Go Core 上，使用已安装插件的 Host 和公开 SDK 运行了[显式验收入口](../../test/desktop/live-thread-controls.mjs)。每次执行都创建带“验收”标题的新 Thread。该入口需显式传入选中的 HTTPS origin、场景名和报告的绝对路径；不会随普通测试运行。

- **SA-03**：在主 Conversation 与 fork 分别形成真实 ask_user 等待。重建 Host 后读到相同 waitId。回答主线后，fork 中另一个 Run 的等待仍是 waiting，同 requestId 返回原回执。独立的周期计划审批有持久到期时间。重连后拒绝，Go 返回 answered 和 decision=deny，原 Run 随后 completed，计划数为零。permission 类型的 answer 字段可保存拒绝理由，展示时应看 kind 和 decision。
- **SA-04**：暂停带有两个活动等待、两个排队输入的 Thread，回读为 paused_by_user。恢复时显式选择一项 drop、一项 run，continueRunIds 为空，startedRunIds 也为空；所选 Run 会等占用该 Conversation 的先前 Run 结束。再次在两个 Conversation 各产生一个等待，且 fork 有未首发的计划。停止 Thread 后，两个 Run、两个 Wait 和计划均为 cancelled；Thread 本身回读为 paused_by_user。重连后沿用原停止请求，收到相同回执。当前 activeRuns 和 waiting 均为零。
- **SA-05**：新 Goal 暂停后回读 paused，累计 token 限额从 20,000 提高至 20,500，补充说明后仍为 paused。恢复后回读 running，永久取消后回读 cancelled。同键重放暂停、取消都得到原回执；此控制场景实际模型请求与已结算 token 均为零。
- **当前桌面的文件与长历史**：真实附件预检后，模型问到了文件里的验收口令。允许写入的 Run 有一个新增文件，差异为三行，回传后实际字节一致；随后拒绝写入的 Run 产物清单为空。四轮完成后，第五轮提问可从输入区一次定位；切走后恢复同一个等待，回答后归档。进入第五轮 Trace 再返回，焦点回到该消息的按钮，未发送草稿逐字保留。
- **覆盖边界**：当前服务对无工作区的 bash 提案在工具环境解析阶段结束，未产生审批。另以计划提案验证拒绝，以专用验收目录验证实际写入。补交缺失文件另用真实 Go 和公开 SDK 测试；正式服务未人工等到审批超时。确认弹窗退出与窄屏布局另有界面测试。
