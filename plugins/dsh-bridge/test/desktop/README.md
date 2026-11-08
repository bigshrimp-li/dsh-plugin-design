# 原生桌面安装与升级回归

在 macOS 上使用官方 DSH 0.2.1-rc.3 和 0.2.1-rc.5、插件 0.1.2 的发布包，以及已构建的 agent-loop-core（运行 `npm run build:go` 生成 `go-runtime/bin/super-agent-runtime`）。每次运行使用临时 Go Runtime 与本机确定性模型。

1. 准备两版签名的 `.app`，分别保存在独立路径。rc.5 默认从 `/Applications/DeepSeek Harness.app` 读取。旧包须是实际 `npm pack` 生成的 0.1.2 tarball。如需重建，可在旧版源码所在的独立工作树（0.1.2 对应提交 `3b23134`）中安装依赖，在 `plugins/dsh-bridge` 下执行 `npm run build`、`npm pack`。macOS arm64 的 rc.3 可从官方归档取得，解压后可用 `codesign --verify --deep --strict` 检查应用签名。[DSH rc.3 官方归档](https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.3-mac-arm64.zip)
2. 在当前插件目录运行以下命令。脚本重新构建候选版并执行 `npm pack`，输出两份包的 SHA-256，使用两版 DSH 自带的 CLI 安装。

   ```sh
   npm run test:desktop-install -- \
     --previous-app '/path/to/rc3/DeepSeek Harness.app' \
     --current-app '/Applications/DeepSeek Harness.app' \
     --legacy-archive '/path/to/super-agent-dsh-bridge-0.1.2.tgz' \
     --core-source '/path/to/built/agent-loop-core' \
     --report '/path/to/output/install-upgrade.json'
   ```

3. `--report` 可选。指定后会输出两份包的哈希、宿主版本与检查结果。核对五行 `PASS`。前两项验证 rc.5 拒绝并回滚 0.1.2 安装，以及全新原生 profile 可选模型并发送消息，看到由 Go 完成并持久保存的真实回复。后三项在同一 profile 验证 rc.3 的 0.1.2 能保存 Thread、Conversation 和未发送草稿，rc.5 拒绝该旧插件，再覆盖安装候选包后读回同一 Thread 和草稿。

两个场景各有独立的 `HOME`、`DSH_HOME` 与 Chromium 用户目录，并通过同一 UDS 访问本次验收专用的 Go Runtime 和 Super Agent 数据目录。测试使用官方应用的临时副本，在业务代码执行前禁止该测试进程激活，屏蔽显示窗口与系统协议注册。任何测试窗口曾显示或获得焦点，检查都会失败。官方 Host、兼容性检查和原生 renderer 按正常入口运行。结束时关闭测试进程并删除临时 profile；随后关闭该测试的 Core 和模型，删除合成 Thread、草稿与临时凭据。
