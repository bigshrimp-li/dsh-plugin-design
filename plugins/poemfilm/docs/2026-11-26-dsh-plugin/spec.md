# 将古诗视频 CLI 与 Skill 合入 DSH

此次接入保留 poemfilm 命令、作品格式、钥匙串服务名和资金账本。一个插件包负责分发 CLI、宿主入口与同名 Skill。凭证和真实作品不随包发布。

| 变更 | 验收 |
|---|---|
| 收录独立 CLI 与 Skill，并登记工作区 | 公共包可导出宿主与客户端，CLI 能从安装的包运行，安装器复制对应 Skill |
| 将 DSH 模型工具连接到既有 CLI | 能查看绑定作品；远端生成沿用同一份已有任务授权 |
| 验证公开分发 | 工作区检查、插件测试、打包与隔离 profile 安装 |

## 验收结果

- 根目录 `npm run check` 与 `npm test` 通过。Poemfilm 的 4 项 DSH 工具测试、38 项 Python 测试及其中的 11 项子测试通过。
- 将 npm 压缩包安装到空目录，使用其 `.bin/poemfilm` 读取版本、创建两句词的作品并读回原文。
- 在 DSH 0.2.2-rc.5 的临时 profile 中连续安装两次。两次安装后的插件声明、依赖锁文件、Skill 内容与归属清单一致。安装 OKR Schedule 后再重装 Poemfilm，两个插件均加载。
- 通过已安装的 Cordis 和 DSH Tools 加载插件，发现默认的五个工具。`poemfilm_show` 读回临时作品的两句词，`poemfilm_plan` 指出缺少分镜与素材。
- 礼金准入及生成使用模拟服务验证。以上验收未发送真实推理请求。
