import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { access } from "node:fs/promises";
import { terminateProcessTree } from "./process-tree.js";
import { PreviewRecipeSchema, PreviewRunSchema, type ExecutorInput, type PreviewFrame, type PreviewRunInput, type PreviewRunResult, type PreviewState } from "../contracts/preview.js";

export class PreviewExecutorError extends Error {
  public readonly path?: string;
  public readonly time?: number;
  constructor(public readonly code: string, message: string, location?: { path?: string; time?: number }) { super(message); this.name = "PreviewExecutorError"; if (location?.path !== undefined) this.path = location.path; if (location?.time !== undefined) this.time = location.time; }
}
export class PreviewExecutor {
  private worker: ChildProcess | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private pixels = 0;
  private readonly timeout: number;
  constructor(options: { timeoutMs?: number } = {}) { this.timeout = options.timeoutMs ?? 30000; }
  get alive(): boolean { return this.worker !== undefined && this.worker.exitCode === null && !this.worker.killed; }

  async initialize(input: ExecutorInput): Promise<PreviewState> {
    const recipe = PreviewRecipeSchema.parse(input.recipe);
    const executablePath = chromium.executablePath();
    try { await access(executablePath); } catch { throw new PreviewExecutorError("BROWSER_NOT_INSTALLED", "未找到预览浏览器，请安装 Playwright Chromium"); }
    this.pixels = Math.ceil(recipe.environment.width * recipe.environment.scale) * Math.ceil(recipe.environment.height * recipe.environment.scale);
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "DISPLAY"].filter(key => process.env[key]).map(key => [key, process.env[key]!]));
    const options: ForkOptions & { windowsHide: boolean } = { serialization: "advanced", windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"], env };
    this.worker = fork(fileURLToPath(new URL(`./preview-worker.${extension}`, import.meta.url)), [], options);
    this.worker.stderr?.on("data", () => {});
    this.worker.on("message", (message: { id: number; result?: unknown; error?: { code: string; message: string; path?: string; time?: number } }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new PreviewExecutorError(message.error.code, message.error.message, message.error));
      else pending.resolve(message.result);
    });
    this.worker.on("error", error => this.rejectPending(error));
    this.worker.on("exit", () => { this.rejectPending(new PreviewExecutorError("PREVIEW_WORKER_EXITED", "预览执行进程已结束")); this.worker = undefined; });
    try { return await this.command("initialize", { ...input, recipe, executablePath }); }
    catch (error) { await this.close(); throw error; }
  }
  async run(input: PreviewRunInput): Promise<PreviewRunResult> {
    const request = PreviewRunSchema.parse(input);
    if (request.times.length * this.pixels > 128000000) throw new PreviewExecutorError("PREVIEW_BUDGET_EXCEEDED", "累计采样像素超过 128 百万像素");
    return this.command("run", request);
  }
  inspect(input: { properties?: string[]; selector?: string } = {}): Promise<PreviewState> { return this.command("inspect", input); }
  capture(input: { properties?: string[]; selector?: string } = {}): Promise<PreviewFrame> { return this.command("capture", input); }

  private command<T>(action: string, data: unknown): Promise<T> {
    if (!this.alive) return Promise.reject(new PreviewExecutorError("PREVIEW_WORKER_EXITED", "预览执行进程不可用"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.close().finally(() => reject(new PreviewExecutorError("PREVIEW_TIMEOUT", "预览执行超过墙钟时间预算")));
      }, this.timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.worker!.send({ id, action, data }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.rejectPending(new PreviewExecutorError("PREVIEW_CLOSED", "预览已关闭"));
    await terminateProcessTree(worker);
  }
}
