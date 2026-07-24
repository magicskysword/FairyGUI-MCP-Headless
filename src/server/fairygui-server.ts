import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ApplyDomPatchInputSchema,
  ApplyResourceOperationsInputSchema,
  ProjectInputSchema,
  PublishInputSchema,
  QueryInputSchema,
  RenderComponentInputSchema,
  TOOL_INPUT_SCHEMAS,
  ValidateInputSchema,
  type ApplyDomPatchInput,
  type ApplyResourceOperationsInput,
  type FairyGuiToolName,
  type ProjectInput,
  type PublishInput
} from "../contracts/tools.js";
import {
  fail,
  type ResultEnvelope
} from "../contracts/result.js";
import { DomPatchService } from "../dom/dom-patch-service.js";
import { ProjectRegistry } from "../project/project-registry.js";
import { PublishService } from "../publish/publish-service.js";
import { QueryService } from "../query/query-service.js";
import { RenderService } from "../render/render-service.js";
import { ResourceOperationsService } from "../resources/resource-operations-service.js";
import { ValidationService } from "../validation/validation-service.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import { FileTransactionManager } from "../write/file-transaction.js";
import {
  PACKAGE_VERSION,
  PROJECT_SERVICE_INFO,
  SERVER_NAME
} from "../version.js";

export const SERVER_INSTRUCTIONS = [
  "FairyGUI 无头创作工作流：先用 fairygui.project 打开工程，再用一次 fairygui.query 批量查询包、组件、DOM、引用与能力；",
  "需要视觉反馈时调用 fairygui.render_component，调整后再渲染；提交前调用 fairygui.validate 完成校验。",
  "磁盘始终是唯一事实来源；每次调用前会刷新外部变更，写操作会原子落盘且不提供草稿、Undo/Redo、revision 或 Git。",
  "DOM 使用受限的 HTML/CSS 风格知识：仅支持已声明的节点、样式名和选择器，不等同于浏览器 DOM/CSS。",
  "尽量把同一意图合并到 query、apply_dom_patch 或 apply_resource_operations 的一个批次中；写目标必须提供 expectedMatches。",
  "render_component 会在内存中编译未发布工程并使用 fairygui-dom runtime-preview；scale=2/3/4 会选择对应高分辨率资源，state.controllers/state.lists/state.trees/state.scrolls 可设置仅用于本次截图的控制器页、List/Tree 状态和滚动位置，它不是 Unity 像素真值。",
  "fairygui.publish 直接使用工程发布设置，可按包执行全量发布或跳过图集的仅定义发布；outputPath 只临时覆盖运行时产物路径。"
].join("\n");

interface DomPatchHandler {
  apply(input: ApplyDomPatchInput): Promise<ResultEnvelope<unknown>>;
}

interface ResourceOperationsHandler {
  apply(input: ApplyResourceOperationsInput): Promise<ResultEnvelope<unknown>>;
}

interface PublishHandler {
  publish(input: PublishInput): Promise<ResultEnvelope<unknown>>;
}

export interface FairyGuiMcpServerOptions {
  projects?: ProjectRegistry;
  query?: QueryService;
  renderer?: RenderService;
  validator?: ValidationService;
  domPatch?: DomPatchHandler;
  resources?: ResourceOperationsHandler;
  publisher?: PublishHandler;
  transactions?: FileTransactionManager;
  coordinator?: ProjectCommitCoordinator;
}

const TOOL_DATA_OUTPUT_SCHEMAS: Record<
  FairyGuiToolName,
  Record<string, unknown>
> = {
  "fairygui.project": {
    type: "object",
    properties: {
      projectId: { type: "string" },
      projects: { type: "array", items: { type: "object" } },
      service: { type: "object" }
    },
    required: ["service"],
    additionalProperties: true
  },
  "fairygui.query": {
    type: "object",
    properties: {
      results: {
        type: "object",
        additionalProperties: { type: "object" }
      }
    },
    required: ["results"],
    additionalProperties: true
  },
  "fairygui.apply_dom_patch": {
    type: "object",
    properties: {
      projectId: { type: "string" },
      packageId: { type: "string" },
      componentId: { type: "string" },
      transactionId: { type: "string" },
      appliedOperations: { type: "integer" },
      clientRefs: { type: "object" },
      affectedFiles: { type: "array", items: { type: "string" } },
      operationResults: { type: "array", items: { type: "object" } },
      affectedNodeIds: { type: "array", items: { type: "string" } }
    },
    required: [
      "projectId",
      "packageId",
      "componentId",
      "transactionId",
      "appliedOperations",
      "operationResults",
      "affectedNodeIds",
      "clientRefs",
      "affectedFiles"
    ],
    additionalProperties: true
  },
  "fairygui.apply_resource_operations": {
    type: "object",
    properties: {
      projectId: { type: "string" },
      dryRun: { type: "boolean" },
      transactionId: { type: "string" },
      appliedOperations: { type: "integer" },
      operationResults: { type: "array", items: { type: "object" } },
      affectedReferences: { type: "array", items: { type: "object" } },
      fileChanges: { type: "object" },
      affectedFiles: { type: "array", items: { type: "string" } }
    },
    required: [
      "projectId",
      "dryRun",
      "appliedOperations",
      "operationResults",
      "affectedReferences",
      "fileChanges",
      "affectedFiles"
    ],
    additionalProperties: true
  },
  "fairygui.render_component": {
    type: "object",
    properties: {
      backend: { const: "fairygui-dom" },
      fidelity: { type: "string" },
      rendererVersion: { type: "string" },
      requested: { type: "integer" },
      succeeded: { type: "integer" },
      failed: { type: "integer" },
      results: {
        type: "object",
        additionalProperties: { type: "object" }
      }
    },
    required: [
      "backend",
      "fidelity",
      "rendererVersion",
      "requested",
      "succeeded",
      "failed",
      "results"
    ],
    additionalProperties: true
  },
  "fairygui.publish": {
    type: "object",
    properties: {
      projectId: { type: "string" },
      publishType: { enum: ["full", "definitions"] },
      outputPath: { type: "string" },
      outputPathSource: { type: "string" },
      packages: { type: "array", items: { type: "object" } },
      writtenFiles: { type: "array", items: { type: "object" } },
      durationMs: { type: "number" }
    },
    required: [
      "projectId",
      "publishType",
      "outputPath",
      "outputPathSource",
      "packages",
      "writtenFiles",
      "durationMs"
    ],
    additionalProperties: true
  },
  "fairygui.validate": {
    type: "object",
    properties: {
      mode: { type: "string" },
      detail: { enum: ["summary", "full"] },
      valid: { type: "boolean" },
      checked: { type: "object" },
      phases: { type: "array", items: { type: "object" } },
      diagnostics: { type: "array", items: { type: "object" } }
    },
    required: [
      "mode",
      "detail",
      "valid",
      "checked",
      "phases",
      "diagnostics"
    ],
    additionalProperties: true
  }
};

function outputSchemaFor(name: FairyGuiToolName): Tool["outputSchema"] {
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          ok: { const: true },
          data: TOOL_DATA_OUTPUT_SCHEMAS[name],
          warnings: {
            type: "array",
            items: { type: "object" }
          }
        },
        required: ["ok", "data"],
        additionalProperties: false
      },
      {
        type: "object",
        properties: {
          ok: { const: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" }
            },
            required: ["code", "message"],
            additionalProperties: true
          }
        },
        required: ["ok", "error"],
        additionalProperties: false
      }
    ]
  } as Tool["outputSchema"];
}

const TOOL_DESCRIPTIONS: Record<FairyGuiToolName, string> = {
  "fairygui.project":
    "打开、列出、查看或关闭本地 FairyGUI 工程会话。路径会规范化，同一路径重复打开会复用会话。",
  "fairygui.query":
    "在一次调用中批量查询包、资源、组件、DOM、引用、能力矩阵和审计信息；单项失败不丢失其他结果。",
  "fairygui.apply_dom_patch":
    "对一个现有组件原子执行最多 200 个 insert、update、move、remove 或 replace DOM 操作；node 与 changes 会在工具内部按目标节点类型严格校验，批次绝不部分成功。",
  "fairygui.apply_resource_operations":
    "原子执行包与资源创建、收件箱导入、替换、重命名、包内移动和删除；批次绝不部分成功。",
  "fairygui.render_component":
    "在内存中编译未发布工程，用隔离 FairyGUI-dom runtime 渲染并返回 PNG；scale 会同时控制截图像素密度和 @2x/@3x/@4x 资源选择，可按受限选择器临时设置当前截图的控制器页、List/Tree 状态和滚动位置且不写盘。",
  "fairygui.publish":
    "使用 FairyGUI 工程发布设置发布全部或指定包；支持全量发布和跳过图集的仅定义发布，outputPath 可临时覆盖运行时产物目录。",
  "fairygui.validate":
    "执行 quick、roundtrip、publish 或 full 校验。工程问题仍是成功调用，并在 data.valid 中返回 false。"
};

const TOOL_ANNOTATIONS: Record<
  FairyGuiToolName,
  NonNullable<Tool["annotations"]>
> = {
  "fairygui.project": {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  "fairygui.query": {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  "fairygui.apply_dom_patch": {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  "fairygui.apply_resource_operations": {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  },
  "fairygui.render_component": {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  "fairygui.publish": {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true
  },
  "fairygui.validate": {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

function toInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const converted = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
    reused: "ref"
  }) as Record<string, unknown>;
  delete converted.$schema;
  return {
    ...converted,
    type: "object"
  } as Tool["inputSchema"];
}

const TOOLS: Tool[] = Object.entries(TOOL_INPUT_SCHEMAS).map(
  ([name, schema]) => {
    const toolName = name as FairyGuiToolName;
    return {
      name: toolName,
      description: TOOL_DESCRIPTIONS[toolName],
      inputSchema: toInputSchema(schema),
      outputSchema: outputSchemaFor(toolName),
      annotations: TOOL_ANNOTATIONS[toolName],
      execution: { taskSupport: "forbidden" }
    };
  }
);

function invalidArguments(
  toolName: string,
  error: z.ZodError
): ResultEnvelope<never> {
  const firstIssue = error.issues[0];
  const issuePath = firstIssue?.path.length
    ? firstIssue.path.map(String).join(".")
    : "arguments";
  return fail("INVALID_ARGUMENT", `工具 ${toolName} 的参数不合法`, {
    path: issuePath,
    actual: error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
      code: issue.code
    })),
    suggestedFix: "按照 tools/list 返回的 inputSchema 修正参数后重试"
  });
}

interface InlineImageContent {
  mimeType: "image/png";
  data: string;
}

function prepareMcpPayload(
  value: unknown,
  images: InlineImageContent[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => prepareMcpPayload(entry, images));
  }
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (
      key === "data"
      && source.mediaType === "image/png"
      && typeof entry === "string"
    ) {
      images.push({ mimeType: "image/png", data: entry });
      result.contentIndex = images.length;
      continue;
    }
    result[key] = prepareMcpPayload(entry, images);
  }
  return result;
}

function toCallToolResult(
  result: ResultEnvelope<unknown>
): CallToolResult {
  const images: InlineImageContent[] = [];
  const structured = prepareMcpPayload(result, images) as Record<
    string,
    unknown
  >;
  const content: CallToolResult["content"] = [{
    type: "text",
    text: JSON.stringify(structured)
  }];
  for (const image of images) {
    content.push({
      type: "image",
      mimeType: image.mimeType,
      data: image.data
    });
  }
  return {
    content,
    structuredContent: structured,
    isError: !result.ok
  };
}

export class FairyGuiMcpServer {
  public readonly server: Server;
  public readonly projects: ProjectRegistry;
  public readonly query: QueryService;
  public readonly renderer: RenderService;
  public readonly validator: ValidationService;
  public readonly transactions: FileTransactionManager;
  public readonly coordinator: ProjectCommitCoordinator;
  private readonly domPatch: DomPatchHandler;
  private readonly resources: ResourceOperationsHandler;
  private readonly publisher: PublishHandler;
  private closed = false;

  public constructor(options: FairyGuiMcpServerOptions = {}) {
    this.transactions = options.transactions ?? new FileTransactionManager();
    this.coordinator = options.coordinator ?? new ProjectCommitCoordinator();
    this.projects = options.projects ?? new ProjectRegistry({
      recovery: this.transactions
    });
    this.query = options.query ?? new QueryService(this.projects);
    this.renderer = options.renderer ?? new RenderService(this.projects);
    this.validator = options.validator ?? new ValidationService(this.projects);
    this.domPatch = options.domPatch ?? new DomPatchService(this.projects, {
      transactions: this.transactions,
      coordinator: this.coordinator
    });
    this.resources = options.resources ?? new ResourceOperationsService(
      this.projects,
      {
        transactions: this.transactions,
        coordinator: this.coordinator
      }
    );
    this.publisher = options.publisher ?? new PublishService(this.projects, {
      coordinator: this.coordinator
    });
    this.server = new Server(
      { name: SERVER_NAME, version: PACKAGE_VERSION },
      {
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS
      }
    );
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOLS
    }));
    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(
        request.params.name,
        request.params.arguments
      )
    );
  }

  public connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.renderer.close();
    await this.projects.closeAll();
    await this.server.close().catch(() => undefined);
  }

  private async callTool(
    name: string,
    rawArguments: Record<string, unknown> | undefined
  ): Promise<CallToolResult> {
    switch (name) {
      case "fairygui.project":
        return this.parseAndRun(
          name,
          ProjectInputSchema,
          rawArguments,
          (input) => this.project(input)
        );
      case "fairygui.query":
        return this.parseAndRun(
          name,
          QueryInputSchema,
          rawArguments,
          (input) => this.query.execute(input)
        );
      case "fairygui.apply_dom_patch":
        return this.parseAndRun(
          name,
          ApplyDomPatchInputSchema,
          rawArguments,
          (input) => this.domPatch.apply(input)
        );
      case "fairygui.apply_resource_operations":
        return this.parseAndRun(
          name,
          ApplyResourceOperationsInputSchema,
          rawArguments,
          (input) => this.resources.apply(input)
        );
      case "fairygui.render_component":
        return this.parseAndRun(
          name,
          RenderComponentInputSchema,
          rawArguments,
          (input) => this.renderer.render(input)
        );
      case "fairygui.publish":
        return this.parseAndRun(
          name,
          PublishInputSchema,
          rawArguments,
          (input) => this.publisher.publish(input)
        );
      case "fairygui.validate":
        return this.parseAndRun(
          name,
          ValidateInputSchema,
          rawArguments,
          (input) => this.validator.validate(input)
        );
      default:
        return toCallToolResult(fail(
          "INVALID_ARGUMENT",
          `未知 MCP 工具：${name}`,
          {
            path: "name",
            actual: name,
            allowed: TOOLS.map((tool) => tool.name)
          }
        ));
    }
  }

  private async parseAndRun<T>(
    name: string,
    schema: z.ZodType<T>,
    rawArguments: Record<string, unknown> | undefined,
    handler: (input: T) => Promise<ResultEnvelope<unknown>>
  ): Promise<CallToolResult> {
    const parsed = schema.safeParse(rawArguments);
    if (!parsed.success) {
      return toCallToolResult(invalidArguments(name, parsed.error));
    }
    try {
      return toCallToolResult(await handler(parsed.data));
    }
    catch (error) {
      return toCallToolResult(fail(
        "INTERNAL_ERROR",
        `工具 ${name} 执行时发生未处理错误`,
        {
          actual: error instanceof Error ? error.message : String(error)
        }
      ));
    }
  }

  private async project(
    input: ProjectInput
  ): Promise<ResultEnvelope<unknown>> {
    let result: ResultEnvelope<unknown>;
    switch (input.action) {
      case "open":
        result = await this.projects.open(input.path);
        break;
      case "list":
        result = this.projects.list();
        break;
      case "status":
        result = this.projects.status(input.projectId);
        break;
      case "close":
        result = await this.projects.close(input.projectId);
        break;
    }
    if (!result.ok) return result;
    return {
      ...result,
      data: {
        ...(result.data as Record<string, unknown>),
        service: PROJECT_SERVICE_INFO
      }
    };
  }
}
