# Go 后台任务宿主接入

BG-10、BG-13、BG-16 使用公开 SDK 读取当前 Conversation 的任务。控制请求以用户点选时的版本提交，界面按持久事实刷新。验收包括任务编号、停止回执与退出事实、独立日志游标、事件重连，以及监控与计划的能力协商。

2026-11-05 在 macOS ARM64 的 DeepSeek Harness 0.2.1-rc.5 / Electron 44.7.0 执行了 4 个实际 Host 测试。插件使用分发包中的公开 SDK，经 Core Server 连接真实 Go Worker，模型为本机受控 HTTP 服务。

- Shell 的原 Run 拿到编号后结束。退出屏障仍关闭时，用户能从同一 Conversation 得到“2 加 2 等于 4”。重新连接 Host 后，以原 stdout 游标接着读到剩余字节。释放屏障得到退出码 7、独立 stderr 和已处理的一次交付；持久事件游标能补读终态，进程哨兵仍只有一次启动。
- 日志监控在 Shell 退出前收到一条完整匹配并通知原 Conversation。用户停止监控，Host 确认其已取消。
- 创建“每 5 分钟检查 PR #42”的计划，重放同一创建请求取得原回执。首发产生一个独立 Conversation 和已完成的检查 Run，报告 CI 已通过并停止。另一未首发计划通过暂停、恢复及取消验证。
- 原 Goal 的建立、真实工具执行、模型评估、独立验证及取消回归也通过。受控模型按语义识别用户输入，不将附加的运行时编排上下文误认作新的请求。

复验时先构建对应版本的 Core dist 和 Go Worker，在插件目录设置 `SUPER_AGENT_SOURCE_ROOT`，运行 `npm run test:background-host-core`；原 Goal 的回归入口为 `npm run test:goal-host-core`。Host 的运行证据来自 Electron Node 加载分发代码，与桌面渲染及真实远端模型验收分开记录。

同日将插件安装到隔离的 `alc` 配置，打开 DSH 0.2.1-rc.5 正式工作区页面。页面在同一 Conversation 同时显示“命令 · 运行中”、stdout 的 READY、“2 加 2”的回答 4，以及一条 stderr 匹配。释放 Shell 退出屏障后，任务卡变为“失败 · 退出码 7”。整页刷新并重新选中该 Conversation，任务编号未变，stdout 从已读位置开始，stderr 可独立读取 ERROR test failed。页面验收使用浏览器加载 DSH 正式客户端；Electron Host 的自动验收见上文。

新建周期检查需提供对象、检查内容、停止条件、间隔和有效期。关闭计划新建后，表单隐藏，已存在计划仍按当前用户的权限显示。点击“计划详情”可查看间隔、期限、额度及历史子检查。
