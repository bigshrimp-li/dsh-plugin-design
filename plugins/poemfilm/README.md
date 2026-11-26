# Poemfilm

一个 DSH 插件同时提供古诗视频制作工具、`poemfilm` Skill 和同源 CLI。你可以先让助手检查某版分镜缺哪些素材，再针对一句诗试读两个版本。剪接、字幕和验片都在本机完成。

## 安装

需要 Node.js 20+、uv 和 Python 3.11+。剪辑与验片还需要 FFmpeg 和 FFprobe；项目密钥登录使用 macOS 钥匙串。从仓库根目录执行：

```sh
./install.sh --plugin poemfilm --profile desktop
./plugins/poemfilm/bin/poemfilm --version
```

安装器在构建阶段准备锁定的 Python 依赖，为所选 profile 注册 `@local/poemfilm`，并把同名 Skill 放到 DSH 的 skills 目录。重新启动目标宿主后即可发现工具。若直接使用 npm 分发包，可以先运行包内的 `bin/poemfilm --setup` 初始化依赖。日常执行启动器不需要下载软件。

## 绑定作品

首次使用可在终端从已核定的 UTF-8 原词建一个作品：

```sh
./plugins/poemfilm/bin/poemfilm init ./我的词作 --poem ./原词.txt --edition 温叙
./plugins/poemfilm/bin/poemfilm --work ./我的词作 show --edition 温叙 --json
```

在可信 DSH 宿主配置中指定 `work`（作品绝对路径）及 `edition`（版名）；也可在启动该宿主的环境中设置 `POEMFILM_WORK` 和 `POEMFILM_EDITION`。随后可对助手说“看看温叙版缺哪段原画”。`poemfilm_show`、`poemfilm_plan`、`poemfilm_estimate`、`poemfilm_status` 和 `poemfilm_verify` 提供本地操作。`plan` 与 `verify` 会写入派生的时间线或报告。

- 配置已有 `job` 或 `POEMFILM_JOB` 后，助手可以使用生成工具及查询该任务的预算。调用由绑定任务约束作品、版本、目标、次数与总额。
- 开启 `allowEdit: true` 或在宿主设置 `POEMFILM_ALLOW_EDIT=1` 后，助手还可以选择候选和导出该版成片。模型工具参数无法替换宿主绑定。
- 用户在自己的终端完成 `auth login`、`funding bind` 和 `job authorize`。礼金不足、资金来源混合或本次费用上界缺失时，CLI 会在发送请求前停止。GPT Image 2 的公开估价不等于严格模式所需的单次费用上界。[完整命令与礼金规则](使用说明.md)

CLI、MCP 和 DSH 使用同一套源码、作品格式和资金账本。原有作品可以继续使用。作品与输出保存在用户指定的作品目录，内部账本默认位于 `~/Library/Application Support/poemfilm`，原有项目密钥仍在原钥匙串服务。用户缓存目录下的 `dsh-poemfilm` 仅保存 Python 依赖。

## 开发验证

从仓库根目录执行 `npm run check` 和 `npm test`。插件测试覆盖 DSH 工具调用、离线 CLI、媒体与模拟资金流程。在插件目录执行 `npm pack --dry-run` 检查分发内容。[Skill](skills/poemfilm/SKILL.md) · [迁入来源](../../docs/imports/poemfilm.json)
