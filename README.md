# DSH Plugins

DeepSeek Harness 的多插件仓库。每个插件独立安装、测试和维护版本；根目录统一提供开发命令和安装入口。远端仓库名称暂时保留 `dsh-plugin-design`。

| 插件 | 目录 | 包名 | 状态 |
|---|---|---|---|
| [Design](plugins/design/README.md) | `plugins/design` | `@local/dsh-plugin-design` | 已有完整测试 |
| [目标日程](plugins/okr-schedule/README.md) | `plugins/okr-schedule` | `@local/okr-schedule` | 实验插件 |
| [会话可视化](plugins/agent-session-visualizer/README.md) | `plugins/agent-session-visualizer` | `@local/agent-session-visualizer` | 实验插件 |

## 安装

前提：Node.js ≥ 20、npm、已安装 DSH，并且 `dsh` 在 PATH 中。Design 的渲染和浏览器测试还需要 Chrome、Chromium 或 Edge。

1. 克隆仓库并安装锁定的依赖：

   ```sh
   git clone git@github.com:bigshrimp-li/dsh-plugin-design.git
   cd dsh-plugin-design
   npm ci
   ```

2. 选择插件和 profile。安装器先检查并构建，再更新该 profile 的依赖与 bundle 列表：

   ```sh
   ./install.sh --all --profile desktop
   ./install.sh --plugin design --profile desktop
   ./install.sh --plugin okr-schedule --profile desktop
   ./install.sh --plugin agent-session-visualizer --profile desktop
   ```

   无参数 `./install.sh` 继续只安装 Design。`--plugin` 可以重复；`--dry-run` 预览且不修改配置；`--skip-build` 用于已经构建的本机仓库；`--keep-skills` 保留已有本机 skills。`DSH_BIN` 和 `DSH_HOME` 可以覆盖默认 CLI 与数据根目录。

3. 完全退出并重新打开 DSH。目标日程、会话可视化保留原侧栏入口；Design 保留设计区和 Design 空间入口，具体位置随宿主导航布局变化。

根包不作为插件安装。直接使用 DSH CLI 时，指定 `plugins/<id>` 子目录。安装器保留 profile 的其他配置，去除重复的 bundle 引用；配置和 skills 的恢复记录保存在 `$DSH_HOME/plugin-backups/`。

## 开发与检查

```sh
npm run plugins:list
npm run check
npm test
npm run test:host
npm run test:browser
npm run build --workspace @local/dsh-plugin-design
npm run test --workspace @local/agent-session-visualizer
```

`npm test` 包含构建、安装器回归、Design 单元测试、OKR 临时目录测试、Session Visualizer 样例测试。`npm run test:host` 和旧入口 `./test.sh` 执行 Design 的 DSH Electron 端到端测试。`npm run test:browser` 执行已声明该入口的浏览器测试；本机 Provider 历史另用 Session Visualizer 的 `test:data:local` 和 `test:browser:cdp` 验证。

```text
plugins/        各插件的实现、清单、测试、示例和插件文档
scripts/        工作区任务、目录检查和安装器
test/          跨插件与安装流程测试
docs/          插件接入、迁移说明和来源记录
plugins.json    插件 ID、路径、成熟度、skills 与来源
```

## 数据与迁移

Design 继续使用 `~/.design`，OKR Host 工具继续使用 `~/.dsh_okr`。Session Visualizer 继续只读各 Provider 的原始历史，其服务地址仍为 `http://127.0.0.1:3789`。

本机 OKR 的旧 `data/` 和 Session Visualizer 的 `data/session-graph.json` 不进入 Git 或分发包。迁移时保留外部旧路径到新插件目录的兼容链接；这些链接属于本机环境，不作为其他机器的安装前提。

OKR 页面目前仍使用内存中的演示数据，与 Host 工具不是同一数据来源。此次迁移保持其现有行为。来源和验证范围见 [迁移记录](docs/migration.md)；新增插件按 [接入约定](docs/plugin-guide.md) 操作。
