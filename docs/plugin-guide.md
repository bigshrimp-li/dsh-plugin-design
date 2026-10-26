# 插件接入约定

一个插件对应一个 plugins/<id>/ 目录。目录中包含 package.json、cordis.patch.yml、宿主与客户端入口、说明和测试；插件使用自己的版本，不随根包统一升级。

1. 将完整源码放入插件目录。先区分源码、样例、本机业务数据和生成文件。真实数据留在本机并加入忽略规则，同时从 package.json 的 files 中排除。
2. 保留原有插件身份。清单中的包名、patch 名称和客户端模块 ID 保持一致，确认 Loader ID、工具名、slot key、HTTP 路由和存储 key 没有冲突。
3. 提供 build、check、test 脚本。无需编译的 JavaScript 插件可让 build 调用 check；需要宿主的测试另设 test:host，便于区分环境前提。
4. 在 plugins.json 登记 ID、路径、成熟度、skills 和来源。包名、版本和导出路径直接读取插件清单，不在目录表重复保存。
5. 在 docs/imports 保存导入来源、日期和文件 SHA-256。有上游时记录固定提交；含未提交变更时以工作文件哈希为准。导入后明确在本仓库开发，或从指定上游单向更新。
6. 运行 npm run check、npm test 和 npm pack --dry-run，检查插件包包含 patch、客户端、服务端和所需资源。使用临时 profile 验证独立安装、重复安装与其他插件共存。
7. 运行 ./install.sh --plugin ID --profile NAME，再重启 DSH 验证可见入口。安装器只接管目录表声明的 skills；未归属或被用户修改的同名 skill 会阻止覆盖。

新 skill 默认使用插件前缀。Design 保留现有 design、design-system 名称。公共脚本读取插件目录，不依赖插件业务实现。只有出现实际复用需求后才增加公共包。

单独移除插件可执行 dsh plugin --profile NAME remove PACKAGE，并从该 profile 的 dsh.profile.bundles 移除同名项后重启。移除插件不删除用户数据；skills 需核对归属后单独处理。
