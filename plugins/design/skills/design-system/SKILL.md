---
name: design-system
description: 在本地工作区建立或修改设计规范，包括设计 tokens、字体、素材和设计系统文档，并使用插件工具校验。
---

# 设计系统工作流程

1. 读取已有设计规范，确定颜色、字体、间距和组件的用途。使用用户已有规范，缺失部分明确记录假设。
2. 按 [文件格式](references/format.md) 保存 design-system.json、tokens.json 和 README.md。
3. 用 design_system_import_asset 保存图片、字体等素材，将返回的 record 写入 indexPath 指定的位置。
4. 执行 design_system_check，修复问题。静态校验不会执行组件代码；涉及实际界面时另建 .dc.html 示例并验证。
5. 说明修改内容、验证结果和仍需用户确认的设计决策。

复用可交互设计组件优先使用本插件的 dc-import。不要默认生成依赖 React、JSX 或远程 CDN 的组件包。用户提供的第三方组件和字体仍需按其自身许可使用，不能通过导入消除来源要求。
