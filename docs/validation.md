# 迁移验收记录

日期：2026-10-26。本机 DSH 版本：0.2.1-rc.3。下面分别记录通用测试、宿主测试和本机历史检查。

| 检查 | 结果 | 范围 |
|---|---|---|
| npm run check | 通过 | 三插件清单、唯一身份、分发配置和语法/类型 |
| npm test | 通过 | 安装器 6 项，Design 96 项单元检查，OKR 临时 HOME 读写，Visualizer 样例及服务响应头 |
| npm ci + npm test，全新目录 | 通过 | 无原 node_modules、构建产物或本机业务 data，使用公共 npm registry |
| Design DSH Electron 端到端 | 通过 | 85 项工具、编辑器、渲染与导出检查 |
| Design 浏览器回归 | 通过 | 24 项编辑器用例 |
| Design 空间回归 | 通过 | 10 项目录、重命名、会话与归档场景 |
| npm pack --dry-run | 通过 | 三包均含 cordis.patch.yml 和运行入口，不含本机 data/ 或 temp/ |
| desktop profile 切换 | 通过 | 三个 link 指向新插件子目录，其他依赖与 bundle 顺序保持原样 |
| DSH 原生界面 | 通过 | 重启后打开 Design 画布、目标日程、会话可视化；可视化内嵌页不再被 CSP 拒绝 |
| Provider 本机只读检查 | 通过 | 从当前索引选择可用的 Codex、Grok、Claude 会话构建图；不修改历史 |

原有 Visualizer test:data:local 的 Codex 检查写死了本机已不存在的会话 ID，因此该固定会话回归未通过。上表的只读抽查使用当前索引中的可用会话，不等价于固定数据集全部回归。Noval 未提供工作目录，本轮没有宣称其真实历史通过。

本机已有 Design skills 与仓库快照不同，安装使用 --keep-skills 原样保留。安装器测试覆盖默认选择、重复安装、保留其他插件、失败恢复和 skill 冲突。

实机发现原 Visualizer 的 frame-ancestors * 不匹配非网络协议父页面。已显式加入 dsh-app://app，且只允许本机页面作为其他父页面；服务响应头回归和原生 DSH 嵌入验收通过。另清理了旧 DSH 退出后仍占用 3789 的孤立 Host 进程，使新服务生效。

DSH 安装诊断另有既有 @super-agent/dsh-bridge 对 rc.3 的兼容声明警告。该插件不属于此次迁入的三个插件，其代码、依赖引用及配置保持原样。当前三个迁入插件均可正常加载。

测试原始日志、配置备份和含本机历史的截图保存在本机 .scratch/multi-plugin-migration，不进入 Git。GitHub CI 只执行通用检查；宿主与本机历史结果不能由该 CI 代替。
