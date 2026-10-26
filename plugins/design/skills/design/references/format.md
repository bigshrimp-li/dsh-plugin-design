# 本地设计稿文件协议

一个设计稿目录包含 canvas.json、一个或多个 .dc.html 画板，以及 assets/ 素材目录。

## 索引

```json
{
  "v": 3,
  "createdOnFiles": {"v": 1},
  "title": "Example",
  "boards": {"Main.dc.html": {"x": 0, "y": 0, "w": 520, "h": 560}},
  "order": ["Main.dc.html"],
  "pages": [],
  "notes": {},
  "designSystems": []
}
```

每块画板必须存在于 boards 和 order，且尺寸为 40–8000 px。文件路径使用相对路径；目录名和文件名仅用英文字母、数字、下划线、点和连字符，首字符不能是点或连字符。不要用符号链接。

## 画板

```html
<!doctype html>
<html><head><meta charset="utf-8">
<script src="./support.js"></script>
</head><body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<div style="width:520px;height:560px;background:#fff">
  <h1>Example</h1>
  <button onClick="{{increment}}">{{count}}</button>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":520,"height":560}}'>
class Component extends DCLogic {
  renderVals() {
    return {
      count: this.state.count || 0,
      increment: () => this.setState(s => ({count: (s.count || 0) + 1}))
    };
  }
}
</script>
</body></html>
```

support.js 由插件提供。一个画板包含一个 x-dc 模板及一个 data-dc-script。$preview 的 width/height 与索引 w/h 一致。data-props 是 HTML 属性中的 JSON；注意单引号和 & 的实体转义。

## 绑定与交互

- `{{name}}`、`{{item.label}}`：从 renderVals 的结果取值。也支持数字、布尔值和字符串字面量。计算和函数调用放进 renderVals，不写进绑定。
- `<sc-if value="{{visible}}">…</sc-if>`：按布尔值显示节点。
- `<sc-for list="{{items}}" as="item" key="{{item.id}}">…</sc-for>`：渲染列表。每项可使用 `$index`；优先提供稳定且唯一的 key。
- `onClick="{{handler}}"` 等事件绑定函数。输入框 onChange 对文本输入响应 input，对 select/checkbox 响应 change。事件是原生 DOM Event。
- `this.props` 接收属性；`this.state` 保存实例状态。setState 接收对象或函数，支持更新后的回调；forceUpdate 请求更新。
- 支持 componentDidMount、componentDidUpdate、componentWillUnmount。不要依赖 React 其他 API。
- `ref` 可绑定回调或 `{current: null}` 对象；组件卸载时释放引用。
- data-props 的普通值作为初始属性；`{"editor":"text","default":"…"}` 采用 default。已有编辑器类型字段保持兼容，但不因此承诺实现每种属性面板。

## 组件、样式和资源

`<dc-import name="parts/Card" label="{{label}}"></dc-import>` 导入相对目录的 parts/Card.dc.html。子组件通过 this.props.label 读取属性。每次导入都有独立状态；组件不能循环导入。导入组件内部节点不能从父画板直接写回。

helmet 中的 style、link、meta、title 被放入文档 head。样式使用标准 CSS，动画使用 CSS animation 或 Web Animations API。SVG 使用标准 SVG 标记。表格写出 tbody，所有非空标签显式闭合。

图片和字体用 design_import_asset 返回的 `/_blob/<id>` 地址。字体声明放在 helmet/style 中。为了离线展示，使用本地字体或系统字体。

链接 `Other.dc.html` 用于画板跳转。导出器会转换为 Other.html，组件导入则直接嵌入目标源码。导出不会调用远程脚本；远程字体链接会被移除并使用备用字体。

## 能力边界

运行时不加载 React、ReactDOM、Babel、JSX 或 x-import。旧平台的专用动画指令和不完整文件流式执行没有兼容承诺；使用标准 CSS 动画，文件保存完整后刷新。逻辑脚本只处理可信设计稿，不是隔离运行任意不可信 JavaScript 的沙箱。
