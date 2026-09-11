import { z } from "zod";
import { assertAuthoringOperations, DocumentEditError } from "@magicskysword/openfairygui-core";
import type { SnapshotEditOperation } from "@magicskysword/openfairygui-functions";
import { NativeQueryInputSchema } from "./native-query.js";
import { PreviewRecipeSchema, PreviewRunSchema } from "./preview.js";
import { ProjectInputSchema, PublishInputSchema, ValidateInputSchema } from "./tools.js";

export { ProjectInputSchema, PublishInputSchema, ValidateInputSchema };
const id = z.string().min(1);
const requestId = z.string().min(1).max(200);
const operations = z.array(z.record(z.string(), z.unknown())).min(1).max(200).superRefine((value, ctx) => {
  try { assertAuthoringOperations(value); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error), path: error instanceof DocumentEditError && error.path ? [error.path] : [] }); }
}).transform(value => value as unknown as SnapshotEditOperation[]).describe("原生编辑操作；完整字段和类型见 Skill definitions/authoring/operations.schema.json，服务端按同一共享 Schema 严格校验。");
export const EditInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan"), projectId: id, operations }).strict(),
  z.object({ action: z.literal("apply"), projectId: id, requestId, operations }).strict(),
  z.object({ action: z.literal("commit"), projectId: id, requestId, planId: id }).strict()
]);

// 文件式定义保留深层类型，发现阶段仅传输稳定的外层结构。
function fileDefined<T extends z.ZodType>(schema: T, definition: string) {
  return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }).transform(value => value as z.input<T>).describe(`完整字段见 Skill ${definition}；服务端按该定义严格校验。`);
}
const recipe = fileDefined(PreviewRecipeSchema, "definitions/preview/recipe.schema.json");
const run = fileDefined(PreviewRunSchema, "definitions/preview/run.schema.json");
const source = z.object({ projectId: id, packageId: id, componentId: id, planId: id.optional() }).strict();
const images = { imageResult: z.enum(["inline", "file", "both"]).optional(), includeFrames: z.boolean().optional() };
const inspection = { properties: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)).max(100).optional(), selector: id.optional() };
export const PreviewRequestSchema = z.union([
  z.object({ action: z.literal("open"), source, recipe: recipe.optional() }).strict(),
  z.object({ action: z.literal("run"), source, recipe: recipe.optional(), run: run.optional(), ...images }).strict(),
  z.object({ action: z.literal("run"), previewId: id, run: run.optional(), ...images }).strict(),
  z.object({ action: z.literal("inspect"), previewId: id, ...inspection }).strict(),
  z.object({ action: z.literal("capture"), previewId: id, ...inspection, ...images }).strict(),
  z.object({ action: z.enum(["reset", "reload", "close"]), previewId: id }).strict()
]);
export const PreviewInputSchema = z.union([
  PreviewRequestSchema,
  z.object({ previews: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), PreviewRequestSchema) }).strict().superRefine((value, ctx) => {
    if (Object.keys(value.previews).length < 1 || Object.keys(value.previews).length > 20) ctx.addIssue({ code: "custom", path: ["previews"], message: "命名预览必须包含 1 至 20 项" });
  })
]);
export const TOOL_INPUT_SCHEMAS = {
  "fairygui.project": ProjectInputSchema,
  "fairygui.query": NativeQueryInputSchema,
  "fairygui.edit": EditInputSchema,
  "fairygui.preview": PreviewInputSchema,
  "fairygui.validate": ValidateInputSchema,
  "fairygui.publish": PublishInputSchema
} as const;
export type FairyGuiToolName = keyof typeof TOOL_INPUT_SCHEMAS;
export const FAIRYGUI_TOOL_NAMES = Object.keys(TOOL_INPUT_SCHEMAS) as FairyGuiToolName[];
export type PreviewToolInput = z.infer<typeof PreviewInputSchema>;
