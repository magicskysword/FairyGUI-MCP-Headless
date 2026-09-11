import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ZodError } from "zod";
import { DocumentEditError } from "@magicskysword/openfairygui-core";
import type { ProjectSnapshot } from "@magicskysword/openfairygui-functions";
import { PreviewRecipeSchema, type PreviewRecipe, type PreviewRecipeInput, type PreviewRunInput, type PreviewState, type PreviewFrame, type PreviewFailure } from "../contracts/preview.js";
import { ERROR_CODES, fail, ok, type ErrorCode, type ResultEnvelope } from "../contracts/result.js";
import type { EditService } from "../edit/edit-service.js";
import type { ProjectRegistry } from "../project/project-registry.js";
import { projectSourceFileSystem, snapshotProject } from "../project/source-snapshot.js";
import { ProjectCommitCoordinator } from "../write/commit-coordinator.js";
import { PROJECT_SERVICE_INFO } from "../version.js";
import { CompilationCache } from "./compilation-cache.js";
import { PreviewExecutor, PreviewExecutorError } from "./preview-executor.js";

export interface PreviewSource { projectId: string; packageId: string; componentId: string; planId?: string | undefined; }
export type PreviewInput =
  | { action: "open" | "run"; source: PreviewSource; recipe?: PreviewRecipeInput | undefined; run?: PreviewRunInput | undefined; imageResult?: "inline" | "file" | "both" | undefined; includeFrames?: boolean | undefined }
  | { action: "run" | "inspect" | "capture" | "reset" | "reload" | "close"; previewId: string; run?: PreviewRunInput | undefined; properties?: string[] | undefined; selector?: string | undefined; imageResult?: "inline" | "file" | "both" | undefined; includeFrames?: boolean | undefined };
export interface PreviewData {
  previewId: string;
  status: "ready" | "failed" | "closed";
  source: PreviewSource;
  sourceStatus: "current" | "changed" | "plan";
  snapshotFingerprint: string;
  recipeHash: string;
  seed: number;
  runtimeVersions: typeof PROJECT_SERVICE_INFO.runtimeVersions;
  cacheHit: boolean;
  complete: boolean;
  state: PreviewState;
  frames: Array<Omit<PreviewFrame, "png"> & { path: string }>;
  contactSheet?: { path: string; width: number; height: number };
  images: Array<{ mimeType: "image/png"; data: string }>;
  error?: PreviewFailure;
}
interface Session {
  id: string; source: PreviewSource; snapshot: ProjectSnapshot; recipe: PreviewRecipe;
  executor: PreviewExecutor; lastUsed: number; state: PreviewState; failed: boolean; cacheHit: boolean;
}
interface Options { edits: EditService; temporaryRoot?: string; now?: () => number; runtimeTimeoutMs?: number; compileTimeoutMs?: number; }
export class PreviewService {
  private readonly sessions = new Map<string, Session>();
  private readonly queue = new ProjectCommitCoordinator();
  private readonly cache: CompilationCache;
  private readonly now: () => number;
  private readonly temporaryRoot: string;
  private readonly reaper: NodeJS.Timeout;
  constructor(private readonly registry: ProjectRegistry, private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.temporaryRoot = options.temporaryRoot ?? path.join(os.tmpdir(), "fairygui-mcp-headless", "previews");
    this.cache = new CompilationCache(options.compileTimeoutMs);
    this.reaper = setInterval(() => { void this.reapIdle(); }, 60000); this.reaper.unref();
  }
  get compilationCount(): number { return this.cache.compilationCount; }
  async reapIdle(): Promise<void> {
    for (const [id, session] of this.sessions) if (this.now() - session.lastUsed >= 15 * 60 * 1000) { this.sessions.delete(id); await session.executor.close(); }
  }
  async closeProject(projectId: string): Promise<void> {
    for (const [id, session] of this.sessions) if (session.source.projectId === projectId) { this.sessions.delete(id); await session.executor.close(); }
  }
  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.values()].map(session => session.executor.close()));
    this.sessions.clear(); this.cache.clear();
  }

  async execute(input: PreviewInput): Promise<ResultEnvelope<PreviewData>> {
    if (input.action === "close" && "previewId" in input) {
      const session = this.sessions.get(input.previewId);
      if (!session) return fail("PREVIEW_NOT_FOUND", "预览会话不存在或已回收");
      this.sessions.delete(session.id);
      await session.executor.close();
      return ok(await this.result(session, [], input, "closed"));
    }
    return this.queue.run("preview", async () => {
      await this.reapIdle();
      let session: Session | undefined;
      let ephemeral = false;
      try {
        if ("source" in input) {
          if (input.action === "open" && this.sessions.size >= 2) return fail("PREVIEW_SESSION_LIMIT", "最多保留两个持续预览会话", { suggestedFix: "关闭一个会话后重试" });
          session = await this.create(input.source, input.recipe ?? {});
          ephemeral = input.action === "run";
          if (!ephemeral) this.sessions.set(session.id, session);
        } else {
          session = this.sessions.get(input.previewId);
          if (!session) return fail("PREVIEW_NOT_FOUND", "预览会话不存在或已回收", { path: "previewId", actual: input.previewId });
        }
        session.lastUsed = this.now();
        if (input.action === "close") {
          this.sessions.delete(session.id); await session.executor.close();
          return ok(await this.result(session, [], input, "closed"));
        }
        if (input.action === "reset" || input.action === "reload") {
          const previous = session;
          const source = { ...session.source };
          if (input.action === "reload") delete source.planId;
          session = await this.create(source, session.recipe, input.action === "reset" ? session.snapshot : undefined, session.id);
          this.sessions.set(session.id, session); await previous.executor.close();
        }
        let frames: PreviewFrame[] = [];
        let error: PreviewFailure | undefined;
        if (input.action === "run") {
          if (session.failed) return fail("PREVIEW_FAILED", "预览会话处于失败状态", { suggestedFix: "检查状态，或使用 reset 重建会话" });
          const request = input.run ?? (ephemeral ? { times: [0] } : {});
          const run = await session.executor.run(request);
          frames = run.frames; session.state = run.state; session.failed = !run.complete; error = run.error;
        } else if (input.action === "capture") {
          if (!session.executor.alive) return fail("PREVIEW_FAILED", "失败会话的执行器已释放，需要先 reset");
          frames = [await session.executor.capture({ ...(input.properties ? { properties: input.properties } : {}), ...(input.selector ? { selector: input.selector } : {}) })];
          const { png, requestedTime, ...state } = frames[0]!;
          session.state = state;
        } else if (input.action === "inspect" && session.executor.alive) session.state = await session.executor.inspect({ ...(input.properties ? { properties: input.properties } : {}), ...(input.selector ? { selector: input.selector } : {}) });
        const result = await this.result(session, frames, input, session.failed ? "failed" : "ready");
        if (error) result.error = error;
        return ok(result);
      } catch (error) {
        if (session) session.failed = true;
        if (error instanceof ZodError) return fail("INVALID_ARGUMENT", "预览配方不符合字段契约", { actual: error.issues });
        if (error instanceof PreviewExecutorError || error instanceof DocumentEditError) return fail(ERROR_CODES.includes(error.code as ErrorCode) ? error.code as ErrorCode : "PREVIEW_EXECUTION_FAILED", error.message);
        return fail("PREVIEW_EXECUTION_FAILED", "预览执行失败", { actual: error instanceof Error ? error.message : String(error) });
      } finally { if (ephemeral) await session?.executor.close(); }
    });
  }

  private async create(source: PreviewSource, recipeInput: PreviewRecipeInput, fixed?: ProjectSnapshot, id = `preview_${randomUUID()}`): Promise<Session> {
    const status = this.registry.status(source.projectId);
    if (!status.ok) throw new PreviewExecutorError(status.error.code, status.error.message);
    const snapshot = fixed ?? (source.planId ? this.options.edits.getPlanSnapshot(source.projectId, source.planId) : await snapshotProject(status.data.projectFile));
    if (!snapshot) throw new PreviewExecutorError("PLAN_NOT_FOUND", "编辑计划不存在或已过期");
    const document = await snapshot.readDocument();
    const pkg = document.getRoot().getPackageById(source.packageId);
    if (!pkg) throw new PreviewExecutorError("PACKAGE_NOT_FOUND", "包不存在");
    const component = pkg.listComponents().find(item => item.getId() === source.componentId);
    if (!component) throw new PreviewExecutorError("COMPONENT_NOT_FOUND", "组件不存在");
    const recipe = PreviewRecipeSchema.parse({ ...recipeInput, environment: { width: Math.max(1, Math.ceil(component.getWidth())), height: Math.max(1, Math.ceil(component.getHeight())), ...recipeInput.environment } });
    const { runtime, cacheHit } = await this.cache.get(snapshot);
    const files = snapshot.fileSystem();
    const resources = await Promise.all(Object.entries(recipe.resources).map(async ([name, relativePath]) => {
      if (path.isAbsolute(relativePath) || relativePath.replace(/\\/g, "/").split("/").some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) throw new PreviewExecutorError("INVALID_SOURCE_PATH", "资源映射需要工程相对路径");
      const resourcePath = files.join(status.data.projectDirectory, relativePath);
      const extension = path.extname(relativePath).toLowerCase();
      const mediaType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json" } as Record<string, string>)[extension] ?? "application/octet-stream";
      return { name, data: await files.readFileRaw(resourcePath), mediaType };
    }));
    const executor = new PreviewExecutor(this.options.runtimeTimeoutMs ? { timeoutMs: this.options.runtimeTimeoutMs } : {});
    const state = await executor.initialize({ previewId: id, runtime, packageId: source.packageId, componentId: source.componentId, recipe, resources });
    return { id, source, snapshot, recipe, executor, state, lastUsed: this.now(), failed: false, cacheHit };
  }

  private async result(session: Session, frames: PreviewFrame[], input: PreviewInput, status: PreviewData["status"]): Promise<PreviewData> {
    const directory = path.join(this.temporaryRoot, session.id, randomUUID());
    if (frames.length) await mkdir(directory, { recursive: true });
    const indexed: PreviewData["frames"] = [];
    for (let index = 0; index < frames.length; index++) {
      const { png, ...state } = frames[index]!;
      const file = path.join(directory, `frame-${String(index).padStart(3, "0")}.png`);
      await writeFile(file, png); indexed.push({ ...state, path: file });
    }
    const result: PreviewData = {
      previewId: session.id, status, source: session.source,
      sourceStatus: session.source.planId ? "plan" : (await session.snapshot.changedSources(projectSourceFileSystem(path.dirname(session.snapshot.projectPath)))).length ? "changed" : "current",
      snapshotFingerprint: session.snapshot.fingerprint, recipeHash: createHash("sha256").update(JSON.stringify(session.recipe)).digest("hex"), seed: session.recipe.environment.seed,
      runtimeVersions: PROJECT_SERVICE_INFO.runtimeVersions, cacheHit: session.cacheHit, complete: !session.failed, state: session.state, frames: indexed, images: []
    };
    if (frames.length > 1) {
      const columns = Math.min(4, frames.length);
      const cellWidth = Math.min(480, Math.ceil(session.recipe.environment.width * session.recipe.environment.scale));
      const cellHeight = Math.max(1, Math.round(cellWidth * session.recipe.environment.height / session.recipe.environment.width));
      const width = columns * cellWidth; const height = Math.ceil(frames.length / columns) * (cellHeight + 28);
      const layers: sharp.OverlayOptions[] = [];
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!; const left = index % columns * cellWidth; const top = Math.floor(index / columns) * (cellHeight + 28);
        layers.push({ input: await sharp(frame.png).resize(cellWidth, cellHeight).png().toBuffer(), left, top });
        const label = `<svg width="${cellWidth}" height="28"><rect width="100%" height="100%" fill="#202534"/><text x="8" y="19" fill="white" font-family="Arial" font-size="13">${frame.time.toFixed(2)} ms · frame ${frame.frame}</text></svg>`;
        layers.push({ input: Buffer.from(label), left, top: top + cellHeight });
      }
      const png = await sharp({ create: { width, height, channels: 4, background: "#151923" } }).composite(layers).png().toBuffer();
      const file = path.join(directory, "contact-sheet.png"); await writeFile(file, png);
      result.contactSheet = { path: file, width, height };
      if (input.imageResult !== "file") result.images.push({ mimeType: "image/png", data: png.toString("base64") });
    }
    if (input.imageResult !== "file" && (frames.length === 1 || input.includeFrames)) for (const frame of frames) result.images.push({ mimeType: "image/png", data: Buffer.from(frame.png).toString("base64") });
    return result;
  }
}
