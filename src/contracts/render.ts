import { z } from "zod";
import {
  DiagnosticSchema,
  resultSchema,
  type ResultEnvelope
} from "./result.js";

export const RenderBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
}).strict();
export type RenderBounds = z.infer<typeof RenderBoundsSchema>;

export const RenderImageSchema = z.object({
  mediaType: z.literal("image/png"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  filePath: z.string().min(1).optional(),
  contentIndex: z.number().int().nonnegative().optional()
}).strict();
export type RenderImage = z.infer<typeof RenderImageSchema>;

export interface RenderTransportImage extends RenderImage {
  data?: string;
}

export const RenderStateTargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().min(1)
}).strict();

export const RenderControllerPageStateSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  name: z.string()
}).strict();

export const RenderSelectedControllerPageSchema = z.object({
  index: z.number().int(),
  id: z.string().nullable(),
  name: z.string().nullable()
}).strict();

export const RenderAvailableStateSchema = z.object({
  controllers: z.array(z.object({
    target: RenderStateTargetSchema,
    controllers: z.array(z.object({
      name: z.string(),
      selectedPage: RenderSelectedControllerPageSchema,
      pages: z.array(RenderControllerPageStateSchema)
    }).strict())
  }).strict()),
  lists: z.array(z.object({
    target: RenderStateTargetSchema,
    itemCount: z.number().int().nonnegative(),
    selectionMode: z.string(),
    selectedIndices: z.array(z.number().int().nonnegative())
  }).strict()),
  trees: z.array(z.object({
    target: RenderStateTargetSchema,
    nodeCount: z.number().int().nonnegative(),
    folderCount: z.number().int().nonnegative(),
    selectedPath: z.array(z.number().int().nonnegative()).nullable(),
    nodes: z.array(z.object({
      path: z.array(z.number().int().nonnegative()),
      text: z.string(),
      isFolder: z.boolean(),
      expanded: z.boolean()
    }).strict()).optional()
  }).strict()),
  scrolls: z.array(z.object({
    target: RenderStateTargetSchema,
    position: z.object({
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative()
    }).strict(),
    maxPosition: z.object({
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative()
    }).strict()
  }).strict())
}).strict();
export type RenderAvailableState = z.infer<typeof RenderAvailableStateSchema>;

export const RenderAppliedStateSchema = z.object({
  controllers: z.array(z.object({
    selector: z.string(),
    target: RenderStateTargetSchema,
    controller: z.string(),
    selectedPage: RenderSelectedControllerPageSchema
  }).strict()),
  lists: z.array(z.object({
    selector: z.string(),
    target: RenderStateTargetSchema,
    selectedIndices: z.array(z.number().int().nonnegative())
  }).strict()),
  trees: z.array(z.object({
    selector: z.string(),
    target: RenderStateTargetSchema,
    expansions: z.array(z.object({
      path: z.array(z.number().int().nonnegative()),
      expanded: z.boolean()
    }).strict()),
    selectedPath: z.array(z.number().int().nonnegative()).nullable().optional()
  }).strict()),
  scrolls: z.array(z.object({
    selector: z.string(),
    target: RenderStateTargetSchema,
    position: z.object({
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative()
    }).strict()
  }).strict())
}).strict();
export type RenderAppliedState = z.infer<typeof RenderAppliedStateSchema>;

export const RenderGearHiddenSchema = z.object({
  count: z.number().int().nonnegative(),
  nodes: z.array(RenderStateTargetSchema),
  truncated: z.boolean()
}).strict();
export type RenderGearHidden = z.infer<typeof RenderGearHiddenSchema>;

export const RenderComponentDataSchema = z.object({
  backend: z.literal("fairygui-dom"),
  fidelity: z.literal("runtime-preview"),
  rendererVersion: z.string().min(1),
  packageId: z.string().min(1),
  componentId: z.string().min(1),
  bounds: RenderBoundsSchema,
  diagnostics: z.array(DiagnosticSchema),
  availableState: RenderAvailableStateSchema,
  appliedState: RenderAppliedStateSchema,
  gearHidden: RenderGearHiddenSchema,
  image: RenderImageSchema
}).strict();
export type RenderComponentData = z.infer<typeof RenderComponentDataSchema>;

export interface RenderComponentTransportData extends Omit<
  RenderComponentData,
  "image"
> {
  image: RenderTransportImage;
}

export const RenderBatchDataSchema = z.object({
  backend: z.literal("fairygui-dom"),
  fidelity: z.literal("runtime-preview"),
  rendererVersion: z.string().min(1),
  requested: z.number().int().min(1).max(20),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.record(z.string(), resultSchema(RenderComponentDataSchema))
}).strict();
export type RenderBatchData = z.infer<typeof RenderBatchDataSchema>;

export interface RenderBatchTransportData extends Omit<
  RenderBatchData,
  "results"
> {
  results: Record<string, ResultEnvelope<RenderComponentTransportData>>;
}
