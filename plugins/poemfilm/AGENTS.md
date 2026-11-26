# Poemfilm 插件维护

先读仓库根规则及本插件的 README。Python CLI 在 src/poemfilm，宿主入口在 index.js。宿主工具与 Skill 共用 bin/poemfilm；只有 CLI 处理钥匙串、礼金准入和任务预留。新增宿主工具须保留宿主对作品、版本、预算和目标操作的约束。

版本或依赖变化时同步 package.json、pyproject.toml、uv.lock 和根 npm 锁文件。运行根检查、单测与包内容检查。测试使用合成媒体及模拟服务；真实作品、授权材料、账本和钥匙串导出不属于分发内容。
