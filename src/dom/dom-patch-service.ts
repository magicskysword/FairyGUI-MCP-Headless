import {
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NodeIO,
  PropertyType,
  serializeAffectedProjectFiles,
  type Document,
  type SerializedProjectFile
} from "@magicskysword/openfairygui-core";
import type { FairyDomDocument } from "../contracts/dom.js";
import {
  fail,
  ok,
  type ResultEnvelope
} from "../contracts/result.js";
import type { ApplyDomPatchInput } from "../contracts/tools.js";
import type {
  ProjectRegistry,
  ProjectSummary
} from "../project/project-registry.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import {
  FileTransactionManager,
  type FileTransactionData
} from "../write/file-transaction.js";
import { DomPatchEngine } from "./dom-patch-engine.js";
import { toFairyDomDocument } from "./openfairygui-adapter.js";

const DEFAULT_FRESH_RETRIES = 3;

export interface DomPatchData {
  projectId: string;
  packageId: string;
  componentId: string;
  transactionId: string;
  affectedFiles: string[];
  appliedOperations: number;
  clientRefs: Record<string, string>;
  dom: FairyDomDocument;
}

export interface DomPatchBeforeCommitContext {
  projectDirectory: string;
  projectFile: string;
  relativePath: string;
  sourceContent: string;
  stagedContent: string;
}

export interface DomPatchServiceOptions {
  coordinator?: ProjectCommitCoordinator;
  transactions?: FileTransactionManager;
  engine?: DomPatchEngine;
  temporaryRoot?: string;
  maxFreshRetries?: number;
  beforeCommit?: (
    attempt: number,
    context: DomPatchBeforeCommitContext
  ) => void | Promise<void>;
}

interface PreparedPatch {
  sourceContent: string;
  serialized: SerializedProjectFile;
  appliedOperations: number;
  clientRefs: Record<string, string>;
  dom: FairyDomDocument;
}

function projectFilePath(
  projectDirectory: string,
  relativePath: string
): string {
  return path.join(projectDirectory, ...relativePath.split("/"));
}

function sameSerializedFile(
  expected: SerializedProjectFile,
  actual: SerializedProjectFile
): boolean {
  return expected.kind === actual.kind
    && expected.relativePath === actual.relativePath
    && expected.packageId === actual.packageId
    && expected.componentId === actual.componentId
    && expected.content === actual.content;
}

interface SemanticDifference {
  path: string;
  expected: unknown;
  actual: unknown;
}

function firstSemanticDifference(
  expected: unknown,
  actual: unknown,
  currentPath = "dom"
): SemanticDifference | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (
    expected === null
    || actual === null
    || typeof expected !== "object"
    || typeof actual !== "object"
  ) {
    return { path: currentPath, expected, actual };
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path: currentPath, expected, actual };
    }
    if (expected.length !== actual.length) {
      return {
        path: `${currentPath}.length`,
        expected: expected.length,
        actual: actual.length
      };
    }
    for (let index = 0; index < expected.length; index++) {
      const difference = firstSemanticDifference(
        expected[index],
        actual[index],
        `${currentPath}[${index}]`
      );
      if (difference) return difference;
    }
    return undefined;
  }

  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord)
  ]);
  for (const key of [...keys].sort()) {
    if (!Object.hasOwn(expectedRecord, key)) {
      return {
        path: `${currentPath}.${key}`,
        expected: "<missing>",
        actual: actualRecord[key]
      };
    }
    if (!Object.hasOwn(actualRecord, key)) {
      return {
        path: `${currentPath}.${key}`,
        expected: expectedRecord[key],
        actual: "<missing>"
      };
    }
    const difference = firstSemanticDifference(
      expectedRecord[key],
      actualRecord[key],
      `${currentPath}.${key}`
    );
    if (difference) return difference;
  }
  return undefined;
}

export class DomPatchService {
  readonly #projects: ProjectRegistry;
  readonly #coordinator: ProjectCommitCoordinator;
  readonly #transactions: FileTransactionManager;
  readonly #engine: DomPatchEngine;
  readonly #temporaryRoot: string;
  readonly #maxFreshRetries: number;
  readonly #beforeCommit:
    | DomPatchServiceOptions["beforeCommit"]
    | undefined;

  public constructor(
    projects: ProjectRegistry,
    options: DomPatchServiceOptions = {}
  ) {
    this.#projects = projects;
    this.#coordinator = options.coordinator ?? new ProjectCommitCoordinator();
    this.#transactions = options.transactions ?? new FileTransactionManager();
    this.#engine = options.engine ?? new DomPatchEngine();
    this.#temporaryRoot = path.resolve(
      options.temporaryRoot
      ?? path.join(os.tmpdir(), "fairygui-mcp-headless", "dom-roundtrip")
    );
    this.#maxFreshRetries = options.maxFreshRetries ?? DEFAULT_FRESH_RETRIES;
    if (
      !Number.isSafeInteger(this.#maxFreshRetries)
      || this.#maxFreshRetries < 1
    ) {
      throw new RangeError("maxFreshRetries 必须是正安全整数");
    }
    this.#beforeCommit = options.beforeCommit;
  }

  public apply(
    input: ApplyDomPatchInput
  ): Promise<ResultEnvelope<DomPatchData>> {
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
    input: ApplyDomPatchInput,
    firstPreparation: ResultEnvelope<PreparedPatch>
  ): Promise<ResultEnvelope<DomPatchData>> {
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

      const targetPath = projectFilePath(
        project.projectDirectory,
        prepared.data.serialized.relativePath
      );
      let currentContent: string;
      try {
        currentContent = await readFile(targetPath, "utf8");
      }
      catch (error) {
        if (attempt + 1 < this.#maxFreshRetries) continue;
        return fail(
          "WRITE_FAILED",
          "读取待提交组件源文件失败",
          {
            path: prepared.data.serialized.relativePath,
            actual: error instanceof Error ? error.message : String(error)
          }
        );
      }
      if (currentContent !== prepared.data.sourceContent) {
        continue;
      }

      await this.#beforeCommit?.(attempt, {
        projectDirectory: project.projectDirectory,
        projectFile: project.projectFile,
        relativePath: prepared.data.serialized.relativePath,
        sourceContent: prepared.data.sourceContent,
        stagedContent: prepared.data.serialized.content
      });

      try {
        currentContent = await readFile(targetPath, "utf8");
      }
      catch {
        continue;
      }
      if (currentContent !== prepared.data.sourceContent) {
        continue;
      }

      const transaction = await this.#transactions.commit(
        project.projectDirectory,
        [{
          relativePath: prepared.data.serialized.relativePath,
          content: prepared.data.serialized.content
        }]
      );
      if (!transaction.ok) return transaction;
      return this.success(input, prepared.data, transaction.data);
    }

    return fail(
      "WRITE_FAILED",
      "工程在补丁准备期间持续被外部修改，未覆盖较新的磁盘内容",
      {
        path: project.projectFile,
        actual: { attempts: this.#maxFreshRetries },
        suggestedFix: "暂停 FairyGUI Editor 或其他写入进程后重试"
      }
    );
  }

  private async prepareAttempt(
    project: ProjectSummary,
    input: ApplyDomPatchInput
  ): Promise<ResultEnvelope<PreparedPatch>> {
    const fresh = await this.#projects.read(
      input.projectId,
      () => true
    );
    if (!fresh.ok) return fresh;

    try {
      const document = await new NodeIO().readProject(project.projectFile);
      return await this.prepare(document, input);
    }
    catch (error) {
      return fail(
        "PROJECT_RELOAD_FAILED",
        "写入前无法取得稳定、可解析的最新工程模型",
        {
          path: project.projectFile,
          actual: error instanceof Error ? error.message : String(error),
          suggestedFix: "停止外部持续写入，修复工程 XML 后重试"
        }
      );
    }
  }

  private async prepare(
    document: Document,
    input: ApplyDomPatchInput
  ): Promise<ResultEnvelope<PreparedPatch>> {
    const pkg = document.getRoot().getPackageById(input.packageId);
    if (!pkg) {
      return fail("PACKAGE_NOT_FOUND", `包不存在：${input.packageId}`, {
        path: "packageId",
        actual: input.packageId
      });
    }
    const resource = pkg.getResourceById(input.componentId);
    if (!resource || resource.propertyType !== PropertyType.COMPONENT) {
      return fail(
        "COMPONENT_NOT_FOUND",
        `组件不存在：${input.packageId}/${input.componentId}`,
        {
          path: "componentId",
          actual: input.componentId
        }
      );
    }
    const sourceContent = resource.getExtras()._sourceComponentXml;
    if (typeof sourceContent !== "string") {
      return fail(
        "SERIALIZATION_FAILED",
        "组件缺少可用于冲突检测的原始 XML 快照",
        {
          path: `${input.packageId}/${input.componentId}`,
          suggestedFix: "关闭并重新打开工程后重试"
        }
      );
    }

    const applied = this.#engine.apply(document, input);
    if (!applied.ok) return applied;

    let serialized: SerializedProjectFile;
    try {
      const files = await serializeAffectedProjectFiles(document, [{
        kind: "component",
        packageId: input.packageId,
        componentId: input.componentId
      }]);
      const selected = files[0];
      if (!selected || files.length !== 1) {
        throw new Error(`预期序列化 1 个组件文件，实际得到 ${files.length} 个`);
      }
      serialized = selected;
    }
    catch (error) {
      return fail("SERIALIZATION_FAILED", "序列化目标组件失败", {
        path: `${input.packageId}/${input.componentId}`,
        actual: error instanceof Error ? error.message : String(error)
      });
    }

    const roundtrip = await this.validateRoundtrip(
      document,
      input,
      serialized,
      applied.data.dom
    );
    if (!roundtrip.ok) return roundtrip;
    return ok({
      sourceContent,
      serialized,
      appliedOperations: applied.data.appliedOperations,
      clientRefs: applied.data.clientRefs,
      dom: roundtrip.data
    });
  }

  private async validateRoundtrip(
    document: Document,
    input: ApplyDomPatchInput,
    serialized: SerializedProjectFile,
    expectedDom: FairyDomDocument
  ): Promise<ResultEnvelope<FairyDomDocument>> {
    await mkdir(this.#temporaryRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      path.join(this.#temporaryRoot, "patch-")
    );
    try {
      const io = new NodeIO();
      const temporaryProject = path.join(
        temporaryDirectory,
        "Roundtrip.fairy"
      );
      await io.writeProject(document, temporaryProject);
      const reparsed = await io.readProject(temporaryProject);
      const files = await serializeAffectedProjectFiles(reparsed, [{
        kind: "component",
        packageId: input.packageId,
        componentId: input.componentId
      }]);
      const roundtripFile = files[0];
      if (!roundtripFile || !sameSerializedFile(serialized, roundtripFile)) {
        return fail(
          "SERIALIZATION_FAILED",
          "组件结构化往返后的规范语义不一致",
          {
            path: serialized.relativePath,
            actual: roundtripFile === undefined
              ? "回读后缺少目标文件"
              : {
                  beforeBytes: Buffer.byteLength(serialized.content),
                  afterBytes: Buffer.byteLength(roundtripFile.content)
                },
            suggestedFix: "缩小补丁范围，并报告无法往返的 FairyGUI XML 语料"
          }
        );
      }
      const roundtripDom = toFairyDomDocument(
        reparsed,
        input.packageId,
        input.componentId
      );
      const semanticDifference = firstSemanticDifference(
        expectedDom,
        roundtripDom
      );
      if (semanticDifference) {
        return fail(
          "SERIALIZATION_FAILED",
          "组件 DOM 在结构化往返后发生语义变化",
          {
            path: semanticDifference.path,
            actual: {
              expected: semanticDifference.expected,
              roundtrip: semanticDifference.actual
            },
            suggestedFix: "缩小补丁范围，并报告无法往返的 DOM 字段"
          }
        );
      }
      return ok(roundtripDom);
    }
    catch (error) {
      return fail("SERIALIZATION_FAILED", "组件序列化回读校验失败", {
        path: serialized.relativePath,
        actual: error instanceof Error ? error.message : String(error)
      });
    }
    finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private success(
    input: ApplyDomPatchInput,
    prepared: PreparedPatch,
    transaction: FileTransactionData
  ): ResultEnvelope<DomPatchData> {
    return ok({
      projectId: input.projectId,
      packageId: input.packageId,
      componentId: input.componentId,
      transactionId: transaction.transactionId,
      affectedFiles: transaction.affectedFiles,
      appliedOperations: prepared.appliedOperations,
      clientRefs: prepared.clientRefs,
      dom: prepared.dom
    });
  }
}
