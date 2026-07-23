import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import path from "node:path";
import {
  NodeIO,
  type Document
} from "@magicskysword/openfairygui-core";
import {
  watch,
  type FSWatcher
} from "chokidar";
import {
  fail,
  ok,
  type ErrorCode,
  type ResultEnvelope
} from "../contracts/result.js";

const WATCH_DEBOUNCE_MS = 300;
const WATCH_MAX_WAIT_MS = 2_000;
const TEXT_SOURCE_EXTENSIONS = new Set([
  ".fairy",
  ".xml",
  ".json"
]);

export interface ProjectRecovery {
  recover(projectDirectory: string): Promise<void>;
}

export interface ProjectSummary {
  projectId: string;
  projectFile: string;
  projectDirectory: string;
  state: "open";
  openedAt: string;
  loadedAt: string;
  generation: number;
  packageCount: number;
  watching: boolean;
  dirty: boolean;
  reused: boolean;
  lastReloadError?: {
    message: string;
    at: string;
  };
}

export interface ProjectListData {
  projects: ProjectSummary[];
}

class ProjectPathError extends Error {
  public readonly code: ErrorCode;
  public readonly pathValue: string;
  public readonly suggestedFix?: string;

  public constructor(
    code: ErrorCode,
    message: string,
    pathValue: string,
    suggestedFix?: string
  ) {
    super(message);
    this.name = "ProjectPathError";
    this.code = code;
    this.pathValue = pathValue;
    if (suggestedFix !== undefined) this.suggestedFix = suggestedFix;
  }
}

class ProjectReloadError extends Error {
  public readonly projectFile: string;

  public constructor(projectFile: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`重新解析 FairyGUI 工程失败：${causeMessage}`, { cause });
    this.name = "ProjectReloadError";
    this.projectFile = projectFile;
  }
}

async function resolveProjectFile(inputPath: string): Promise<{
  projectFile: string;
  projectDirectory: string;
}> {
  const absolutePath = path.resolve(inputPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  }
  catch {
    throw new ProjectPathError(
      "PROJECT_NOT_FOUND",
      "工程路径不存在或无法访问",
      absolutePath,
      "传入 FairyGUI 工程目录或其中的 .fairy 文件"
    );
  }

  const entry = await stat(canonicalPath);
  if (entry.isFile()) {
    if (path.extname(canonicalPath).toLowerCase() !== ".fairy") {
      throw new ProjectPathError(
        "NOT_FAIRYGUI_PROJECT",
        "指定文件不是 .fairy 工程描述文件",
        canonicalPath,
        "传入 FairyGUI 工程目录或 .fairy 文件"
      );
    }
    return {
      projectFile: canonicalPath,
      projectDirectory: path.dirname(canonicalPath)
    };
  }

  if (!entry.isDirectory()) {
    throw new ProjectPathError(
      "INVALID_PROJECT_PATH",
      "工程路径必须是目录或普通 .fairy 文件",
      canonicalPath
    );
  }

  const children = await readdir(canonicalPath, { withFileTypes: true });
  const projectFiles = children
    .filter((child) =>
      child.isFile() && path.extname(child.name).toLowerCase() === ".fairy"
    )
    .map((child) => path.join(canonicalPath, child.name))
    .sort((a, b) => a.localeCompare(b));
  if (projectFiles.length !== 1) {
    throw new ProjectPathError(
      "NOT_FAIRYGUI_PROJECT",
      projectFiles.length === 0
        ? "目录中没有 .fairy 工程描述文件"
        : "目录中存在多个 .fairy 工程描述文件，无法确定目标",
      canonicalPath,
      projectFiles.length === 0
        ? "确认目录层级，或直接传入 .fairy 文件"
        : "直接传入目标 .fairy 文件"
    );
  }

  return {
    projectFile: await realpath(projectFiles[0]!),
    projectDirectory: canonicalPath
  };
}

function logicalRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function collectFiles(directory: string): Promise<string[]> {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  }
  catch {
    return [];
  }

  const files: string[] = [];
  for (const child of children) {
    if (child.name === ".fairygui-mcp") continue;
    const childPath = path.join(directory, child.name);
    if (child.isDirectory()) {
      files.push(...await collectFiles(childPath));
    }
    else if (child.isFile()) {
      files.push(childPath);
    }
  }
  return files;
}

async function calculateProjectFingerprint(
  projectFile: string,
  projectDirectory: string
): Promise<string> {
  const files = [
    projectFile,
    ...await collectFiles(path.join(projectDirectory, "assets")),
    ...await collectFiles(path.join(projectDirectory, "settings"))
  ];
  const uniqueFiles = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");

  for (const filePath of uniqueFiles) {
    let fileStat;
    try {
      fileStat = await lstat(filePath, { bigint: true });
    }
    catch {
      hash.update(`missing:${logicalRelativePath(projectDirectory, filePath)}\0`);
      continue;
    }
    if (!fileStat.isFile()) continue;
    hash.update(logicalRelativePath(projectDirectory, filePath));
    hash.update("\0");
    hash.update(String(fileStat.size));
    hash.update("\0");
    hash.update(String(fileStat.mtimeNs));
    hash.update("\0");
    if (TEXT_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      hash.update(await readFile(filePath));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function projectIdFor(projectFile: string): string {
  return `p_${createHash("sha256").update(projectFile).digest("hex").slice(0, 16)}`;
}

function assertCompleteProjectDocument(document: Document): void {
  for (const pkg of document.getRoot().listPackages()) {
    for (const component of pkg.listComponents()) {
      if (typeof component.getExtras()._sourceComponentXml !== "string") {
        throw new Error(
          `组件 ${pkg.getId()}/${component.getId()} 未能完整解析`
        );
      }
    }
  }
}

class ProjectSession {
  public readonly projectId: string;
  public readonly projectFile: string;
  public readonly projectDirectory: string;
  private readonly openedAt = new Date().toISOString();
  private readonly io = new NodeIO();
  private document: Document;
  private fingerprint: string;
  private loadedAt: string;
  private generation = 1;
  private watcher: FSWatcher | undefined;
  private closed = false;
  private dirty = false;
  private dirtySince: number | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private reloadTail: Promise<void> = Promise.resolve();
  private lastReloadError: { message: string; at: string } | undefined;

  private constructor(
    projectFile: string,
    projectDirectory: string,
    document: Document,
    fingerprint: string
  ) {
    this.projectId = projectIdFor(projectFile);
    this.projectFile = projectFile;
    this.projectDirectory = projectDirectory;
    this.document = document;
    this.fingerprint = fingerprint;
    this.loadedAt = new Date().toISOString();
  }

  public static async create(
    projectFile: string,
    projectDirectory: string
  ): Promise<ProjectSession> {
    const io = new NodeIO();
    const document = await io.readProject(projectFile);
    assertCompleteProjectDocument(document);
    const fingerprint = await calculateProjectFingerprint(
      projectFile,
      projectDirectory
    );
    const session = new ProjectSession(
      projectFile,
      projectDirectory,
      document,
      fingerprint
    );
    session.startWatcher();
    return session;
  }

  public summary(reused: boolean): ProjectSummary {
    const base: ProjectSummary = {
      projectId: this.projectId,
      projectFile: this.projectFile,
      projectDirectory: this.projectDirectory,
      state: "open",
      openedAt: this.openedAt,
      loadedAt: this.loadedAt,
      generation: this.generation,
      packageCount: this.document.getRoot().listPackages().length,
      watching: this.watcher !== undefined && !this.closed,
      dirty: this.dirty,
      reused
    };
    if (this.lastReloadError !== undefined) {
      base.lastReloadError = { ...this.lastReloadError };
    }
    return base;
  }

  public async read<T>(
    reader: (document: Document) => T | Promise<T>
  ): Promise<T> {
    await this.ensureFresh();
    return reader(this.document);
  }

  public async ensureFresh(): Promise<void> {
    if (this.closed) throw new Error("Project session is closed");
    const currentFingerprint = await calculateProjectFingerprint(
      this.projectFile,
      this.projectDirectory
    );
    if (!this.dirty && currentFingerprint === this.fingerprint) {
      await this.reloadTail;
      return;
    }
    this.clearReloadTimer();
    await this.enqueueReload();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearReloadTimer();
    await this.reloadTail;
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = undefined;
      await watcher.close();
    }
  }

  private startWatcher(): void {
    this.watcher = watch(this.projectDirectory, {
      ignoreInitial: true,
      persistent: true,
      ignored: (watchedPath) => {
        const relative = path.relative(this.projectDirectory, watchedPath);
        return relative === ".fairygui-mcp"
          || relative.startsWith(`.fairygui-mcp${path.sep}`);
      }
    });
    this.watcher.on("all", () => this.markDirty());
    this.watcher.on("error", (error) => {
      this.lastReloadError = {
        message: `文件监听失败：${
          error instanceof Error ? error.message : String(error)
        }`,
        at: new Date().toISOString()
      };
    });
  }

  private markDirty(): void {
    if (this.closed) return;
    this.dirty = true;
    const now = Date.now();
    if (this.dirtySince === undefined) this.dirtySince = now;
    this.clearReloadTimer();
    const elapsed = now - this.dirtySince;
    const delay = Math.max(
      0,
      Math.min(WATCH_DEBOUNCE_MS, WATCH_MAX_WAIT_MS - elapsed)
    );
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.enqueueReload().catch(() => {
        // The error is retained in lastReloadError and surfaced by ensureFresh.
      });
    }, delay);
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
  }

  private enqueueReload(): Promise<void> {
    const reload = this.reloadTail.then(() => this.reloadIfChanged());
    this.reloadTail = reload.catch(() => undefined);
    return reload;
  }

  private async reloadIfChanged(): Promise<void> {
    if (this.closed) return;
    const currentFingerprint = await calculateProjectFingerprint(
      this.projectFile,
      this.projectDirectory
    );
    if (currentFingerprint === this.fingerprint) {
      this.dirty = false;
      this.dirtySince = undefined;
      return;
    }

    try {
      let nextDocument: Document | undefined;
      let stableFingerprint = currentFingerprint;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await calculateProjectFingerprint(
          this.projectFile,
          this.projectDirectory
        );
        const candidate = await this.io.readProject(this.projectFile);
        assertCompleteProjectDocument(candidate);
        const after = await calculateProjectFingerprint(
          this.projectFile,
          this.projectDirectory
        );
        if (before === after) {
          nextDocument = candidate;
          stableFingerprint = after;
          break;
        }
      }
      if (!nextDocument) {
        throw new Error("工程在解析期间持续变化，未取得稳定快照");
      }

      this.document = nextDocument;
      this.fingerprint = stableFingerprint;
      this.loadedAt = new Date().toISOString();
      this.generation++;
      this.dirty = false;
      this.dirtySince = undefined;
      this.lastReloadError = undefined;
    }
    catch (error) {
      const reloadError = new ProjectReloadError(this.projectFile, error);
      this.lastReloadError = {
        message: reloadError.message,
        at: new Date().toISOString()
      };
      this.dirty = true;
      throw reloadError;
    }
  }
}

export class ProjectRegistry {
  private readonly sessionsById = new Map<string, ProjectSession>();
  private readonly sessionsByFile = new Map<string, ProjectSession>();
  private readonly openingByFile = new Map<
    string,
    Promise<ResultEnvelope<ProjectSummary>>
  >();
  private readonly recovery: ProjectRecovery | undefined;

  public constructor(options: { recovery?: ProjectRecovery } = {}) {
    this.recovery = options.recovery;
  }

  public async open(inputPath: string): Promise<ResultEnvelope<ProjectSummary>> {
    let resolved: Awaited<ReturnType<typeof resolveProjectFile>>;
    try {
      resolved = await resolveProjectFile(inputPath);
    }
    catch (error) {
      return this.pathFailure(error, inputPath);
    }

    const existing = this.sessionsByFile.get(resolved.projectFile);
    if (existing) return ok(existing.summary(true));

    const opening = this.openingByFile.get(resolved.projectFile);
    if (opening) {
      const result = await opening;
      return result.ok ? ok({ ...result.data, reused: true }) : result;
    }

    const operation = this.openResolved(resolved);
    this.openingByFile.set(resolved.projectFile, operation);
    try {
      return await operation;
    }
    finally {
      this.openingByFile.delete(resolved.projectFile);
    }
  }

  public list(): ResultEnvelope<ProjectListData> {
    return ok({
      projects: [...this.sessionsById.values()]
        .map((session) => session.summary(false))
        .sort((a, b) => a.projectFile.localeCompare(b.projectFile))
    });
  }

  public status(projectId: string): ResultEnvelope<ProjectSummary> {
    const session = this.sessionsById.get(projectId);
    if (!session) return this.sessionNotFound(projectId);
    return ok(session.summary(false));
  }

  public async close(projectId: string): Promise<ResultEnvelope<{
    projectId: string;
    closed: true;
  }>> {
    const session = this.sessionsById.get(projectId);
    if (!session) return this.sessionNotFound(projectId);
    this.sessionsById.delete(projectId);
    this.sessionsByFile.delete(session.projectFile);
    await session.close();
    return ok({ projectId, closed: true });
  }

  public async closeAll(): Promise<void> {
    const sessions = [...this.sessionsById.values()];
    this.sessionsById.clear();
    this.sessionsByFile.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  public async read<T>(
    projectId: string,
    reader: (document: Document) => T | Promise<T>
  ): Promise<ResultEnvelope<Awaited<T>>> {
    const session = this.sessionsById.get(projectId);
    if (!session) return this.sessionNotFound(projectId);
    try {
      const data = await session.read(reader);
      return ok(data as Awaited<T>);
    }
    catch (error) {
      if (error instanceof ProjectReloadError) {
        return fail("PROJECT_RELOAD_FAILED", error.message, {
          path: error.projectFile,
          actual: error.cause instanceof Error
            ? error.cause.message
            : String(error.cause),
          suggestedFix: "修复外部修改后的工程文件，再重试当前调用"
        });
      }
      return fail("INTERNAL_ERROR", "读取工程快照失败", {
        actual: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async openResolved(resolved: {
    projectFile: string;
    projectDirectory: string;
  }): Promise<ResultEnvelope<ProjectSummary>> {
    try {
      await this.recovery?.recover(resolved.projectDirectory);
      const session = await ProjectSession.create(
        resolved.projectFile,
        resolved.projectDirectory
      );
      this.sessionsById.set(session.projectId, session);
      this.sessionsByFile.set(session.projectFile, session);
      return ok(session.summary(false));
    }
    catch (error) {
      return fail("NOT_FAIRYGUI_PROJECT", "无法解析 FairyGUI 工程", {
        path: resolved.projectFile,
        actual: error instanceof Error ? error.message : String(error),
        suggestedFix: "使用 FairyGUI Editor 检查工程 XML 是否完整有效"
      });
    }
  }

  private pathFailure(
    error: unknown,
    inputPath: string
  ): ResultEnvelope<never> {
    if (error instanceof ProjectPathError) {
      return fail(error.code, error.message, {
        path: error.pathValue,
        ...(error.suggestedFix === undefined
          ? {}
          : { suggestedFix: error.suggestedFix })
      });
    }
    return fail("INVALID_PROJECT_PATH", "无法解析工程路径", {
      path: inputPath,
      actual: error instanceof Error ? error.message : String(error)
    });
  }

  private sessionNotFound(projectId: string): ResultEnvelope<never> {
    return fail("SESSION_NOT_FOUND", `工程会话不存在：${projectId}`, {
      path: "projectId",
      actual: projectId,
      suggestedFix: "调用 fairygui.project list 或重新 open 工程"
    });
  }
}
