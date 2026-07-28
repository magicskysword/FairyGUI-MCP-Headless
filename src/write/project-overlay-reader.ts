import {
  access,
  readFile,
  readdir,
  stat
} from "node:fs/promises";
import path from "node:path";
import {
  ProjectReader,
  type Document,
  type FileSystem
} from "@magicskysword/openfairygui-core";

export interface ProjectOverlayFile {
  relativePath: string;
  content: string | Uint8Array;
}

export interface ProjectOverlay {
  files: readonly ProjectOverlayFile[];
  deletedPaths?: readonly string[];
}

function resolveProjectPath(
  projectDirectory: string,
  relativePath: string
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`覆盖层路径不能是绝对路径：${relativePath}`);
  }
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (
    segments.length === 0
    || segments.some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`覆盖层路径无效：${relativePath}`);
  }
  const resolved = path.resolve(projectDirectory, ...segments);
  const relative = path.relative(projectDirectory, resolved);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`覆盖层路径越过工程目录：${relativePath}`);
  }
  return resolved;
}

function pathKey(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function missingFileError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${filePath}'`
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = filePath;
  return error;
}

async function diskDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const directories = await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) return entry.name;
      if (!entry.isSymbolicLink()) return undefined;
      try {
        return (await stat(path.join(directory, entry.name))).isDirectory()
          ? entry.name
          : undefined;
      }
      catch {
        return undefined;
      }
    }));
    return directories.filter((entry): entry is string =>
      entry !== undefined
    );
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function overlayFileSystem(
  projectDirectory: string,
  overlay: ProjectOverlay
): FileSystem {
  const files = new Map<string, string | Uint8Array>();
  const deleted = new Set<string>();
  const directories = new Set<string>([pathKey(projectDirectory)]);

  for (const file of overlay.files) {
    const resolved = resolveProjectPath(
      projectDirectory,
      file.relativePath
    );
    files.set(pathKey(resolved), file.content);
    let directory = path.dirname(resolved);
    while (true) {
      directories.add(pathKey(directory));
      if (pathKey(directory) === pathKey(projectDirectory)) break;
      directory = path.dirname(directory);
    }
  }
  for (const relativePath of overlay.deletedPaths ?? []) {
    deleted.add(pathKey(resolveProjectPath(projectDirectory, relativePath)));
  }

  const contentFor = (filePath: string): string | Uint8Array | undefined =>
    files.get(pathKey(filePath));
  const isDeleted = (filePath: string): boolean =>
    deleted.has(pathKey(filePath));

  return {
    async readFile(filePath: string): Promise<string> {
      if (isDeleted(filePath)) throw missingFileError(filePath);
      const content = contentFor(filePath);
      if (typeof content === "string") return content;
      if (content !== undefined) return Buffer.from(content).toString("utf8");
      return readFile(filePath, "utf8");
    },
    async readFileRaw(filePath: string): Promise<Uint8Array> {
      if (isDeleted(filePath)) throw missingFileError(filePath);
      const content = contentFor(filePath);
      if (typeof content === "string") return new TextEncoder().encode(content);
      if (content !== undefined) return new Uint8Array(content);
      const data = await readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
    async writeFile(): Promise<void> {
      throw new Error("工程覆盖层是只读的");
    },
    async writeFileRaw(): Promise<void> {
      throw new Error("工程覆盖层是只读的");
    },
    async mkdir(): Promise<void> {
      throw new Error("工程覆盖层是只读的");
    },
    async readdir(directory: string): Promise<string[]> {
      const names = new Set(await diskDirectories(directory));
      const directoryKey = pathKey(directory);
      for (const candidate of directories) {
        if (candidate === directoryKey) continue;
        if (pathKey(path.dirname(candidate)) !== directoryKey) continue;
        names.add(path.basename(candidate));
      }
      return [...names].sort((left, right) => left.localeCompare(right));
    },
    async exists(filePath: string): Promise<boolean> {
      if (isDeleted(filePath)) return false;
      const key = pathKey(filePath);
      if (files.has(key) || directories.has(key)) return true;
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
    },
    dirname(filePath: string): string {
      return path.dirname(filePath);
    }
  };
}

export async function readProjectWithOverlay(
  projectFile: string,
  overlay: ProjectOverlay
): Promise<Document> {
  const projectDirectory = path.dirname(projectFile);
  const reader = new ProjectReader(
    overlayFileSystem(projectDirectory, overlay)
  );
  return reader.read(projectFile);
}
