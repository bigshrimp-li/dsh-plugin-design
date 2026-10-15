# docs

**根目录只放当前有效的文档。** 已经实现或已被取代的方案挪到 [`history/`](history)，那是过程记录，不要拿它当现状。

## 当前有效

| 文档 | 讲什么 |
|---|---|
| [baocut-dependency-audit.md](baocut-dependency-audit.md) | **与 BaoCut 的关系**：哪些代码是搬来的、哪些是自有的、要「移出依赖」分别意味着什么、各自的工作量 |
| [design-space.md](design-space.md) | **Design 空间**（主区域设计面板）的使用、状态、外部修改处理与限制 |
| [feature-parity.md](feature-parity.md) | **与 Claude Design 的功能对比**：已有 / 欠缺 / 值得补什么 |
| [baocut-design-port.md](baocut-design-port.md) | **架构参考**：四层拆解（提示词 / 格式 / 工具 / 编辑器）、各层的接口契约、移植时的风险清单 |
| `images/` | README 用的图 |

## 历史（已实现或已被取代）

| 文档 | 状态 |
|---|---|
| [history/editor-plan.md](history/editor-plan.md) | 编辑器的 P1/P2 方案 —— **已实现** |
| [history/editor-features-spec.md](history/editor-features-spec.md) | 编辑器八项功能的需求说明 —— **已实现** |
| [history/baocut-l3-dsh-plugin.md](history/baocut-l3-dsh-plugin.md) | 最初的插件落地计划 —— **已被实现取代** |

## 规矩

- 新的方案文档先写在根目录；**实现完成并稳定后**挪进 `history/`
- 挪动时同步改掉引用它的地方（根目录这几份之间会互相引用）
- 一份文档如果只对当时那个人有意义，就不该留在根目录
