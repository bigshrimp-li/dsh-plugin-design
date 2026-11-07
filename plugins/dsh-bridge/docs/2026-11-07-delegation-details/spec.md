# 任务详情中的委派管理（SA-14）

用户在「父子任务与报告交付」中选择父 Run，打开「本任务发出的委派」，然后选择真实委派 ID。详情分别显示子任务状态、报告交付和父任务处理。同步委派没有异步报告交付记录时，请查看任务轨迹；界面不根据子任务终态推断报告已处理。若另一个后续 Run 接收报告，界面显示该 Run，不归功于原父任务。

- 公共 SDK：Go 声明 `delegationsV1` 后，插件使用 `client.delegations.list/get/cancel`。缺少客户端模块或运行时能力时，原任务图和 Trace 仍可只读查看。
- 归属：Go 校验父 Run 的输入 actor。Host 另核对 Thread、Conversation、Run、委派 ID 和操作者所在的服务实例。错误会展示在详情中；无权读取时清除先前读取的委派。
- 取消：详情返回 `allowedActions` 中的 `cancel` 才显示取消按钮。对于一个不能重复创建的委派，界面根据真实 ID 生成稳定 requestId；断线或 Host 重连后重试仍指向原操作。界面先报告服务接收，再以回读结果显示子任务状态。
- 验证：独立可重复的 DSH Electron Host → 固定 SDK → 真实 Go Worker 验收使用本机受控模型。运行 `SUPER_AGENT_SOURCE_ROOT=/绝对路径/agent-loop-core npm run test:delegation-host-core` 前先构建该 Core 的公开 dist 和 Go Worker。两项用例分别覆盖同步取消／同键回执／错对象和异步报告由另一个 Run 接收处理。另有交互单测覆盖回执先于终态、断线重试和拒读后的降级。
- 版本：实际宿主为 DSH 0.2.1-rc.5、Electron 44.7.0。来源见[SDK 快照](../../provenance/sdk-delegations-2026-11-07.json)。测试仅使用临时数据，不需要外部模型凭据。
