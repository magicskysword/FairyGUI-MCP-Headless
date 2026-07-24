import { z } from "zod";
import { DiagnosticSchema } from "./result.js";

export const RenderBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
}).strict();
export type RenderBounds = z.infer<typeof RenderBoundsSchema>;

export const RenderImageSchema = z.object({
  mediaType: z.literal("image/png"),
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  filePath: z.string().min(1).optional()
}).strict();
export type RenderImage = z.infer<typeof RenderImageSchema>;

export const RenderComponentDataSchema = z.object({
  backend: z.literal("fairygui-dom"),
  fidelity: z.literal("runtime-preview"),
  rendererVersion: z.string().min(1),
  packageId: z.string().min(1),
  componentId: z.string().min(1),
  bounds: RenderBoundsSchema,
  diagnostics: z.array(DiagnosticSchema),
  image: RenderImageSchema
}).strict();
export type RenderComponentData = z.infer<typeof RenderComponentDataSchema>;
