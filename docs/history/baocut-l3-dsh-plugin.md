> 历史记录：运行时和派生实现已迁移，当前状态以 [独立化记录](../baocut-dependency-audit.md) 为准。本文保留原方案，不作为当前能力承诺。

# 把 BaoCut L3（design 工具集）落地成 DSH 插件

目标：把 `design_check` / `design_import_asset` / `design_system_check` / `design_system_import_asset` 四个工具做成一个 DeepSeek Harness Host 插件，**代码以搬运为主**。

结论：**可行，搬运率约 90%，约 2 人日。** 核心校验代码几乎没有外部依赖，只有 2 个常量需要补。

---

## 1. 好消息：要搬的代码几乎零依赖

对 5 个待搬运文件的 import 审计（实证）：

| 文件 | 行数 | 运行期外部依赖 |
|---|---|---|
| `packages/design-system/src/tokens-check.ts` | 433 | **无（0 imports）** |
| `packages/design/src/canvas-check.ts` | 675 | `node:fs/promises`、`node:path`、`{ASSETS_DIR, BLOB_ID_PATTERN}`、`./canvas-layout.ts` |
| `packages/design/src/canvas-layout.ts` | 132 | `node:fs/promises`、`node:path`、`{ASSETS_DIR}`、`type DeckLayout`*、`type DesignCanvasInfo`* |
| `packages/design-system/src/check.ts` | 745 | `node:fs/promises`、`node:path`、`{BLOB_ID_PATTERN}`、`./layout.ts`、`./tokens-check.ts` |
| `packages/design-system/src/layout.ts` | 285 | `node:fs/promises`、`node:path`、`type DeckLayout`*、`type DesignSystemInfo`* |

\* 类型导入，编译后消失。

**从 BaoCut 包进来的运行期符号只有两个常量：**

```js
export const ASSETS_DIR = 'assets';
export const BLOB_ID_PATTERN = /^[0-9a-f]{32}$/;
```

也就是说 **2,270 行校验代码可以近乎逐字复制**，只要：
- 把 `ASSETS_DIR` / `BLOB_ID_PATTERN` 复制进本地常量文件；
- 把 `type` 导入删掉或改成本地 `type` 声明（`.ts` → `.js` 时本来就会消失）。

`tokens-check.ts` 那段 433 行的 token 形状校验（正则表、值被丢弃的每种原因）是整份代码里最琐碎、最值得原样搬的部分。

---

## 2. 移植映射表：需要动的地方

| 原依赖 | 用途 | DSH 对应 |
|---|---|---|
| `zod` `z.strictObject` | 参数 schema | `defineTool` 的 `parameters` DSL（JSON-Schema 风格，直接改写） |
| `ToolError` / `ToolInfo` / `ToolSet` / `tool-catalog.ts` | 工具框架 | **删除**，换成 `ctx.tools.register(defineTool({...}))` |
| `ToolScope`（`authorize`/`createRoot`/`fileBase`/`confirm`/`recordDesign`） | 工作区作用域、审批、卡片 | `ctx.fs` + `exec.agent.session.header.cwd` + `ctx.approval`；`recordDesign` **无对应**（见 §4） |
| `@baocut/protocol` 的 `RpcError`、`RcAgentTools`（i18n 文案） | 错误码、确认摘要 | **删除**，字符串内联 |
| `@baocut/slides` 的 `contentTypeOf`、`MIME`、`EXT_BY_MIME` | 按扩展名判 mime | 抄一张约 40 行的常量表 |
| `@baocut/slides` 的 `sha256`、`putBlob`、`assetExtensionOf`、`findBlobFile` | 内容寻址素材库 | 抄约 30 行（见 §3） |
| `resolveDeckDir` | 目录解析 | `ctx.fs.resolve(path, { cwd })` |
| `node:fs/promises` | 读写字节、lstat、realpath | **保留**（原代码就是这么写的，搬运成本最低；见 §5） |

### 素材导入（putBlob）的真实实现

原实现（`packages/slides/src/deck-store.ts`）可以直接抄：

```js
const id = sha256(bytes).slice(0, 32);           // sha256 十六进制前 32 位
const type = contentType.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
// 已存在（assets/<id>.<任意扩展名>）就复用，实现内容寻址去重
if (findBlobFile(id) === null) await writeFileAtomic(`<canvas>/assets/${id}.${assetExtensionOf(type)}`, bytes);
// 维护 assets/index.json：{ [id]: contentType }
return { id, url: `/_blob/${id}`, sizeBytes: bytes.byteLength };
```

这解释了 `BLOB_ID_PATTERN = /^[0-9a-f]{32}$/` 的来历，也是校验器能验证 `/_blob/<id>` 引用的基础。

**素材上限**：`DESIGN_ASSET_MAX_BYTES = 20 * 1024 * 1024`（设计稿）；设计系统侧另有 ≤20 MB、SVG ≤2 MB 的限制。

---

## 3. 三个必须做决策的点

### 3.1 `ctx.fs` 没有 `writeBytes` —— 这是最大的技术障碍

DSH 的 fs 接缝（`@deepseek-ai/dsh-fs`）只有：

```
resolve / stat / readText / readBytes / streamText / editText / writeText / sandboxMode
```

**能读二进制，不能写二进制**（`dsh-fs-local` 里 `grep -c writeBytes` = 0）。

而 `design_import_asset` 的本质就是"把一个 png/woff2 拷进 `<canvas>/assets/`"。三个选项：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 直接用 `node:fs`**（推荐） | 插件里 `import fs from 'node:fs/promises'`，照搬原代码 | 绕过 sandbox 与 fs-observation-policy；但原代码本来就是这么写的，搬运零成本 |
| B. 让 agent 用 bash 拷 | 插件只返回目标路径，让 agent `cp` | 多一轮往返，且 `dc.html` 里要写相对路径而不是 `/_blob/<id>`（craft 免工具版就是这么规定的） |
| C. base64 内联 | 写进 `.dc.html` | **格式明令禁止** `data:` URI，不可行 |

> 注意 A 和 B 不是等价的：`/_blob/<id>` 是编辑器认的地址，相对路径是"文件优先"的另一种存法。如果你的 Agent 侧不做编辑器（L4），B 完全够用，而且**不需要写插件**——craft 版已经写好了。

### 3.2 "设计稿卡片"没有对应机制

原版 `design_check` 成功（`problems === 0`）时会调用 `scope.recordDesign(...)`，在会话线程里放一张可点开编辑器的设计稿卡片。DSH 没有等价的"工具产出一个 UI 卡片"机制——`present` 工具走的是 `deliverables/presented` 会话事件，用于文件交付，语义不同。

三个选择：
1. **不做**（推荐）：没有 L4 编辑器，卡片点开也没东西可看。
2. 复刻 `present` 的模式：`ctx.on('tools/result', ...)` + `session.append(...)` —— 但 practices 明确警告 **"Do not append session events with a new `type`"**，只能用已有事件类型，所以基本做不到。
3. 在工具返回的 `output.render` 里给一段人类可读的确认文案（最省事，也最符合 DSH 的做法）。

### 3.3 审批（ask）怎么表达

原版 `design_import_asset` 会"按访问模式向用户确认"。DSH 的对应机制是 `@deepseek-ai/dsh-user-approval`（`ctx.approval`）：

- 需要**同步、顺序无关**的拒绝 → `ctx.tools.guard()`
- 需要**异步询问用户** → 从 `tools/pre-execute` 返回 `ask`
- 或直接 `ctx.approval.request({ agent, tool, reason, signal })` —— 必须在一个 open turn 内，否则抛错

⚠️ **当前这个会话的审批策略是 `never`**：`never` 会在瀑布分发之前**确定性拒绝**，answerer 无法绕过。所以如果你要保留确认步骤，得先把 profile 的 `dsh-user-approval` 配置回 `policy: ask`。

实务建议：`design_import_asset` 的语义只是"读工作目录里的一个文件 + 写进 canvas/assets/"，本身不危险。**建议不实现审批**，少一个失败面。

---

## 4. 插件骨架

### 文件布局

```
dsh-plugin-design/
├── package.json
├── cordis.patch.yml
├── index.js                  # apply()：inject + 注册 4 个工具
├── tools.js                  # 4 个 defineTool 定义（描述文案照抄原版）
├── constants.js              # ASSETS_DIR / BLOB_ID_PATTERN / MIME / EXT / 各种上限
├── blobs.js                  # sha256 / contentTypeOf / assetExtensionOf / findBlobFile / putBlob
└── check/
    ├── canvas-layout.js      # 搬运 132 行
    ├── canvas-check.js       # 搬运 675 行
    ├── system-layout.js      # 搬运 285 行
    ├── system-check.js       # 搬运 745 行
    └── tokens-check.js       # 搬运 433 行（零改动）
```

### package.json

```json
{
  "name": "@local/dsh-plugin-design",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Host-only bundle **不需要依赖、不需要构建工具**（官方模板原文）。`dsh.bundle.patch` 被 `dsh plugin add` 读取后，会自动把包名追加进 profile 的 `dsh.profile.bundles`。

### cordis.patch.yml

```yaml
- insert:
    - id: design-tools
      name: '@local/dsh-plugin-design'
```

### index.js

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkCanvas } from './check/canvas-check.js';
import { checkDesignSystem } from './check/system-check.js';

export const name = 'design-tools';
export const inject = ['tools'];   // 缺 tools 时插件保持不激活，而不是抛错

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'design_check',
    description: /* 照抄原版：那段中文描述把所有格式规则都讲清了，是极好的 model-facing 文本 */ '',
    parameters: { path: { type: 'string', required: true, description: '设计稿目录（里面有 canvas.json），相对工作目录的路径' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { /* title, boardCount, problems, issues */ } },
      render: (_args, value) => [{ type: 'text', text: `design_check: ${value.problems} 个问题` }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('design_check requires an agent Session');
      const cwd = exec.agent.session.header.cwd;
      if (cwd === undefined) throw new Error('design_check requires a workspace');
      const result = await checkCanvas(path.resolve(cwd, args.path));
      return { title: result.title, boardCount: result.boardCount, problems: result.issues.length, issues: result.issues.slice(0, 200) };
    },
  }));
  // design_import_asset / design_system_check / design_system_import_asset 同理
}
```

要点（来自官方 practices）：
- `apply` 里注册的一切都要用 `ctx.effect` / `ctx.on` 并把 disposer 返回，插件卸载时会被清掉。
- 可调值放进 `export const Config`（schemastery），用户能在 `cordis.patch.yml` 里改，且不会被升级覆盖。
- 不确定 Service 方法名时用 `cordis_inspect_query` 核对——**"installed Harness is the authority"**。

### 工具描述文案建议原样搬运

原版 `design-tools.ts` 里的 `description` 标了 `// i18n-ignore-start`，也就是**故意不翻译**：它们直接写给模型看，把画板规则、`support.js` 头行、`{{ }}` 只能是点号路径、`/_blob/<id>` 用法等全部编码进去了。这是 L3 里最值钱的提示词资产，**不要重写**。

---

## 5. 关于 TypeScript

BaoCut 那边是 TS，DSH 插件加载的是 **plain JS**（`lib/index.js` 或 `index.js`，官方实践明确说 "a plain-JS plugin has no type check"）。三条路：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. tsc 编译**（推荐） | 保留 TS 源码，`tsc` 输出 JS | 类型检查保住，改动最小 |
| B. `node --experimental-strip-types` | 直接跑 `.ts` | 依赖 Node 24 的 strip-types；运行时只有 DSH 那个 Node，风险高 |
| C. 手工去类型 | 逐个改 | 2,270 行里类型标注不少，费时且易错 |

选 A。注意 `layout.ts` 里有两个 `import type` 来自 `@baocut/protocol`，编译后会消失，但 **tsc 需要能解析它们**——最省事的做法是把 `DeckLayout` / `DesignCanvasInfo` / `DesignSystemInfo` 三个类型定义也抄过来（或直接 `type X = any`，反正校验逻辑不强依赖它们）。

---

## 6. 安装与验证

`dsh` CLI 在 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（不在 PATH 上，要写全路径或加软链）。

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 本地路径安装（plugin-manager 支持 file: / link: / 绝对路径 / tarball / git）
"$DSH" plugin --profile desktop add /abs/path/to/dsh-plugin-design

# 确认已进 bundle 栈
cat ~/.dsh/profiles/desktop/package.json    # 看 dependencies 与 dsh.profile.bundles
```

验证要点（官方 verification 参考）：
- 新装 bundle 可以经 HMR 激活；**替换已安装的包需要重启**才能加载新的 JS 模块代。
- `failed` 要诊断，`overridden` 说明有更高优先级的 layer 覆盖了，`restart-required` 说明改动还没生效。
- 最直接的验收：让 agent 对一个真实设计稿目录跑 `design_check`，与 BaoCut 里同样的目录比对问题清单。

---

## 7. 工作量拆解

| 工作项 | 估时 |
|---|---|
| 搬运 5 个校验文件 + 补常量（§1） | 0.5 天 |
| 搬运 `putBlob` / `contentTypeOf` / MIME 表（§2） | 0.5 天 |
| 4 个 `defineTool` 包装 + 输出 schema（§4） | 0.5 天 |
| tsc 构建链 + 安装调试 + 真实目录验收（§5–6） | 0.5 天 |
| **合计** | **约 2 天** |

---

## 8. 风险与遗留

1. **许可证**：BaoCut Community License 1.0 允许内部使用，但把其代码并入"提供给他人的商业软件产品/库/SDK"需单独商业许可。校验代码与工具描述文案都属许可证定义的 "Software"（含 documentation）。自用没问题，对外发行要评估。
2. **`writeBytes` 缺失**（§3.1）：用 `node:fs` 就绕过了 sandbox 与 observation policy。这在 DSH 里是一个策略缺口——如果以后要收紧，正解是给 `@deepseek-ai/dsh-fs` 贡献一个 `writeBytes`，或让 `dsh-fs-local` 暴露它。
3. **卡片缺失**（§3.2）：`design_check` 通过后不会有任何 UI 反馈，只有工具返回值。如果将来做 L4 编辑器，这个反馈通道要重新设计。
4. **审批策略**（§3.3）：当前 profile 是 `never`，任何 `ask` 都会被确定性拒绝。若保留确认步骤，记得同步改 `dsh-user-approval` 的 `policy`。
5. **只搬 L3 的价值有限**：没有 L1（skill 文案），模型不知道要写 `.dc.html`；没有 L2 的调用约定，工具不会被触发。建议 **L1 + L3 一起落地**——L1 是纯 Markdown，成本几乎为零。
