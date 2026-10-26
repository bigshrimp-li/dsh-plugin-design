# Agent Session Visualizer 维护规则

## AI规则与临时任务

- AGENTS.md 只保存 AI 维护指令，不附引用或被引用清单，不参与知识关系统计。
- AI 的临时方案、检查日志和截图统一放本仓库根 .scratch/；不进入 Git 或分发包。
- 正式知识、可运行源码和最终同步所需清单不以 temp 为唯一副本。临时资料库建设文档不保留为长期主题正文。

本项目继承仓库根 AGENTS.md。保留通用 Session Graph 与各 Provider 适配器的边界。

- 会话读取保持只读，不修改 Codex、Claude、Grok 或其他 Provider 的原始历史。
- 移动代码后先运行 npm test；本机历史与浏览器回归另有环境前提，不把 fixture 通过称为全部 Provider 已实测。
- 真实会话快照不进入 Git；浏览器回归截图默认写仓库根 .scratch/。
- 保留未落盘提示词、继承上下文、子 Agent 关联和截断信息的来源边界，不补造原始数据。
