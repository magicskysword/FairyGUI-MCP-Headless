import { z } from "zod";
import { AUTHORING_TARGET_SCHEMA, type AuthoringTarget } from "@magicskysword/openfairygui-core";

export const AuthoringTargetSchema = z.fromJSONSchema(AUTHORING_TARGET_SCHEMA as Record<string, unknown>).meta({ id: "AuthoringTarget" }) as z.ZodType<AuthoringTarget>;
const pagination = { limit: z.number().int().min(1).max(500).default(50), cursor: z.string().optional() };
const detail = z.enum(["summary", "full"]).default("summary");
const scope = { packageId: z.string().min(1), componentId: z.string().min(1) };
export const NativeQueryRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("packages"), detail, ...pagination }).strict(),
  z.object({ kind: z.enum(["resources", "components"]), packageId: z.string().optional(), nameContains: z.string().optional(), types: z.array(z.string()).optional(), detail, ...pagination }).strict(),
  z.object({ kind: z.enum(["nodes", "controllers", "transitions", "gears"]), ...scope, nodeId: z.string().optional(), selector: z.string().optional(), detail, ...pagination }).strict(),
  z.object({ kind: z.enum(["object", "xml", "references"]), target: AuthoringTargetSchema, direction: z.enum(["incoming", "outgoing", "both"]).default("incoming"), detail, ...pagination }).strict(),
  z.object({ kind: z.literal("audit"), packageId: z.string().optional(), componentId: z.string().optional(), detail, ...pagination }).strict(),
  z.object({ kind: z.literal("capabilities"), detail, ...pagination }).strict()
]);
export const NativeQueryInputSchema = z.object({ projectId: z.string().min(1), queries: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), NativeQueryRequestSchema) }).strict().superRefine((input, ctx) => {
  if (Object.keys(input.queries).length < 1 || Object.keys(input.queries).length > 100) ctx.addIssue({ code: "custom", path: ["queries"], message: "命名查询必须包含 1 至 100 项" });
});
export type NativeQueryRequest = z.infer<typeof NativeQueryRequestSchema>;
export type NativeQueryInput = z.input<typeof NativeQueryInputSchema>;
