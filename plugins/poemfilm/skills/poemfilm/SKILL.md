---
name: poemfilm
description: 用 poemfilm 为古诗词写第一人称分镜、制作中式动漫原画和诗人配音、比较朗读版本，并在本机排镜和验片。支持 DeepSeek Harness 的插件工具、绑定的 MCP 和本机 CLI。
---

# 用 poemfilm 制作古诗视频

## 找到当前作品

1. 在 DeepSeek Harness（DSH）中优先用 `poemfilm_show`。宿主已绑定作品和版本，工具直接返回台词、镜头和候选 ID。若工具提示尚未绑定，请让宿主指定作品绝对路径 `work` 和版本 `edition`。MCP 宿主提供的对应工具名是 `show`。
2. 受限宿主只使用其公布的工具。需要更多权限时说明缺少的配置，例如选入候选和导出需要 `allowEdit`，生成需要有效的 `job`。
3. 在有 Shell 权限且用户选择 CLI 的工作流中，使用已核实的插件启动器。可信宿主可提供 `POEMFILM_BIN` 的绝对路径。DSH 安装时，读取当前 profile 的 `package.json`，确认 `dsh.profile.bundles` 包含 `@local/poemfilm`，解析该 profile 的 `node_modules/@local/poemfilm` 实际包目录，使用它的 `bin/poemfilm`。源码使用者可从已知仓库的 `plugins/poemfilm/bin/poemfilm` 启动。用 `"$POEMFILM_BIN" --work "作品目录" show --edition "版本" --json` 查镜头。直接用安装在 PATH 的同名命令可能选错版本。缺少执行入口时请说明所需输入。

## 按用户的任务操作

| 用户要什么 | DSH 中的操作 |
|---|---|
| 看素材、重剪作品 | 调用 `poemfilm_plan`，查看 `data.renderable` 和 `data.issues`。按报告补足画面和音轨，再用 `poemfilm_render`、`poemfilm_verify` 出片验片。离线出片不使用模型额度。 |
| 询问做法、评估花费 | 只问做法时直接说明。需要价格时调用 `poemfilm_estimate`，用 `asset` 选择 `script`、`art` 或 `voice`。后两种另给 `target`，试读还需 `delivery`。 |
| 写分镜、补画、试读两版 | 先从 `poemfilm_show` 获取真实 ID。查看 `poemfilm_status`、`poemfilm_job_status`，在同一授权任务下调用 `poemfilm_generate`，每次提供 `max_usd` 美元字符串。返回两次实际保存的候选供对比。 |
| 将候选剪进成片 | 用 `poemfilm_select` 提交候选的 `asset` 和 `candidate`，在该版重新排镜、导出和验片。多个交付版本分别绑定相应版本操作。 |

例如，“谁怕？”可以试作平静自问和轻笑反问两条音轨。两次保留相同的台词 ID，各给一条具体的表演指导。每次生成的实际费用和未决预留都计入同一任务。交付时附上实际音轨或成片路径，注明哪些字音、重音或动作仍待人工核听、审看。

命令行使用 `--json`，按返回的 `ok`、`data` 和 `error.code` 判断是否成功。`credential_state=configured` 只代表本机已配置凭证，赠金另看资金状态。身份和赠金绑定、任务预算签发由用户或可信宿主在终端完成。遇到 `funding_mixed`、`job_budget_exceeded`、`job_scope_denied` 或缺少供应商价格上界时，说明具体原因，继续可做的离线步骤。`remote_outcome_unknown` 表示请求可能已计费，记录操作 ID 供核账；保留原授权和原 take，等待该请求核实。
