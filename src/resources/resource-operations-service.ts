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
import type { ProjectRegistry } from "../project/project-registry.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import {
  FileTransactionManager,
  type FileTransactionData
} from "../write/file-transaction.js";
import {
  ResourceOperationsEngine,
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
  content: string | undefined;
}

interface PreparedResourceOperations {
  engine: ResourceOperationsEngineData;
  files: SerializedProjectFile[];
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
  string | undefined
> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("目标存在但不是普通文件");
    }
    return await readFile(filePath, "utf8");
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
    return this.#coordinator.run(
      input.projectId,
      () => this.applyQueued(input)
    );
  }

  private async applyQueued(
    input: ApplyResourceOperationsInput
  ): Promise<ResultEnvelope<ResourceOperationsData>> {
    const status = this.#projects.status(input.projectId);
    if (!status.ok) return status;

    for (let attempt = 0; attempt < this.#maxFreshRetries; attempt++) {
      const fresh = await this.#projects.read(input.projectId, () => true);
      if (!fresh.ok) return fresh;

      let prepared: ResultEnvelope<PreparedResourceOperations>;
      try {
        const document = await new NodeIO().readProject(
          status.data.projectFile
        );
        prepared = await this.prepare(document, input);
      }
      catch (error) {
        if (attempt + 1 < this.#maxFreshRetries) continue;
        return fail(
          "PROJECT_RELOAD_FAILED",
          "资源写入前无法取得稳定、可解析的最新工程模型",
          {
            path: status.data.projectFile,
            actual: error instanceof Error ? error.message : String(error),
            suggestedFix: "停止外部持续写入，修复工程文件后重试"
          }
        );
      }
      if (!prepared.ok) return prepared;

      let current: SourceFileState[];
      try {
        current = await Promise.all(
          prepared.data.sourceStates.map(async (source) => {
            const content = await fileContentOrUndefined(projectFilePath(
              status.data.projectDirectory,
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
      const sourceMap = new Map(
        prepared.data.sourceStates.map((source) => [
          source.relativePath,
          source.content
        ])
      );
      const unchanged = current.every((source) =>
        sourceMap.get(source.relativePath) === source.content
      );
      if (!unchanged) continue;

      const transaction = await this.#transactions.commit(
        status.data.projectDirectory,
        [
          ...prepared.data.files.map((file) => ({
            relativePath: file.relativePath,
            content: file.content
          })),
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

  private async prepare(
    document: Document,
    input: ApplyResourceOperationsInput
  ): Promise<ResultEnvelope<PreparedResourceOperations>> {
    const applied = this.#engine.apply(document, input);
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
    const sourceStates = files.map((file) => ({
      relativePath: file.relativePath,
      content: movedByDestination.has(file.relativePath)
        ? undefined
        : originalContentFor(document, file)
    }));
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
      sourceStates.push({
        relativePath: move.from,
        content: originalContentFor(document, destination)
      });
    }
    return ok({
      engine: applied.data,
      files,
      deletedFiles: [
        ...new Set([
          ...applied.data.fileMoves.map((move) => move.from),
          ...applied.data.deletedFiles
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
    return ok({
      projectId: input.projectId,
      transactionId: transaction.transactionId,
      affectedFiles: transaction.affectedFiles,
      appliedOperations: prepared.engine.appliedOperations,
      clientRefs: prepared.engine.clientRefs,
      affectedPackageIds: prepared.engine.affectedPackageIds
    });
  }
}
