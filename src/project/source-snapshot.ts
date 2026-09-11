import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DocumentEditError, type FileSystem } from "@magicskysword/openfairygui-core";
import { captureProjectSnapshot, type ProjectSnapshot } from "@magicskysword/openfairygui-functions";

export function projectSourceFileSystem(projectDirectory: string): FileSystem & { assertSafe(): void } {
  const root = path.resolve(projectDirectory);
  let violation: Error | undefined;
  const guard = async (file: string) => {
    const resolved = path.resolve(file);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      violation = new DocumentEditError("INVALID_SOURCE_PATH", "来源路径越过工程目录", file);
      throw violation;
    }
    let current = root;
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          violation = new DocumentEditError("SOURCE_SYMLINK_REJECTED", "来源路径包含符号链接", current);
          throw violation;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return resolved;
  };
  const readonly = async (): Promise<never> => { throw new Error("工程来源是只读的"); };
  return {
    readFile: async (file) => readFile(await guard(file), "utf8"),
    readFileRaw: async (file) => new Uint8Array(await readFile(await guard(file))),
    readdir: async (directory) => {
      const resolved = await guard(directory);
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries) if (entry.isSymbolicLink()) await guard(path.join(resolved, entry.name));
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    },
    exists: async (file) => {
      const resolved = await guard(file);
      try { await lstat(resolved); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    },
    join: (...parts) => path.resolve(...parts),
    dirname: path.dirname,
    writeFile: readonly,
    writeFileRaw: readonly,
    mkdir: readonly,
    assertSafe() { if (violation) throw violation; }
  };
}

export async function snapshotProject(projectFile: string): Promise<ProjectSnapshot> {
  const fs = projectSourceFileSystem(path.dirname(projectFile));
  const result = await captureProjectSnapshot(fs, projectFile);
  // Readers may retain diagnostics for individual missing resources; path violations remain fatal.
  fs.assertSafe();
  return result;
}
