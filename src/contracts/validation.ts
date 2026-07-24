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

export const ValidationDiagnosticCountsSchema = z.object({
  bySeverity: z.object({
    error: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    info: z.number().int().nonnegative()
  }).strict(),
  byCode: z.record(
    z.string().min(1),
    z.number().int().nonnegative()
  )
}).strict();
export type ValidationDiagnosticCounts = z.infer<
  typeof ValidationDiagnosticCountsSchema
>;

export const ValidationSummaryPhaseSchema = z.object({
  name: ValidationPhaseNameSchema,
  valid: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  diagnosticCount: z.number().int().nonnegative(),
  counts: ValidationDiagnosticCountsSchema,
  metrics: z.record(
    z.string().min(1),
    z.number().finite().nonnegative()
  ).optional()
}).strict();
export type ValidationSummaryPhase = z.infer<
  typeof ValidationSummaryPhaseSchema
>;

const validationDataBase = {
  mode: z.enum(["quick", "roundtrip", "publish", "full"]),
  valid: z.boolean(),
  diagnostics: z.array(DiagnosticSchema)
} as const;

export const ValidationFullDataSchema = z.object({
  ...validationDataBase,
  detail: z.literal("full"),
  checked: z.object({
    packageCount: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    packageIds: z.array(z.string().min(1)),
    componentIds: z.array(z.string().min(1))
  }).strict(),
  phases: z.array(ValidationPhaseSchema).min(1)
}).strict();
export type ValidationFullData = z.infer<typeof ValidationFullDataSchema>;

export const ValidationSummaryDataSchema = z.object({
  ...validationDataBase,
  detail: z.literal("summary"),
  checked: z.object({
    packageCount: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative()
  }).strict(),
  diagnosticCount: z.number().int().nonnegative(),
  counts: ValidationDiagnosticCountsSchema,
  phases: z.array(ValidationSummaryPhaseSchema).min(1),
  diagnosticsTruncated: z.boolean()
}).strict();
export type ValidationSummaryData = z.infer<
  typeof ValidationSummaryDataSchema
>;

export const ValidationDataSchema = z.discriminatedUnion("detail", [
  ValidationSummaryDataSchema,
  ValidationFullDataSchema
]);
export type ValidationData = z.infer<typeof ValidationDataSchema>;
