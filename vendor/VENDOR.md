# vendor/ — 画板渲染运行时

`support.js` 是设计稿画板（`.dc.html`）的渲染运行时：把它放到画板旁边，画板里的
`<script src="./support.js"></script>` 就能把 `<x-dc>` 挂载成真实界面。

## 来源

从 BaoCut 的 `packages/design-runtime/src/runtime/` 打包而来（`runtime/index.tsx` 是自包含入口：
它 import React / ReactDOM / react-dom/client，挂到 `window.React` / `window.ReactDOM` 再 boot）。

| 项 | 值 |
|---|---|
| 源码 | `JimLiu/baocut`，`packages/design-runtime/src/runtime/`（15 个文件，3,576 行） |
| 构建时 revision | `37a5c351`；该目录自 `7aa049e8` 起未改动（`git diff` 为空） |
| 依赖 | 只有 `react`、`react-dom`、`react-dom/client`，**锁定 18.3.1**（BaoCut 用的就是这个版本） |
| 产物 | `support.js`，1.1 MB，IIFE，自包含（React 已打进去） |
| sha256 | `aae3acd07d65de68702cef33e2ad40937984072d4695f2a018d45262cea5335d` |

## 重新构建

```bash
./build-support.sh /path/to/baocut /path/to/node_modules   # 需要 esbuild 与 react@18.3.1
```

## 许可证（重要）

这份运行时是 BaoCut 从 Claude Design 已发布的最小化代码**重建**出来的，BaoCut 自己的
Community License 1.0 覆盖不了它的权利来源（见 `repo-analysis/baocut-design-port.md` §7.2）。
它随本插件分发只适用于**你自己内部使用**；对外发行前请自行做法务判断。

`vendor/` 不参与 `tsc` 构建，只是随包分发的静态资源。
