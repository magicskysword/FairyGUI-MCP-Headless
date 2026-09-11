import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DocumentEditError } from "@magicskysword/openfairygui-core";
import { prepareSnapshotEdits, type ProjectSnapshot, type SnapshotEditOperation } from "@magicskysword/openfairygui-functions";
import { ERROR_CODES, fail, ok, type ErrorCode, type ResultEnvelope } from "../contracts/result.js";
import type { ProjectRegistry } from "../project/project-registry.js";
import { projectSourceFileSystem, snapshotProject } from "../project/source-snapshot.js";
import { readImportInboxFile } from "../resources/import-inbox.js";
import { SKILL_PATH } from '../version.js';
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import { FileTransactionManager } from "../write/file-transaction.js";

export type EditInput =
  | { action: "plan"; projectId: string; operations: SnapshotEditOperation[] }
  | { action: "apply"; projectId: string; requestId: string; operations: SnapshotEditOperation[] }
  | { action: "commit"; projectId: string; requestId: string; planId: string };

type Prepared = Awaited<ReturnType<typeof prepareSnapshotEdits>>;
export interface EditData {
  projectId: string;
  planId: string;
  state: "planned" | "committed";
  sourceFingerprint: string;
  resultFingerprint: string;
  expiresAt: string;
  files: Array<{ relativePath: string; action: "create" | "update" | "remove"; beforeHash: string | null; afterHash: string | null; beforeBytes: number; afterBytes: number }>;
  clientRefs: Prepared["clientRefs"];
  operationResults: Prepared["operationResults"];
  diagnostics: Prepared["diagnostics"];
  affectedReferences: Prepared["affectedReferences"];
  xmlFindings: Prepared["xmlFindings"];
  transactionId?: string;
}
interface Plan {
  projectId: string;
  source: ProjectSnapshot;
  prepared: Prepared;
  expiresAt: number;
  data: EditData;
}
export interface EditServiceOptions {
  transactions?: FileTransactionManager;
  coordinator?: ProjectCommitCoordinator;
  now?: () => number;
  beforeCommit?: () => Promise<void> | void;
}
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const fileKey = (value: string) => path.resolve(value).replace(/\\/g, "/");

export class EditService {
  private readonly plans = new Map<string, Plan>();
  private readonly transactions: FileTransactionManager;
  private readonly coordinator: ProjectCommitCoordinator;
  private readonly now: () => number;
  constructor(private readonly registry: ProjectRegistry, private readonly options: EditServiceOptions = {}) {
    this.transactions = options.transactions ?? new FileTransactionManager();
    this.coordinator = options.coordinator ?? new ProjectCommitCoordinator();
    this.now = options.now ?? Date.now;
  }

  getPlanSnapshot(projectId: string, planId: string): ProjectSnapshot | undefined {
    const plan = this.plans.get(planId);
    return plan?.projectId === projectId && plan.expiresAt > this.now() ? plan.prepared.snapshot : undefined;
  }

  closeProject(projectId: string): void {
    for (const [id, plan] of this.plans) if (plan.projectId === projectId) this.plans.delete(id);
  }

  async execute(input: EditInput): Promise<ResultEnvelope<EditData>> {
    if (input.action !== "plan" && (!input.requestId || input.requestId.length > 200)) return fail("INVALID_ARGUMENT", "写入请求需要 1 至 200 字符的 requestId", { path: "requestId" });
    return this.coordinator.run(input.projectId, async () => {
      const status = this.registry.status(input.projectId);
      if (!status.ok) return status;
      const { projectDirectory, projectFile } = status.data;
      try {
        const digest = hash(canonical(input));
        if (input.action !== "plan") {
          const existing = await this.transactions.findReceipt(projectDirectory, input.requestId);
          if (existing) {
            if (existing.request.digest !== digest) return fail("REQUEST_ID_CONFLICT", "requestId 已用于不同请求", { path: "requestId", actual: input.requestId });
            return ok({ ...(existing.request.result as unknown as EditData), transactionId: existing.transactionId });
          }
        }
        let plan: Plan;
        if (input.action === "commit") {
          const existing = this.plans.get(input.planId);
          if (!existing || existing.projectId !== input.projectId) return fail("PLAN_NOT_FOUND", "编辑计划不存在", { path: "planId", actual: input.planId });
          if (existing.expiresAt <= this.now()) { this.plans.delete(input.planId); return fail("PLAN_EXPIRED", "编辑计划已过期", { suggestedFix: "重新生成编辑计划" }); }
          plan = existing;
        } else {
          let source = await snapshotProject(projectFile);
          const inbox = [];
          for (const [index, operation] of input.operations.entries()) {
            if (operation.op === "xml" || !operation.inboxPath) continue;
            const imported = await readImportInboxFile(projectDirectory, operation.inboxPath, `operations[${index}].inboxPath`);
            if (!imported.ok) return imported;
            inbox.push({ relativePath: imported.data.sourceRelativePath, content: imported.data.content });
          }
          if (inbox.length) source = await source.withChanges(inbox);
          const prepared = await prepareSnapshotEdits(source, input.operations);
          const originals = new Map(source.listFiles().map((file) => [fileKey(file.path), file.data]));
          const expiresAt = this.now() + 30 * 60 * 1000;
          const data: EditData = {
            projectId: input.projectId, planId: `plan_${randomUUID()}`, state: "planned",
            sourceFingerprint: source.fingerprint, resultFingerprint: prepared.snapshot.fingerprint, expiresAt: new Date(expiresAt).toISOString(),
            files: prepared.changes.map((change) => {
              const before = originals.get(fileKey(path.join(projectDirectory, change.relativePath)));
              return { relativePath: change.relativePath, action: change.content === undefined ? "remove" : before === undefined ? "create" : "update",
                beforeHash: before === undefined ? null : hash(before), afterHash: change.content === undefined ? null : hash(change.content), beforeBytes: before?.length ?? 0, afterBytes: change.content?.length ?? 0 };
            }),
            clientRefs: prepared.clientRefs, operationResults: prepared.operationResults, diagnostics: prepared.diagnostics, affectedReferences: prepared.affectedReferences, xmlFindings: prepared.xmlFindings
          };
          plan = { projectId: input.projectId, source, prepared, expiresAt, data };
          if (input.action === "plan") {
            for (const [id, cached] of this.plans) if (cached.expiresAt <= this.now()) this.plans.delete(id);
            this.plans.set(data.planId, plan);
            return ok(structuredClone(data));
          }
        }
        await this.options.beforeCommit?.();
        const fs = projectSourceFileSystem(projectDirectory);
        const changed = await plan.source.changedSources(fs);
        fs.assertSafe();
        if (changed.length) return fail("SOURCE_CONFLICT", "编辑计划的来源或依赖已变化", { actual: changed, suggestedFix: "重新生成编辑计划" });
        const originals = new Map(plan.source.listFiles().map((file) => [fileKey(file.path), file.data]));
        const data: EditData = { ...plan.data, state: "committed" };
        const transaction = await this.transactions.commit(projectDirectory, plan.prepared.changes.map((change) => ({
          relativePath: change.relativePath, content: change.content ?? null,
          expectedContent: originals.get(fileKey(path.join(projectDirectory, change.relativePath))) ?? null
        })), { requestId: input.requestId, digest, result: { ...data } });
        if (!transaction.ok) return transaction;
        this.plans.delete(plan.data.planId);
        return ok({ ...data, transactionId: transaction.data.transactionId });
      } catch (error) {
        if (error instanceof DocumentEditError) {
          const position = /^operations\[(\d+)\](?:\.props\.([^.]+))?/.exec(error.path ?? '');
          const operation = input.action !== 'commit' && position ? input.operations[Number(position[1])] : undefined;
          const value = operation && operation.op !== 'xml' && position?.[2] ? operation.props?.[position[2]] : undefined;
          return fail(ERROR_CODES.includes(error.code as ErrorCode) ? error.code as ErrorCode : "INVALID_EDIT", error.message, {
            ...(error.path ? { path: error.path } : {}), actual: error.details ?? value ?? error.code,
            ...(operation ? { relatedObjects: [operation.target] } : {}),
            definition: { file: path.join(path.dirname(SKILL_PATH), 'definitions/authoring/operations.schema.json'), symbol: 'operations' },
            suggestedFix: '按关联定义检查目标、属性和引用后重新生成编辑计划'
          });
        }
        return fail("INTERNAL_ERROR", "编辑请求处理失败", { actual: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
