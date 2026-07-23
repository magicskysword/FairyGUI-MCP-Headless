import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fail,
  ok,
  type ResultEnvelope
} from "../contracts/result.js";

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_FILE_NAME = "journal.json";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PROJECT_BYTES = 1024 * 1024 * 1024;
const TERMINAL_STATES = new Set<TransactionState>([
  "committed",
  "rolled-back"
]);

type TransactionState =
  | "preparing"
  | "prepared"
  | "committing"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "recovery-failed";

interface TransactionJournalFile {
  relativePath: string;
  existed: boolean;
  delete?: boolean;
  beforePath?: string;
  beforeHash?: string;
  stagedPath: string;
  stagedHash: string;
  adjacentTempPath: string;
  committed: boolean;
}

interface TransactionJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  projectDirectory: string;
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: string;
  files: TransactionJournalFile[];
}

type TransactionDiagnosticOutcome =
  | "pending"
  | "committed"
  | "rolled-back"
  | "interrupted";

interface TransactionDiagnosticEntry {
  severity: "error";
  code: string;
  message: string;
}

interface TransactionDiagnosticSummary {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  outcome: TransactionDiagnosticOutcome;
  updatedAt: string;
  diagnostics: TransactionDiagnosticEntry[];
}

export interface TransactionFileChange {
  relativePath: string;
  /** `null` atomically deletes an existing regular file. */
  content: string | Uint8Array | null;
}

export interface FileTransactionData {
  transactionId: string;
  logPath: string;
  affectedFiles: string[];
}

export type TransactionFaultPoint =
  | "after-prepare"
  | "before-replace"
  | "after-replace"
  | "before-complete";

export interface TransactionFaultContext {
  transactionId: string;
  projectDirectory: string;
  logPath: string;
  fileIndex?: number;
  relativePath?: string;
}

export interface FileTransactionManagerOptions {
  baseDirectory?: string;
  idFactory?: () => string;
  now?: () => Date;
  retentionMs?: number;
  maxProjectBytes?: number;
  faultInjector?: (
    point: TransactionFaultPoint,
    context: TransactionFaultContext
  ) => void | Promise<void>;
}

export class SimulatedTransactionCrash extends Error {
  public constructor(message = "Simulated transaction crash") {
    super(message);
    this.name = "SimulatedTransactionCrash";
  }
}

export class TransactionRecoveryError extends Error {
  public readonly code = "TRANSACTION_RECOVERY_FAILED" as const;
  public readonly transactionId?: string;
  public readonly logPath?: string;

  public constructor(
    message: string,
    options: {
      cause?: unknown;
      transactionId?: string;
      logPath?: string;
    } = {}
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "TransactionRecoveryError";
    if (options.transactionId !== undefined) {
      this.transactionId = options.transactionId;
    }
    if (options.logPath !== undefined) this.logPath = options.logPath;
  }
}

class TransactionInputError extends Error {
  public readonly pathValue?: string;

  public constructor(message: string, pathValue?: string) {
    super(message);
    this.name = "TransactionInputError";
    if (pathValue !== undefined) this.pathValue = pathValue;
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function transactionIdIsSafe(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function normalizeRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0
    || relativePath.includes("\\")
    || path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
  ) {
    throw new TransactionInputError(
      "事务目标必须是使用正斜杠的工程内相对路径",
      relativePath
    );
  }
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new TransactionInputError(
      "事务目标不能越过工程目录",
      relativePath
    );
  }
  return normalized;
}

function resolveProjectTarget(
  projectDirectory: string,
  relativePath: string
): string {
  const target = path.resolve(
    projectDirectory,
    ...relativePath.split("/")
  );
  const relative = path.relative(projectDirectory, target);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new TransactionInputError(
      "事务目标必须位于工程目录内",
      relativePath
    );
  }
  return target;
}

async function entryOrUndefined(filePath: string) {
  try {
    return await lstat(filePath);
  }
  catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function assertNoSymbolicLink(
  projectDirectory: string,
  targetPath: string
): Promise<void> {
  const relative = path.relative(projectDirectory, targetPath);
  const segments = relative.split(path.sep);
  let current = projectDirectory;
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await entryOrUndefined(current);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      throw new TransactionInputError(
        "事务目标路径不能包含符号链接",
        relative.split(path.sep).join("/")
      );
    }
  }
}

async function writeDurableFile(
  filePath: string,
  content: Uint8Array,
  exclusive = false
): Promise<void> {
  const handle = await open(filePath, exclusive ? "wx" : "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  }
  finally {
    await handle.close();
  }
}

async function writeJournal(
  logPath: string,
  journal: TransactionJournal
): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const target = path.join(logPath, JOURNAL_FILE_NAME);
  const temporary = path.join(
    logPath,
    `.journal-${randomUUID()}.tmp`
  );
  await writeDurableFile(
    temporary,
    Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"),
    true
  );
  await rename(temporary, target);
}

async function readDiagnosticEntries(
  logPath: string
): Promise<TransactionDiagnosticEntry[]> {
  try {
    const value = JSON.parse(await readFile(
      path.join(logPath, "diagnostics", "summary.json"),
      "utf8"
    )) as Partial<TransactionDiagnosticSummary>;
    return Array.isArray(value.diagnostics)
      ? value.diagnostics.filter((entry): entry is TransactionDiagnosticEntry =>
          typeof entry === "object"
          && entry !== null
          && entry.severity === "error"
          && typeof entry.code === "string"
          && typeof entry.message === "string"
        )
      : [];
  }
  catch {
    return [];
  }
}

async function writeDiagnosticSummary(
  logPath: string,
  journal: TransactionJournal,
  outcome: TransactionDiagnosticOutcome,
  now: Date,
  append: TransactionDiagnosticEntry[] = []
): Promise<void> {
  const directory = path.join(logPath, "diagnostics");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "summary.json");
  const temporary = path.join(
    directory,
    `.summary-${randomUUID()}.tmp`
  );
  const summary: TransactionDiagnosticSummary = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId: journal.transactionId,
    outcome,
    updatedAt: now.toISOString(),
    diagnostics: [
      ...await readDiagnosticEntries(logPath),
      ...append
    ]
  };
  await writeDurableFile(
    temporary,
    Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    true
  );
  await rename(temporary, target);
}

async function fileHash(filePath: string): Promise<string | undefined> {
  const entry = await entryOrUndefined(filePath);
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`事务目标不是普通文件：${filePath}`);
  }
  return hashBytes(await readFile(filePath));
}

async function collectJournalFiles(directory: string): Promise<string[]> {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  }
  catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const results: string[] = [];
  for (const child of children) {
    const childPath = path.join(directory, child.name);
    if (child.isDirectory()) {
      results.push(...await collectJournalFiles(childPath));
    }
    else if (child.isFile() && child.name === JOURNAL_FILE_NAME) {
      results.push(childPath);
    }
  }
  return results;
}

async function directoryByteSize(directory: string): Promise<number> {
  const children = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const child of children) {
    const childPath = path.join(directory, child.name);
    if (child.isDirectory()) {
      total += await directoryByteSize(childPath);
    }
    else {
      total += (await lstat(childPath)).size;
    }
  }
  return total;
}

function isStrictDescendant(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function parseJournal(raw: string, journalPath: string): TransactionJournal {
  const value = JSON.parse(raw) as Partial<TransactionJournal>;
  if (
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION
    || typeof value.transactionId !== "string"
    || typeof value.projectDirectory !== "string"
    || typeof value.state !== "string"
    || !Array.isArray(value.files)
  ) {
    throw new Error(`事务日志结构无效：${journalPath}`);
  }
  for (const file of value.files) {
    if (
      typeof file !== "object"
      || file === null
      || typeof file.relativePath !== "string"
      || typeof file.existed !== "boolean"
      || (
        file.delete !== undefined
        && typeof file.delete !== "boolean"
      )
      || typeof file.stagedPath !== "string"
      || typeof file.stagedHash !== "string"
      || typeof file.adjacentTempPath !== "string"
      || typeof file.committed !== "boolean"
    ) {
      throw new Error(`事务日志文件项无效：${journalPath}`);
    }
  }
  return value as TransactionJournal;
}

function contextFor(
  journal: TransactionJournal,
  logPath: string,
  fileIndex?: number
): TransactionFaultContext {
  const base: TransactionFaultContext = {
    transactionId: journal.transactionId,
    projectDirectory: journal.projectDirectory,
    logPath
  };
  if (fileIndex !== undefined) {
    base.fileIndex = fileIndex;
    const relativePath = journal.files[fileIndex]?.relativePath;
    if (relativePath !== undefined) base.relativePath = relativePath;
  }
  return base;
}

export class FileTransactionManager {
  readonly #baseDirectory: string;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #retentionMs: number;
  readonly #maxProjectBytes: number;
  readonly #faultInjector:
    | FileTransactionManagerOptions["faultInjector"]
    | undefined;

  public constructor(options: FileTransactionManagerOptions = {}) {
    this.#baseDirectory = path.resolve(
      options.baseDirectory
      ?? path.join(os.tmpdir(), "fairygui-mcp-headless")
    );
    this.#idFactory = options.idFactory ?? (() => `tx_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date());
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#maxProjectBytes = options.maxProjectBytes
      ?? DEFAULT_MAX_PROJECT_BYTES;
    if (
      !Number.isSafeInteger(this.#retentionMs)
      || this.#retentionMs < 0
    ) {
      throw new RangeError("retentionMs 必须是非负安全整数");
    }
    if (
      !Number.isSafeInteger(this.#maxProjectBytes)
      || this.#maxProjectBytes < 0
    ) {
      throw new RangeError("maxProjectBytes 必须是非负安全整数");
    }
    this.#faultInjector = options.faultInjector;
  }

  public async commit(
    projectDirectory: string,
    changes: readonly TransactionFileChange[]
  ): Promise<ResultEnvelope<FileTransactionData>> {
    let canonicalProjectDirectory = path.resolve(projectDirectory);
    try {
      canonicalProjectDirectory = await realpath(canonicalProjectDirectory);
    }
    catch (error) {
      return fail("TRANSACTION_FAILED", "事务工程目录不存在或无法访问", {
        path: canonicalProjectDirectory,
        actual: error instanceof Error ? error.message : String(error)
      });
    }

    const transactionId = this.#idFactory();
    if (!transactionIdIsSafe(transactionId)) {
      return fail("TRANSACTION_FAILED", "事务标识包含不安全字符", {
        actual: transactionId
      });
    }
    const logPath = this.logPathFor(
      canonicalProjectDirectory,
      transactionId,
      this.#now()
    );

    let journal: TransactionJournal | undefined;
    try {
      journal = await this.prepare(
        canonicalProjectDirectory,
        transactionId,
        logPath,
        changes
      );
      await this.inject("after-prepare", journal, logPath);
      await this.commitPrepared(journal, logPath);
      await writeDiagnosticSummary(
        logPath,
        journal,
        "committed",
        this.#now()
      ).catch(() => undefined);
      return ok({
        transactionId,
        logPath,
        affectedFiles: journal.files.map((file) => file.relativePath)
      });
    }
    catch (error) {
      if (error instanceof SimulatedTransactionCrash) {
        if (journal !== undefined) {
          await writeDiagnosticSummary(
            logPath,
            journal,
            "interrupted",
            this.#now(),
            [{
              severity: "error",
              code: "TRANSACTION_INTERRUPTED",
              message: error.message
            }]
          ).catch(() => undefined);
        }
        return fail("TRANSACTION_FAILED", "事务被中断，等待启动恢复", {
          actual: error.message,
          transactionId,
          logPath,
          suggestedFix: "重新打开工程以执行事务恢复"
        });
      }

      let rollbackError: unknown;
      if (journal !== undefined) {
        journal.failure = error instanceof Error
          ? error.message
          : String(error);
        await writeJournal(logPath, journal).catch(() => undefined);
        await writeDiagnosticSummary(
          logPath,
          journal,
          "pending",
          this.#now(),
          [{
            severity: "error",
            code: "TRANSACTION_COMMIT_FAILED",
            message: journal.failure
          }]
        ).catch(() => undefined);
        try {
          await this.rollback(journal, logPath, false);
          await writeDiagnosticSummary(
            logPath,
            journal,
            "rolled-back",
            this.#now()
          ).catch(() => undefined);
        }
        catch (caught) {
          rollbackError = caught;
        }
      }
      if (rollbackError !== undefined) {
        return fail(
          "TRANSACTION_RECOVERY_FAILED",
          "事务提交失败，且自动回滚未能完成",
          {
            actual: {
              commit: error instanceof Error ? error.message : String(error),
              rollback: rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            },
            transactionId,
            logPath,
            suggestedFix: "保留事务日志并重新打开工程以再次恢复"
          }
        );
      }
      return fail("TRANSACTION_FAILED", "事务提交失败，磁盘内容已回滚", {
        ...(error instanceof TransactionInputError
          && error.pathValue !== undefined
          ? { path: error.pathValue }
          : {}),
        actual: error instanceof Error ? error.message : String(error),
        transactionId,
        logPath,
        suggestedFix: "根据错误信息修正写入内容后重试"
      });
    }
  }

  public async recover(projectDirectory: string): Promise<void> {
    const canonicalProjectDirectory = await realpath(
      path.resolve(projectDirectory)
    );
    const projectLogRoot = path.join(
      this.#baseDirectory,
      this.projectHash(canonicalProjectDirectory)
    );
    const journalPaths = (await collectJournalFiles(projectLogRoot))
      .sort((left, right) => left.localeCompare(right));

    for (const journalPath of journalPaths) {
      const logPath = path.dirname(journalPath);
      let journal: TransactionJournal | undefined;
      try {
        journal = parseJournal(
          await readFile(journalPath, "utf8"),
          journalPath
        );
        if (path.resolve(journal.projectDirectory) !== canonicalProjectDirectory) {
          throw new Error("事务日志所属工程与当前工程不一致");
        }
        if (TERMINAL_STATES.has(journal.state)) continue;
        await this.rollback(journal, logPath, true);
        await writeDiagnosticSummary(
          logPath,
          journal,
          "rolled-back",
          this.#now()
        ).catch(() => undefined);
      }
      catch (error) {
        throw new TransactionRecoveryError("恢复未完成事务失败", {
          cause: error,
          ...(journal?.transactionId === undefined
            ? {}
            : { transactionId: journal.transactionId }),
          logPath
        });
      }
    }
    try {
      await this.cleanupTerminalLogs(
        projectLogRoot,
        canonicalProjectDirectory,
        this.#now()
      );
    }
    catch {
      // 日志清理是尽力而为；已完成的工程恢复不能因清理失败而回退。
    }
  }

  private async cleanupTerminalLogs(
    projectLogRoot: string,
    projectDirectory: string,
    now: Date
  ): Promise<void> {
    type TerminalLog = {
      logPath: string;
      completedAt: number;
      size: number;
    };
    const terminalLogs: TerminalLog[] = [];
    for (const journalPath of await collectJournalFiles(projectLogRoot)) {
      const logPath = path.dirname(journalPath);
      if (!isStrictDescendant(projectLogRoot, logPath)) continue;
      let journal: TransactionJournal;
      try {
        journal = parseJournal(
          await readFile(journalPath, "utf8"),
          journalPath
        );
      }
      catch {
        continue;
      }
      if (
        path.resolve(journal.projectDirectory) !== projectDirectory
        || !TERMINAL_STATES.has(journal.state)
        || journal.completedAt === undefined
      ) {
        continue;
      }
      const completedAt = Date.parse(journal.completedAt);
      if (!Number.isFinite(completedAt)) continue;
      terminalLogs.push({
        logPath,
        completedAt,
        size: await directoryByteSize(logPath)
      });
    }

    const remaining: TerminalLog[] = [];
    for (const log of terminalLogs) {
      if (now.getTime() - log.completedAt > this.#retentionMs) {
        await rm(log.logPath, { recursive: true, force: true });
      }
      else {
        remaining.push(log);
      }
    }

    let projectBytes = await directoryByteSize(projectLogRoot);
    if (projectBytes <= this.#maxProjectBytes) return;
    remaining.sort((left, right) =>
      left.completedAt - right.completedAt
      || left.logPath.localeCompare(right.logPath)
    );
    for (const log of remaining) {
      if (projectBytes <= this.#maxProjectBytes) break;
      await rm(log.logPath, { recursive: true, force: true });
      projectBytes -= log.size;
    }
  }

  private async prepare(
    projectDirectory: string,
    transactionId: string,
    logPath: string,
    changes: readonly TransactionFileChange[]
  ): Promise<TransactionJournal> {
    if (changes.length === 0) {
      throw new TransactionInputError("事务至少需要一个受影响文件");
    }
    const normalized = changes.map((change) => ({
      relativePath: normalizeRelativePath(change.relativePath),
      delete: change.content === null,
      content: change.content === null
        ? Buffer.alloc(0)
        : typeof change.content === "string"
          ? Buffer.from(change.content, "utf8")
          : Buffer.from(change.content)
    }));
    const uniquePaths = new Set(normalized.map((change) => change.relativePath));
    if (uniquePaths.size !== normalized.length) {
      throw new TransactionInputError("事务目标路径规范化后不能重复");
    }

    const preparedFiles: TransactionJournalFile[] = [];
    const beforeContents: Array<Uint8Array | undefined> = [];
    for (let index = 0; index < normalized.length; index++) {
      const change = normalized[index]!;
      const target = resolveProjectTarget(
        projectDirectory,
        change.relativePath
      );
      await assertNoSymbolicLink(projectDirectory, target);
      const entry = await entryOrUndefined(target);
      if (entry && !entry.isFile()) {
        throw new TransactionInputError(
          "事务目标存在但不是普通文件",
          change.relativePath
        );
      }
      if (change.delete && !entry) {
        throw new TransactionInputError(
          "事务不能删除不存在的文件",
          change.relativePath
        );
      }
      const before = entry ? await readFile(target) : undefined;
      beforeContents.push(before);
      const parentRelative = path.posix.dirname(change.relativePath);
      const temporaryName = `${
        path.posix.basename(change.relativePath)
      }.fairygui-mcp-${transactionId}-${index}.tmp`;
      const adjacentTempPath = parentRelative === "."
        ? temporaryName
        : `${parentRelative}/${temporaryName}`;
      preparedFiles.push({
        relativePath: change.relativePath,
        existed: before !== undefined,
        delete: change.delete,
        ...(before === undefined
          ? {}
          : {
              beforePath: `before/${index}.bin`,
              beforeHash: hashBytes(before)
            }),
        stagedPath: `staged/${index}.bin`,
        stagedHash: hashBytes(change.content),
        adjacentTempPath,
        committed: false
      });
    }

    const timestamp = this.#now().toISOString();
    const journal: TransactionJournal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId,
      projectDirectory,
      state: "preparing",
      createdAt: timestamp,
      updatedAt: timestamp,
      files: preparedFiles
    };

    await mkdir(path.join(logPath, "before"), { recursive: true });
    await mkdir(path.join(logPath, "staged"), { recursive: true });
    await mkdir(path.join(logPath, "diagnostics"), { recursive: true });
    await writeJournal(logPath, journal);
    await writeDiagnosticSummary(
      logPath,
      journal,
      "pending",
      this.#now()
    );
    for (let index = 0; index < normalized.length; index++) {
      const before = beforeContents[index];
      if (before !== undefined) {
        await writeDurableFile(
          path.join(logPath, preparedFiles[index]!.beforePath!),
          before,
          true
        );
      }
      await writeDurableFile(
        path.join(logPath, preparedFiles[index]!.stagedPath),
        normalized[index]!.content,
        true
      );
    }
    journal.state = "prepared";
    await writeJournal(logPath, journal);
    return journal;
  }

  private async commitPrepared(
    journal: TransactionJournal,
    logPath: string
  ): Promise<void> {
    journal.state = "committing";
    await writeJournal(logPath, journal);

    for (let index = 0; index < journal.files.length; index++) {
      const file = journal.files[index]!;
      const target = resolveProjectTarget(
        journal.projectDirectory,
        file.relativePath
      );
      const adjacentTemporary = resolveProjectTarget(
        journal.projectDirectory,
        file.adjacentTempPath
      );
      await mkdir(path.dirname(target), { recursive: true });
      await assertNoSymbolicLink(journal.projectDirectory, target);
      if (file.delete) {
        await this.inject("before-replace", journal, logPath, index);
        await rm(target);
        file.committed = true;
        await writeJournal(logPath, journal);
        await this.inject("after-replace", journal, logPath, index);
        continue;
      }
      await writeDurableFile(
        adjacentTemporary,
        await readFile(path.join(logPath, file.stagedPath)),
        true
      );
      await this.inject("before-replace", journal, logPath, index);
      await rename(adjacentTemporary, target);
      file.committed = true;
      await writeJournal(logPath, journal);
      await this.inject("after-replace", journal, logPath, index);
    }

    await this.inject("before-complete", journal, logPath);
    journal.state = "committed";
    journal.completedAt = this.#now().toISOString();
    await writeJournal(logPath, journal);
  }

  private async rollback(
    journal: TransactionJournal,
    logPath: string,
    recovering: boolean
  ): Promise<void> {
    journal.state = "rolling-back";
    await writeJournal(logPath, journal);

    for (let index = journal.files.length - 1; index >= 0; index--) {
      const file = journal.files[index]!;
      const target = resolveProjectTarget(
        journal.projectDirectory,
        file.relativePath
      );
      const adjacentTemporary = resolveProjectTarget(
        journal.projectDirectory,
        file.adjacentTempPath
      );
      await rm(adjacentTemporary, { force: true });
      const currentHash = await fileHash(target);

      if (file.existed) {
        if (file.delete) {
          if (
            !recovering
            && !file.committed
            && currentHash === file.beforeHash
          ) {
            continue;
          }
          if (
            currentHash !== undefined
            && currentHash !== file.beforeHash
          ) {
            throw new Error(
              `事务恢复发现外部冲突，拒绝覆盖：${file.relativePath}`
            );
          }
          if (currentHash === file.beforeHash) continue;
          const recoveryTemporary = `${adjacentTemporary}.recovery`;
          await rm(recoveryTemporary, { force: true });
          await mkdir(path.dirname(target), { recursive: true });
          await writeDurableFile(
            recoveryTemporary,
            await readFile(path.join(logPath, file.beforePath!)),
            true
          );
          await rename(recoveryTemporary, target);
          file.committed = false;
          await writeJournal(logPath, journal);
          continue;
        }
        if (
          !recovering
          && !file.committed
          && currentHash === file.beforeHash
        ) {
          continue;
        }
        if (
          currentHash !== file.stagedHash
          && currentHash !== file.beforeHash
        ) {
          throw new Error(
            `事务恢复发现外部冲突，拒绝覆盖：${file.relativePath}`
          );
        }
        if (currentHash === file.beforeHash) continue;
        const recoveryTemporary = `${adjacentTemporary}.recovery`;
        await rm(recoveryTemporary, { force: true });
        await writeDurableFile(
          recoveryTemporary,
          await readFile(path.join(logPath, file.beforePath!)),
          true
        );
        await rename(recoveryTemporary, target);
      }
      else {
        if (currentHash === undefined) continue;
        if (currentHash !== file.stagedHash) {
          throw new Error(
            `事务恢复发现外部创建的同名文件，拒绝删除：${file.relativePath}`
          );
        }
        await rm(target);
      }
      file.committed = false;
      await writeJournal(logPath, journal);
    }

    journal.state = "rolled-back";
    journal.completedAt = this.#now().toISOString();
    await writeJournal(logPath, journal);
  }

  private async inject(
    point: TransactionFaultPoint,
    journal: TransactionJournal,
    logPath: string,
    fileIndex?: number
  ): Promise<void> {
    await this.#faultInjector?.(
      point,
      contextFor(journal, logPath, fileIndex)
    );
  }

  private logPathFor(
    projectDirectory: string,
    transactionId: string,
    now: Date
  ): string {
    const date = now.toISOString().slice(0, 10);
    return path.join(
      this.#baseDirectory,
      this.projectHash(projectDirectory),
      date,
      transactionId
    );
  }

  private projectHash(projectDirectory: string): string {
    return createHash("sha256")
      .update(path.resolve(projectDirectory))
      .digest("hex")
      .slice(0, 24);
  }
}
