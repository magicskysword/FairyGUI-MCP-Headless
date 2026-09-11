import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOL_INPUT_SCHEMAS, type FairyGuiToolName, type PreviewToolInput } from "../contracts/v2-tools.js";
import type { ProjectInput, PublishInput } from "../contracts/tools.js";
import { fail, ok, type ResultEnvelope } from "../contracts/result.js";
import { EditService } from "../edit/edit-service.js";
import { PreviewService } from "../preview/preview-service.js";
import { ProjectRegistry } from "../project/project-registry.js";
import { PublishService } from "../publish/publish-service.js";
import { NativeQueryService } from "../query/native-query-service.js";
import { ValidationService } from "../validation/validation-service.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import { FileTransactionManager } from "../write/file-transaction.js";
import { PACKAGE_VERSION, PROJECT_SERVICE_INFO, SERVER_NAME, SKILL_PATH } from "../version.js";

export const SERVER_INSTRUCTIONS = [
  `FairyGUI 原生创作入口：先按需读取 Skill ${SKILL_PATH} 及其 definitions 文件。`,
  "用 fairygui.project 打开工程，fairygui.query 命名批量查询原生对象和引用；摘要默认分页 50 项，完整属性显式请求 detail:full。",
  "fairygui.edit 的 plan 生成不可变修改结果，可通过 fairygui.preview 在 JavaScript 中预览并采样；apply 或 commit 使用 requestId 幂等原子写入。",
  "编辑使用 x、y、alpha 等原生属性；有 Gear 控制的字段须指定 scope。静态定义通过文件读取，运行时实际状态通过 preview.inspect 获取。",
  "preview 的 run 可临时执行，open 创建持续会话；reset 重放同一快照，reload 接纳最新工程，close 释放会话。预览脚本只修改隔离环境。",
  "多帧默认返回带时间标签的总览图片和逐帧文件索引；文本不包含图片编码。命名 queries/previews 的各项结果独立，编辑批次全有或全无。",
  "使用 fairygui.validate 完成结构、引用、往返与发布校验；fairygui.publish 按工程配置生成正式产物。"
].join("\n");

interface PublishHandler { publish(input: PublishInput): Promise<ResultEnvelope<unknown>>; }
export interface FairyGuiMcpServerOptions {
  projects?: ProjectRegistry; query?: NativeQueryService; edits?: EditService; preview?: PreviewService;
  validator?: ValidationService; publisher?: PublishHandler; transactions?: FileTransactionManager; coordinator?: ProjectCommitCoordinator;
}
const OUTPUT_FIELDS: Record<FairyGuiToolName, Record<string, unknown>> = {
  "fairygui.project": { projectId: { type: "string" }, projects: { type: "array" }, service: { type: "object" } },
  "fairygui.query": { results: { type: "object" } },
  "fairygui.edit": { planId: { type: "string" }, state: { enum: ["planned", "committed"] }, files: { type: "array" }, operationResults: { type: "array" }, clientRefs: { type: "object" } },
  "fairygui.preview": { previewId: { type: "string" }, results: { type: "object" }, status: { type: "string" }, complete: { type: "boolean" }, frames: { type: "array" }, state: { type: "object" } },
  "fairygui.validate": { valid: { type: "boolean" }, mode: { type: "string" }, diagnostics: { type: "array" } },
  "fairygui.publish": { projectId: { type: "string" }, outputPath: { type: "string" }, writtenFiles: { type: "array" } }
};
function outputSchema(name: FairyGuiToolName): Tool["outputSchema"] {
  return { type: "object", oneOf: [
    { type: "object", properties: { ok: { const: true }, data: { type: "object", properties: OUTPUT_FIELDS[name], additionalProperties: true }, warnings: { type: "array", items: { type: "object" } } }, required: ["ok", "data"], additionalProperties: false },
    { type: "object", properties: { ok: { const: false }, error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"], additionalProperties: true } }, required: ["ok", "error"], additionalProperties: false }
  ] } as Tool["outputSchema"];
}
const DESCRIPTIONS: Record<FairyGuiToolName, string> = {
  "fairygui.project": "打开、列出、查看或关闭本地工程会话，返回运行版本和实际 Skill 入口。",
  "fairygui.query": "命名批量查询包、资源、组件、节点、Controller、Gear、Transition、引用、XML 片段与审计；单项失败不丢失其他结果。",
  "fairygui.edit": "以原生属性执行最多 200 项结构化或 XML 编辑。plan 预演，apply 直接原子提交，commit 提交计划；写请求必须提供 requestId。完整操作定义位于 Skill 文件。",
  "fairygui.preview": "在隔离 JavaScript 运行时初始化、执行时间线和采集多帧，支持持续会话及实际状态查询。可用 previews 命名批量执行；完整配方及 API 位于 Skill 文件。",
  "fairygui.validate": "执行 quick、roundtrip、publish 或 full 校验。工程问题在成功结果的 valid:false 和 diagnostics 中报告。",
  "fairygui.publish": "按工程发布配置生成全部或指定包产物，支持全量或仅定义发布，以及临时输出路径。"
};
const TOOLS: Tool[] = Object.entries(TOOL_INPUT_SCHEMAS).map(([name, schema]) => {
  const toolName = name as FairyGuiToolName;
  const converted = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any", reused: "ref" }) as Record<string, unknown>;
  delete converted.$schema;
  return { name, description: DESCRIPTIONS[toolName], inputSchema: { ...converted, type: "object" } as Tool["inputSchema"], outputSchema: outputSchema(toolName),
    annotations: { readOnlyHint: name === "fairygui.query" || name === "fairygui.validate", destructiveHint: name === "fairygui.edit" || name === "fairygui.publish", idempotentHint: name !== "fairygui.preview", openWorldHint: name === "fairygui.project" || name === "fairygui.publish" }, execution: { taskSupport: "forbidden" } };
});

function prepareMcpPayload(value: unknown, images: Array<{ mimeType: "image/png"; data: string }>): unknown {
  if (Array.isArray(value)) return value.map(entry => prepareMcpPayload(entry, images));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "data" && (source.mimeType === "image/png" || source.mediaType === "image/png") && typeof entry === "string") {
      images.push({ mimeType: "image/png", data: entry }); result.contentIndex = images.length;
    } else result[key] = prepareMcpPayload(entry, images);
  }
  return result;
}
function toCallToolResult(result: ResultEnvelope<unknown>): CallToolResult {
  const images: Array<{ mimeType: "image/png"; data: string }> = [];
  const structured = prepareMcpPayload(result, images) as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(structured) }, ...images.map(image => ({ type: "image" as const, ...image }))], structuredContent: structured, isError: !result.ok };
}

export class FairyGuiMcpServer {
  public readonly server: Server;
  public readonly projects: ProjectRegistry;
  public readonly query: NativeQueryService;
  public readonly edits: EditService;
  public readonly preview: PreviewService;
  public readonly validator: ValidationService;
  public readonly transactions: FileTransactionManager;
  public readonly coordinator: ProjectCommitCoordinator;
  private readonly publisher: PublishHandler;
  private closed = false;
  constructor(options: FairyGuiMcpServerOptions = {}) {
    this.transactions = options.transactions ?? new FileTransactionManager();
    this.coordinator = options.coordinator ?? new ProjectCommitCoordinator();
    this.projects = options.projects ?? new ProjectRegistry({ recovery: this.transactions });
    this.query = options.query ?? new NativeQueryService(this.projects);
    this.edits = options.edits ?? new EditService(this.projects, { transactions: this.transactions, coordinator: this.coordinator });
    this.preview = options.preview ?? new PreviewService(this.projects, { edits: this.edits });
    this.validator = options.validator ?? new ValidationService(this.projects);
    this.publisher = options.publisher ?? new PublishService(this.projects, { coordinator: this.coordinator });
    this.server = new Server({ name: SERVER_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    this.server.setRequestHandler(CallToolRequestSchema, request => this.callTool(request.params.name, request.params.arguments));
  }
  connect(transport: Transport): Promise<void> { return this.server.connect(transport); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.preview.closeAll(); await this.projects.closeAll();
    await this.server.close().catch(() => undefined);
  }
  private async callTool(name: string, raw: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const schema = TOOL_INPUT_SCHEMAS[name as FairyGuiToolName];
    if (!schema) return toCallToolResult(fail("INVALID_ARGUMENT", `未知 MCP 工具：${name}`, { path: "name", actual: name, allowed: Object.keys(TOOL_INPUT_SCHEMAS) }));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return toCallToolResult(fail("INVALID_ARGUMENT", `工具 ${name} 的参数不合法`, {
      path: parsed.error.issues[0]?.path.map(String).join(".") || "arguments", actual: parsed.error.issues,
      suggestedFix: `按 tools/list 和 ${SKILL_PATH} 的定义文件修正参数`
    }));
    try {
      switch (name) {
        case "fairygui.project": return toCallToolResult(await this.project(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        case "fairygui.query": return toCallToolResult(await this.query.execute(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        case "fairygui.edit": return toCallToolResult(await this.edits.execute(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        case "fairygui.preview": return toCallToolResult(await this.runPreview(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        case "fairygui.validate": return toCallToolResult(await this.validator.validate(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        case "fairygui.publish": return toCallToolResult(await this.publisher.publish(TOOL_INPUT_SCHEMAS[name].parse(raw)));
        default: return toCallToolResult(fail("INVALID_ARGUMENT", "工具名称不合法"));
      }
    } catch (error) { return toCallToolResult(fail("INTERNAL_ERROR", `工具 ${name} 执行失败`, { actual: error instanceof Error ? error.message : String(error) })); }
  }
  private async runPreview(input: PreviewToolInput): Promise<ResultEnvelope<unknown>> {
    if (!("previews" in input)) return this.preview.execute(input);
    const results: Record<string, ResultEnvelope<unknown>> = {};
    for (const [name, request] of Object.entries(input.previews)) results[name] = await this.preview.execute(request);
    const succeeded = Object.values(results).filter(result => result.ok).length;
    return ok({ results, requested: Object.keys(results).length, succeeded, failed: Object.keys(results).length - succeeded });
  }
  private async project(input: ProjectInput): Promise<ResultEnvelope<unknown>> {
    let result: ResultEnvelope<unknown>;
    switch (input.action) {
      case "open": result = await this.projects.open(input.path); break;
      case "list": result = this.projects.list(); break;
      case "status": result = this.projects.status(input.projectId); break;
      case "close":
        await this.preview.closeProject(input.projectId); this.edits.closeProject(input.projectId);
        result = await this.projects.close(input.projectId); break;
    }
    return result.ok ? { ...result, data: { ...(result.data as Record<string, unknown>), service: PROJECT_SERVICE_INFO } } : result;
  }
}
