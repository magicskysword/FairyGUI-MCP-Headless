import {
  lstat,
  readFile,
  realpath
} from "node:fs/promises";
import path from "node:path";
import {
  fail,
  ok,
  type ResultEnvelope
} from "../contracts/result.js";

const INBOX_SEGMENTS = [".fairygui-mcp", "import-inbox"] as const;

export interface ImportInboxFile {
  fileName: string;
  sourceRelativePath: string;
  content: Uint8Array;
}

function invalidInboxPath(inboxPath: string, argumentPath: string) {
  return fail("IMPORT_PATH_INVALID", "导入路径必须是收件箱内的规范相对路径", {
    path: argumentPath,
    actual: inboxPath,
    suggestedFix: "使用类似 icons/sword.png 的正斜杠相对路径"
  });
}

function isCanonicalInboxPath(inboxPath: string): boolean {
  if (
    inboxPath.length === 0
    || inboxPath.includes("\\")
    || path.posix.isAbsolute(inboxPath)
    || path.win32.isAbsolute(inboxPath)
    || path.posix.normalize(inboxPath) !== inboxPath
  ) {
    return false;
  }
  const segments = inboxPath.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

export async function readImportInboxFile(
  projectDirectory: string,
  inboxPath: string,
  argumentPath: string
): Promise<ResultEnvelope<ImportInboxFile>> {
  if (!isCanonicalInboxPath(inboxPath)) {
    return invalidInboxPath(inboxPath, argumentPath);
  }

  const projectRoot = path.resolve(projectDirectory);
  const userSegments = inboxPath.split("/");
  const allSegments = [...INBOX_SEGMENTS, ...userSegments];
  let current = projectRoot;
  try {
    for (let index = 0; index < allSegments.length; index++) {
      current = path.join(current, allSegments[index]!);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        return fail(
          "IMPORT_SYMLINK_REJECTED",
          "导入路径任一层级都不能是符号链接",
          {
            path: argumentPath,
            actual: inboxPath,
            suggestedFix: "把普通文件直接复制到工程导入收件箱"
          }
        );
      }
      const isLast = index === allSegments.length - 1;
      if (isLast ? !entry.isFile() : !entry.isDirectory()) {
        return fail(
          "IMPORT_NOT_REGULAR_FILE",
          isLast ? "导入目标不是普通文件" : "导入路径父级不是普通目录",
          {
            path: argumentPath,
            actual: inboxPath
          }
        );
      }
    }

    const inboxRoot = await realpath(path.join(projectRoot, ...INBOX_SEGMENTS));
    const canonicalTarget = await realpath(current);
    const relative = path.relative(inboxRoot, canonicalTarget);
    if (
      relative === ""
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      return invalidInboxPath(inboxPath, argumentPath);
    }
    return ok({
      fileName: path.basename(canonicalTarget),
      sourceRelativePath: [
        ...INBOX_SEGMENTS,
        ...userSegments
      ].join("/"),
      content: await readFile(canonicalTarget)
    });
  }
  catch (error) {
    return fail(
      "IMPORT_NOT_REGULAR_FILE",
      isMissing(error)
        ? "导入收件箱文件不存在"
        : "无法读取导入收件箱普通文件",
      {
        path: argumentPath,
        actual: isMissing(error)
          ? inboxPath
          : {
              inboxPath,
              error: error instanceof Error ? error.message : String(error)
            },
        suggestedFix: "确认文件仍位于 .fairygui-mcp/import-inbox/ 内"
      }
    );
  }
}
