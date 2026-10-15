# BaoCut 依赖审计

**结论：这个插件没有任何技术依赖。** 它不 import 任何 BaoCut 包，不需要 BaoCut 就能构建、能运行（画板运行时已提交）。

剩下的是两类**性质完全不同**的东西，必须分开对待：

| | 是什么 | 移出它的工作量 |
|---|---|---|
| **许可证依赖** | 2,270 行校验器的著作权、工具文案、skills 的文本 | 中等（约两周） |
| **出处依赖** | `vendor/support.js` 的来源 | **大，而且 BaoCut 的许可证覆盖不到它** |

**先说最要紧的一句**：`support.js` 是 Claude Design 线上最小化 JS 的逐函数重建。它**不是 BaoCut 有权许可的东西**，所以「移出对 BaoCut 的依赖」**并不会顺手解决它**——那是另一件事，而且更难。

---

## 一、完整清单

| 路径 | 体量 | 是什么 | 权利来自 | 能不能换 |
|---|---|---|---|---|
| `src/check/tokens-check.ts` | 433 行 | 设计系统 tokens 校验 | BaoCut | ✅ 可重写 |
| `src/check/system-check.ts` | 745 行 | 设计系统校验 | BaoCut | ✅ 可重写 |
| `src/check/system-layout.ts` | 285 行 | 设计系统文件布局 | BaoCut | ✅ 可重写 |
| `src/check/canvas-check.ts` | 675 行 | 设计稿校验 | BaoCut | ✅ 可重写 |
| `src/check/canvas-layout.ts` | 132 行 | 设计稿文件布局 | BaoCut | ✅ 可重写 |
| `src/blobs.ts` | 72 行 | 内容寻址素材库 | BaoCut | ✅ 易重写 |
| `src/shared.ts` | 119 行 | 常量、类型、mime 映射 | BaoCut | ✅ 易重写 |
| `src/tools.ts` 的 description | 约 300 行文本 | 给模型看的工具说明 | BaoCut | ✅ 可重写 |
| `skills/design/` | 9 页 | 设计稿怎么写 | BaoCut | ✅ 可重写 |
| `skills/design-system/` | 7 页 | 设计系统怎么写 | BaoCut | ✅ 可重写 |
| `skills/*/references/*.json` | 371 行 | 示例数据 | BaoCut | ✅ 可重写 |
| **`vendor/support.js`** | **1.16 MB** | **画板运行时** | **不是 BaoCut 的** | ⚠️ 见 §三 |
| `docs/baocut-*.md` | 670 行 | 我写的移植分析 | 本仓库 | 保留或删 |
| `vendor/build-support.sh` | 37 行 | 重建运行时的脚本 | 本仓库 | 见 §四 方案 A |

**已核对过的技术事实**（不是推测）：

```
grep -rn "@baocut" --include=*.ts --include=*.js   →  命中全在注释里
grep -h "^import" src/check/*.ts src/blobs.ts      →  只有 node:fs、node:path、node:crypto 和自己的 ../shared.ts
git ls-files vendor/                                →  support.js 已提交（1,155,587 字节）
```

所以：**clone 下来 `npm install && npm run build` 就能跑，不需要 BaoCut 检出。**

---

## 二、三个层次，别混为一谈

### 2.1 技术依赖 —— **零**

没有 import，没有运行时依赖，构建也不需要。唯一碰 BaoCut 的是 `vendor/build-support.sh`，那是**可选的重建路径**（改了运行时才用得上）。

### 2.2 许可证依赖 —— 约 2,270 行代码 + 约 1,600 行文本

**BaoCut Community License 1.0** 管着这些。它的关键条款：

- ✅ 个人、学习、研究、**内部使用**
- ✅ 用这个软件做出来的*内容*可以卖
- ❌ 卖/租/商业分发这个软件或修改版
- ❌ 把它**并入提供给别人的**商业软件产品、库、SDK 或服务

**要断掉这一层，就得让这些文件不再包含 BaoCut 的受版权保护的表达。**

这里有一条重要的界线：**格式的规则是事实，不是表达。** `BOARD_SIZE = 40..8000`、`MAX_PAGES = 40`、`tid` 的编号规则、哪些标签是 void —— 这些是**格式的客观性质**，任何人都可以独立实现。受保护的是*具体那份代码怎么写*。

所以**从文档化的格式规范做一次净室重写，是正当的**，而且工作量有界。

### 2.3 格式依赖 —— 最深的一层

整个产品建立在 `.dc.html` + `canvas.json` 上。这个格式是 Claude Design 的（BaoCut 复刻了它）。

**换掉格式 ≠ 移出 BaoCut 依赖，而是换一个产品。** 除非你就是要做这个决定，否则别把它和前两层混在一起谈。

---

## 三、`support.js` 才是真正的问题

这一条独立于 BaoCut，必须单独说。

- 它是 `support.js`，1.16 MB，由 `vendor/build-support.sh` 从 BaoCut 的 `packages/design-runtime/src/runtime/`（15 个文件，3,576 行）打包，内嵌 React 18.3.1
- BaoCut 自己的 README 写明：那套代码是**按 Claude Design 线上发布的最小化 JS 逐函数重建**的（20,463 个函数，19,111 个完全对上）

**所以 BaoCut 无权许可它。** BaoCut 的社区许可证覆盖的是 BaoCut 自己写的东西，而这套代码的源头是 Anthropic 的产品。

这意味着：

- **移出 BaoCut 依赖，`support.js` 的问题一点没变**
- 它现在是「私有仓库自用」的性质——和你把 BaoCut 检出放在自己磁盘上一样
- **一旦要公开这个仓库，或提供给外部的人，它就是第一块绊脚石**，而且比 2,270 行校验器难得多

三条路：

| 路 | 说明 | 量级 |
|---|---|---|
| **(a) 自己写运行时** | 实现 `.dc.html` 的运行时语义：`{{hole}}` 取值、`<sc-for>`、`<sc-if>`、`<helmet>` 提升、`<dc-import>`、事件绑定、`data-props` tweak。**不需要**那 50 万行的编辑器，只需要"把源文件挂成界面"这一件事 | **2–4 周**（BaoCut 那边是 3,576 行源码） |
| **(b) 换格式** | 不用模板语法，回到纯 HTML+CSS（或者换个现成模板引擎）。运行时就不用自己写了，但 `<sc-for>`、hole、tweak、`<dc-import>` 这些能力要么丢掉要么另找 | 数周，且**设计稿格式变了，`examples/`、skills、已有的设计稿全部要改** |
| **(c) 接受现状** | 保持私有仓库自用 | 0 |

**我的判断：如果要走向公开，(a) 是唯一不釜底抽薪的路**，而且它比听起来的可控——运行时是**自包含**的（只依赖 react/react-dom），输入输出清晰（源文件 → 界面），边界比编辑器小得多。

---

## 四、方案与工作量

### 方案 A：只断「重建依赖」（很小）

**其实已经达成了。** 要做的只是把话说清楚，避免误解：

- `vendor/VENDOR.md` 与 `vendor/build-support.sh` 里写明：**重建是可选的**，仓库里已经带了构建产物，日常开发完全不需要 BaoCut 检出
- README/NOTICE 里不再让「BaoCut」出现在前置条件的位置

**工作量：半天。**

### 方案 B：断掉许可证依赖（中等）

重写这四类，让仓库里不再有 BaoCut 的受保护表达：

| 要做 | 说明 | 量级 |
|---|---|---|
| **重写校验器** | 2,270 行。规则来自**格式规范**（skills 里的 `format.md` 等）而不是那份代码。要做的是一次行为等价的重写：同样输入 → 同样的问题列表 | **5–8 天** |
| **重写 `shared.ts` / `blobs.ts`** | 191 行，都是通用的东西（sha256、mime 表、常量）。基本是照着重打一遍 | **半天** |
| **重写工具文案** | 约 300 行给模型看的说明。这些文案把格式规则编码进去了，得自己组织语言 | **1–2 天** |
| **重写 skills** | 928 行 md + 371 行 json，16 页参考。**这是最大的一块**，而且要重新验证：改完 agent 还做得出一样质量的设计吗 | **4–6 天 + 回归** |

**合计约 2 周**，其中 skills 那部分有真实的回归风险。

**做法建议**：先写一份**独立的格式规范**（从 skills 里把规则抽出来，写成规格而不是教程），然后照着它重写校验器。这样规范本身成了资产，校验器和 skills 都从它派生。

### 方案 C：换掉格式（大）

不是「移出依赖」，是「换产品」。**除非你已经决定要这么干，否则不建议现在谈。**

---

## 五、建议

**分两步走，而且第一步几乎没有成本：**

**第一步（现在就能做）**：方案 A。把「重建是可选的」写清楚，让仓库的前置条件里不再出现 BaoCut。半天。

**第二步（要真做的话）**：方案 B，但**先写格式规范再重写代码**。这样：
- 规范是干净的自有资产
- 校验器、skills、文档都从规范派生，以后改格式只改一处
- 顺带把 `skills/` 那 16 页重新组织一遍（现在的结构是 BaoCut 的，不一定最适合这里）

**`support.js` 单独决策**，不要和上面两步混。它的性质不同（不是 BaoCut 的权利问题，是更上游的问题），解法也不同（要么自己写运行时，要么接受私有自用）。

---

## 六、顺带：文档该整理一下

`docs/` 现在有 6 份 1,643 行，其中三份是关于 BaoCut 的，而且是**不同时期**写的：

已经整理了：**根目录只留当前有效的，已实现的挪进 `docs/history/`**，并加了 [`docs/README.md`](README.md) 做索引。

| 现在的位置 | 什么时候写的 | 状态 |
|---|---|---|
| `docs/baocut-dependency-audit.md`（本文） | 现在 | 当前有效 |
| `docs/design-space.md` | 实现方写的 | 当前有效 |
| `docs/feature-parity.md` | 与 Claude Design 的功能对比 | 当前有效 |
| `docs/baocut-design-port.md` | 最早期，四层拆解与移植分析 | 架构参考（`vendor/VENDOR.md` 引用它） |
| `docs/history/editor-plan.md` | 编辑器方案期 | **已实现**，归档 |
| `docs/history/editor-features-spec.md` | 编辑器功能需求 | **已实现**，归档 |
| `docs/history/baocut-l3-dsh-plugin.md` | 插件方案期 | **已被实现取代**，归档 |

---

## 附：一句话总结

> **技术上早就没有 BaoCut 依赖了。** 要断的是两样东西：一是 **2,270 行校验器 + 1,600 行文本的著作权**（约两周，可做）；二是 **`vendor/support.js` 的出处**（大得多，而且 BaoCut 的许可证帮不上忙，得单独决策）。
