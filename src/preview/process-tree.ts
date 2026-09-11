import { spawn, type ChildProcess } from "node:child_process";

export function processTreeTermination(pid: number, platform: NodeJS.Platform): { command: string; args: string[] } | { processGroup: number } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid worker PID");
  return platform === "win32" ? { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] } : { processGroup: -pid };
}

export async function terminateProcessTree(worker: ChildProcess): Promise<void> {
  if (!worker.pid || worker.exitCode !== null) return;
  const strategy = processTreeTermination(worker.pid, process.platform);
  if ("processGroup" in strategy) {
    try { process.kill(strategy.processGroup, "SIGKILL"); } catch { worker.kill("SIGKILL"); }
    return;
  }
  await new Promise<void>(resolve => {
    const killer = spawn(strategy.command, strategy.args, { windowsHide: true, stdio: "ignore" });
    killer.once("exit", () => resolve());
    killer.once("error", () => { worker.kill(); resolve(); });
  });
}
