# 设计系统文件格式

最小目录包括 design-system.json、tokens.json、README.md。素材放入 _blobs/，已导入素材按工具返回的索引记录引用。

```json
{
  "v": 3, "layout": "files", "createdOnFiles": {"v": 1},
  "title": "Local system", "namespace": "LocalSystem",
  "libraries": [], "sections": {}, "groups": [],
  "assetGroups": {}, "blobs": {},
  "docs": {"readme": "README.md", "sections": []}
}
```

namespace 是合法的 JavaScript 全局标识符。保留该字段用于现有文件兼容；本插件不会据此下载组件框架。createdOnFiles 或 convertedFrom 标记用于确认文件模式。

```json
{
  "version": 1,
  "color": {
    "themes": [{"id":"light","name":"Light"}],
    "tokens": [{"name":"ink","value":{"light":"#17212b"},"usage":"正文"}]
  },
  "type": {
    "fonts": [],
    "families": {"body":"system-ui, sans-serif"},
    "groups": [{"name":"Body","family":"body","styles":[{"name":"regular","fontSize":"16px","lineHeight":"24px","fontWeight":400}]}]
  },
  "spacing": {"tokens":[{"name":"space-4","value":"16px"}]},
  "radius": {"tokens":[{"name":"rounded","value":"8px"}]}
}
```

每个 token 族使用 tokens 数组。名称不得重复，最多 64 个字符。颜色可按主题指定，也可用 `{other-name}` 引用另一颜色；引用不能形成循环。字体记录使用 family 和相对 fonts/ 文件路径。间距和圆角需要 CSS 单位或零。

README 说明语义和用法，不只罗列色值。为常用颜色说明背景及文字组合，为字体说明用途。新增组件尽量提供独立 .dc.html 用例。

导入素材返回 `{name,blob,size,type}`。有 group 时保存到 assetGroups 的组内 files，否则保存到 blobs。编码后的索引 key 由工具返回，不自行猜测。素材组名不允许路径分隔符。

派生文件 manifest.json、tokens.css、api/ 不作为静态校验的事实来源。校验通过只表示结构和已实现规则通过，不代表任意第三方组件可运行。
