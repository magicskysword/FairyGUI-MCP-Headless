import { z } from "zod";

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_PROJECT_PATH",
  "PROJECT_NOT_FOUND",
  "NOT_FAIRYGUI_PROJECT",
  "PROJECT_RELOAD_FAILED",
  "SESSION_NOT_FOUND",
  "PACKAGE_NOT_FOUND",
  "RESOURCE_NOT_FOUND",
  "COMPONENT_NOT_FOUND",
  "QUERY_NOT_SUPPORTED",
  "PARTIAL_QUERY_FAILURE",
  "INVALID_SELECTOR",
  "SELECTOR_MATCH_COUNT",
  "INSTANCE_BOUNDARY",
  "CAPABILITY_NOT_IMPLEMENTED",
  "READ_ONLY_CAPABILITY",
  "INVALID_DOM",
  "INVALID_PATCH",
  "OPAQUE_CONTENT_CONFLICT",
  "SERIALIZATION_FAILED",
  "WRITE_FAILED",
  "TRANSACTION_FAILED",
  "TRANSACTION_RECOVERY_FAILED",
  "IMPORT_PATH_INVALID",
  "IMPORT_NOT_REGULAR_FILE",
  "IMPORT_SYMLINK_REJECTED",
  "RESOURCE_CONFLICT",
  "RESOURCE_IN_USE",
  "CROSS_PACKAGE_MOVE_UNSUPPORTED",
  "BROWSER_NOT_INSTALLED",
  "RENDER_FAILED",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR"
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DiagnosticSchema = z.object({
  severity: DiagnosticSeveritySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const ErrorDetailSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  path: z.string().min(1).optional(),
  actual: z.unknown().optional(),
  allowed: z.unknown().optional(),
  suggestedFix: z.string().min(1).optional(),
  transactionId: z.string().min(1).optional(),
  logPath: z.string().min(1).optional()
}).strict();
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: ErrorDetailSchema
}).strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  warnings?: Diagnostic[];
}

export type ResultEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function resultSchema<T extends z.ZodType>(
  dataSchema: T
): z.ZodType<ResultEnvelope<z.infer<T>>> {
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: dataSchema,
      warnings: z.array(DiagnosticSchema).min(1).optional()
    }).strict(),
    ErrorEnvelopeSchema
  ]) as z.ZodType<ResultEnvelope<z.infer<T>>>;
}

export function ok<T>(data: T, warnings?: Diagnostic[]): SuccessEnvelope<T> {
  if (warnings && warnings.length > 0) {
    return { ok: true, data, warnings };
  }
  return { ok: true, data };
}

export type ErrorOptions = Omit<ErrorDetail, "code" | "message">;

export function fail(
  code: ErrorCode,
  message: string,
  options: ErrorOptions = {}
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      ...options
    }
  };
}

export function isFailure<T>(result: ResultEnvelope<T>): result is ErrorEnvelope {
  return !result.ok;
}
