#!/usr/bin/env node

import { Console } from "node:console";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FairyGuiMcpServer } from "./server/fairygui-server.js";

function reserveStdoutForJsonRpc(): void {
  globalThis.console = new Console({
    stdout: process.stderr,
    stderr: process.stderr,
    colorMode: false
  });
}

async function main(): Promise<void> {
  reserveStdoutForJsonRpc();
  const app = new FairyGuiMcpServer();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  await app.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});
