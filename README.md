# dsh-plugin-design

给 **DeepSeek Harness** 的设计稿工具：让 agent 在你的工作目录里产出**可校验、能渲染、能导出**的设计稿与设计系统 —— 界面、网页、海报、印刷品、图表、App 交互流程。

不是一个「让模型画 HTML」的提示词，而是一条完整回路：**写 → 校验 → 渲染出来看 → 改 → 导出给人**。

![四屏点单流程](docs/images/order-flow.png)

<sub>上面这条四屏点单流程是这个插件跑出来的，点 [examples/order-flow](examples/order-flow) 看源码。</sub>

---

## 目录

- [快速开始](#快速开始)
- [你得到什么](#你得到什么)
- [一次完整的往返](#一次完整的往返)
- [为什么需要 `design_render`](#为什么需要-design_render)
- [为什么 `.dc.html` 不能直接打开](#为什么-dchtml-不能直接打开)
- [直接可用的提示词](#直接可用的提示词)
- [它是怎么工作的](#它是怎么工作的)
- [限制](#限制)
- [开发](#开发)
- [来源与许可](#来源与许可)

---

## 快速开始

前置：**Node ≥ 20**、**TypeScript**（`npm i -g typescript`）、**Chrome / Chromium / Edge**（渲染用）。

```sh
git clone <this repo> && cd dsh-plugin-design
./install.sh                      # 默认装进 desktop profile
./install.sh --profile web        # 或别的 profile
```

`install.sh` 做三件事：构建插件、把两个 skill 拷进 `<dsh home>/skills/`、用 `dsh plugin add` 把插件装进 profile。

然后**完全退出并重启 DSH**。skill 是热加载的（重启前就生效），但插件模块要重新加载，六个工具才会出现。

验证：

```
> 做一版咖啡店的春季菜单海报，880×560，摆在吧台上
```

agent 会写完设计稿、跑 `design_check` 自检、再跑 `design_render` 把图贴给你看。

---

## 你得到什么

### 六个工具

| 工具 | 做什么 | 要浏览器吗 |
|---|---|---|
| `design_check` | 校验设计稿（`canvas.json` v3 + 每块画板一个 `.dc.html`），返回按文件列出的问题 | 否 |
| `design_render` | **渲染成 PNG 并显示在会话里**：声明尺寸、实际挂载尺寸、是否超出 frame、页面报错 | 是 |
| `design_export` | 导出**自包含 HTML**：运行时内联、素材变 data: URI，双击即开，画板间链接自动改写 | 否 |
| `design_import_asset` | 图片/字体按内容寻址拷进 `<canvas>/assets/`，返回 `/_blob/<id>` | 否 |
| `design_system_check` | 校验设计系统（`design-system.json` + `tokens.json` + 组件与素材） | 否 |
| `design_system_import_asset` | 图片/视频/PDF/字体拷进 `<system>/_blobs/`，返回 `/_blob/<id>` 和要写进索引的记录 | 否 |

`design_check` 与 `design_system_check` **只看文件**：不渲染、不截图、不联网、零外部依赖。它们是纯粹的格式校验器。

### 两个 skill

| Skill | 什么时候命中 |
|---|---|
| `design` | 「做一版……界面 / 网页 / 海报 / 图表 / 示意图 / 原型」 |
| `design-system` | 「把品牌色、字阶、间距整理成设计系统」 |

自动路由，不用点名。它们教 agent 怎么写这套格式、怎么装设计系统、怎么自检，并带着 16 页参考文档（语法卡、印刷规则、示意图规则、品牌手册写法……）。细节见 [skills/README.md](skills/README.md)。

### 四个可跑的示例

[`examples/`](examples) 里是四份能直接校验通过的完整设计稿：

| 目录 | 是什么 |
|---|---|
| [`ethiopia-guji/`](examples/ethiopia-guji) | A4 印刷海报（固定页、装了设计系统、导入了品牌标志） |
| [`order-flow/`](examples/order-flow) | 四屏 App 点单流程，可点、可跳转的原型 |
| [`spring-menu/`](examples/spring-menu) | 菜单海报（导入位图素材） |
| [`ember-ds/`](examples/ember-ds) | 一套设计系统：11 个颜色（明暗两个 theme）、6 种文字样式、间距/圆角/阴影 + 品牌手册 |

```sh
# 拿任意一份试：
> 校验一下 examples/order-flow
> 把 examples/ethiopia-guji 渲染出来看看
```

![A4 海报](docs/images/poster.png)

---

## 一次完整的往返

这是真实跑出来的，不是示意。

**第 1 步 · 校验**（`design_check`）

```
> 校验一下 examples/order-flow

design_check examples/order-flow: 通过（4 块画板）
```

有问题时它逐条列出来，`file` 是相对设计稿目录的路径：

```
design_check <路径>: 10 个问题
canvas.json: boards["Main.dc.html"]: w and h must be numbers from 40 to 8000
canvas.json: boards["Missing.dc.html"]: the file Missing.dc.html does not exist; write it or remove the entry
Main.dc.html: the <head> must contain the exact line <script src="./support.js"></script>
Main.dc.html: the attribute style=color:red is not quoted; quote every attribute
Main.dc.html: <img src> uses a data: URI; upload the file with design_import_asset and use its /_blob/<id>
Main.dc.html: {{ a + b }} is an expression; a hole is a dotted lookup only: compute it in renderVals() and use its name
Main.dc.html: data-props is not valid JSON ...; escape & as &amp; and ' as &#39;
Main.dc.html: builds UI from script (innerHTML / appendChild / document.write); all UI is <x-dc> markup
Main.dc.html: <script src> "./SUPPORT.js" is not a file in this design; write it there or upload it with design_import_asset
Main.dc.html: <iframe> is not allowed in an artboard
```

**第 2 步 · 渲染出来看**（`design_render`）

```
design_render examples/order-flow
  Main.dc.html：声明 390x844，实际 390x844
  Base.dc.html：声明 390x844，实际 390x844
  Flavor.dc.html：声明 390x844，实际 390x844
  Review.dc.html：声明 390x844，实际 390x844
PNG 在 examples/.design-preview/order-flow
```

四张 PNG 直接出现在会话里。**这一步抓到了前两步抓不到的东西** —— 见下一节。

**第 3 步 · 导出给人**（`design_export`）

```
design_export examples/order-flow
  Main.dc.html → .../view/Main.html（1133 KB）
  Base.dc.html → .../view/Base.html（1133 KB）
  Flavor.dc.html → .../view/Flavor.html（1133 KB）
  Review.dc.html → .../view/Review.html（1133 KB）
在浏览器里打开上面这些文件即可（不需要本地服务）。
```

那份 HTML 是**真能点的原型**：选项能选、Next 能跳、Change 能回改。

---

## 为什么需要 `design_render`

BaoCut 里设计稿由编辑器提供预览，所以它的 `design_check` 刻意**不渲染**，还把「渲染、截图、打开」列进了禁止事项。

在 DSH 里这个前提不成立 —— 没有编辑器。于是「看不见自己做的设计」成了最大的问题：**格式全对、排版一塌糊涂，谁都不知道**。

实际发生的（都是这一版设计里真实抓到的）：

| 问题 | `design_check` | `design_render` |
|---|---|---|
| 三个装饰圆弧被色块从中间切断（`viewBox` 写错，真 bug） | 通过 | 抓到 |
| 正文最后一行只剩一个词「whole.」（孤字） | 通过 | 抓到 |
| 字体加载后标题变宽、自动折行 —— **排版随网络变** | 通过 | 抓到 |
| 窄画板被误判「超出 frame」 | — | 抓到（工具自己的 bug） |

所以这个插件把渲染**做成了必做步骤**，而不是可选验证。skill 里写得很直白：

> 写完 → `design_check` → `design_render` → **认真看那些图** → 改 → 再来

原来那条「绝不验证」的规矩保留了下来，只是范围收窄：

> 渲染之外**不要**自己加验证：不要读回文件复查 layout、不要另写脚本量尺寸、不要用别的浏览器、不要装任何东西。**`design_check` 与 `design_render` 就是你该用的两件工具**。

### 「超出 frame」是怎么知道的

`design_render` 起一个只读本地服务供出设计稿，并在 `<head>` **最前面**注入一小段探针 —— 位置很关键，它要赶在画板运行时启动**之前**装上错误监听。然后无头 Chrome 打开画板截图，探针把挂载结果 `POST` 回服务端。一次 Chrome 调用同时拿到截图和结构化结果：

| 报回的东西 | 抓到什么问题 |
|---|---|
| `mounted` | 画板脚本报错、运行时没启动、画板是空的 |
| `rendered` vs `declared` | **内容比声明的 frame 高/宽，会被裁切** |
| `overflow` | 同上，布尔版 |
| `errors` | 运行时异常、未处理的 rejection |

量的是**画板自己的根元素**，不是宿主的包装层 —— 包装层会撑满窗口，窄画板（手机尺寸）会被 Chrome 的最小窗口宽度带偏，误报溢出。

---

## 为什么 `.dc.html` 不能直接打开

`.dc.html` 是**源格式**，不是网页。双击打开会同时坏三件事：

| 缺什么 | 你会看到什么 |
|---|---|
| `<script src="./support.js">` 那个**画板运行时** | `<x-dc>` 不挂载，看到的是没加工的原始 markup |
| 运行时对 `{{hole}}` 的替换 | `background: {{accent}}` 被浏览器当**非法值丢掉** → 色块变透明 → 白字白底看不见 |
| 一个把 `/_blob/<id>` 映射到 `assets/` 的**服务** | 图片全是裂图 |

看着像坏了，其实是源文件。**给人看要用 `design_export`**：

```sh
design_export <设计稿目录>          # 每块画板一个自包含 HTML
```

它把运行时内联、相对样式表与脚本内联、`/_blob/<id>` 换成 data: URI，并把画板间链接从 `X.dc.html` 改写成 `X.html` —— 所以导出的原型**点得动**。不改变设计稿本身一个字节。

---

## 直接可用的提示词

### 做设计

```
帮我做一版咖啡店的春季菜单海报，880×560，摆在吧台上。
```

```
给「还没有项目的团队」做一个更好的 empty state，做三块画板让我挑方向。
```

```
做一个 SaaS 定价页：三档，中间那档高亮。做成能滚动的一整页。
```

```
做一张 A4 的活动海报，能导出成 PDF。
```

```
设计一个咖啡点单的界面：先选咖啡，再选基底（椰子水、牛奶、水…），再选风味（榛子…）。
```

```
把这三条流程画成一张泳道图。
```

### 改设计

```
把标题再大一点，用主色。
```

```
把右边那块图换成我这张图：assets/hero.png
```

```
太挤了，把间距放开一些。
```

> 相对说法（「这块画板」「这个按钮」）没有屏幕上下文可用 —— agent 会问你指的是哪个，或者按上下文判断并说明它改了哪里。

### 设计系统

```
把我们品牌的颜色、字阶、间距整理成一套设计系统，色板我发你。
```

```
用 examples/ember-ds 这套设计系统做一版产品介绍页。
```

```
把这个 logo 加进设计系统，放在 Logos 组里。
```

### 校验 / 渲染 / 导出

```
校验一下 examples/order-flow
```

```
渲染出来我看看
```

```
给我一份能在浏览器里打开的
```

---

## 它是怎么工作的

```
                    ┌─────────────────────────────────────────┐
   你的 agent ──────▶│  6 个工具                                │
                    │  check / render / export / import ×2     │
                    └───────────────┬─────────────────────────┘
                                    │
          ┌─────────────────────────┼──────────────────────────┐
          ▼                         ▼                          ▼
   ┌─────────────┐         ┌──────────────┐           ┌─────────────────┐
   │ 格式校验     │         │ 渲染          │           │ 导出             │
   │ 纯文件读取   │         │ 本地服务      │           │ 运行时内联        │
   │ 零依赖       │         │ + 无头 Chrome │           │ + 素材→data URI  │
   │ 2,270 行     │         │ + 注入探针    │           │ + 链接改写        │
   └─────────────┘         └──────┬───────┘           └─────────────────┘
                                  │
                                  ▼
                        vendor/support.js（画板运行时）
                        把 <x-dc> 挂载成真实界面
                        执行 {{hole}} / <sc-if> / <sc-for> / <helmet>
```

关键点是**画板运行时**（`vendor/support.js`，1.1 MB）：它把 `.dc.html` 变成活界面。它只需要 `react`、`react-dom`、`react-dom/client` 三个依赖，而且入口是自包含的，所以**一次 esbuild 就能打包** —— 不需要那 50 万行的编辑器。

重新构建它：

```sh
./vendor/build-support.sh /path/to/baocut /path/to/node_modules   # 需要 esbuild + react@18.3.1
```

`.dc.html` 的渲染语义全都在这个运行时里：`{{hole}}` 点号取值、`<sc-for>` / `<sc-if>` 控制流、`<helmet>` 提升到 `<head>`、`<dc-import>` 子组件、`data-props` 调节杆、事件绑定。

---

## 限制

1. **渲染是「加载后一瞬间」**。点按钮、输入、hover 这些交互验不了 —— 截图是静态的。导出 HTML 能点（浏览器里跑真的运行时），但 agent 看不到点击后的状态。
2. **要本机有 Chrome / Chromium / Edge**。找不到时 `design_render` 直接报错，不静默降级。用 `$DSH_DESIGN_CHROME` 指路。一张静态画板约 5 秒。
3. **没有设计系统渲染**。`design_system_check` 只看文件；组件预览（`preview.html`）要加载设计系统自己的 bundle 和 React，是另一件事。
4. **没网时网页字体会回退**。设计里引的 Google Fonts 取不到就用 fallback 排版 —— 图会和有网时不一样。这一条实际咬过一次：标题因字体变宽而自动折行，把排版改了。**要固定的断行就写死**（`<br>`）。
5. **选择不跨画板累积**。格式里每块画板有各自的 `state`，所以多屏流程的状态是**按设计稿惯例在每屏写死**的。要真累积得把整个流程做成一块画板、每屏一个 `<sc-if>`。
6. **导入素材写 `node:fs`**，绕过 DSH 的沙箱与 fs 观察策略 —— 因为 DSH 的 `ctx.fs` 只有 `writeText`，写不了二进制。

---

## 开发

```sh
npm run build      # tsc -p tsconfig.json  ->  dist/
./test.sh          # 63 项端到端断言（用 DSH 自带的 Electron Node）
```

`test.sh` 用 `module.registerHooks` 把 `@deepseek-ai/dsh-tools` 指向安装目录里的**真实实现**，构造一个假的 `ctx.tools`，然后拿 fixture 跑通六个工具（含各类错误路径）。必须用 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1`），因为 `defineTool` 在 `app.asar` 里。

TypeScript 用 `rewriteRelativeImportExtensions` 把 `./x.ts` 改写成 `./x.js` 输出。构建同时**做了类型检查** —— 搬运 2,270 行、手改 import 之后，这是最值得的一步。

`src/dsh-tools.d.ts` 是 `@deepseek-ai/dsh-tools` 的最小本地类型声明：发行包里没有 `.d.ts`（asar 只带 `.js`），TS 解析不到。只影响类型检查，不产生运行期代码。

### 目录

```
src/check/     从 BaoCut 近乎逐字搬运的校验器（2,270 行）
src/tools.ts   六个工具的 defineTool 定义
src/render.ts  本地服务 + 无头 Chrome + 注入探针
src/export.ts  自包含 HTML 导出
src/blobs.ts   内容寻址素材库
src/shared.ts  常量、类型、mime 映射
vendor/        画板运行时（support.js）+ 重建脚本
skills/        两个 skill + 全部参考页
examples/      四份可跑的设计稿
test/          测试与 fixture
docs/          架构与移植分析
```

---

## 来源与许可

这个仓库**不是单一许可**，混了三类材料：

| 类别 | 内容 | 许可 |
|---|---|---|
| 原创 | `render.ts`、`export.ts`、`index.ts`、测试、文档 | 本仓库 |
| 移植自 BaoCut | `src/check/`（2,270 行）、工具描述文案、`blobs.ts`、`shared.ts`、`skills/` | BaoCut Community License 1.0 |
| 随包 | `vendor/support.js`（画板运行时） | **另有权利来源，见下** |

**BaoCut Community License 1.0** 是 source-available，不是开源：允许个人/学习/研究与**内部使用**；把它的代码并入**提供给他人的**商业软件产品、库、SDK 或服务需要单独的商业许可。

⚠️ **`vendor/support.js` 的权利不来自 BaoCut。** BaoCut 自己的 README 写明 `design-runtime` 那套代码是按 Claude Design 线上发布的最小化 JS **逐函数重建**的 —— 所以它不是 BaoCut 有权许可的东西，BaoCut 的许可证覆盖不到它。**私有仓库自用**和你把 BaoCut 检出放在自己磁盘上是一样的性质；**公开发布这个仓库是另一回事**，请自行做法务判断。

完整说明（含逐文件来源表、React 的 MIT、字体许可）见 **[NOTICE.md](NOTICE.md)**。
