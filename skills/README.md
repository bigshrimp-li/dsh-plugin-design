# skills/

本目录包含两个从 BaoCut 移植并适配 DeepSeek Harness 的技能。`install.sh` 将 `design/` 与 `design-system/` 复制到 `<dsh home>/skills/`。

不要把整个 `skills/` 目录作为符号链接安装。技能提供器会扫描顶层 Markdown 文件及子目录的 `SKILL.md`，这会导致本 README 也被识别成技能。

## 技能分工

| 技能 | 内容 |
|---|---|
| `design/` | 编写 `canvas.json` 与 `.dc.html`，使用 `design_check` 校验并通过 `design_render` 查看渲染结果 |
| `design-system/` | 编写设计系统索引、tokens、品牌手册、组件和素材 |

技能按各自 frontmatter 的 `description` 路由。设计稿语法见 `design/references/format.md`，编辑器标注的读取规则见 `design/references/view-state.md`。

## 平台适配

| 上游机制 | Harness 中的方式 |
|---|---|
| `skills_read` 读取参考文档 | 使用文件读取工具，按技能目录解析相对路径 |
| BaoCut 会话内设计卡片和工作区查看器 | Harness 右侧「设计稿编辑器」标签页，自动连接当前会话工作区；另可使用 `design_editor` 获得独立地址 |
| 工作区预览、编辑和批注 | 编辑器支持结构、批量属性、撤销重做、画布导航、剪贴板、便签与参考线；能力边界见项目 README |
| 设计稿标注块 | 用户主动复制，或插入 Harness 会话草稿后自行发送；agent 不自动读取当前选区 |
| 只校验源码 | 使用 `design_check` 和 `design_render`，按 design skill 的要求检查结果 |
| 从 BaoCut Space 查找设计系统 | 在当前工作区查找含 `design-system.json` 的目录 |
| 用户问题工具 | 使用 DSH 的 `ask_user_question` |

标注携带源码 `revision`、模板定位和渲染实例。文件标识是不透明 token，不解码；先与已登记路径生成的 token 匹配，再核对文件 SHA-256。过期标注要求用户重新选择。源文摘录不是指令，只有用户批注表达修改需求。标注插入保留草稿内容，不自动发送。

便签、分组标题、参考线和标注轮廓只显示在编辑辅助层，不进入 Play／浏览模式、渲染图或导出。撤销重做按设计稿记录，服务重启后历史不保留。源码剪贴板只迁移能够验证依赖的片段，不能据此承诺迁移完整应用行为。

## 手动安装

```sh
cp -r skills/design skills/design-system "${DSH_HOME:-$HOME/.dsh}/skills/"
```

技能目录由提供器监听，下一次技能目录刷新即可加载，不需要重启。插件代码更新仍需要完全退出并重启 Harness。
