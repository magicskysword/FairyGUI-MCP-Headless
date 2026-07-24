---
name: fairygui-headless
description: 使用 FairyGUI-MCP-Headless 查询、编辑、渲染、校验并发布本地 FairyGUI 工程。适用于 AI 直接创作 FairyGUI UI、批量修改组件 DOM、导入资源、通过 PNG 运行时预览循环调整以及生成正式运行时产物。
---

# FairyGUI Headless

把 FairyGUI 工程视为磁盘上的强类型 UI 文档。可以复用 HTML/CSS 的树、选择器、
样式和批处理知识，但只能使用本 Skill、完整 DOM 查询和工具结果明确声明的字段。
这里不是浏览器 DOM，也不是完整 CSS。

## 标准闭环

1. 用 `fairygui.project` 的 `open` 打开工程，保存 `projectId`。
2. 用一次 `fairygui.query` 批量查询包、组件、目标 DOM、资源引用和能力。
3. 先检查目标与能力，再把同一意图合并为一次
   `fairygui.apply_dom_patch` 或 `fairygui.apply_resource_operations`。
4. 写入成功后，顺序调用 `fairygui.render_component` 做命名批量渲染。
5. 根据 PNG、`availableState`、`appliedState`、Gear 隐藏摘要和 diagnostics
   调整，再次批量写入并渲染。
6. 局部完成后做 `quick` 校验；交付前做 `roundtrip`、`publish` 或 `full`。
7. 只有需要正式磁盘产物时才调用 `fairygui.publish`，最后关闭工程会话。

磁盘是唯一事实来源。工具会在查询、渲染和写入前刷新外部修改；没有草稿、
Undo/Redo、revision、文件锁或 Git 操作。不要假设并发 render 能看到尚未完成的
patch。

## 查询纪律

`fairygui.query` 的 `queries` 是最多 100 项的命名批次：

- `packages`：包；
- `resources`、`components`：资源和组件；
- `dom`：受限 DOM、静态 `stateModel` 与可选实例来源投影；
- `references`：资源引用来源；
- `capabilities`：implemented、planned 与 read-only 边界；
- `audit`：未知 XML 的只读审计。

大结果默认 `detail:"summary"`，默认分页 50 项。摘要用于定位，写入依据使用显式
`detail:"full"`；继续分页时原样传回不透明 `cursor`。DOM 的
`instanceProjection` 使用 `"none"|"summary"|"full"`，默认 `"none"`。

命名查询部分失败时，顶层仍是 `ok:true`、MCP `isError:false`，同时返回
`warnings:[{code:"PARTIAL_QUERY_FAILURE",...}]`。每个查询键有自己的成功或错误
信封；只重试失败项，不丢弃已经取得的数据。

`stateModel` 会解释 Controller 默认页、全部页面、Gear 适用页、当前有效值和节点
默认可见性。静态无法确定时返回 `unknown`，不要自行猜测。

## DOM 编写前置要求

公共样式使用 `left/top/width/height/opacity/rotation/scaleX/scaleY/...`，值是
JSON number；不要传 `px`、`calc()`、`vw/vh` 或运行时别名 `x/y/alpha`。

选择器只支持类型、`#id`、`[name="..."]`、复合形式、后代和直接子代 `>`。
不支持伪类、逗号组或通用 CSS。所有写目标必须传 `expectedMatches`，数量不符时
修正选择器，不要降低预期来掩盖歧义。

在执行 `insert`、`update` 或 `replace` 前，先读取
[`references/dom-authoring.md`](references/dom-authoring.md)。该引用是节点字段、
必填/可空规则、枚举、Relations、Group、List、Merge Patch 与五种操作范例的
编写契约。随后用 `detail:"full"` 查询实际目标；查询结果与引用共同构成输入依据。

## 原子 DOM 补丁

`fairygui.apply_dom_patch` 只接受一个组件和一个 `operations` 数组，支持：

- `insert`：在组件根插入新节点，由 `clientRef` 取得服务端 ID；
- `update`：对一个或多个目标应用受限 Merge Patch；
- `move`：把一个节点移动到 `toIndex`；
- `remove`：删除一个或多个节点；
- `replace`：以新类型或完整节点替换一个目标，并保留原稳定 ID。

`node` 与 `changes` 在公开工具 Schema 中有意保持为普通 JSON object，以确保
Agent 能发现工具；服务会按节点类型进行第二次严格校验。`INVALID_PATCH.path`
会精确指向 `operations[n].node...` 或 `operations[n].changes...`，应按
`actual`、`allowed` 和 `suggestedFix` 修正。

`update.changes` 遵循受限 Merge Patch：缺省字段不修改、对象递归合并、数组整体
替换、`null` 清除可选字段；必填字段不能清除。不能修改
`id/type/readOnly/capability`，类型变化使用 `replace`。`selector` 与
`targetRef` 必须且只能选一个；`targetRef` 只能指向本批已经执行的 `insert`。
`groupId`、Relation `targetId` 等引用可使用稳定节点 ID 或同批 `clientRef`。

批次会先预检所有目标，再修改完整内存模型；任一项失败都不写磁盘。成功结果只
返回事务、逐操作摘要、`affectedNodeIds`、文件和 `clientRefs`，不会回传完整
DOM；需要结果状态时再批量 query。

## 资源操作

`fairygui.apply_resource_operations` 批量创建包/组件、导入、替换、重命名、包内
移动和删除。高风险操作先传 `dryRun:true`：服务仍会读取最新磁盘、执行完整模型
操作、序列化和回读校验，但不创建事务、不写盘、不消费 inbox。确认
`operationResults`、`affectedReferences`、`fileChanges`、
`wouldConsumeInboxPaths` 和 `wouldRemoveDirectories` 后，再用相同操作传
`dryRun:false`。

导入源必须位于 `.fairygui-mcp/import-inbox/`，只传规范相对路径。不要传绝对
路径、`..`、目录或符号链接。冲突策略是 `reject|rename|replace`；删除策略是
`reject|cascade|force`。只有明确理解引用影响时才用 `cascade` 或 `force`。

## 命名批量渲染

`fairygui.render_component` 的唯一形式是 `renders` 命名对象，最多 20 项；单个
组件也必须给一个键。`imageResult` 为 `"inline"|"file"|"both"`，默认
`"inline"`；`stateDetail` 为 `"summary"|"full"`，默认 `"summary"`。
structuredContent 和文本永不包含 base64；内联 PNG 通过 `contentIndex` 对应
命名结果。

```json
{
  "projectId": "p_...",
  "imageResult": "file",
  "stateDetail": "full",
  "renders": {
    "default": {
      "packageId": "pkg00001",
      "componentId": "cmp01"
    },
    "page_one": {
      "packageId": "pkg00001",
      "componentId": "cmp01",
      "width": 800,
      "height": 600,
      "scale": 2,
      "state": {
        "controllers": [{
          "selector": "component-root",
          "expectedMatches": 1,
          "controller": "start",
          "page": { "index": 1 }
        }],
        "lists": [{
          "selector": "list[name=\"items\"]",
          "expectedMatches": 1,
          "selectedIndices": [1, 3]
        }],
        "trees": [{
          "selector": "tree[name=\"outline\"]",
          "expectedMatches": 1,
          "expansions": [{ "path": [0, 2], "expanded": true }],
          "selectedPath": [0, 2, 1]
        }],
        "scrolls": [{
          "selector": "instance[name=\"viewport\"]",
          "expectedMatches": 1,
          "position": { "y": 320 }
        }]
      }
    }
  }
}
```

Controller 的 `page` 必须在 `index/id/name` 中三选一；scroll `position` 至少给
一个轴。临时状态只存在于当前隔离 BrowserContext，不写盘、不影响下一张图。
单项组件或状态失败会保留其他命名结果并返回
`PARTIAL_RENDER_FAILURE` warning；工程会话、浏览器或共享编译失败才是顶层失败。

预览编译会在独立内存模型中临时导出全部组件，因此未在 Editor 勾选导出的组件也
能预览，工程发布设置不会改变。结果固定声明 `backend:"fairygui-dom"` 与
`fidelity:"runtime-preview"`；位置、显示、图片和颜色应肉眼接近 Editor，但
浏览器字体栅格化等仍可能产生少量像素差异，不是 Unity 像素真值。

## 校验与发布

`fairygui.validate` 的 `detail` 默认 `"summary"`：返回检查数、阶段指标、按严重度
和代码统计以及有限诊断；需要全部 ID 和诊断时用 `"full"`。工程问题是合法结果
`ok:true,data.valid:false`，不要只看 MCP `isError`。

`fairygui.publish` 直接使用工程发布设置：

- 省略 `packageIds` 发布全部，指定时使用稳定包 ID；
- `publishType:"full"` 完整发布；
- `publishType:"definitions"` 只跳过图集，不判断输出是否独立可用；
- `outputPath` 只临时覆盖运行时产物目录，代码路径仍来自工程设置。

不要把 validate 的 `publish` 模式当成正式发布；它只在临时目录验证链路。

## 调用纪律

- 先批量查询，再按明确字段写入。
- 写前检查能力；planned/read-only 不要尝试绕过。
- 同一意图一次批量调用，写成功后再顺序渲染。
- 根据稳定错误码与 `suggestedFix` 修正，不直接改 XML。
- 结束时调用 `fairygui.project` 的 `close`。
