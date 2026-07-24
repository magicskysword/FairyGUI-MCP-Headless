---
name: fairygui-headless
description: 使用 FairyGUI-MCP-Headless 查询、编辑、渲染、校验并发布本地 FairyGUI 工程。适用于 AI 直接创作 FairyGUI UI、批量修改组件 DOM、导入资源、通过 PNG 运行时预览循环调整以及生成正式运行时产物。
---

# FairyGUI Headless

把 FairyGUI 工程视为磁盘上的强类型 UI 文档。复用 HTML/CSS 中关于树、选择器、样式和批处理的知识，但只使用工具 Schema 明确支持的字段；这里不是浏览器 DOM，也不是完整 CSS。

## 标准工作流

1. 用 `fairygui.project` 的 `open` 打开工程并保存返回的 `projectId`。同一路径重复打开会复用会话。
2. 用一次 `fairygui.query` 放入多个命名查询，批量查询包、组件、目标 DOM、资源引用和能力矩阵。不要为每个字段单独调用工具。
3. 编辑前检查 `capabilities`。`implemented` 才可写；`planned` 或 `read-only` 不要尝试绕过。
4. 组件内容修改使用一次 `fairygui.apply_dom_patch` 批量提交相关操作；包和资源修改使用一次 `fairygui.apply_resource_operations`。
5. 写入成功后顺序调用 `fairygui.render_component` 查看内存编译的 PNG 运行时预览，再根据视觉反馈批量调整。
6. 完成局部修改后用 `fairygui.validate` 的 `quick` 校验；交付前使用 `roundtrip`、`publish` 或 `full` 校验。
7. 只有需要正式磁盘产物时才调用 `fairygui.publish`。

磁盘是唯一事实来源。工具会在读取、写入和渲染前刷新外部修改；没有草稿、Undo/Redo、revision、文件锁或 Git 操作。不要假设并发渲染能观察到尚未完成的写入。

## 高效查询

`fairygui.query` 的 `queries` 是命名批次。一次请求可以同时查询：

- `packages`：工程包；
- `resources` 与 `components`：资源和组件；
- `dom`：强类型 DOM，可选受限选择器和只读实例投影；
- `references`：资源引用来源；
- `capabilities`：implemented、planned 与 read-only 边界；
- `audit`：未知 XML 结构的只读审计。

批量查询发生部分失败时，顶层返回 `PARTIAL_QUERY_FAILURE`，成功兄弟仍保留在每个查询键下。只重试失败项，不要丢弃已经取得的数据。

## DOM 与选择器

公共样式采用规范名称，例如 `left`、`top`、`width`、`height`、`opacity`、`rotation`、`scaleX` 和 `scaleY`。数值直接使用 JSON number；不要传 `px`、`calc()`、`vw`、`vh` 或运行时别名 `x/y/alpha`。

选择器只支持：

- 类型：`text`
- ID：`#n3`
- 名称属性：`[name="title"]`
- 复合：`text[name="title"]`
- 后代与直接子代：`component-root text`、`component-root > text`

不支持伪类、逗号组和通用 CSS。所有写目标都必须给出 `expectedMatches`；匹配数量不同属于失败，不会猜测目标。

同一批新增节点通过 `clientRef` 相互引用。组件实例默认是边界节点；`resolvedPreview:true` 只提供来源投影，不能跨边界写入。Group 成员仍是兄弟节点并通过 `groupId` 关联；List/Tree 项目不是普通子节点。

## 原子写入

`fairygui.apply_dom_patch` 支持：

- `operations`：把插入、删除、移动、改名、样式、文本、资源、Relations 和静态 List 项目合成一个原子批次；
- `replace`：每次只替换一个内容域。

优先使用 operations 做局部编辑。只有确实要完整接管一个内容域时才使用 replace；若未知 XML 无法安全保留，会返回 `OPAQUE_CONTENT_CONFLICT` 且不写磁盘。

`fairygui.apply_resource_operations` 把创建包/组件、收件箱导入、替换、重命名、包内移动和删除合成一个原子批次。导入文件必须预先放入工程的 `.fairygui-mcp/import-inbox/`，并传规范相对路径。不要传绝对路径或 `..`。

资源冲突使用 `reject|rename|replace`；默认 `reject`。`replace` 必须指定已有 `resourceId`，以保留 ID 和引用。删除默认 `reject`；只有明确理解引用影响时才使用 `cascade` 或 `force`。

## 反馈与校验

`fairygui.render_component` 返回：

- `backend: "fairygui-dom"`
- `fidelity: "runtime-preview"`
- PNG、边界、诊断和渲染器版本

工具会直接从未发布的工程在内存中编译运行时包，并执行真实 FairyGUI-dom 组件与资源加载；临时运行时产物不会写入源工程。预览应在位置、显示、图片和颜色上肉眼接近 Editor，但因浏览器与 Unity/Editor 的渲染后端不同，仍不是像素真值。遇到外部资源、计划能力或渲染差异时先阅读 diagnostics，再决定修改。浏览器缺失时按 `BROWSER_NOT_INSTALLED.suggestedFix` 安装 Playwright Chromium；工具不会静默下载或回退到系统浏览器。

`scale` 同时控制截图像素密度和 FairyGUI 高分辨率资源选择；需要检查 `@2x/@3x/@4x` 资源时分别传 `2/3/4`。隐式变体不要求单独导出，也不会因预览而写回工程。

需要查看控制器的非默认页、List/Tree 状态或滚动区域时，在同一次调用中传入临时状态。`state.controllers` 每项使用受限 DOM `selector`、`expectedMatches` 和控制器 `controller`，并以 `selectedIndex`、`pageId` 或 `pageName` 三选一指定页面；`state.lists` 用 `selectedIndex`（`-1` 清空）或唯一的 `selectedIndices` 设置非 Tree 列表；`state.trees` 用逐级子节点索引组成的 `nodePath` 设置 folder 展开状态和选中节点，`selectedPath:null` 清空选择；`state.scrolls` 使用相同目标约束和非负像素 `x`/`y`，位置必须处于返回的实际可滚范围。临时状态可穿入已实例化的嵌套组件，但只存在于该次隔离截图中，不会写盘或影响下一次渲染。遇到 `SELECTOR_MATCH_COUNT` 或 `TRANSIENT_STATE_INVALID` 时根据返回的 `actual`、`allowed` 修正调用，不要猜测页面、项目索引、Tree 路径或依赖静默夹取。

`fairygui.validate` 发现工程问题时仍是合法成功结果：检查 `data.valid`，不要只看 MCP `isError`。非法参数、找不到目标、能力越界或基础设施故障会返回 `{ ok:false, error }` 并设置 `isError:true`。

## 正式发布

`fairygui.publish` 直接消费工程中的发布设置，不用 MCP 参数重复设置图集、压缩或代码生成选项：

- 省略 `packageIds` 发布全部包；指定时使用 `fairygui.query` 返回的包 ID。
- `publishType:"full"` 执行完整发布；`"definitions"` 只跳过图集打包，不检查结果能否独立运行。
- 省略 `outputPath` 使用工程配置路径；显式传入时，相对路径以工程根目录解析且只覆盖本次运行时产物目录。
- 代码生成继续使用工程配置的代码路径。
- 已有目录只覆盖同名产物，不清空目录或删除其他旧文件。

不要把 `fairygui.validate` 的 `publish` 模式当成正式发布：它只在临时目录校验发布链路，并且不会生成代码。

## 调用纪律

- 先查询再写，先能力检查再选择操作。
- 同一意图尽量一次批量调用，避免琐碎的逐字段工具往返。
- 每次写入后等待成功结果，再顺序渲染。
- 根据明确错误码和 `suggestedFix` 修正调用，不要通过猜测字段、修改 XML 文本或跨越实例边界来绕过契约。
- 完成后关闭不再使用的工程会话：`fairygui.project` 的 `close`。
