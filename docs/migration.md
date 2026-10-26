# 多插件仓库迁移

迁移日期：2026-10-26。仓库远端与本地根目录名称保持不变，定位调整为 DSH Plugins。

| 插件 | 原代码位置 | 新代码位置 | 保留包名 |
|---|---|---|---|
| Design | 当前仓库根目录 | plugins/design | @local/dsh-plugin-design |
| OKR | /Users/bytedance/worskpace/dsh-okr-schedule-plugin | plugins/okr-schedule | @local/okr-schedule |
| Session Visualizer | /Users/bytedance/worskpace/learning/代码/Agent_Session_Visualizer | plugins/agent-session-visualizer | @local/agent-session-visualizer |

两个外部原目录替换为兼容符号链接。当前 desktop profile 的三个依赖改为新子目录，bundle 名称和顺序保持兼容；其他 profile 不作批量安装。原始 profile 配置备份与测试日志保留在本机 .scratch/multi-plugin-migration，安装器另有持久恢复记录。

Design 原有源码、文档、示例和测试整体保留，新增 patch 分发声明。原未跟踪的通用交互测试随插件保留；硬编码本机地址的截图脚本保存在本机任务材料中。构建和测试始终以插件目录为工作目录。

OKR 按现有 2.3.0 工作文件导入，没有可合并的独立 Git 历史。Session Visualizer 保留当前工作文件，包含其祖先学习仓库尚未提交的 DSH 集成；来源提交不能代替工作文件哈希。两份导入记录位于 imports/。

本机数据位置保持兼容：Design 使用 ~/.design，OKR Host 使用 ~/.dsh_okr，Session Visualizer 只读 Provider 历史。Session Visualizer 原 data/session-graph.json 随本机目录移动，但不提交、不打包；原调试截图移入 .scratch/。

OKR 页面当前采用 initialData 与 React 内存状态。Host 三个工具独立读写 ~/.dsh_okr，数据连接和真实 AI 抽屉不属于此次目录迁移。Session Visualizer 的本机历史测试和摘要能力分别依赖本机历史与本地模型服务，不将样例测试通过表述为全部 Provider 已实测。

验证命令及结果写入 validation.md。环境相关原始日志和截图仅保存在本机，不提交真实会话材料。

实机验收时发现 Session Visualizer 的原 frame-ancestors * 不匹配 DSH 自定义协议，导致内嵌页空白。已显式允许 dsh-app://app 与本机页面，并增加响应头回归；插件版本更新为 1.0.1。Design 通过当前宿主测试后补充 0.2.1-rc.3 兼容声明，版本更新为 0.1.1。本机已有 skills 使用 --keep-skills 保留。
