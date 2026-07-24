import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-stdio-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="stdio-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="200,100">
  <displayList>
    <text id="n0" name="title" xy="10,10" size="180,40"
      text="stdio preview" fontSize="20"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: unknown;
}

class RawStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;
  private buffer = "";
  public readonly invalidStdoutLines: string[] = [];
  public readonly stderr: string[] = [];

  public constructor() {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath],
      {
        cwd: path.dirname(path.dirname(cliPath)),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    children.push(this.child);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `stdio MCP 提前退出：code=${String(code)}, signal=${String(signal)}`
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "stdio-contract-test",
        version: "1.0.0"
      }
    });
    this.notify("notifications/initialized", {});
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.request("tools/call", {
      name,
      arguments: args
    });
    assert.equal(response.error, undefined);
    const result = response.result as {
      structuredContent?: Record<string, unknown>;
    };
    assert.ok(result.structuredContent);
    return result.structuredContent;
  }

  public close(): void {
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }

  private request(
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })}\n`);
    return Promise.race([
      response,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(
            `等待 ${method} 超时；stderr=${this.stderr.join("")}`
          )),
          30_000
        ).unref();
      })
    ]);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      }
      catch {
        this.invalidStdoutLines.push(line);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      request.resolve(message);
    }
  }
}

test(
  "stdio CLI reserves stdout for JSON-RPC across render and later calls",
  { timeout: 60_000 },
  async () => {
    const projectDirectory = await createProject();
    const client = new RawStdioClient();
    try {
      await client.initialize();
      const opened = await client.callTool("fairygui.project", {
        action: "open",
        path: projectDirectory
      });
      assert.equal(opened.ok, true);
      const projectId = (opened.data as { projectId: string }).projectId;

      const rendered = await client.callTool("fairygui.render_component", {
        projectId,
        imageResult: "file",
        stateDetail: "summary",
        renders: {
          default: {
            packageId: "pkg00001",
            componentId: "cmp01"
          }
        }
      });
      assert.equal(rendered.ok, true);

      const publishDirectory = await mkdtemp(
        path.join(os.tmpdir(), "fgui-stdio-publish-")
      );
      temporaryDirectories.push(publishDirectory);
      const published = await client.callTool("fairygui.publish", {
        projectId,
        publishType: "definitions",
        outputPath: publishDirectory
      });
      assert.equal(published.ok, true);

      const validated = await client.callTool("fairygui.validate", {
        projectId,
        mode: "full",
        detail: "summary"
      });
      assert.equal(validated.ok, true);

      const status = await client.callTool("fairygui.project", {
        action: "status",
        projectId
      });
      assert.equal(status.ok, true);
      const closed = await client.callTool("fairygui.project", {
        action: "close",
        projectId
      });
      assert.equal(closed.ok, true);

      assert.deepEqual(
        client.invalidStdoutLines,
        [],
        `stdout 泄漏了非 JSON-RPC 内容：${client.invalidStdoutLines.join("\n")}`
      );
    }
    finally {
      client.close();
    }
  }
);
