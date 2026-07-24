import { z } from "zod";

export const PublishDataSchema = z.object({
  projectId: z.string().min(1),
  publishType: z.enum(["full", "definitions"]),
  outputPath: z.string().min(1),
  outputPathSource: z.enum(["project-settings", "override"]),
  packages: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }).strict()).min(1),
  writtenFiles: z.array(z.object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative()
  }).strict()),
  durationMs: z.number().finite().nonnegative()
}).strict();

export type PublishData = z.infer<typeof PublishDataSchema>;
