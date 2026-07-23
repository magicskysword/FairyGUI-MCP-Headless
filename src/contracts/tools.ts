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
  selector,
  expectedMatches
} as const;

export const DomPatchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("insert"),
    parentSelector: selector,
    expectedMatches,
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
    node: FairyDomNewNodeSchema
  }).strict()
]);
export type DomPatchOperation = z.infer<typeof DomPatchOperationSchema>;

const rootPropertiesSchema = FairyDomComponentRootSchema.pick({
  style: true,
  content: true
});

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
    selector,
    expectedMatches,
    value: z.array(FairyDomRelationSchema)
  }).strict(),
  z.object({
    domain: z.literal("listItems"),
    selector,
    expectedMatches,
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
  }).strict(),
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

export const RenderComponentInputSchema = z.object({
  projectId: nonEmptyId,
  packageId: nonEmptyId,
  componentId: nonEmptyId,
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  scale: z.number().finite().min(0.25).max(4).default(1),
  background: z.string().min(1).optional(),
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

