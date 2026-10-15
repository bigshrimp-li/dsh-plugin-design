# docs

**根目录只放当前有效的文档。** 已经实现或已被取代的方案挪到 [`history/`](history)，那是过程记录，不要拿它当现状。

## 当前有效

| 文档 | 讲什么 |
|---|---|
| [baocut-dependency-audit.md](baocut-dependency-audit.md) | **独立化记录**：本地运行时、派生模块替换、保留的通用依赖与测试入口 |
| [design-space.md](design-space.md) | **Design 空间**（主区域设计面板）的使用、状态、外部修改处理与限制 |
| [feature-parity.md](feature-parity.md) | **历史功能对比**：不代表迁移后的运行时兼容范围 |
| [baocut-design-port.md](baocut-design-port.md) | **历史架构参考**：旧移植方案，当前以独立化记录为准 |
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
