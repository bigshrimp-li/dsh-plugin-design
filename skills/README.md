# 本地设计技能

这两个技能描述本插件自己的文件协议和工具。运行时与校验器源码均在本仓库维护。
`install.sh` 将 `design/` 和 `design-system/` 分别安装到 Harness 技能目录。

- `design`：设计稿、交互、可视化编辑、截图与离线导出。参考文件按任务类型读 —— `craft.md`（界面基本功：层级、字号、间距、颜色、状态）、`print.md`（印刷品尺寸与信息密度）、`diagrams.md`（流程图、架构图、数据图表）、`brand.md`（定色定字与对比度）、`format.md`（文件协议）、`view-state.md`（标注定位）。
- `design-system`：设计规范、tokens、品牌文档与素材索引。

不要将整个 skills 目录作为一个技能安装。已有会话中的旧标注可以继续按文件标识和 revision 定位；旧标注标签只是兼容字段，不会加载旧软件。
