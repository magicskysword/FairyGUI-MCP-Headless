import { z } from "zod";

const OutputPathSourceSchema = z.enum(["project-settings", "package-settings", "override"]);

export const PublishDataSchema = z.object({
  projectId: z.string().min(1),
  publishType: z.enum(["full", "definitions"]),
  outputPath: z.string().min(1).describe("第一个所选包的输出目录；逐包目录见 packageOutputs"),
  outputPathSource: OutputPathSourceSchema,
  packageOutputs: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    outputPath: z.string().min(1),
    outputPathSource: OutputPathSourceSchema
  }).strict()).min(1),
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
