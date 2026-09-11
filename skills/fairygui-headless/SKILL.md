---
name: fairygui-headless
description: 使用 FairyGUI-MCP-Headless 原生模型查询和编辑本地 FairyGUI 工程，通过隔离 JavaScript 会话采样动态 UI，并校验或发布工程产物。
---

# FairyGUI Headless

使用 `fairygui.project` 打开工程，记录 `projectId` 和 `service` 中的版本、Skill 路径。
先按任务读取定义文件，再查询实际对象；字段采用 FairyGUI 原生命名，如 `x`、`y`、`alpha`。

## 按需导航

- 类型或 API 定位：读取 [definitions/index.json](definitions/index.json)，选择需要的 authoring、preview 或 runtime 文件。
- 工程编辑：先读 [references/authoring.md](references/authoring.md) 和 [操作 Schema](definitions/authoring/operations.schema.json)，再读查询结果 `definition.file` 指向的类型。
- 动态试验：读 [references/preview.md](references/preview.md)、[配方 Schema](definitions/preview/recipe.schema.json)、[执行 Schema](definitions/preview/run.schema.json)；具体 API 按需读取 runtime 类声明。

## 创作闭环

1. `fairygui.query` 用 `queries` 命名批量定位包、资源、组件及原生对象。默认摘要分页 50 项；修改前显式查询 `detail:"full"`，查看 `props`、Gear 控制范围及引用。
2. `fairygui.edit` 使用 `plan` 生成可预览的修改结果。检查逐操作结果、文件差异、ID 映射和诊断。
3. `fairygui.preview` 以工程组件或 `planId` 为来源，用 JavaScript 注入数据、执行时间线，采集 PNG 与实际属性。
4. 依据实际结果修正操作并重新生成计划；确认后用 `commit` 和唯一 `requestId` 原子提交。简单明确的修改可直接 `apply`。
5. `fairygui.validate` 局部使用 `quick`，完整检查使用 `full`。判断 `data.valid`，工程诊断可能存在于 `ok:true` 的调用结果中。
6. 需要正式产物时调用 `fairygui.publish`。结束后关闭预览与工程会话。

命名查询和预览逐项返回结果，先检查每项的 `ok`；编辑批次全部成功或全部失败。
静态查询中的来源组件与实例目标分开定位；运行时对象通过 `preview.inspect` 返回会话内唯一引用。

## 请求与生命周期

`apply/commit` 的 `requestId` 标识一次逻辑写入，重试原请求时保持不变；内容不同须换新值。
计划默认有效 30 分钟。`SOURCE_CONFLICT` 表示来源或依赖已变化，需要重新规划。

`preview.run` 带 `source` 时结束即释放环境，带 `previewId` 时继续会话。
`open` 建立持续会话；`inspect` 读取实际状态；`capture` 不推进模拟时间；
`reset` 重放同一快照与种子；`reload` 使用最新工程；`close` 释放环境。
持续会话最多两个，空闲 15 分钟回收；关闭工程会同时释放关联会话和计划。

单帧默认返回图片；多帧默认返回时间总览和逐帧文件索引。
`imageResult:"file"` 仅返回文件位置，`includeFrames:true` 额外内联单帧。
文本中的 `contentIndex` 指向 MCP 图片块。

错误修正依据为 `code`、`path`、`actual` 及关联定义。预览失败后保留已完成结果；
持续会话可检查、重置或关闭。预览中的业务数据和脚本修改只存在于隔离环境。
