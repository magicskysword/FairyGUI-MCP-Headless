# FairyGUI-MCP-Headless

面向 AI Agent 的本地 FairyGUI 无头创作 MCP。它把 FairyGUI 工程映射为受限、
强类型的 DOM 中间模型，让 Agent 复用 HTML/CSS 的树、选择器和样式知识完成批量
查询、原子编辑、运行时预览与校验，但不声称兼容浏览器 DOM 或完整 CSS。

V1 使用 Node.js 24、TypeScript ESM、本地 stdio、FairyGUI-dom 和 Playwright
Chromium。Windows 是唯一正式开发、测试和截图基线；源码不依赖 Windows-only
包或业务逻辑，Linux/macOS 暂不提供主动适配、CI 或视觉基线。

## 安装

```sh
pnpm add --global @magicskysword/fairygui-mcp-headless
pnpm exec playwright install chromium
```

浏览器必须显式安装。服务不会静默下载 Chromium，也不会回退到 Edge、Tauri 或
系统 WebView。缺少浏览器时，`fairygui.render_component` 返回
`BROWSER_NOT_INSTALLED` 和安装命令。

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

## 六个工具

| 工具 | 用途 |
|---|---|
| `fairygui.project` | `open/list/status/close` 多工程会话与启动恢复 |
| `fairygui.query` | 一次批量查询包、资源、组件、DOM、引用、能力和审计 |
| `fairygui.apply_dom_patch` | 对一个现有组件执行原子 DOM 批处理或单域替换 |
| `fairygui.apply_resource_operations` | 原子创建、导入、替换、重命名、移动和删除资源 |
| `fairygui.render_component` | 返回内联 PNG、边界、诊断、版本和预览保真度 |
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
`{ok:true,data:{valid:false,...}}`。批量查询的兄弟项可以部分成功；写批次绝不
部分成功。

## Agent 推荐闭环

1. 用 `fairygui.project` 打开工程，保存返回的 `projectId`。
2. 用一次 `fairygui.query` 批量取得组件、目标 DOM、资源引用与能力矩阵。
3. 用一次 `fairygui.apply_dom_patch` 或
   `fairygui.apply_resource_operations` 合并同一意图的修改。
4. 写入成功后顺序调用 `fairygui.render_component` 查看 PNG。
5. 根据视觉反馈继续批量调整，最后调用 `fairygui.validate`。

包内同时发布 `skills/fairygui-headless/SKILL.md`，包含面向 Agent 的完整调用
纪律。

## DOM 与选择器边界

- 公共样式使用 `left/top/width/height/opacity/rotation/scaleX/...`，JSON
  数值不带 `px`；不支持 `calc()`、`vw/vh` 或 `x/y/alpha` 别名。
- 选择器只支持类型、`#id`、`[name="..."]`、复合选择器、后代和 `>`。
- 所有写目标必须声明 `expectedMatches`，匹配数不符立即失败。
- 同一批新节点通过 `clientRef` 引用；服务端生成稳定兼容 ID。
- 组件实例默认是边界节点；`resolvedPreview:true` 只提供只读来源投影。
- Group 成员仍是兄弟节点并引用 `groupId`；List/Tree 项不是普通子节点。

V1 可写 image、text、rich-text、input-text、loader、graph、movie-clip、group、
静态 list、instance、组件根基础属性、25 种 Relations、组件滚动/溢出、五种
静态 List 布局和横向/纵向 Group。Tree、虚拟 List、Controller/Gear 驱动布局、
Transition、Loader3D、Spine/DragonBones 与自定义扩展保留为 planned/read-only。

## 磁盘、事务与导入

磁盘始终是唯一事实来源。读取、渲染和写入前都会刷新外部修改；没有草稿、
Undo/Redo、revision、ifMatch、文件锁、历史或 Git 操作。同工程写入按提交顺序
串行，查询与渲染可以并行。写调用会立即保留提交顺序，但模型解析、序列化和
往返校验允许并行；轮到提交时若准备依据已经过期，会从最新磁盘重新准备。

写入只完整序列化受影响的 `package.xml`、组件 XML 和资源文件。多文件事务使用
同目录临时文件、journal、before、staged、diagnostics、回滚和启动恢复；
日志默认位于系统临时目录，保留 7 天且每工程最多 1 GiB。每个变更携带预期源
内容，事务准备时和原子替换前都会验证，因此不会覆盖比较后才出现的外部新内容。

导入文件必须先放到：

```text
<project>/.fairygui-mcp/import-inbox/
```

工具只接受该目录下的规范相对路径，拒绝绝对路径、`..`、符号链接、目录和
非普通文件。成功事务消费源文件，失败保留。冲突策略为
`reject|rename|replace`；删除策略为 `reject|cascade|force`。

## 运行时预览

`fairygui.render_component` 会从未发布的源工程在内存中编译临时 `.fui` 与图集，
不会要求先在 FairyGUI Editor 中执行发布，也不会把临时运行时产物写回工程。
随后使用常驻 Chromium，每次任务创建隔离 BrowserContext，并通过
`http://fairygui.internal/` 路由拦截加载这些内存资源；所有外部网络请求被阻断。
结果明确声明：

```json
{
  "backend": "fairygui-dom",
  "fidelity": "runtime-preview"
}
```

它执行真实 FairyGUI-dom 包加载、组件构造、资源解析和布局，目标是让位置、显示、
图片与颜色在肉眼上接近 Editor；由于渲染后端、字体栅格化等差异，它仍不是 Unity
像素真值。Windows 是固定截图基线平台。

需要查看非默认控制器页或滚动区域时，可在一次渲染调用中设置只作用于该截图的
状态：

```json
{
  "state": {
    "controllers": [{
      "selector": "component-root",
      "expectedMatches": 1,
      "controller": "start",
      "selectedIndex": 1
    }],
    "scrolls": [{
      "selector": "instance[name=\"viewport\"]",
      "expectedMatches": 1,
      "y": 320
    }],
    "lists": [{
      "selector": "list[name=\"items\"]",
      "expectedMatches": 1,
      "selectedIndices": [1, 3]
    }]
  }
}
```

页也可用 `pageId` 或 `pageName` 指定。状态选择器复用受限 DOM 选择器语法并可
定位嵌套运行时对象；滚动位置使用非负像素 `x`/`y`，必须处于运行时实际可滚
范围。List 单选使用 `selectedIndex`（`-1` 清空），多选使用唯一的
`selectedIndices`；Tree 不按可见行索引混入 List 状态。匹配数量、目标类型、
控制器、页面、选择模式、项目索引或滚动范围不合法时会明确失败，不会静默
夹取。临时状态只修改隔离 BrowserContext 内的对象，不写回工程，也不进入后续
截图。

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
tarball，再通过已安装 CLI 完成 MCP 初始化。详细设计见
[`docs/architecture.md`](docs/architecture.md)，软性能记录见
[`docs/performance-baseline.md`](docs/performance-baseline.md)。
