# FairyGUI-MCP-Headless V1 架构与契约

## 1. 目标与边界

FairyGUI-MCP-Headless 让 AI Agent 直接读取、编辑、预览和校验 FairyGUI 工程。
核心目标是：

1. 用批量工具减少逐字段往返。
2. 让每次调用只有合法成功或带稳定错误码的失败。
3. 支持“查询 → 写入 → 渲染 → 调整 → 校验”的循环反馈。
4. 通过受限 DOM、CSS 风格字段和选择器复用 HTML 开发知识。

V1 不实现 FairyGUI Editor 插件遥控、HTTP/SSE、远程鉴权、Unity 渲染、
Tauri/系统 WebView、Undo/Redo、revision/ifMatch、文件锁、历史或 Git 操作。
FairyGUI Editor 的私有序列化器不是依赖项；兼容性依据是公开 API、官方工程语料
和结构化往返契约。

技术基线是 Node.js 24、TypeScript ESM、pnpm、MCP SDK 1.x、Zod 4、
Chokidar 5 和 Playwright Chromium。Windows 是 V1 唯一正式开发、测试和截图
基线。Linux/macOS 不做主动适配，但禁止 Windows-only 依赖、盘符假设、反斜杠
拼路径和平台专用业务逻辑。

安装渲染器：

```sh
pnpm exec playwright install chromium
```

未安装时返回 `BROWSER_NOT_INSTALLED`，不静默下载或回退。

## 2. 仓库与依赖

V1 使用四个正式 npm 包：

| 仓库 | npm 包 | 职责 |
|---|---|---|
| OpenFairyGUI | `@magicskysword/openfairygui-core` | 工程模型、XML、ID、引用索引、受影响文件序列化 |
| OpenFairyGUI | `@magicskysword/openfairygui-functions` | 可组合发布与转换函数 |
| FairyGUI-dom | `@magicskysword/fairygui-dom` | 内存包加载与真实 DOM 运行时预览 |
| FairyGUI-MCP-Headless | `@magicskysword/fairygui-mcp-headless` | MCP、会话、事务、渲染和 AI Skill |

MCP 是独立单包仓库。`package.json` 只使用正常 SemVer，不使用
`file:`、`link:`、`workspace:` 或兄弟目录路径。开发时由工作区根部
`pnpm-workspace.yaml` 自动链接匹配版本；发布时依次构建四个包并执行
`pnpm pack`，再在工作区外的新目录安装 tarball。运行时不访问相邻仓库。

当前固定开发语料基线起点：

- FairyGUI-dom `98ed13a`
- OpenFairyGUI `d56053c`
- FairyGUI-unity `8cc8f21`
- FairyGUI-Editor `1eab944`

fork 中的后续提交属于 V1 实现的一部分。

## 3. 六个 MCP 工具

| 工具 | 契约 |
|---|---|
| `fairygui.project` | `open/list/status/close`；规范化路径、复用同路径会话、打开前恢复事务 |
| `fairygui.query` | 命名批次查询包、资源、组件、DOM、引用、能力和审计 |
| `fairygui.apply_dom_patch` | 对单个现有组件执行 `operations` 或一次单内容域 `replace` |
| `fairygui.apply_resource_operations` | 原子创建、导入、替换、重命名、包内移动和删除 |
| `fairygui.render_component` | 显式渲染并返回 PNG、边界、诊断、版本和保真度 |
| `fairygui.validate` | `quick/roundtrip/publish/full`；工程问题用 `valid:false` 表达 |

统一结果：

```ts
{ ok: true, data, warnings?: Diagnostic[] }
{ ok: false, error: {
  code, message, path?, actual?, allowed?, suggestedFix?,
  transactionId?, logPath?
} }
```

非法调用设置 MCP `isError:true`。命名查询允许兄弟项部分成功，顶层错误为
`PARTIAL_QUERY_FAILURE`，每个键保留独立结果。任何写批次都不允许部分成功。

## 4. DOM 中间模型

DOM JSON 固定 `schemaVersion: 1`。节点保存 FairyGUI 稳定 ID、类型、名称、
CSS 风格样式、资源引用、Relations 和类型专属内容。它只借用 HTML/CSS 知识，
不兼容浏览器 DOM 或完整 CSS。

公共样式接受 `left/top/width/height/minWidth/maxWidth/minHeight/maxHeight/`
`opacity/rotation/scaleX/scaleY/skewX/skewY/pivotX/pivotY/...`。内部映射
FairyGUI 的 `x/y/alpha/...`。不接受别名、`px` 字符串、`calc()` 或 `vw/vh`。

选择器语法只包括：

- 类型，例如 `text`
- `#id`
- `[name="..."]`
- 以上的复合形式
- 后代组合和直接子代 `>`

不支持伪类、逗号组或通用 CSS。每个写目标都声明 `expectedMatches`。
同批新增节点使用 `clientRef`。包 ID 为 8 位小写字母数字，资源/组件定义 ID
为 5 位，组件子节点使用 `n<max+1>`；已有非标准 ID 原样保留。

组件实例是默认边界。`resolvedPreview:true` 返回只读来源投影，跨实例写入返回
`INSTANCE_BOUNDARY`。Group 成员仍是兄弟并引用 `groupId`；List/Tree 项目不是
普通子节点。

### 已实现

- 节点：image、text、rich-text、input-text、loader、graph、movie-clip、
  group、静态 list、instance、组件根基础属性。
- 布局：绝对布局、全部 25 种 Relations、组件 visible/hidden/scroll 与滚动轴、
  五种静态 List 布局、横向/纵向 Group。
- 替换域：`displayTree`、`componentProperties`、`relations`、`listItems`。

### Planned / read-only

- Tree 与虚拟 List
- Controller/Gear 驱动布局
- `gears`、`controllers`、`transitions` 替换域
- Transition
- Loader3D
- Spine/DragonBones
- 自定义扩展

能力矩阵是公共查询的一部分。planned 能力返回稳定的
`READ_ONLY_CAPABILITY`，不会被悄悄跳过。

## 5. 工程会话与外部变化

服务采用本地 stdio 并支持多个工程会话。主机 Agent 决定进程可访问的工程；
MCP 可打开当前进程权限范围内任意合法 FairyGUI 工程。目录和其中唯一 `.fairy`
文件会规范化为同一会话。

Chokidar 使用尾沿 300 ms 防抖和最长 2 s 合并窗口。读取、渲染和写入前执行
`ensureFresh`；只有新模型完整解析成功后才原子替换内存快照。外部 XML 临时损坏
时保留上一份可用快照并报告解析错误。

查询和渲染可以并行。同工程写调用会立即保留提交顺序，但模型解析、内存修改、
序列化和往返校验允许并行；最终提交按调用顺序串行且互斥。若并行准备所依据的
源状态已被更早提交改变，轮到该调用时会从最新磁盘重新准备。目标字段仍存在时，
后提交覆盖前提交；节点或资源已经删除、类型已经改变时，后提交明确失败。调用方
必须按顺序执行“patch 后 render”，并发 render 不保证观察到 patch 后状态。

## 6. 写回与事务

每次写入从最新磁盘重新解析，然后执行：

1. Schema 与能力预校验。
2. 完整内存模型修改。
3. 只序列化受影响的 `package.xml`、组件 XML 和资源文件。
4. 临时目录结构化回读与稳定往返校验。
5. 再次比较磁盘源状态，并把预期内容传入事务。
6. 事务准备时验证预期内容，在目标旁创建临时文件。
7. 原子替换前再次验证 `before` 哈希，然后执行替换。

不做文本 XML patch，也不整工程重写。未知 XML 属性和子节点作为有序不透明数据
随所属节点移动或删除。内容域替换无法安全保留未知结构时返回
`OPAQUE_CONTENT_CONFLICT`，零写入。保证结构化语义往返，不保证空白、属性顺序
或字节一致。

多文件事务日志位于：

```text
<os.tmpdir>/fairygui-mcp-headless/<projectHash>/<date>/<transactionId>/
```

目录包含 `journal.json`、`before/`、`staged/` 和 `diagnostics/summary.json`。
启动时先恢复全部非终态事务，再清理终态日志。默认保留 7 天或每工程 1 GiB，
超额时从最旧已完成事务开始清理；不删除未完成或损坏的恢复证据。

MCP 级别保证失败后全部回滚；不承诺其他进程永远观察不到极短暂的多文件提交
中间态。若外部进程在服务比较之后、事务开始之前或原子替换之前改写目标文件，
事务返回 `WRITE_FAILED` 并保留外部的新内容。

## 7. 资源安全

导入根固定为：

```text
<project>/.fairygui-mcp/import-inbox/
```

只接受规范相对路径。绝对路径、`..`、反斜杠路径、符号链接、目录和非普通文件
均被拒绝。成功事务消费收件箱文件；校验或事务失败保留/恢复源文件。

冲突策略：

- `reject`：默认，存在冲突即失败。
- `rename`：生成目标路径中的唯一名称。
- `replace`：必须指定已有 `resourceId`，保留 ID 与引用，并验证资源类型。

删除策略：

- `reject`：默认；有引用时返回 `RESOURCE_IN_USE` 和来源。
- `cascade`：清理受支持的标量、List 项和实例引用。
- `force`：不扫描依赖，直接删除并返回 `projectMayBeInvalid:true`。

若 `cascade` 遇到 Gear/Transition 等 V1 只读引用，会清理可支持部分并转为
`cascade-with-force-fallback`，保留只读引用，返回警告和
`projectMayBeInvalid:true`。跨包移动在 V1 返回
`CROSS_PACKAGE_MOVE_UNSUPPORTED`。

## 8. 渲染

Playwright Chromium 常驻，每个任务创建隔离 BrowserContext。预览资源通过
`http://fairygui.internal/` 路由拦截加载，不启动 localhost 服务器，并阻断所有
外部网络。浏览器断连后下一次调用会重新启动 Chromium。渲染前从最新磁盘快照
重新读取独立工程模型，通过 OpenFairyGUI 在内存中编译临时 `.fui` 和图集；
编译产物只存在于进程内，不要求 Editor 预发布，也不会落盘或污染工程快照。
BrowserContext 加载全部内存包后，按包 ID 和组件 ID 构造真实 FairyGUI-dom
对象，并等待包资源就绪后截图。

结果固定声明：

```json
{
  "backend": "fairygui-dom",
  "fidelity": "runtime-preview"
}
```

它覆盖真实包解析、组件实例、图片、文本、控制器/Gear 与运行时布局，视觉验收
目标是肉眼接近 FairyGUI Editor；浏览器与 Unity/Editor 的字体栅格化和后端差异
仍可能产生微量像素抖动，因此不承诺 Unity 像素真值。可选 `saveToFile:true`
将 PNG 保存到系统临时目录；默认以内联 MCP image content 返回。

`state.controllers` 可在隔离 BrowserContext 内按受限 DOM 选择器设置控制器页，
支持 `selectedIndex`、`pageId` 或 `pageName` 三选一。每个目标必须声明
`expectedMatches`；选择器数量、目标类型、控制器名和页面都经过显式校验。
这些状态只用于当前截图，不改变内存工程快照或磁盘文件。

## 9. 验证、测试与发布

`fairygui.validate` 模式：

- `quick`：结构、引用、能力和基础一致性。
- `roundtrip`：临时目录完整写出、重读和语义比较。
- `publish`：执行 OpenFairyGUI 发布链路。
- `full`：组合全部阶段。

测试遵循“接口与错误语义 → 测试 → 实现 → 测试通过 → 中文提交”。

```sh
pnpm test:implemented
pnpm test:future
pnpm test:all
pnpm test:corpus
pnpm benchmark:corpus
pnpm test:pack
```

`test:implemented` 是提交门禁；已实现失败项不得改成 planned 或 skip。
`test:corpus` 打开 FairyGUI-unity 的全部 30 个包、查询 205 个组件、投影并渲染
每包代表组件，且比较源摘要确保只读闭环零写入。`benchmark:corpus` 记录冷启动、
完整组件查询、基础 patch、热渲染和浏览器恢复的 p95，只报告软预算。
`test:pack` 对四个 `pnpm pack` 产物执行隔离安装并通过已安装 CLI 枚举六工具。

发布顺序为：

1. `@magicskysword/openfairygui-core`
2. `@magicskysword/openfairygui-functions`
3. `@magicskysword/fairygui-dom`
4. `@magicskysword/fairygui-mcp-headless` `0.1.x`

## 10. AI 工作流

服务器 instructions 与包内 `skills/fairygui-headless/SKILL.md` 都要求：

1. `fairygui.project` 打开。
2. `fairygui.query` 批量查询并检查能力。
3. `fairygui.apply_dom_patch` 或
   `fairygui.apply_resource_operations` 原子写入。
4. `fairygui.render_component` 获取内存编译后的 runtime-preview。
5. 根据反馈继续调整。
6. `fairygui.validate` 校验并关闭会话。

这套流程优先批量表达意图，以明确错误码修正调用，不鼓励 Agent 猜字段、直接
修改 XML 文本或跨实例边界绕过契约。
