import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  NodeIO,
  type Document
} from "@magicskysword/openfairygui-core";
import {
  publish,
  type PublishFileSystem,
  type RootProjectSettings
} from "@magicskysword/openfairygui-functions";
import sharp from "sharp";
import type { PublishData } from "../contracts/publish.js";
import {
  fail,
  ok,
  type ResultEnvelope
} from "../contracts/result.js";
import type { PublishInput } from "../contracts/tools.js";
import type { ProjectRegistry } from "../project/project-registry.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";

interface PublishSettingsWithPath {
  path?: string;
  fileName?: string;
}

interface PublishProjectSettings extends RootProjectSettings {
  publish?: RootProjectSettings["publish"] & PublishSettingsWithPath;
  customProperties?: Record<string, unknown>;
}

interface TrackedWrite {
  path: string;
  bytes: number;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function toRawBytes(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function createPublishFileSystem(
  writtenFiles: Map<string, TrackedWrite>
): PublishFileSystem {
  return {
    async readFileRaw(filePath: string): Promise<Uint8Array> {
      return toRawBytes(await readFile(filePath));
    },
    async writeFileRaw(
      filePath: string,
      data: Uint8Array
    ): Promise<void> {
      const absolutePath = path.resolve(filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, data);
      writtenFiles.set(absolutePath, {
        path: absolutePath,
        bytes: data.byteLength
      });
    },
    async mkdir(directory: string): Promise<void> {
      await mkdir(directory, { recursive: true });
    },
    async readdir(directory: string): Promise<string[]> {
      return readdir(directory);
    },
    async deleteFile(filePath: string): Promise<void> {
      const absolutePath = path.resolve(filePath);
      await rm(absolutePath, { force: true });
      writtenFiles.delete(absolutePath);
    },
    async exists(filePath: string): Promise<boolean> {
      try {
        await access(filePath);
        return true;
      }
      catch {
        return false;
      }
    },
    join(...segments: string[]): string {
      return path.join(...segments);
    }
  };
}

function replacePathVariables(
  configuredPath: string,
  settings: PublishProjectSettings,
  projectFile: string
): ResultEnvelope<string> {
  const variables = new Map<string, string>();
  variables.set(
    "publish_file_name",
    settings.publish?.fileName?.trim()
      || path.basename(projectFile, path.extname(projectFile))
  );
  for (const [name, value] of Object.entries(
    settings.customProperties ?? {}
  )) {
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      variables.set(name, String(value));
    }
  }

  const missingVariables = new Set<string>();
  const resolved = configuredPath.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      const value = variables.get(name);
      if (value === undefined) {
        missingVariables.add(name);
        return `{${name}}`;
      }
      return value;
    }
  );
  if (missingVariables.size > 0) {
    return fail("PUBLISH_PATH_INVALID", "发布路径包含无法解析的变量", {
      path: "settings/Publish.json:path",
      actual: [...missingVariables],
      suggestedFix: "在工程自定义属性中定义变量，或显式传入 outputPath"
    });
  }
  return ok(resolved);
}

function resolveAbsoluteOutputPath(
  rawPath: string,
  projectDirectory: string
): ResultEnvelope<string> {
  try {
    const normalized = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(
        projectDirectory,
        rawPath.replace(/[\\/]+/g, path.sep)
      );
    return ok(normalized);
  }
  catch (error) {
    return fail("PUBLISH_PATH_INVALID", "无法解析发布路径", {
      path: rawPath,
      actual: error instanceof Error ? error.message : String(error)
    });
  }
}

async function validateOutputDirectory(
  outputPath: string
): Promise<ResultEnvelope<true>> {
  try {
    const outputStat = await stat(outputPath);
    if (!outputStat.isDirectory()) {
      return fail("PUBLISH_PATH_INVALID", "发布路径已存在但不是目录", {
        path: outputPath,
        suggestedFix: "改用一个目录路径后重试"
      });
    }
    return ok(true);
  }
  catch (error) {
    if (isMissingFileError(error)) return ok(true);
    return fail("PUBLISH_PATH_INVALID", "无法访问发布路径", {
      path: outputPath,
      actual: error instanceof Error ? error.message : String(error)
    });
  }
}

export class PublishService {
  private readonly projects: ProjectRegistry;
  private readonly coordinator: ProjectCommitCoordinator;

  public constructor(
    projects: ProjectRegistry,
    options: { coordinator?: ProjectCommitCoordinator } = {}
  ) {
    this.projects = projects;
    this.coordinator = options.coordinator ?? new ProjectCommitCoordinator();
  }

  public async publish(
    input: PublishInput
  ): Promise<ResultEnvelope<PublishData>> {
    return this.coordinator.run(
      input.projectId,
      () => this.publishSerialized(input)
    );
  }

  private async publishSerialized(
    input: PublishInput
  ): Promise<ResultEnvelope<PublishData>> {
    const status = this.projects.status(input.projectId);
    if (!status.ok) return status;

    const fresh = await this.projects.read(input.projectId, () => true);
    if (!fresh.ok) return fresh;

    const startedAt = performance.now();
    try {
      const io = new NodeIO();
      const document = await io.readProject(status.data.projectFile);
      const allPackages = document.getRoot().listPackages();
      const packageIds = input.packageIds
        ? new Set(input.packageIds)
        : undefined;
      if (packageIds) {
        for (const packageId of packageIds) {
          if (!allPackages.some((pkg) => pkg.getId() === packageId)) {
            return fail("PACKAGE_NOT_FOUND", `包不存在：${packageId}`, {
              path: "packageIds",
              actual: packageId,
              suggestedFix: "先通过 fairygui.query 查询有效包 ID"
            });
          }
        }
      }
      const selectedPackages = packageIds
        ? allPackages.filter((pkg) => packageIds.has(pkg.getId()))
        : allPackages;

      const output = this.resolveOutputPath(
        document,
        status.data.projectFile,
        status.data.projectDirectory,
        input.outputPath
      );
      if (!output.ok) return output;
      const outputValidation = await validateOutputDirectory(output.data.path);
      if (!outputValidation.ok) return outputValidation;

      const writtenFiles = new Map<string, TrackedWrite>();
      await document.transform(publish({
        output: output.data.path,
        packages: selectedPackages.map((pkg) => pkg.getName()),
        mode: input.publishType,
        encoder: sharp,
        basePath: path.join(status.data.projectDirectory, "assets"),
        fs: createPublishFileSystem(writtenFiles)
      }));

      return ok({
        projectId: input.projectId,
        publishType: input.publishType,
        outputPath: output.data.path,
        outputPathSource: output.data.source,
        packages: selectedPackages.map((pkg) => ({
          id: pkg.getId(),
          name: pkg.getName()
        })),
        writtenFiles: [...writtenFiles.values()]
          .sort((left, right) => left.path.localeCompare(right.path)),
        durationMs: Math.max(
          0,
          Math.round((performance.now() - startedAt) * 100) / 100
        )
      });
    }
    catch (error) {
      return fail("PUBLISH_FAILED", "FairyGUI 工程发布失败", {
        actual: error instanceof Error ? error.message : String(error),
        suggestedFix: "检查工程资源与发布设置后重试"
      });
    }
  }

  private resolveOutputPath(
    document: Document,
    projectFile: string,
    projectDirectory: string,
    override: string | undefined
  ): ResultEnvelope<{
    path: string;
    source: "project-settings" | "override";
  }> {
    if (override !== undefined) {
      const resolved = resolveAbsoluteOutputPath(override, projectDirectory);
      return resolved.ok
        ? ok({ path: resolved.data, source: "override" })
        : resolved;
    }

    const settings = document.getRoot().getSettings() as PublishProjectSettings;
    const configuredPath = settings.publish?.path?.trim();
    if (!configuredPath) {
      return fail("PUBLISH_PATH_MISSING", "工程没有配置发布路径", {
        path: "settings/Publish.json:path",
        suggestedFix: "在 FairyGUI 中配置发布路径，或显式传入 outputPath"
      });
    }
    const expanded = replacePathVariables(
      configuredPath,
      settings,
      projectFile
    );
    if (!expanded.ok) return expanded;
    const resolved = resolveAbsoluteOutputPath(
      expanded.data,
      projectDirectory
    );
    return resolved.ok
      ? ok({ path: resolved.data, source: "project-settings" })
      : resolved;
  }
}
