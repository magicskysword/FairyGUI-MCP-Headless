# FairyGUI-MCP-Headless V1 架构与契约

## 1. 目标与边界

FairyGUI-MCP-Headless 让 AI Agent 直接读取、编辑、预览、发布和校验 FairyGUI
工程。核心目标是：

1. 用命名批量工具减少逐字段往返。
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

MCP 是独立单包仓库。`package.json` 只使用正常 SemVer，不使用本地路径依赖。
开发时由工作区根部 `pnpm-workspace.yaml` 自动链接匹配版本；发布验证依次构建
四个包并执行 `pnpm pack`，再在工作区外的新目录安装 tarball。运行时不访问
相邻仓库。

`fairygui.project` 的所有动作结果都包含 Headless 包名、版本、DOM Schema 版本
以及 OpenFairyGUI core/functions 和 FairyGUI-dom 的实际运行版本，避免 Agent
把全局旧版本误认为当前构建。

## 3. 七个 MCP 工具

| 工具 | 契约 |
|---|---|
| `fairygui.project` | `open/list/status/close`；规范化路径、复用会话、恢复事务并报告版本 |
| `fairygui.query` | 命名批次查询包、资源、组件、DOM、引用、能力和审计 |
| `fairygui.apply_dom_patch` | 对单个现有组件执行五种通用 DOM 操作 |
| `fairygui.apply_resource_operations` | 预演或原子执行创建、导入、替换、重命名、包内移动和删除 |
| `fairygui.render_component` | 命名批量渲染并返回 PNG、状态、边界、诊断、版本和保真度 |
| `fairygui.publish` | 按工程设置完整发布或跳过图集发布全部/指定包 |
| `fairygui.validate` | `quick/roundtrip/publish/full`；工程问题用 `valid:false` 表达 |

统一结果：

```ts
{ ok: true, data, warnings?: Diagnostic[] }
{ ok: false, error: {
  code, message, path?, actual?, allowed?, suggestedFix?,
  transactionId?, logPath?
} }
```

非法调用设置 MCP `isError:true`。命名查询部分失败时，顶层仍为 `ok:true`、
MCP `isError:false`；诊断码 `PARTIAL_QUERY_FAILURE` 放在顶层 `warnings` 中，
每个查询键保留独立的成功或错误信封。任何写批次都不允许部分成功。

### 3.1 Query、Validate 与 Project

`fairygui.query` 最多接收 100 个命名查询。包、资源、组件和 DOM 等大结果都有
`detail:"summary"|"full"`，默认 `"summary"`：

- resources/components 摘要只返回 ID、名称和类型；full 增加路径、尺寸和导出
  信息；
- DOM 摘要返回根信息、节点 outline 和状态概览；full 返回可直接作为 patch
  字段依据的完整强类型 DOM；
- 默认分页 50 条；`limit` 显式覆盖页大小，`cursor` 是必须原样传回的不透明值。

DOM 的 `instanceProjection:"none"|"summary"|"full"` 默认 `"none"`，只读投影不
改变实例边界。DOM 结果还包含 `stateModel`：

- Controller 当前页与全部页面；
- 十种 Gear 的类型、控制器、适用页面、默认值和当前页有效值；
- 节点在默认状态下的有效可见性和隐藏原因；
- 静态信息不足时返回 `unknown`，不推测运行时状态。

审计查询支持 package、component、source kind、finding kind、name 和 path
过滤。单个命名项的无效输入不会丢弃兄弟项结果。

`fairygui.validate` 增加同名 `detail`：

- summary 返回检查总数、阶段指标、严重度/代码统计和有限诊断；
- full 返回全部检查 ID 与诊断；
- 工程问题仍是合法执行：`ok:true,data.valid:false`。

### 3.2 Render

`fairygui.render_component` 只有命名批量形式：

```ts
{
  projectId,
  imageResult?: "inline" | "file" | "both",
  stateDetail?: "summary" | "full",
  renders: {
    [key]: {
      packageId,
      componentId,
      width?,
      height?,
      scale?,
      background?,
      state?: {
        controllers?: [{
          selector, expectedMatches, controller,
          page: { index?: number, id?: string, name?: string }
        }],
        lists?: [{ selector, expectedMatches, selectedIndices: number[] }],
        trees?: [{
          selector, expectedMatches,
          expansions?: [{ path: number[], expanded: boolean }],
          selectedPath?: number[] | null
        }],
        scrolls?: [{
          selector, expectedMatches,
          position: { x?: number, y?: number }
        }]
      }
    }
  }
}
```

最多 20 个命名渲染；单组件也使用一个键。`imageResult` 默认 `"inline"`，
`stateDetail` 默认 `"summary"`。Controller page 必须在 index/id/name 中三选一，
scroll position 至少含一个轴，所有临时状态目标必须给 `expectedMatches`。

每项返回 `availableState`、`appliedState` 和 Gear 隐藏摘要；full 状态才展开
完整 Tree 路径等大数据。单项组件或状态失败保留其他结果并产生
`PARTIAL_RENDER_FAILURE` warning；无效工程会话、浏览器失败或共享编译失败才是
顶层失败。

inline 只向 MCP `content` 附加 PNG；file 只返回系统临时文件路径；both 同时
提供。文本和 structuredContent 永不包含 base64，内联图片通过 `contentIndex`
与命名结果对应。

### 3.3 Resource operations

`fairygui.apply_resource_operations` 的 `dryRun` 默认为 `false`。预演仍执行最新
磁盘读取、完整模型操作、受影响文件序列化和结构化回读，但：

- 不写盘；
- 不创建事务或事务日志；
- 不消费 import inbox；
- 返回逐操作 before/after、受影响引用、文件写入/移动/删除和
  `wouldConsumeInboxPaths`；
- 返回 `wouldRemoveDirectories`，而实际执行返回 `removedDirectories`。

实际执行返回同构的变更摘要与已消费 inbox。成功事务之后，只尝试清理由本次移动
或删除产生的安全空目录；清理失败只产生 warning，不回滚已经提交的文件变化。

### 3.4 DOM patch

`fairygui.apply_dom_patch` 只有以下五种可组合操作，顺序执行：

1. `insert`：向组件根插入节点，并把服务端 ID 绑定到 `clientRef`；
2. `update`：对一个或多个已有目标应用受限 Merge Patch；
3. `move`：把单个节点移动到 `toIndex`；
4. `remove`：删除一个或多个目标；
5. `replace`：以完整节点替换单个目标并保留原稳定 ID。

公开 MCP Schema 只严格描述操作骨架，`node` 和 `changes` 只声明为 JSON object。
它的序列化预算不超过 8 KiB；其他单工具不超过 16 KiB，最大 Schema 深度不超过
10。复杂节点联合、枚举和跨字段约束留给内部强类型 Schema。

内部校验失败返回 `INVALID_PATCH`，`path` 精确到
`operations[n].node...` 或 `operations[n].changes...`，同时尽可能提供
`actual`、`allowed` 和 `suggestedFix`。`insert/replace.node` 使用 full DOM 的
`type/name/groupId/style/relations/content` 命名，不接受服务端字段
`id/readOnly/capability`。

`update.changes` 是受限 Merge Patch：

- 缺省字段不修改；
- 对象递归合并；
- 数组整体替换；
- `null` 清除可选字段并恢复默认；
- 必填字段不能清除；
- `id/type/readOnly/capability` 不可修改，类型变化必须使用 replace。

`selector` 与 `targetRef` 必须且只能选一个；`targetRef` 只能引用同批更早执行的
insert。Relation `targetId`、`groupId`、mask 等节点引用可以使用稳定节点 ID 或
同批 `clientRef`。多目标 update/remove 必须全部通过类型、引用、实例边界和能力
预检后才修改模型。

成功结果只返回事务、逐操作摘要、受影响节点、文件和 `clientRefs`，不回传完整
DOM。任何操作失败都保持整批零写入。

## 4. DOM 中间模型

DOM JSON 固定 `schemaVersion: 1`。节点保存 FairyGUI 稳定 ID、类型、名称、
CSS 风格样式、资源引用、Relations 和类型专属 content。它只借用 HTML/CSS
知识，不兼容浏览器 DOM 或完整 CSS。

公共样式接受 `left/top/width/height/minWidth/maxWidth/minHeight/maxHeight/`
`opacity/rotation/scaleX/scaleY/skewX/skewY/pivotX/pivotY/...`。内部映射
FairyGUI 的 `x/y/alpha/...`。不接受别名、`px` 字符串、`calc()` 或 `vw/vh`。

选择器语法只包括：

- 类型，例如 `text`
- `#id`
- `[name="..."]`
- 以上的复合形式
- 后代组合和直接子代 `>`

不支持伪类、逗号组或通用 CSS。每个写目标都声明 `expectedMatches`。同批新增
节点使用 `clientRef`。包 ID 为 8 位小写字母数字，资源/组件定义 ID 为 5 位，
组件子节点使用 `n<max+1>`；已有非标准 ID 原样保留。

组件实例是默认边界。`instanceProjection` 只返回只读来源投影，跨实例写入返回
`INSTANCE_BOUNDARY`。Group 成员仍是兄弟并引用 `groupId`；List/Tree 项目不是
普通子节点。

### 已实现

- 节点：image、text、rich-text、input-text、loader、graph、movie-clip、
  group、静态 list、instance、组件根基础属性。
- 布局：绝对布局、全部 25 种 Relations、组件 visible/hidden/scroll 与滚动轴、
  五种静态 List 布局、横向/纵向 Group。
- 操作：insert、update、move、remove、replace；同批 clientRef 与引用解析。

### Planned / read-only

- Tree 与虚拟 List 的结构编辑
- Controller/Gear 驱动布局编辑
- Transition
- Loader3D
- Spine/DragonBones
- 自定义扩展

Controller、Gear、Tree 和 Transition 的查询/状态契约仍被完整保留。能力矩阵是
公共查询的一部分，planned 能力返回稳定错误，不会被悄悄跳过。

完整节点字段、必填/可空规则、枚举、Relations、Group、List 与操作范例位于
`skills/fairygui-headless/references/dom-authoring.md`。Agent 在 insert、update
或 replace 前必须先读取该引用，并用 full DOM 查询确认当前目标。

## 5. 工程会话与外部变化

服务采用本地 stdio 并支持多个工程会话。主机 Agent 决定进程可访问的工程；
MCP 可打开当前进程权限范围内任意合法 FairyGUI 工程。目录和其中唯一 `.fairy`
文件会规范化为同一会话。

Chokidar 使用尾沿 300 ms 防抖和最长 2 s 合并窗口。读取、渲染和写入前执行
`ensureFresh`；只有新模型完整解析成功后才原子替换内存快照。外部 XML 临时损坏
时保留上一份可用快照并报告解析错误。

查询和渲染可以并行。同工程写调用会立即保留提交顺序，但模型解析、内存修改、
序列化和往返校验允许并行；最终提交按调用顺序串行且互斥。若并行准备所依据的
源状态已被更早提交改变，轮到该调用时会从最新磁盘重新准备。节点或资源已经
删除、类型已经改变时，后提交明确失败。调用方必须按顺序执行“patch 后 render”。

## 6. 写回、事务与未知 XML

每次写入从最新磁盘重新解析，然后执行：

1. Schema、引用、匹配数量与能力预校验。
2. 完整内存模型修改。
3. 只序列化受影响的 `package.xml`、组件 XML 和资源文件。
4. 临时目录结构化回读与稳定往返校验。
5. 再次比较磁盘源状态，并把预期内容传入事务。
6. 在目标旁创建临时文件，验证 before 哈希后原子替换。

不做文本 XML patch，也不整工程重写。未知 XML 属性和子节点作为有序不透明数据
随所属节点移动或删除。若某次结构变更无法安全保留未知内容，返回
`OPAQUE_CONTENT_CONFLICT` 并保持零写入。保证结构化语义往返，不保证空白、
属性顺序或字节一致。

多文件事务日志位于：

```text
<os.tmpdir>/fairygui-mcp-headless/<projectHash>/<date>/<transactionId>/
```

目录包含 `journal.json`、`before/`、`staged/` 和 `diagnostics/summary.json`。
启动时先恢复全部非终态事务，再清理终态日志。默认保留 7 天或每工程 1 GiB，
超额时从最旧已完成事务开始清理；不删除未完成或损坏的恢复证据。

MCP 级别保证失败后全部回滚；不承诺其他进程永远观察不到极短暂的多文件提交
中间态。若外部进程在比较之后改写目标文件，事务返回 `WRITE_FAILED` 并保留
外部的新内容。

## 7. 资源安全

导入根固定为：

```text
<project>/.fairygui-mcp/import-inbox/
```

只接受规范相对路径。绝对路径、`..`、反斜杠路径、符号链接、目录和非普通文件
均被拒绝。成功事务消费收件箱文件；校验、预演或事务失败都保留源文件。

冲突策略：

- `reject`：默认，存在冲突即失败。
- `rename`：生成目标路径中的唯一名称。
- `replace`：必须指定已有 `resourceId`，保留 ID 与引用并验证类型。

删除策略：

- `reject`：默认；有引用时返回 `RESOURCE_IN_USE` 和来源。
- `cascade`：清理受支持的标量、List 项和实例引用。
- `force`：不扫描依赖，直接删除并返回 `projectMayBeInvalid:true`。

若 cascade 遇到 V1 只读引用，会转为 `cascade-with-force-fallback`，返回警告和
`projectMayBeInvalid:true`。跨包移动返回
`CROSS_PACKAGE_MOVE_UNSUPPORTED`。

空目录清理严格限制在规范化工程 `assets` 目录下，不删除 `assets` 本身，不跟随
符号链接，也不触碰本次操作未产生的目录。预演只报告候选目录。

## 8. 内存编译与渲染

Playwright Chromium 常驻，每个任务创建隔离 BrowserContext。预览资源通过
`http://fairygui.internal/` 路由拦截加载，不启动 localhost 服务器，并阻断所有
外部网络。浏览器断连后下一次调用会重新启动 Chromium。

渲染前从最新磁盘快照读取独立工程模型，临时把全部组件纳入预览导出，通过
OpenFairyGUI 在内存中编译 `.fui` 和图集；未在 Editor 勾选导出的组件也可预览，
临时设置不会落盘或进入正式发布。BrowserContext 加载内存包后，按包 ID 和组件
ID 构造真实 FairyGUI-dom 对象并等待资源就绪。

结果固定声明：

```json
{
  "backend": "fairygui-dom",
  "fidelity": "runtime-preview"
}
```

它覆盖真实包解析、组件实例、图片、文本、控制器/Gear 与运行时布局，视觉目标是
肉眼接近 FairyGUI Editor；浏览器与 Unity/Editor 的字体栅格化和后端差异仍可能
产生微量像素抖动，因此不承诺 Unity 像素真值。

`scale` 既设置 BrowserContext 的设备像素密度，也驱动 FairyGUI 的资源等级。
内存发布会识别 `@2x/@3x/@4x` 隐式变体，缺失等级沿用 FairyGUI 的高分辨率回退
语义。

临时状态按 Controller、Tree 展开/选择、List 选择、滚动位置的顺序应用，只用于
当前命名截图。选择器数量、目标类型、页面、列表选择模式、项目索引、Tree 路径
和实际可滚范围都经过显式校验，越界不会静默夹取。

## 9. 验证、测试与发布

`fairygui.validate` 模式：

- `quick`：结构、引用、能力和基础一致性。
- `roundtrip`：临时目录完整写出、重读和语义比较。
- `publish`：在临时目录执行 OpenFairyGUI 发布链路。
- `full`：组合全部阶段。

publish 校验始终禁用代码生成，只使用系统临时目录。正式发布由
`fairygui.publish` 执行：

- 省略 `packageIds` 发布全部包，指定时按稳定包 ID 精确选择；
- `publishType:"full"` 执行完整流程；
- `publishType:"definitions"` 执行相同流程但跳过图集打包，不判断产物能否独立
  运行；
- 省略 `outputPath` 使用 `settings/Publish.json`，显式传入时只覆盖本次运行时
  产物目录；
- 代码生成路径始终服从工程全局及包级设置；
- 已有目录只覆盖同名产物，不主动清理其他旧文件。

同一工程的正式发布串行执行。成功结果返回实际输出路径、路径来源、已发布包和
本次写入文件。

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
`test:corpus` 打开 FairyGUI-unity 全部语料并验证查询、投影、渲染和零写入。
`benchmark:corpus` 记录冷启动、完整组件查询、基础 patch、热渲染和浏览器恢复的
p95，只报告软预算。

`test:pack` 对三个 fork 和 Headless 的四个 `pnpm pack` 产物做全新目录隔离
安装，通过已安装 stdio CLI 列出全部七个工具，并实际完成 project、summary/full
query、resource dryRun/apply、通用 patch、命名批量 render、临时 definitions
publish、full validate 和 close。

## 10. AI 工作流

服务器 instructions 与包内 `skills/fairygui-headless/SKILL.md` 都要求：

1. `fairygui.project` 打开工程并确认版本。
2. `fairygui.query` 先做紧凑批量定位；写前读取 DOM 参考并取 full DOM。
3. 资源操作先 dryRun，再调用 `fairygui.apply_resource_operations` 写入。
4. 用 `fairygui.apply_dom_patch` 合并同一组件的通用操作。
5. `fairygui.render_component` 做默认和临时状态的命名批量 runtime-preview。
6. 根据状态解释与 PNG 继续调整，最后用 `fairygui.validate` 校验。
7. 需要正式产物时调用 `fairygui.publish`，结束后关闭会话。

这套流程以明确错误码修正调用，不鼓励 Agent 猜字段、直接修改 XML 文本、跨实例
边界写入或把运行时临时状态误认为磁盘状态。
