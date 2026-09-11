# 可运行预览示例

将 [示例工程](../examples/project/Examples.fairy) 所在的 `project/` 目录复制到工作目录后，用 `fairygui.project.open` 打开。
所有示例使用来源 `{ projectId, packageId:"example1", componentId:"gallery" }`。
从对应 JSON 读取 `recipe` 和 `run`，传给 `fairygui.preview.run`；`expect` 是示例的验收数据。

| 任务 | 示例 | 主要 API |
| --- | --- | --- |
| JavaScript 列表填充 | [list.json](../examples/list.json) | `GList.itemRenderer/numItems` |
| 树数据与展开 | [tree.json](../examples/tree.json) | `tree` 操作、`GTreeNode` |
| 控制器与 Gear Tween | [controller.json](../examples/controller.json) | `controller` 操作、逐帧状态 |
| 组件实例进度值 | [instance.json](../examples/instance.json) | `GProgressBar.value` |
| 动态节点与语义事件 | [dynamic-create.json](../examples/dynamic-create.json) | `GGraph.element`、`on/emit` |
| 循环动效采样 | [transition.json](../examples/transition.json) | `Transition.play`、多帧总览 |
| 构造前扩展注册 | [preconstruct.json](../examples/preconstruct.json) | `UIObjectFactory.setExtension` |

运行时与工程模型的属性类型以各自定义为准。例如运行时 `Shape.drawRect` 接收 `Color` 对象，原生工程颜色字段使用 XML 色值。
