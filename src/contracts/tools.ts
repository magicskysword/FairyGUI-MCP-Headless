import { z } from "zod";
import {
  FairyDomComponentRootSchema,
  FairyDomListItemSchema,
  FairyDomNewNodeSchema,
  FairyDomNodeSchema,
  FairyDomRelationSchema,
  FairyDomResourceReferenceSchema,
  FairyDomStyleSchema
} from "./dom.js";

export const FAIRYGUI_TOOL_NAMES = [
  "fairygui.project",
  "fairygui.query",
  "fairygui.apply_dom_patch",
  "fairygui.apply_resource_operations",
  "fairygui.render_component",
  "fairygui.validate"
] as const;
export type FairyGuiToolName = typeof FAIRYGUI_TOOL_NAMES[number];

const nonEmptyId = z.string().min(1);
const expectedMatches = z.number().int().min(1).max(10_000);
const singleExpectedMatch = z.literal(1);
const selector = z.string().min(1);
const clientRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const ProjectInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    path: z.string().min(1)
  }).strict(),
  z.object({
    action: z.literal("list")
  }).strict(),
  z.object({
    action: z.literal("status"),
    projectId: nonEmptyId
  }).strict(),
  z.object({
    action: z.literal("close"),
    projectId: nonEmptyId
  }).strict()
]);
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

const paginationShape = {
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional()
} as const;

export const QueryRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("packages"),
    ...paginationShape
  }).strict(),
  z.object({
    kind: z.literal("resources"),
    packageId: nonEmptyId.optional(),
    resourceTypes: z.array(z.string().min(1)).min(1).optional(),
    nameContains: z.string().min(1).optional(),
    ...paginationShape
  }).strict(),
  z.object({
    kind: z.literal("components"),
    packageId: nonEmptyId.optional(),
    nameContains: z.string().min(1).optional(),
    ...paginationShape
  }).strict(),
  z.object({
    kind: z.literal("dom"),
    packageId: nonEmptyId,
    componentId: nonEmptyId,
    selector: selector.optional(),
    resolvedPreview: z.boolean().optional()
  }).strict(),
  z.object({
    kind: z.literal("references"),
    packageId: nonEmptyId,
    resourceId: nonEmptyId,
    ...paginationShape
  }).strict(),
  z.object({
    kind: z.literal("capabilities")
  }).strict(),
  z.object({
    kind: z.literal("audit"),
    includeOpaque: z.boolean().optional(),
    ...paginationShape
  }).strict()
]);
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

const queryKeyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const QueryInputSchema = z.object({
  projectId: nonEmptyId,
  queries: z.record(z.string(), QueryRequestSchema)
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value.queries);
  if (entries.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["queries"],
      message: "queries 至少需要一个命名查询"
    });
  }
  if (entries.length > 100) {
    context.addIssue({
      code: "too_big",
      origin: "object",
      maximum: 100,
      inclusive: true,
      path: ["queries"],
      message: "单批最多允许 100 个查询"
    });
  }
  for (const [key] of entries) {
    if (!queryKeyPattern.test(key)) {
      context.addIssue({
        code: "custom",
        path: ["queries", key],
        message: "查询键必须以字母开头且仅包含字母、数字、_ 或 -"
      });
    }
  }
});
export type QueryInput = z.infer<typeof QueryInputSchema>;

const nonEmptyStyleChanges = FairyDomStyleSchema.refine(
  (value) => Object.keys(value).length > 0,
  "changes 至少需要一个样式字段"
);

const patchTargetShape = {
  selector: selector.optional(),
  targetRef: clientRef.optional(),
  expectedMatches
} as const;

export const DomPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("insert"),
    parentSelector: selector,
    expectedMatches: singleExpectedMatch,
    clientRef,
    index: z.number().int().nonnegative().optional(),
    node: FairyDomNewNodeSchema
  }).strict(),
  z.object({
    op: z.literal("remove"),
    ...patchTargetShape
  }).strict(),
  z.object({
    op: z.literal("move"),
    ...patchTargetShape,
    expectedMatches: singleExpectedMatch,
    toIndex: z.number().int().nonnegative()
  }).strict(),
  z.object({
    op: z.literal("set-name"),
    ...patchTargetShape,
    name: z.string()
  }).strict(),
  z.object({
    op: z.literal("set-style"),
    ...patchTargetShape,
    changes: nonEmptyStyleChanges
  }).strict(),
  z.object({
    op: z.literal("set-text"),
    ...patchTargetShape,
    text: z.string()
  }).strict(),
  z.object({
    op: z.literal("set-resource"),
    ...patchTargetShape,
    resource: FairyDomResourceReferenceSchema.nullable()
  }).strict(),
  z.object({
    op: z.literal("set-relations"),
    ...patchTargetShape,
    relations: z.array(FairyDomRelationSchema)
  }).strict(),
  z.object({
    op: z.literal("set-list-items"),
    ...patchTargetShape,
    items: z.array(FairyDomListItemSchema)
  }).strict(),
  z.object({
    op: z.literal("replace-node"),
    ...patchTargetShape,
    expectedMatches: singleExpectedMatch,
    node: FairyDomNewNodeSchema
  }).strict()
]);
export type DomPatchOperation = z.infer<typeof DomPatchOperationSchema>;

function validatePatchTarget(
  value: {
    selector?: string | undefined;
    targetRef?: string | undefined;
    expectedMatches: number;
  },
  context: z.RefinementCtx,
  path: Array<string | number> = []
): void {
  const targetCount = Number(value.selector !== undefined)
    + Number(value.targetRef !== undefined);
  if (targetCount !== 1) {
    context.addIssue({
      code: "custom",
      path,
      message: "写目标必须且只能指定 selector 或 targetRef"
    });
  }
  if (value.targetRef !== undefined && value.expectedMatches !== 1) {
    context.addIssue({
      code: "custom",
      path: [...path, "expectedMatches"],
      message: "targetRef 精确指向一个同批新节点，expectedMatches 必须为 1"
    });
  }
}

const rootPropertiesSchema = FairyDomComponentRootSchema.pick({
  style: true,
  content: true
});

const replacementTargetShape = {
  selector,
  expectedMatches
} as const;

export const DomContentReplacementSchema = z.discriminatedUnion("domain", [
  z.object({
    domain: z.literal("displayTree"),
    value: z.array(FairyDomNodeSchema)
  }).strict(),
  z.object({
    domain: z.literal("componentProperties"),
    value: rootPropertiesSchema
  }).strict(),
  z.object({
    domain: z.literal("relations"),
    ...replacementTargetShape,
    value: z.array(FairyDomRelationSchema)
  }).strict(),
  z.object({
    domain: z.literal("listItems"),
    ...replacementTargetShape,
    value: z.array(FairyDomListItemSchema)
  }).strict(),
  z.object({
    domain: z.literal("gears"),
    value: z.array(z.unknown())
  }).strict(),
  z.object({
    domain: z.literal("controllers"),
    value: z.array(z.unknown())
  }).strict(),
  z.object({
    domain: z.literal("transitions"),
    value: z.array(z.unknown())
  }).strict()
]);
export type DomContentReplacement = z.infer<typeof DomContentReplacementSchema>;

const domPatchBaseShape = {
  projectId: nonEmptyId,
  packageId: nonEmptyId,
  componentId: nonEmptyId
} as const;

export const ApplyDomPatchInputSchema = z.union([
  z.object({
    ...domPatchBaseShape,
    operations: z.array(DomPatchOperationSchema).min(1).max(200)
  }).strict().superRefine((value, context) => {
    const declaredClientRefs = new Set<string>();
    value.operations.forEach((operation, index) => {
      if (operation.op !== "insert") return;
      if (declaredClientRefs.has(operation.clientRef)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "clientRef"],
          message: `同一批次不能重复声明 clientRef：${operation.clientRef}`
        });
      }
      declaredClientRefs.add(operation.clientRef);
    });
    value.operations.forEach((operation, index) => {
      if (operation.op !== "insert") {
        validatePatchTarget(operation, context, ["operations", index]);
        if (
          operation.targetRef !== undefined
          && !declaredClientRefs.has(operation.targetRef)
        ) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "targetRef"],
            message: `targetRef 必须引用同一批次声明的插入节点：${
              operation.targetRef
            }`
          });
        }
      }
    });
  }),
  z.object({
    ...domPatchBaseShape,
    replace: DomContentReplacementSchema
  }).strict()
]);
export type ApplyDomPatchInput = z.infer<typeof ApplyDomPatchInputSchema>;

const conflictPolicy = z.enum(["reject", "rename", "replace"]);
const deleteMode = z.enum(["reject", "cascade", "force"]);

export const ResourceOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create-package"),
    clientRef,
    name: z.string().min(1),
    id: z.string().min(1).optional()
  }).strict(),
  z.object({
    op: z.literal("create-component"),
    packageId: nonEmptyId.optional(),
    packageRef: clientRef.optional(),
    clientRef,
    name: z.string().min(1),
    path: z.string().optional(),
    width: z.number().finite().nonnegative().optional(),
    height: z.number().finite().nonnegative().optional()
  }).strict(),
  z.object({
    op: z.literal("import"),
    packageId: nonEmptyId,
    clientRef,
    inboxPath: z.string().min(1),
    name: z.string().min(1),
    path: z.string().optional(),
    conflict: conflictPolicy.default("reject"),
    resourceId: nonEmptyId.optional()
  }).strict(),
  z.object({
    op: z.literal("replace-resource"),
    packageId: nonEmptyId,
    resourceId: nonEmptyId,
    inboxPath: z.string().min(1)
  }).strict(),
  z.object({
    op: z.literal("rename-package"),
    packageId: nonEmptyId,
    name: z.string().min(1)
  }).strict(),
  z.object({
    op: z.literal("rename-resource"),
    packageId: nonEmptyId,
    resourceId: nonEmptyId,
    name: z.string().min(1)
  }).strict(),
  z.object({
    op: z.literal("move-resource"),
    packageId: nonEmptyId,
    targetPackageId: nonEmptyId.optional(),
    resourceId: nonEmptyId,
    path: z.string()
  }).strict(),
  z.object({
    op: z.literal("delete-resource"),
    packageId: nonEmptyId,
    resourceId: nonEmptyId,
    mode: deleteMode.default("reject")
  }).strict(),
  z.object({
    op: z.literal("delete-package"),
    packageId: nonEmptyId,
    mode: deleteMode.default("reject")
  }).strict()
]);
export type ResourceOperation = z.infer<typeof ResourceOperationSchema>;

export const ApplyResourceOperationsInputSchema = z.object({
  projectId: nonEmptyId,
  operations: z.array(ResourceOperationSchema).min(1).max(200)
}).strict().superRefine((value, context) => {
  value.operations.forEach((operation, index) => {
    if (operation.op === "create-component") {
      const targetCount = Number(operation.packageId !== undefined)
        + Number(operation.packageRef !== undefined);
      if (targetCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: "create-component 必须且只能指定 packageId 或 packageRef"
        });
      }
    }
    if (
      operation.op === "import"
      && operation.conflict === "replace"
      && operation.resourceId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations", index, "resourceId"],
        message: "replace 冲突策略必须指定已有 resourceId"
      });
    }
  });
});
export type ApplyResourceOperationsInput = z.infer<
  typeof ApplyResourceOperationsInputSchema
>;

const renderControllerStateBase = {
  selector,
  expectedMatches,
  controller: z.string().min(1)
} as const;

export const RenderControllerStateSchema = z.union([
  z.object({
    ...renderControllerStateBase,
    selectedIndex: z.number().int().nonnegative()
  }).strict(),
  z.object({
    ...renderControllerStateBase,
    pageId: z.string().min(1)
  }).strict(),
  z.object({
    ...renderControllerStateBase,
    pageName: z.string()
  }).strict()
]);
export type RenderControllerState = z.infer<
  typeof RenderControllerStateSchema
>;

const renderScrollStateBase = {
  selector,
  expectedMatches
} as const;
const renderScrollPosition = z.number().finite().nonnegative();

export const RenderScrollStateSchema = z.union([
  z.object({
    ...renderScrollStateBase,
    x: renderScrollPosition
  }).strict(),
  z.object({
    ...renderScrollStateBase,
    y: renderScrollPosition
  }).strict(),
  z.object({
    ...renderScrollStateBase,
    x: renderScrollPosition,
    y: renderScrollPosition
  }).strict()
]);
export type RenderScrollState = z.infer<typeof RenderScrollStateSchema>;

const renderListStateBase = {
  selector,
  expectedMatches
} as const;
const renderListIndex = z.number().int().nonnegative();
const renderListIndices = z.array(renderListIndex).max(100).refine(
  (indices) => new Set(indices).size === indices.length,
  { message: "selectedIndices 不能包含重复索引" }
);

export const RenderListStateSchema = z.union([
  z.object({
    ...renderListStateBase,
    selectedIndex: z.number().int().min(-1)
  }).strict(),
  z.object({
    ...renderListStateBase,
    selectedIndices: renderListIndices
  }).strict()
]);
export type RenderListState = z.infer<typeof RenderListStateSchema>;

const renderControllers = z.array(RenderControllerStateSchema).min(1).max(100);
const renderScrolls = z.array(RenderScrollStateSchema).min(1).max(100);
const renderLists = z.array(RenderListStateSchema).min(1).max(100);
const renderTransientStateFields = {
  controllers: renderControllers.optional(),
  scrolls: renderScrolls.optional(),
  lists: renderLists.optional()
} as const;

export const RenderTransientStateSchema = z.union([
  z.object({
    ...renderTransientStateFields,
    controllers: renderControllers
  }).strict(),
  z.object({
    ...renderTransientStateFields,
    scrolls: renderScrolls
  }).strict(),
  z.object({
    ...renderTransientStateFields,
    lists: renderLists
  }).strict()
]);
export type RenderTransientState = z.infer<
  typeof RenderTransientStateSchema
>;

export const RenderComponentInputSchema = z.object({
  projectId: nonEmptyId,
  packageId: nonEmptyId,
  componentId: nonEmptyId,
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  scale: z.number().finite().min(0.25).max(4).default(1),
  background: z.string().min(1).optional(),
  state: RenderTransientStateSchema.optional(),
  saveToFile: z.boolean().default(false)
}).strict();
export type RenderComponentInput = z.infer<typeof RenderComponentInputSchema>;

export const ValidateInputSchema = z.object({
  projectId: nonEmptyId,
  mode: z.enum(["quick", "roundtrip", "publish", "full"]),
  packageIds: z.array(nonEmptyId).min(1).optional(),
  componentIds: z.array(nonEmptyId).min(1).optional()
}).strict();
export type ValidateInput = z.infer<typeof ValidateInputSchema>;

export const TOOL_INPUT_SCHEMAS = {
  "fairygui.project": ProjectInputSchema,
  "fairygui.query": QueryInputSchema,
  "fairygui.apply_dom_patch": ApplyDomPatchInputSchema,
  "fairygui.apply_resource_operations": ApplyResourceOperationsInputSchema,
  "fairygui.render_component": RenderComponentInputSchema,
  "fairygui.validate": ValidateInputSchema
} as const;
