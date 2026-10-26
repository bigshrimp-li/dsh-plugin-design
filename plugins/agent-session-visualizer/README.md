# Agent Session Visualizer

DSH 会话可视化插件，同时支持浏览器独立访问。通过通用 Session Graph 和 Codex、Claude、Grok、Noval 适配器展示会话、执行与子 Agent 的关系。

## 运行

1. 在仓库根目录执行 ./install.sh --plugin agent-session-visualizer --profile desktop。
2. 完全退出并重启 DSH，点击侧栏“会话可视化”。服务默认监听 127.0.0.1:3789。
3. 独立运行时，在本目录执行 npm start，再访问 http://127.0.0.1:3789。独立服务可以用 PORT 更换端口；DSH 集成的客户端地址仍为 3789，不宜只修改 Host 端口。

插件只读 Provider 原始历史。Noval 需要指定工作目录。自动摘要沿用原有本地 Magpie 接口 127.0.0.1:3425，该服务缺失时不代表轨迹数据服务不可用。

## 验证

- npm test：语法、Codex 和 Grok 样例测试；不要求真实历史。
- npm run test:data:local：本机 Codex、Grok、Claude 历史检查，要求对应历史存在。
- npm run test:browser:cdp -- --url URL --out OUTPUT_DIR：浏览器轨迹检查，要求 Chrome 与运行中的服务。
- npm run extract：从本机 Codex 历史生成 data/session-graph.json。该文件可能含真实消息，不提交、不分发。

浏览器检查材料默认进入仓库 .scratch/。迁移保留了原有基于固定会话的 test:browser:local；它的历史和数据量前提不适用于任意机器。
