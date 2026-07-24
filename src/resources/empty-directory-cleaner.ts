import {
  lstat,
  readdir,
  rmdir
} from "node:fs/promises";
import path from "node:path";
import type { Diagnostic } from "../contracts/result.js";

export interface EmptyDirectoryCleanupResult {
  directories: string[];
  warnings: Diagnostic[];
}

export interface EmptyDirectoryCleaner {
  preview(
    projectDirectory: string,
    removedFiles: readonly string[],
    writtenFiles: readonly string[]
  ): Promise<EmptyDirectoryCleanupResult>;
  cleanup(
    projectDirectory: string,
    removedFiles: readonly string[]
  ): Promise<EmptyDirectoryCleanupResult>;
}

export interface SafeEmptyDirectoryCleanerOptions {
  removeDirectory?: (directory: string) => Promise<void>;
}

type SafeDirectoryState = "directory" | "missing" | "unsafe";

interface SafeDirectoryInspection {
  state: SafeDirectoryState;
  unsafePath?: string;
  reason?: string;
}

function isFileSystemError(
  error: unknown,
  ...codes: string[]
): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && codes.includes(error.code);
}

function candidateDirectories(files: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    if (
      path.posix.isAbsolute(file)
      || path.posix.normalize(file) !== file
    ) {
      continue;
    }
    const segments = file.split("/");
    if (segments[0] !== "assets" || segments.length < 3) continue;
    for (let length = segments.length - 1; length > 1; length--) {
      candidates.add(segments.slice(0, length).join("/"));
    }
  }
  return [...candidates].sort((left, right) =>
    right.split("/").length - left.split("/").length
    || left.localeCompare(right)
  );
}

function absoluteDirectory(
  projectDirectory: string,
  relativePath: string
): string {
  return path.join(projectDirectory, ...relativePath.split("/"));
}

async function inspectDirectory(
  projectDirectory: string,
  relativePath: string
): Promise<SafeDirectoryInspection> {
  const segments = relativePath.split("/");
  let current = projectDirectory;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let entry;
    try {
      entry = await lstat(current);
    }
    catch (error) {
      if (isFileSystemError(error, "ENOENT")) return { state: "missing" };
      throw error;
    }
    const inspectedPath = segments.slice(0, index + 1).join("/");
    if (entry.isSymbolicLink()) {
      return {
        state: "unsafe",
        unsafePath: inspectedPath,
        reason: "目录路径包含符号链接"
      };
    }
    if (!entry.isDirectory()) {
      return {
        state: "unsafe",
        unsafePath: inspectedPath,
        reason: "目录路径包含非目录项"
      };
    }
  }
  return { state: "directory" };
}

function warningForUnsafe(
  relativePath: string,
  inspection: SafeDirectoryInspection
): Diagnostic {
  return {
    severity: "warning",
    code: "EMPTY_DIRECTORY_CLEANUP_SKIPPED",
    message: "为避免越过工程资源边界，已跳过不安全的空目录清理",
    path: inspection.unsafePath ?? relativePath,
    details: {
      candidate: relativePath,
      reason: inspection.reason ?? "路径不安全"
    }
  };
}

function warningForFailure(
  relativePath: string,
  error: unknown
): Diagnostic {
  return {
    severity: "warning",
    code: "EMPTY_DIRECTORY_CLEANUP_FAILED",
    message: "资源事务已成功，但清理遗留空目录失败",
    path: relativePath,
    details: {
      error: error instanceof Error ? error.message : String(error)
    }
  };
}

export class SafeEmptyDirectoryCleaner implements EmptyDirectoryCleaner {
  readonly #removeDirectory: (directory: string) => Promise<void>;

  public constructor(options: SafeEmptyDirectoryCleanerOptions = {}) {
    this.#removeDirectory = options.removeDirectory ?? rmdir;
  }

  public async preview(
    projectDirectory: string,
    removedFiles: readonly string[],
    writtenFiles: readonly string[]
  ): Promise<EmptyDirectoryCleanupResult> {
    const directories = new Set<string>();
    const warnings: Diagnostic[] = [];
    const removed = new Set(removedFiles);
    for (const relativePath of candidateDirectories(removedFiles)) {
      let inspection: SafeDirectoryInspection;
      try {
        inspection = await inspectDirectory(projectDirectory, relativePath);
      }
      catch (error) {
        warnings.push(warningForFailure(relativePath, error));
        continue;
      }
      if (inspection.state === "missing") continue;
      if (inspection.state === "unsafe") {
        warnings.push(warningForUnsafe(relativePath, inspection));
        continue;
      }

      try {
        const hasSurvivingWrite = writtenFiles.some((file) =>
          file.startsWith(`${relativePath}/`) && !removed.has(file)
        );
        if (hasSurvivingWrite) continue;
        const entries = await readdir(
          absoluteDirectory(projectDirectory, relativePath),
          { withFileTypes: true }
        );
        const becomesEmpty = entries.every((entry) => {
          if (entry.isSymbolicLink()) return false;
          const child = `${relativePath}/${entry.name}`;
          return entry.isDirectory()
            ? directories.has(child)
            : removed.has(child);
        });
        if (becomesEmpty) directories.add(relativePath);
      }
      catch (error) {
        warnings.push(warningForFailure(relativePath, error));
      }
    }
    return {
      directories: [...directories].sort(),
      warnings
    };
  }

  public async cleanup(
    projectDirectory: string,
    removedFiles: readonly string[]
  ): Promise<EmptyDirectoryCleanupResult> {
    const directories: string[] = [];
    const warnings: Diagnostic[] = [];
    for (const relativePath of candidateDirectories(removedFiles)) {
      let inspection: SafeDirectoryInspection;
      try {
        inspection = await inspectDirectory(projectDirectory, relativePath);
      }
      catch (error) {
        warnings.push(warningForFailure(relativePath, error));
        continue;
      }
      if (inspection.state === "missing") continue;
      if (inspection.state === "unsafe") {
        warnings.push(warningForUnsafe(relativePath, inspection));
        continue;
      }

      const directory = absoluteDirectory(projectDirectory, relativePath);
      try {
        if ((await readdir(directory)).length > 0) continue;
        await this.#removeDirectory(directory);
        directories.push(relativePath);
      }
      catch (error) {
        if (isFileSystemError(error, "ENOENT", "ENOTEMPTY", "EEXIST")) {
          continue;
        }
        warnings.push(warningForFailure(relativePath, error));
      }
    }
    return {
      directories: directories.sort(),
      warnings
    };
  }
}
