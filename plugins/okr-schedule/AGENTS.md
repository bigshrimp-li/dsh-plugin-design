# 目标日程插件维护规则

本目录继承仓库根 [AGENTS.md](../../AGENTS.md)。修改前先读 [README.md](README.md)，区分已经实现的能力、合成模型协议测试和真实 Provider 验收。

## 目录与修改入口

| 路径 | 内容与使用方式 |
|---|---|
| `index.js` | Host 入口、兼容工具注册和可选宿主服务接入。 |
| `client.js` | 真实工作台、日历、审查与聊天；只依据 Host 回执显示业务结果。 |
| `locale/`、`icon.svg` | 中英文元数据和导航图标。 |
| `src/host/` | SQLite Worker、领域服务、受限工具、方案版本、Bot、群、HTTP 与兼容层。 |
| `bin/`、`scripts/` | CLI、检查、临时预览、浏览器和真实宿主探测。 |
| `test/` | 临时 HOME 合成数据测试；浏览器入口与普通测试分开。 |
| `preview.html` | 本地页面预览材料，不代表 Host 数据已经接通。 |
| `docs/` | 本插件的迭代 spec，记录 tickets、进度、问题和验收结果。 |
| `provenance/` | 导入来源与快照哈希，移动记录时保持原文不变。 |
| `data/` | 迁入前遗留的本机资料，不是当前 Host 数据源，不提交、不分发。 |
| `package.json`、`cordis.patch.yml` | 依赖、分发清单和 Loader 配置。安装使用仓库根 `install.sh`。 |

本插件的开发迭代记录写入 `docs/YYYY-MM-DD-<主题>/spec.md`。唯一的整体 [产品设计](../../../learning/原型设计/目标日程插件/产品设计.md) 保存在同级 Learning，依次写领域对象及其关系、核心功能、核心案例；对象关系合为一章不设小标题，功能用无序列表说明设计理念并附简短场景，案例复用现有 demo 和设计图，不再拆出 Learning 核心工程文档。

每项新产品需求在 `learning/原型设计/目标日程插件/需求/YYYY-MM-DD-简短主题/` 独立保存增量 `产品设计.md` 和 `UI设计原型/`。讨论阶段保留未确认设计；用户确认定稿后按三个章节融入整体文档，并在需求文档记录融合位置、日期与状态。设计确认、内容融合与实现验收分别判断。

本插件 spec 链接相关需求，保存开发 tickets、进度、问题和测试验收；实现细节留在源码仓库。融合规则见 [Learning 目录规则](../../../learning/原型设计/AGENTS.md)。

## 数据与兼容边界

1. 数据根目录仍为 `~/.dsh_okr/`。迁移后每 O 的 `space.sqlite` 为业务与运行状态权威来源；群状态在 `groups/general/group.sqlite`，不得复制正式事项。原JSON保留备份，不双写；正文导出不成为第二权威来源。
2. 所有SQLite与迁移文件操作在专用Worker执行。保留O绑定、来源、bundle版本、revision、context fence、幂等和归档校验。调用接纳、业务保存和发布分别判断；草稿回执为trial，不冒充saved。
3. 保留包名及客户端 ID `@local/okr-schedule`、Loader ID `okr-schedule`、slot key，以及 `okr_schedule_query`、`okr_schedule_checkin`、`okr_inspiration_capture` 三个工具名。CLI及生成的空间Skill不获得任意终端、文件或跨O权限。
4. 测试和安装探测使用临时HOME、合成空间及独立profile，不自动迁移真实用户数据；清理不删除旧data/、用户空间或其他任务材料。迁移时通过compatibility/legacy共享写队列暂停同进程旧写，其他进程的旧写须先停止。
5. 本轮图片输入不在实施范围。新能力不可用时明确关闭对应能力，不能用模拟回复代替模型、持久化或真实缓存证据。

## 验证与收尾

1. 在仓库根目录执行 `npm run check` 和 `npm test`。需要单独检查时，在本目录执行 `npm run check` 和 `npm test`。
2. 修改客户端页面或 DSH 接入时，补做相应浏览器或宿主检查。本插件分别提供 `test:browser`、`test:host` 与临时安装profile探测入口，按README前提执行；宿主测试的合成transport不代表真实模型语义验收。
3. 将 tickets 状态、问题处理、验证结果和未完成项写入本次 spec。数据路径或页面持久化能力变化时同步 README；只清理本次生成的临时材料。
