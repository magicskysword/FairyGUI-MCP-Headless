import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NodeIO,
  serializeAffectedProjectFiles,
  type Document,
  type ProjectFileTarget,
  type SerializedProjectFile
} from "@magicskysword/openfairygui-core";
import {
  fail,
  ok,
  type ResultEnvelope
} from "../contracts/result.js";
import type { ApplyResourceOperationsInput } from "../contracts/tools.js";
import type {
  ProjectRegistry,
  ProjectSummary
} from "../project/project-registry.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import {
  FileTransactionManager,
  type FileTransactionData
} from "../write/file-transaction.js";
import {
  readImportInboxFile,
  type ImportInboxFile
} from "./import-inbox.js";
import {
  ResourceOperationsEngine,
  type ResourceDeleteResult,
  type ResourceOperationClientRef,
  type ResourceOperationsEngineData
} from "./resource-operations-engine.js";

const DEFAULT_FRESH_RETRIES = 3;

export interface ResourceOperationsData {
  projectId: string;
  transactionId: string;
  affectedFiles: string[];
  appliedOperations: number;
  clientRefs: Record<string, ResourceOperationClientRef>;
  affectedPackageIds: string[];
  consumedInboxPaths: string[];
  deleteResults: ResourceDeleteResult[];
  projectMayBeInvalid?: boolean;
}

export interface ResourceOperationsServiceOptions {
  coordinator?: ProjectCommitCoordinator;
  transactions?: FileTransactionManager;
  engine?: ResourceOperationsEngine;
  temporaryRoot?: string;
  maxFreshRetries?: number;
}

interface SourceFileState {
  relativePath: string;
  content: string | Uint8Array | undefined;
}

interface PreparedResourceOperations {
  engine: ResourceOperationsEngineData;
  files: SerializedProjectFile[];
  assetWrites: Array<{
    relativePath: string;
    content: Uint8Array;
  }>;
  deletedFiles: string[];
  sourceStates: SourceFileState[];
}

function projectFilePath(
  projectDirectory: string,
  relativePath: string
): string {
  return path.join(projectDirectory, ...relativePath.split("/"));
}

function targetsFor(
  data: ResourceOperationsEngineData
): ProjectFileTarget[] {
  return [
    ...data.affectedPackageIds.map((packageId) => ({
      kind: "package" as const,
      packageId
    })),
    ...data.affectedComponents.map(({ packageId, componentId }) => ({
      kind: "component" as const,
      packageId,
      componentId
    }))
  ];
}

function originalContentFor(
  document: Document,
  file: SerializedProjectFile
): string | undefined {
  if (file.kind === "package") {
    const sources = document.getRoot()
      .getPackageById(file.packageId!)
      ?.getExtras()._sourcePackageXmlByBranch;
    if (!sources || typeof sources !== "object") return undefined;
    const source = (sources as Record<string, unknown>)[file.branch ?? ""];
    return typeof source === "string" ? source : undefined;
  }
  if (file.kind === "component") {
    const source = document.getRoot()
      .getPackageById(file.packageId!)
      ?.getResourceById(file.componentId!)
      ?.getExtras()._sourceComponentXml;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

function sameSerializedFile(
  expected: SerializedProjectFile,
  actual: SerializedProjectFile
): boolean {
  return expected.kind === actual.kind
    && expected.relativePath === actual.relativePath
    && expected.packageId === actual.packageId
    && expected.componentId === actual.componentId
    && expected.branch === actual.branch
    && expected.content === actual.content;
}

function sameSerializedDescriptor(
  expected: SerializedProjectFile,
  actual: SerializedProjectFile
): boolean {
  return expected.kind === actual.kind
    && expected.relativePath === actual.relativePath
    && expected.packageId === actual.packageId
    && expected.componentId === actual.componentId
    && expected.branch === actual.branch;
}

async function fileContentOrUndefined(filePath: string): Promise<
  Uint8Array | undefined
> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("目标存在但不是普通文件");
    }
    return await readFile(filePath);
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

function contentBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function sameSourceContent(
  expected: string | Uint8Array | undefined,
  actual: string | Uint8Array | undefined
): boolean {
  if (expected === undefined || actual === undefined) {
    return expected === actual;
  }
  return Buffer.from(contentBytes(expected)).equals(
    Buffer.from(contentBytes(actual))
  );
}

function addSourceState(
  states: SourceFileState[],
  state: SourceFileState
): void {
  const existing = states.find((item) =>
    item.relativePath === state.relativePath
  );
  if (!existing) {
    states.push(state);
    return;
  }
  if (!sameSourceContent(existing.content, state.content)) {
    throw new Error(`资源事务源状态冲突：${state.relativePath}`);
  }
}

export class ResourceOperationsService {
  readonly #projects: ProjectRegistry;
  readonly #coordinator: ProjectCommitCoordinator;
  readonly #transactions: FileTransactionManager;
  readonly #engine: ResourceOperationsEngine;
  readonly #temporaryRoot: string;
  readonly #maxFreshRetries: number;

  public constructor(
    projects: ProjectRegistry,
    options: ResourceOperationsServiceOptions = {}
  ) {
    this.#projects = projects;
    this.#coordinator = options.coordinator ?? new ProjectCommitCoordinator();
    this.#transactions = options.transactions ?? new FileTransactionManager();
    this.#engine = options.engine ?? new ResourceOperationsEngine();
    this.#temporaryRoot = path.resolve(
      options.temporaryRoot
      ?? path.join(
        os.tmpdir(),
        "fairygui-mcp-headless",
        "resource-roundtrip"
      )
    );
    this.#maxFreshRetries = options.maxFreshRetries ?? DEFAULT_FRESH_RETRIES;
    if (
      !Number.isSafeInteger(this.#maxFreshRetries)
      || this.#maxFreshRetries < 1
    ) {
      throw new RangeError("maxFreshRetries 必须是正安全整数");
    }
  }

  public apply(
    input: ApplyResourceOperationsInput
  ): Promise<ResultEnvelope<ResourceOperationsData>> {
    const status = this.#projects.status(input.projectId);
    if (!status.ok) return Promise.resolve(status);

    return this.#coordinator.runPrepared(
      input.projectId,
      () => this.prepareAttempt(status.data, input),
      (firstPreparation) => this.applyQueued(
        status.data,
        input,
        firstPreparation
      )
    );
  }

  private async applyQueued(
    project: ProjectSummary,
    input: ApplyResourceOperationsInput,
    firstPreparation: ResultEnvelope<PreparedResourceOperations>
  ): Promise<ResultEnvelope<ResourceOperationsData>> {
    for (let attempt = 0; attempt < this.#maxFreshRetries; attempt++) {
      const prepared = attempt === 0
        ? firstPreparation
        : await this.prepareAttempt(project, input);
      if (!prepared.ok) {
        if (
          prepared.error.code === "PROJECT_RELOAD_FAILED"
          && attempt + 1 < this.#maxFreshRetries
        ) {
          continue;
        }
        return prepared;
      }

      let current: SourceFileState[];
      try {
        current = await Promise.all(
          prepared.data.sourceStates.map(async (source) => {
            const content = await fileContentOrUndefined(projectFilePath(
              project.projectDirectory,
              source.relativePath
            ));
            return {
              relativePath: source.relativePath,
              content
            };
          })
        );
      }
      catch (error) {
        if (attempt + 1 < this.#maxFreshRetries) continue;
        return fail("WRITE_FAILED", "读取资源事务目标失败", {
          actual: error instanceof Error ? error.message : String(error)
        });
      }
      const unchanged = current.every((source, index) =>
        sameSourceContent(
          prepared.data.sourceStates[index]?.content,
          source.content
        )
      );
      if (!unchanged) continue;

      const transaction = await this.#transactions.commit(
        project.projectDirectory,
        [
          ...prepared.data.files.map((file) => ({
            relativePath: file.relativePath,
            content: file.content
          })),
          ...prepared.data.assetWrites,
          ...prepared.data.deletedFiles.map((relativePath) => ({
            relativePath,
            content: null
          }))
        ].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        )
      );
      if (!transaction.ok) return transaction;

      const reloaded = await this.#projects.read(input.projectId, () => true);
      if (!reloaded.ok) return reloaded;
      return this.success(input, prepared.data, transaction.data);
    }

    return fail(
      "WRITE_FAILED",
      "工程在资源批处理准备期间持续被外部修改，未覆盖较新的磁盘内容",
      {
        actual: { attempts: this.#maxFreshRetries },
        suggestedFix: "暂停 FairyGUI Editor 或其他写入进程后重试"
      }
    );
  }

  private async prepareAttempt(
    project: ProjectSummary,
    input: ApplyResourceOperationsInput
  ): Promise<ResultEnvelope<PreparedResourceOperations>> {
    const fresh = await this.#projects.read(input.projectId, () => true);
    if (!fresh.ok) return fresh;

    const importFiles = await this.loadImportFiles(
      project.projectDirectory,
      input
    );
    if (!importFiles.ok) return importFiles;

    try {
      const document = await new NodeIO().readProject(project.projectFile);
      return await this.prepare(
        document,
        input,
        project.projectDirectory,
        importFiles.data
      );
    }
    catch (error) {
      return fail(
        "PROJECT_RELOAD_FAILED",
        "资源写入前无法取得稳定、可解析的最新工程模型",
        {
          path: project.projectFile,
          actual: error instanceof Error ? error.message : String(error),
          suggestedFix: "停止外部持续写入，修复工程文件后重试"
        }
      );
    }
  }

  private async loadImportFiles(
    projectDirectory: string,
    input: ApplyResourceOperationsInput
  ): Promise<ResultEnvelope<ReadonlyMap<number, ImportInboxFile>>> {
    const files = new Map<number, ImportInboxFile>();
    for (let index = 0; index < input.operations.length; index++) {
      const operation = input.operations[index]!;
      if (operation.op !== "import" && operation.op !== "replace-resource") {
        continue;
      }
      const file = await readImportInboxFile(
        projectDirectory,
        operation.inboxPath,
        `operations[${index}].inboxPath`
      );
      if (!file.ok) return file;
      files.set(index, file.data);
    }
    return ok(files);
  }

  private async prepare(
    document: Document,
    input: ApplyResourceOperationsInput,
    projectDirectory: string,
    importFiles: ReadonlyMap<number, ImportInboxFile>
  ): Promise<ResultEnvelope<PreparedResourceOperations>> {
    const applied = this.#engine.apply(document, input, { importFiles });
    if (!applied.ok) return applied;

    let files: SerializedProjectFile[];
    try {
      files = (await serializeAffectedProjectFiles(
        document,
        targetsFor(applied.data)
      )).sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      );
    }
    catch (error) {
      return fail("SERIALIZATION_FAILED", "序列化资源批处理目标失败", {
        actual: error instanceof Error ? error.message : String(error)
      });
    }

    const roundtrip = await this.validateRoundtrip(
      document,
      targetsFor(applied.data),
      files
    );
    if (!roundtrip.ok) return roundtrip;
    files = roundtrip.data;
    const movedByDestination = new Map(
      applied.data.fileMoves.map((move) => [move.to, move.from])
    );
    const sourceStates: SourceFileState[] = [];
    for (const file of files) {
      addSourceState(sourceStates, {
        relativePath: file.relativePath,
        content: movedByDestination.has(file.relativePath)
          ? undefined
          : originalContentFor(document, file)
      });
    }
    for (const move of applied.data.fileMoves) {
      const destination = files.find((file) =>
        file.relativePath === move.to
      );
      if (!destination) {
        return fail(
          "SERIALIZATION_FAILED",
          "资源移动后缺少目标序列化文件",
          {
            path: move.to,
            actual: move
          }
        );
      }
      addSourceState(sourceStates, {
        relativePath: move.from,
        content: originalContentFor(document, destination)
      });
    }

    const assetWrites = applied.data.assetWrites.map((write) => ({
      relativePath: write.relativePath,
      content: new Uint8Array(write.content)
    }));
    for (const write of applied.data.assetWrites) {
      const expected = write.targetExisted
        ? await fileContentOrUndefined(projectFilePath(
            projectDirectory,
            write.relativePath
          ))
        : undefined;
      if (write.targetExisted && expected === undefined) {
        return fail("WRITE_FAILED", "待替换资源文件不存在", {
          path: write.relativePath,
          suggestedFix: "修复 package.xml 与资源文件的一致性后重试"
        });
      }
      addSourceState(sourceStates, {
        relativePath: write.relativePath,
        content: expected
      });
    }

    for (const move of applied.data.assetMoves) {
      const sourceContent = await fileContentOrUndefined(projectFilePath(
        projectDirectory,
        move.from
      ));
      if (sourceContent === undefined) {
        return fail("WRITE_FAILED", "待移动资源文件不存在", {
          path: move.from,
          suggestedFix: "修复 package.xml 与资源文件的一致性后重试"
        });
      }
      addSourceState(sourceStates, {
        relativePath: move.from,
        content: sourceContent
      });
      const replacement = applied.data.assetWrites.some((write) =>
        write.relativePath === move.to
      );
      if (!replacement) {
        assetWrites.push({
          relativePath: move.to,
          content: new Uint8Array(sourceContent)
        });
        addSourceState(sourceStates, {
          relativePath: move.to,
          content: undefined
        });
      }
    }

    for (const relativePath of [
      ...applied.data.deletedFiles,
      ...applied.data.deletedAssetFiles
    ]) {
      const sourceContent = await fileContentOrUndefined(projectFilePath(
        projectDirectory,
        relativePath
      ));
      if (sourceContent === undefined) {
        return fail("WRITE_FAILED", "待删除的工程文件不存在", {
          path: relativePath,
          suggestedFix: "修复 package.xml 与工程文件的一致性后重试"
        });
      }
      addSourceState(sourceStates, {
        relativePath,
        content: sourceContent
      });
    }

    for (const inboxPath of applied.data.consumedInboxPaths) {
      const inboxFile = [...importFiles.values()].find((file) =>
        file.sourceRelativePath === inboxPath
      );
      if (!inboxFile) {
        return fail("IMPORT_NOT_REGULAR_FILE", "缺少待消费收件箱文件", {
          path: inboxPath
        });
      }
      addSourceState(sourceStates, {
        relativePath: inboxPath,
        content: inboxFile.content
      });
    }
    sourceStates.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );

    return ok({
      engine: applied.data,
      files,
      assetWrites: assetWrites.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      ),
      deletedFiles: [
        ...new Set([
          ...applied.data.fileMoves.map((move) => move.from),
          ...applied.data.deletedFiles,
          ...applied.data.assetMoves.map((move) => move.from),
          ...applied.data.deletedAssetFiles,
          ...applied.data.consumedInboxPaths
        ])
      ].sort(),
      sourceStates
    });
  }

  private async validateRoundtrip(
    document: Document,
    targets: ProjectFileTarget[],
    expected: SerializedProjectFile[]
  ): Promise<ResultEnvelope<SerializedProjectFile[]>> {
    await mkdir(this.#temporaryRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      path.join(this.#temporaryRoot, "resources-")
    );
    try {
      const io = new NodeIO();
      const projectFile = path.join(temporaryDirectory, "Roundtrip.fairy");
      await io.writeProject(document, projectFile);
      const reparsed = await io.readProject(projectFile);
      const actual = (await serializeAffectedProjectFiles(reparsed, targets))
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        );
      if (
        actual.length !== expected.length
        || expected.some((file, index) =>
          !sameSerializedDescriptor(file, actual[index]!)
        )
      ) {
        const differenceIndex = expected.findIndex((file, index) =>
          !sameSerializedDescriptor(file, actual[index]!)
        );
        const expectedDifference = expected[differenceIndex];
        const actualDifference = actual[differenceIndex];
        return fail(
          "SERIALIZATION_FAILED",
          "资源批处理结构化往返后的目标文件不一致",
          {
            actual: {
              expected: expected.map((file) => file.relativePath),
              roundtrip: actual.map((file) => file.relativePath),
              difference: {
                index: differenceIndex,
                expected: expectedDifference?.relativePath,
                roundtrip: actualDifference?.relativePath
              }
            },
            suggestedFix: "缩小资源批次，并报告无法往返的 FairyGUI 语料"
          }
        );
      }
      const stableDirectory = path.join(temporaryDirectory, "stable");
      await mkdir(stableDirectory, { recursive: true });
      const stableProjectFile = path.join(stableDirectory, "Stable.fairy");
      await io.writeProject(reparsed, stableProjectFile);
      const stableDocument = await io.readProject(stableProjectFile);
      const stable = (await serializeAffectedProjectFiles(
        stableDocument,
        targets
      )).sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      );
      if (
        stable.length !== actual.length
        || actual.some((file, index) =>
          !sameSerializedFile(file, stable[index]!)
        )
      ) {
        return fail(
          "SERIALIZATION_FAILED",
          "资源批处理规范化后未达到稳定往返",
          {
            actual: {
              first: actual.map((file) => file.relativePath),
              second: stable.map((file) => file.relativePath)
            },
            suggestedFix: "缩小资源批次，并报告无法稳定往返的 FairyGUI 语料"
          }
        );
      }
      return ok(actual);
    }
    catch (error) {
      return fail("SERIALIZATION_FAILED", "资源批处理回读校验失败", {
        actual: error instanceof Error ? error.message : String(error)
      });
    }
    finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private success(
    input: ApplyResourceOperationsInput,
    prepared: PreparedResourceOperations,
    transaction: FileTransactionData
  ): ResultEnvelope<ResourceOperationsData> {
    const data: ResourceOperationsData = {
      projectId: input.projectId,
      transactionId: transaction.transactionId,
      affectedFiles: transaction.affectedFiles,
      appliedOperations: prepared.engine.appliedOperations,
      clientRefs: prepared.engine.clientRefs,
      affectedPackageIds: prepared.engine.affectedPackageIds,
      consumedInboxPaths: prepared.engine.consumedInboxPaths,
      deleteResults: prepared.engine.deleteResults,
      ...(prepared.engine.projectMayBeInvalid
        ? { projectMayBeInvalid: true }
        : {})
    };
    const warnings = prepared.engine.deleteResults.flatMap((result) => {
      if (result.effectiveMode === "cascade-with-force-fallback") {
        return [{
          severity: "warning" as const,
          code: "CASCADE_FORCE_FALLBACK",
          message:
            "级联删除遇到只读引用并已保留该引用，工程可能处于无效状态",
          details: {
            packageId: result.packageId,
            ...(result.resourceId === undefined
              ? {}
              : { resourceId: result.resourceId }),
            unsupportedReferences: result.unsupportedReferences
          }
        }];
      }
      if (result.effectiveMode === "force") {
        return [{
          severity: "warning" as const,
          code: "FORCE_DELETE_MAY_INVALIDATE_PROJECT",
          message: "强制删除跳过了引用扫描，工程可能处于无效状态",
          details: {
            packageId: result.packageId,
            ...(result.resourceId === undefined
              ? {}
              : { resourceId: result.resourceId })
          }
        }];
      }
      return [];
    });
    return ok(data, warnings);
  }
}
