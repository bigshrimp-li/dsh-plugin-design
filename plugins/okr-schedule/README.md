# 目标与日程罗盘 (OKR Schedule Navigator) - DSH 插件

专门为 **DeepSeek Harness** 开发的日常工作与生活日程管理插件。

通过 **“目标牵引（O）+ 核心支撑点（K）+ 日程执行（Schedule）+ 阶段成果评价（R）+ 灵感沉淀（Inspirations）”** 架构，将个人长期投入（如制作 Super Agent、英语进阶、健身锻炼、量化研究）与每日单点/周期日程无缝连接。

---

## 当前实现与安装

在本仓库根目录执行 `./install.sh --plugin okr-schedule --profile desktop`，重启 DSH 后从侧栏进入“目标日程”。Host 实际读取 `~/.dsh_okr/global_index.json` 和各目标目录，仓库旧 `data/` 保留为本机资料，未提交、未打包。

页面目前仍使用 `initialData` 与 React 内存状态；页面修改和模拟 AI 回复尚未接入 Host 持久化。以下特性包含原始设计目标，实际行为以源码与上述限制为准。

## 一、 插件特性

1. **三维核心业务视角**：
   - 📅 **整合日历 (Calendar)**：涵盖月视图（目标色彩药丸）、周视图（24h 时段 Blocking）、日视图（今日聚焦、一键打卡流转、每日反思与收获便签）；
   - 📊 **甘特与看板 (Gantt & Kanban)**：针对 O 深入看板，展示各个 K 的执行进度与时间窗口，支持待开始/进行中/已完成的看板流转；
   - 🎯 **O 专属网页 (Dedicated Workspace)**：愿景 Banner、动态进度、K 态势、💡 灵感与想法草稿箱、📚 关联工作区文档、🏆 阶段成果复盘 (R)；
   - 🤖 **AI Copilot 智能抽屉**：对话式自动打卡、灵感捕获、热身清单制定。
2. **归档封存核心规则**：
   - K 和 O 都有归档状态；
   - 归档后，K 与历史日程封存只读，**唯独阶段成果 R（Result）终身保持可追评与更新**。
3. **元数据与内容存储**：
   - `data/metadata.json`：存储全局 ID 索引、关系映射、状态、颜色、周期提醒规则；
   - `data/**/*.md`：存储 O/K/R 的深度内容、随笔与知识库关联。
4. **Agent 工具集成 (Host Tools)**：
   - `okr_schedule_query`: Agent 查询日程与 OKR 进展；
   - `okr_schedule_checkin`: Agent 帮用户打卡日程并记录心得；
   - `okr_inspiration_capture`: Agent 快速捕获灵感并归纳至对应 O。

---

## 二、 目录架构

```text
dsh-okr-schedule-plugin/
├── package.json          # 插件清单 (exports, bundle patch, client inject)
├── cordis.patch.yml      # Cordis Loader 补丁定义
├── icon.svg              # 罗盘与日程专属 SVG 图标
├── index.js              # Host 端实现 (数据持久化 + Agent Tools)
├── client.js             # Client 端实现 (UI 视图、日历、甘特图、AI 抽屉)
├── locale/
│   ├── zh.json           # 中文标题与描述元数据
│   └── en.json           # 英文标题与描述元数据
├── data/
│   ├── metadata.json     # 全局核心元数据表
│   ├── objectives/       # 目标 Markdown 正文
│   ├── keypoints/        # 核心支撑点 Markdown 与清单
│   └── results/          # 阶段成果评价 R
└── README.md             # 本文档
```

---

## 三、 安装与使用方式

在 Harness 中作为 profile 插件安装：
```bash
# 在 DSH 终端或通过 plugin_manager 进行安装
./install.sh --plugin okr-schedule --profile desktop
```
安装后，Harness Web UI 左侧侧边栏将常驻 **“🧭 目标日程”** 图标，点击即可进入全屏独立页面！
