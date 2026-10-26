# 本地运行时迁移验收

日期：2026-10-15。适用当前工作区实现，尚未提交 Git。

## 结果

| 验证 | 结果 |
|---|---|
| TypeScript 与运行时构建 | 通过，运行时构建输入仅包含 src/design-runtime/ |
| 本地协议、素材、运行时来源检查 | 7/7 |
| 客户端测试 | 16/16 |
| 编辑器、事务、设计空间服务测试 | 74/74 |
| Harness 工具端到端检查 | 83/83 |
| 编辑器界面回归 | 24/24 |
| 多选界面回归 | 4/4 |
| 标注界面回归 | 4/4 |
| Design 空间界面回归 | 28/28 |
| 独立运行时集成场景 | 13/13 |
| 发布内容检查 | 无 vendor 目录，包含新运行时与 NOTICE.md |
| 旧路径兼容 | vendor/support.js 是指向新构建产物的本地符号链接，两处字节一致 |

运行时场景覆盖：默认属性与转义文字、helmet 样式、无框架与远程请求、受控输入的焦点和光标、非受控输入、复选框和选择框、列表重排保留状态、条件节点、table/SVG、源码节点映射、子组件状态隔离、属性更新、生命周期释放、离线嵌套组件导出，以及不支持的组件类型和循环引用错误。

## 原生进程状态

插件已通过本地 link 安装到 Harness desktop profile，新构建已生成。design 和 design-system 技能已同步到 ~/.dsh/skills/，旧技能保存在 ~/.dsh/skill-backups/ 下。

用户授权后，已通过应用菜单退出并重新启动 Harness，确认新应用进程和 Host 进程启动。原生设计区已完成验收，没有发送模型消息。

- 原生画板显示 `dsh-dom-1` 和 `React: undefined`。
- 实际点击计数按钮：0 → 1；切换条件内容：详情消失。
- 实际输入 `native-local-OK`，输入框及模板回显同步更新；列表两项正常显示。
- 属性面板将标题字号从 28px 改为 32px，确认源码已写入；原生撤销后源码逐字节恢复。
- 正在运行的服务返回带 `data-design-template` 的新版模板，运行时响应与本地构建逐字节一致（12,417 字节）。
- 运行时 SHA-256：`4aa59add1475babf59e72bf0525531f7acf7c3aa7f5eed49ea881447a02ec3ed`。
- 原生验收画板保留在 `/Users/bytedance/workplace/Novel-Generator/design-space-native-20261015/Runtime.dc.html`，原有 Main.dc.html 未修改；整个测试设计稿静态校验为 0 问题。

结果记录位于 `.scratch/native-runtime-acceptance/results.json`。

## 复现命令

```sh
npm test
npm run test:runtime
npm run test:browser
node test/editor-multiselect-browser.mjs
node test/editor-annotations-browser.mjs
node test/design-space-browser.mjs
npm pack --dry-run --json
```

`.scratch/independence-tests.log`、`.scratch/runtime-integration.log` 和 `.scratch/independent-*.log` 保存本轮自动化结果。Design 空间测试中的 404 输出来自特意验证旧 Host 路由的用例。

## 兼容范围

保留现有文件协议、常用模板行为与编辑功能；不再加载旧框架。x-import/JSX 和旧平台专有动画、未完成文件流式执行不在兼容范围。迁移路径见 skills/design/references/format.md。
