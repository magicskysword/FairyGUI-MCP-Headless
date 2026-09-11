import { z } from "zod";
import type { PreviewArtifacts } from "@magicskysword/openfairygui-functions";

const target = z.string().min(1).default(":root");
const props = z.record(z.string(), z.json());
const code = z.string().min(1).max(1024 * 1024);
export const PreviewOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("script"), code }).strict(),
  z.object({ op: z.literal("set"), target, props }).strict(),
  z.object({ op: z.literal("controller"), target, name: z.string().min(1), pageId: z.string().optional(), pageName: z.string().optional(), index: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal("call"), target, method: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), args: z.array(z.json()).default([]) }).strict(),
  z.object({ op: z.literal("event"), target, type: z.string().min(1), data: z.json().optional() }).strict(),
  z.object({ op: z.literal("scroll"), target, x: z.number().optional(), y: z.number().optional(), animated: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("list"), target, items: z.array(props).max(10000), defaultItem: z.string().optional() }).strict(),
  z.object({ op: z.literal("tree"), target, items: z.array(z.json()).max(10000) }).strict(),
  z.object({ op: z.literal("transition"), target, name: z.string().min(1), action: z.enum(["play", "playReverse", "stop", "pause", "resume"]), times: z.number().int().min(-1).default(1) }).strict()
]);
const operations = z.array(PreviewOperationSchema).max(200).default([]);
const timeline = z.array(z.object({ at: z.number().min(0).max(60000), operations }).strict()).max(200).default([]);
export const PreviewRecipeSchema = z.object({
  environment: z.object({
    width: z.number().int().min(1).max(4096).default(1024), height: z.number().int().min(1).max(4096).default(768),
    scale: z.number().min(0.25).max(4).default(1), background: z.string().max(128).default("transparent"),
    clock: z.enum(["manual", "realtime"]).default("manual"), seed: z.number().int().default(0)
  }).strict().default({ width: 1024, height: 768, scale: 1, background: "transparent", clock: "manual", seed: 0 }),
  data: z.json().default({}), resources: z.record(z.string(), z.string()).default({}),
  preconstruct: code.optional(), setup: operations, timeline
}).strict().superRefine((recipe, ctx) => {
  const { width, height, scale } = recipe.environment;
  if (Math.ceil(width * scale) > 4096 || Math.ceil(height * scale) > 4096) ctx.addIssue({ code: "custom", message: "单帧物理尺寸单边不能超过 4096px", path: ["environment"] });
});
export type PreviewRecipe = z.infer<typeof PreviewRecipeSchema>;
export type PreviewRecipeInput = z.input<typeof PreviewRecipeSchema>;
export type PreviewOperation = z.infer<typeof PreviewOperationSchema>;
export const PreviewRunSchema = z.object({
  operations, timeline,
  times: z.array(z.number().min(0).max(60000)).max(64).default([]),
  properties: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)).max(100).optional(), selector: z.string().optional()
}).strict().superRefine((value, ctx) => {
  if (value.times.some((time, index) => index > 0 && time < value.times[index - 1]!)) ctx.addIssue({ code: "custom", message: "采样时间必须按升序排列", path: ["times"] });
});
export type PreviewRun = z.infer<typeof PreviewRunSchema>;
export type PreviewRunInput = z.input<typeof PreviewRunSchema>;
export * from './preview-state.js';
export * from './preview-context.js';
export interface ExecutorInput {
  previewId: string; runtime: PreviewArtifacts; packageId: string; componentId: string; recipe: PreviewRecipeInput;
  resources?: Array<{ name: string; data: Uint8Array; mediaType: string }>;
}
