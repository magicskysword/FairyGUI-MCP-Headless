# JavaScript 动态预览

配方见 [recipe](../definitions/preview/recipe.schema.json)，单次执行见 [run](../definitions/preview/run.schema.json)，声明式操作见 [operation](../definitions/preview/operation.schema.json)。
脚本上下文见 [preview-context.d.ts](../definitions/preview/preview-context.d.ts)，逐帧结果与 MCP 结果见 [preview-state.d.ts](../definitions/preview/preview-state.d.ts) 中的 `PreviewFrame` 和 `PreviewToolData`。

来源为 `{ projectId, packageId, componentId, planId? }`。配方包含 `environment/data/resources/preconstruct/setup/timeline`。
画布默认取组件尺寸，`scale` 默认 1、`seed` 默认 0、时钟默认 `manual`。
手动时钟以 60Hz 固定步长推进；所有 `at/times` 使用毫秒，截图时刻向后对齐模拟帧，结果同时返回请求时间、实际时间和帧号。

`preconstruct` 在组件构造前注册扩展；此时 `ctx.root` 尚未创建。
`setup` 在构造后按序执行一次；会话后续操作放入 `run.operations` 或时间线。
脚本参数为 `ctx` 和 `fgui`，后者即 FairyGUI-dom 公共 API，类型入口为 [runtime/FairyGUI.d.ts](../definitions/runtime/FairyGUI.d.ts)。
脚本可使用顶层 `await`；同一时刻按输入顺序等待操作完成，再更新动画、刷新布局并采样。手动时钟只在采样推进时前进，未来模拟时刻的工作使用定时回调或时间线安排。

`ctx` 提供：

- `root`：当前根组件；`data`：配方 JSON 数据。
- `query(selector)`、`one(selector)`：查询多个或严格一个运行时对象。
- `ref(object)`、`resolve(ref)`：建立及解析会话内对象引用。
- `resources.url(name)`：访问配方 `resources` 中映射的快照文件。
- `clock.now()`、`setTimeout(fn,ms)`、`setInterval(fn,ms)`、`clear(id)`、`requestFrame(fn)`、`cancelFrame(id)`：受控调度。
- `log(...)`、`warn(...)`：记录带时间的诊断。

选择器支持 `:root`、`#id`、`[name="title"]`、原生类型和运行时引用。同一来源有多个实例时优先使用唯一运行时引用。
资源映射的值是工程相对路径；由已捕获快照提供字节。

```json
{
  "action": "run",
  "source": { "projectId": "p_example", "packageId": "pkg00001", "componentId": "cmp01" },
  "recipe": {
    "data": { "title": "Preview" },
    "setup": [{ "op": "script", "code": "ctx.one('[name=\"title\"]').text = ctx.data.title;" }],
    "timeline": [{ "at": 100, "operations": [{ "op": "set", "target": "[name=\"title\"]", "props": { "alpha": 0.5 } }] }]
  },
  "run": { "times": [0, 100, 300], "properties": ["x", "y", "alpha", "text"] }
}
```

单次最多 64 帧、60 秒模拟时间，单帧物理边长最大 4096px，累计采样最多 128 百万像素。
执行墙钟超时 30 秒、编译超时 120 秒，由宿主终止工作进程。固定快照编译结果可缓存复用。

`sourceStatus` 报告 current、changed 或 plan；运行中外部修改不会替换会话快照。
实际状态包括属性、Controller、Gear、Transition 等信息；图片是 FairyGUI-dom runtime-preview。
字体与浏览器环境会影响栅格化结果，跨环境比较应同时检查属性序列。
