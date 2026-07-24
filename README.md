# FairyGUI-MCP-Headless

面向 AI Agent 的本地 FairyGUI 无头创作 MCP。它把 FairyGUI 工程映射为受限、
强类型的 DOM 中间模型，让 Agent 复用 HTML/CSS 的树、选择器和样式知识完成批量
查询、原子编辑、运行时预览、发布与校验，但不声称兼容浏览器 DOM 或完整 CSS。

V1 使用 Node.js 24、TypeScript ESM、本地 stdio、FairyGUI-dom 和 Playwright
Chromium。Windows 是唯一正式开发、测试和截图基线；源码不依赖 Windows-only
包或平台专用业务逻辑，Linux/macOS 暂不提供主动适配、CI 或视觉基线。

## 安装

```sh
pnpm add --global @magicskysword/fairygui-mcp-headless
pnpm exec playwright install chromium
```

浏览器必须显式安装。服务不会静默下载 Chromium，也不会回退到 Edge、Tauri 或
系统 WebView。缺少浏览器时，`fairygui.render_component` 返回
`BROWSER_NOT_INSTALLED` 和明确的安装命令。

MCP 主机配置示例：

```json
{
  "mcpServers": {
    "fairygui": {
      "command": "fairygui-mcp-headless"
    }
  }
}
```

## 七个工具

| 工具 | 用途 |
|---|---|
| `fairygui.project` | `open/list/status/close` 多工程会话、事务恢复和服务版本信息 |
| `fairygui.query` | 命名批量查询包、资源、组件、DOM、引用、能力和审计 |
| `fairygui.apply_dom_patch` | 用 insert、update、move、remove、replace 原子修改单个组件 |
| `fairygui.apply_resource_operations` | 预演或执行创建、导入、替换、重命名、移动和删除 |
| `fairygui.render_component` | 命名批量渲染，返回 PNG、状态解释、诊断、版本和保真度 |
| `fairygui.publish` | 使用工程设置完整发布或仅发布定义，可选择全部或指定包 |
| `fairygui.validate` | 执行 `quick/roundtrip/publish/full` 校验 |

所有工具只返回两类顶层结果：

```ts
{ ok: true, data, warnings? }
{ ok: false, error: {
  code, message, path?, actual?, allowed?, suggestedFix?,
  transactionId?, logPath?
} }
```

非法调用同时设置 MCP `isError:true`。校验发现工程问题仍是合法执行，结果为
`{ok:true,data:{valid:false,...}}`。命名查询或命名渲染的单项可以部分失败，
写批次绝不部分成功。

## Agent 推荐闭环

1. 用 `fairygui.project` 打开工程，保存 `projectId`。
2. 用一次 `fairygui.query` 的 summary 批量定位包、组件和资源。
3. 写 DOM 前用 full 查询目标，并读取包内
   `skills/fairygui-headless/references/dom-authoring.md`。
4. 先用 `dryRun:true` 预演资源操作；把同一意图合并为一次 DOM 或资源写调用。
5. 写入成功后顺序调用 `fairygui.render_component` 做命名批量截图。
6. 根据 PNG、状态信息和诊断继续调整，最后调用 `fairygui.validate`。
7. 需要正式产物时再调用 `fairygui.publish`，然后关闭工程会话。

服务器 instructions 与包内 `skills/fairygui-headless/SKILL.md` 都包含这套纪律。

## 紧凑查询、状态与校验

`fairygui.query` 接收最多 100 项命名查询。大结果默认
`detail:"summary"`，默认每页 50 条；显式 `detail:"full"` 才返回完整路径、尺寸、
导出信息或可直接作为 patch 依据的强类型 DOM。继续分页时原样传回不透明
`cursor`。

DOM 查询用 `instanceProjection:"none"|"summary"|"full"` 控制组件实例来源投影，
默认 `"none"`。结果同时包含只读 `stateModel`：

- Controller 当前页与全部页面；
- Gear 类型、控制器、适用页面、默认值和当前页有效值；
- 默认状态下的有效可见性及隐藏原因；无法静态确定时明确返回 `unknown`。

命名查询部分失败时，顶层仍是 `ok:true`、MCP `isError:false`，并通过
`warnings` 返回 `PARTIAL_QUERY_FAILURE`；每个查询键保留自己的成功或错误信封。
审计查询可按 package、component、source kind、finding kind、name 和 path
过滤。

`fairygui.validate` 的 `detail` 同样默认为 `"summary"`，返回检查数量、阶段指标、
按严重度和代码统计以及有限诊断；`"full"` 才返回全部 ID 和诊断。
`fairygui.project` 的各动作结果包含服务包名、版本、DOM Schema 版本以及三个
fork 的运行版本，便于确认正在测试的实际构建。

## DOM 与选择器边界

- 公共样式使用 `left/top/width/height/opacity/rotation/scaleX/...`，JSON
  数值不带 `px`；不支持 `calc()`、`vw/vh` 或 `x/y/alpha` 别名。
- 选择器只支持类型、`#id`、`[name="..."]`、复合选择器、后代和 `>`。
- 所有写目标必须声明 `expectedMatches`，匹配数不符立即失败。
- 同一批新节点通过 `clientRef` 引用；服务端生成稳定兼容 ID。
- 组件实例默认是边界节点；`instanceProjection` 只提供只读来源投影。
- Group 成员仍是兄弟节点并引用 `groupId`；List/Tree 项不是普通子节点。

V1 可写 image、text、rich-text、input-text、loader、graph、movie-clip、group、
静态 list、instance、组件根基础属性、25 种 Relations、组件滚动/溢出、五种
静态 List 布局和横向/纵向 Group。Tree、虚拟 List、Controller/Gear 驱动布局、
Transition、Loader3D、Spine/DragonBones 与自定义扩展保留为 planned/read-only。

### 通用 DOM 补丁

`fairygui.apply_dom_patch` 只接受五种可批量组合的操作：`insert`、`update`、
`move`、`remove`、`replace`。公开 MCP Schema 只严格描述操作骨架；`node` 和
`changes` 是普通 JSON object，由服务内部使用完整强类型契约二次校验。

```json
{
  "projectId": "p_...",
  "packageId": "pkg00001",
  "componentId": "cmp01",
  "operations": [
    {
      "op": "insert",
      "parentSelector": "component-root",
      "expectedMatches": 1,
      "clientRef": "title",
      "node": {
        "type": "text",
        "name": "title",
        "style": { "left": 20, "top": 12, "width": 200, "height": 36 },
        "relations": [],
        "content": { "text": "Hello" }
      }
    },
    {
      "op": "update",
      "targetRef": "title",
      "expectedMatches": 1,
      "changes": { "style": { "opacity": 0.9 } }
    }
  ]
}
```

`update.changes` 使用受限 Merge Patch：字段缺省表示不修改、对象递归合并、
数组整体替换、`null` 清除可选字段；必填字段不能清除。不能修改
`id/type/readOnly/capability`，类型变化使用 `replace`。`selector` 与
`targetRef` 必须且只能给一个；`targetRef` 只能指向本批更早的 `insert`。
内部校验失败返回 `INVALID_PATCH`，路径精确到 `operations[n]` 下的具体字段。

成功结果只包含事务、逐操作摘要、受影响节点、文件与 `clientRefs`，不会回传
完整 DOM；需要确认结果时再批量查询。任何目标或能力预检失败都保持零写入。

## 资源预演、事务与导入

`fairygui.apply_resource_operations` 的 `dryRun` 默认为 `false`。高风险调用应先
使用 `dryRun:true`：服务仍从最新磁盘执行完整模型操作、序列化和回读校验，但
不创建事务、不写盘、不消费 inbox。结果会给出逐操作 before/after、
`affectedReferences`、文件写入/移动/删除、`wouldConsumeInboxPaths` 和
`wouldRemoveDirectories`。实际执行返回对应的已发生摘要。

导入文件必须先放到：

```text
<project>/.fairygui-mcp/import-inbox/
```

工具只接受该目录下的规范相对路径，拒绝绝对路径、`..`、符号链接、目录和
非普通文件。成功事务消费源文件，失败保留。冲突策略为
`reject|rename|replace`；删除策略为 `reject|cascade|force`。

实际资源移动或删除完成后，服务只清理工程 `assets` 下由本次操作产生的安全
空目录；不删除 `assets` 本身、不跟随符号链接。清理失败只产生 warning，不回滚
已经成功的事务。

磁盘始终是唯一事实来源。读取、渲染和写入前都会刷新外部修改；没有草稿、
Undo/Redo、revision、ifMatch、文件锁、历史或 Git 操作。同工程写入按提交顺序
串行，查询与渲染可以并行。

写入只完整序列化受影响的 `package.xml`、组件 XML 和资源文件。多文件事务使用
同目录临时文件、journal、before、staged、diagnostics、回滚和启动恢复；日志
默认位于系统临时目录，保留 7 天且每工程最多 1 GiB。

## 命名批量运行时预览

`fairygui.render_component` 只有命名批量形式，最多 20 项；单组件也使用一个
命名键。它从未发布源工程在独立内存模型中临时导出全部组件，编译 `.fui` 与
图集，不要求先在 FairyGUI Editor 中发布，也不改变工程发布设置或磁盘文件。

```json
{
  "projectId": "p_...",
  "imageResult": "both",
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

`imageResult` 为 `"inline"|"file"|"both"`，默认 `"inline"`；`stateDetail` 为
`"summary"|"full"`，默认 `"summary"`。文本与 structuredContent 永不包含
base64；内联 PNG 通过 `contentIndex` 对应命名结果。

Controller 的 `page` 必须在 `index/id/name` 中三选一，scroll `position` 至少给
一个轴。临时 Controller、List、Tree 和滚动状态只存在于当前隔离
BrowserContext。每个结果都返回 `availableState`、`appliedState` 与 Gear 隐藏
摘要，因此默认空白界面可以从状态信息解释；`stateDetail:"full"` 才展开完整
Tree 路径等大数据。

单项组件或状态失败保留其他结果，并产生 `PARTIAL_RENDER_FAILURE` warning；
工程会话、浏览器或共享编译失败才是顶层失败。渲染固定声明：

```json
{
  "backend": "fairygui-dom",
  "fidelity": "runtime-preview"
}
```

预览执行真实 FairyGUI-dom 包加载、组件构造、资源解析和布局，位置、显示、图片
与颜色目标是肉眼接近 Editor；浏览器字体栅格化等差异仍可能产生少量像素抖动，
不是 Unity 像素真值。`scale` 同时控制 PNG 设备像素密度和 `@2x/@3x/@4x`
FairyGUI 资源等级。

## 正式发布

`fairygui.publish` 只接收发布范围、发布类型和可选的一次性路径覆盖：

```json
{
  "projectId": "p_...",
  "packageIds": ["028qk31h"],
  "publishType": "full",
  "outputPath": "../release/ui"
}
```

省略 `packageIds` 发布全部包；`publishType` 默认为 `full`。
`definitions` 仍执行描述文件、外部资源和工程配置要求的代码生成，只跳过图集
打包，不判断输出是否能独立运行。省略 `outputPath` 时读取
`settings/Publish.json`；显式路径只覆盖本次运行时产物目录，代码输出继续使用
工程设置。

发布会覆盖同名产物，但不会清空目录或删除其他旧文件。`validate` 的 `publish`
模式只在临时目录验证发布链路并强制关闭代码生成，不会产生正式发布结果。

## 本地开发与验证

MCP 的 `package.json` 只写普通 SemVer 依赖。工作区根部
`pnpm-workspace.yaml` 在开发期自动链接 OpenFairyGUI 与 FairyGUI-dom fork，
运行时不依赖兄弟目录。

```sh
pnpm install
pnpm test:all
pnpm test:corpus
pnpm benchmark:corpus
pnpm test:pack
```

`test:pack` 会分别打包三个 fork 和 MCP，在工作区外的全新临时项目中安装四个
tarball，再经已安装的 stdio CLI 列出并实际调用全部七个工具，覆盖紧凑/完整
查询、资源预演与写入、DOM patch、批量渲染、临时发布、完整校验和关闭会话。
详细设计见 [`docs/architecture.md`](docs/architecture.md)，软性能记录见
[`docs/performance-baseline.md`](docs/performance-baseline.md)。
