import { z } from "zod";
import { DiagnosticSchema } from "./result.js";

export const ValidationPhaseNameSchema = z.enum([
  "quick",
  "roundtrip",
  "publish"
]);
export type ValidationPhaseName = z.infer<typeof ValidationPhaseNameSchema>;

export const ValidationPhaseSchema = z.object({
  name: ValidationPhaseNameSchema,
  valid: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  metrics: z.record(
    z.string().min(1),
    z.number().finite().nonnegative()
  ).optional()
}).strict();
export type ValidationPhase = z.infer<typeof ValidationPhaseSchema>;

export const ValidationDataSchema = z.object({
  mode: z.enum(["quick", "roundtrip", "publish", "full"]),
  valid: z.boolean(),
  checked: z.object({
    packageCount: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    packageIds: z.array(z.string().min(1)),
    componentIds: z.array(z.string().min(1))
  }).strict(),
  phases: z.array(ValidationPhaseSchema).min(1),
  diagnostics: z.array(DiagnosticSchema)
}).strict();
export type ValidationData = z.infer<typeof ValidationDataSchema>;
