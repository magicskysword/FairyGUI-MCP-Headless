# FairyGUI-MCP-Headless

面向 AI 的本地 FairyGUI 原生创作工作流：读取类型定义、查询工程、安全编辑、JavaScript 动态预览、校验与发布。
工程模型来自 OpenFairyGUI，预览运行于独立 FairyGUI-dom 工作进程和 Playwright Chromium。

## 安装与连接

需要 Node.js 24。Windows 提供开发及截图基线；路径和进程接口支持跨平台运行。

```sh
pnpm add --global @magicskysword/fairygui-mcp-headless
pnpm exec playwright install chromium
```

MCP 主机以 `fairygui-mcp-headless` 命令启动 stdio 服务。stdout 专用于 JSON-RPC。
浏览器由用户安装，缺失时返回 `BROWSER_NOT_INSTALLED`。
初始化 instructions 和 `fairygui.project` 结果提供实际 Skill 文件路径及运行依赖版本。

## 六个工具

| 工具 | 用途 |
|---|---|
| `fairygui.project` | open/list/status/close 工程会话 |
| `fairygui.query` | 原生对象、引用、XML、审计的命名批量查询 |
| `fairygui.edit` | apply/plan/commit 原子编辑与幂等提交 |
| `fairygui.preview` | run/open/inspect/capture/reset/reload/close 动态试验 |
| `fairygui.validate` | quick/roundtrip/publish/full 校验 |
| `fairygui.publish` | 按工程配置生成正式产物 |

字段使用 `x/y/alpha` 等原生名称。查询默认摘要分页 50 项，显式 `detail:"full"` 获取完整属性和可写范围。
定义和示例入口为 [Skill](skills/fairygui-headless/SKILL.md)，完整字段按类型读取文件。

编辑计划包含不可变结果、ID 映射、文件差异及指纹。计划默认有效 30 分钟，提交时验证来源未变化。
所有 apply/commit 写请求使用 `requestId`，原请求重试返回持久化回执。

预览配方支持构造前脚本、初始化、JSON 数据和时间线。默认 60Hz 手动时钟、随机种子 0，
固定画布采集 PNG 与实际属性；多帧默认返回带时间标签的总览图和逐帧索引。
图片通过 MCP 图片块返回，`imageResult:"file"` 只返回文件位置。
FairyGUI-dom runtime-preview 的字体栅格化取决于浏览器和字体环境。

持续预览固定来源快照，reset 重放，reload 接纳工程更新；最多两个会话，空闲 15 分钟释放。
关闭工程会释放关联预览与计划。

统一结果为 `{ok:true,data,warnings?}` 或 `{ok:false,error}`。
命名查询/预览逐项返回结果；编辑保持全有或全无。工程校验问题以 `data.valid:false` 表达。
`validate` 的 publish 阶段在临时目录运行；正式发布由 `fairygui.publish` 执行。

正式发布按显式 `outputPath`、包级 `publish.path`、全局发布路径的顺序解析目录。
`packageOutputs` 返回各包的实际目录及配置来源；顶层 `outputPath` 和 `outputPathSource` 对应第一个所选包。
正式发布可选 packageIds、full/definitions 及一次性 outputPath，按同名文件覆盖产物。

## 开发

包依赖使用 SemVer；开发期由 `pnpm-workspace.yaml` 链接本地仓库，安装产物不依赖相邻目录。

```sh
pnpm typecheck
pnpm test:implemented
pnpm generate:definitions
pnpm build
pnpm test:pack
```

架构与预算见 [architecture](docs/architecture.md)，语料软性能记录见 [performance-baseline](docs/performance-baseline.md)。
