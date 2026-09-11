import { fork, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PreviewArtifacts, ProjectSnapshot } from "@magicskysword/openfairygui-functions";
import { PROJECT_SERVICE_INFO } from "../version.js";
import { terminateProcessTree } from "./process-tree.js";
import { PreviewExecutorError } from "./preview-executor.js";

async function compile(snapshot: ProjectSnapshot, timeoutMs: number): Promise<PreviewArtifacts> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]!]));
  const options: ForkOptions & { windowsHide: boolean } = { serialization: "advanced", windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"], env };
  const worker = fork(fileURLToPath(new URL(`./compile-worker.${extension}`, import.meta.url)), [], options);
  try {
    return await new Promise<PreviewArtifacts>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PreviewExecutorError("PREVIEW_COMPILE_TIMEOUT", "预览编译超过墙钟时间预算")), timeoutMs);
      worker.once("message", (message: { result?: PreviewArtifacts; error?: string }) => {
        clearTimeout(timer);
        if (message.result) resolve(message.result);
        else reject(new PreviewExecutorError("RUNTIME_COMPILE_FAILED", message.error ?? "运行时编译失败"));
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", () => { clearTimeout(timer); reject(new PreviewExecutorError("RUNTIME_COMPILE_FAILED", "运行时编译进程已退出")); });
      worker.send({ projectPath: snapshot.projectPath, files: snapshot.listFiles() });
    });
  } finally { await terminateProcessTree(worker); }
}
export class CompilationCache {
  private readonly entries = new Map<string, Promise<PreviewArtifacts>>();
  public compilationCount = 0;
  constructor(private readonly timeoutMs = 120000) {}
  async get(snapshot: ProjectSnapshot): Promise<{ runtime: PreviewArtifacts; cacheHit: boolean }> {
    const key = snapshot.fingerprint + JSON.stringify(PROJECT_SERVICE_INFO.runtimeVersions);
    const cached = this.entries.get(key);
    if (cached) return { runtime: await cached, cacheHit: true };
    this.compilationCount++;
    const compilation = compile(snapshot, this.timeoutMs);
    this.entries.set(key, compilation);
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    try { return { runtime: await compilation, cacheHit: false }; }
    catch (error) { this.entries.delete(key); throw error; }
  }
  clear(): void { this.entries.clear(); }
}
