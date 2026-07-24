import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface PackedPackage {
  name: string;
  version: string;
  directory: string;
  tarball: string;
}

const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
const mcpDirectory = path.resolve(import.meta.dirname, "..");
const packages = [
  {
    name: "@magicskysword/openfairygui-core",
    version: "0.2.1",
    directory: path.join(workspaceRoot, "OpenFairyGUI", "packages", "core")
  },
  {
    name: "@magicskysword/openfairygui-functions",
    version: "0.2.1",
    directory: path.join(workspaceRoot, "OpenFairyGUI", "packages", "functions")
  },
  {
    name: "@magicskysword/fairygui-dom",
    version: "1.1.1",
    directory: path.join(workspaceRoot, "FairyGUI-dom")
  },
  {
    name: "@magicskysword/fairygui-mcp-headless",
    version: "0.1.1",
    directory: mcpDirectory
  }
] as const;

function pnpmCommand(args: string[]): {
  command: string;
  args: string[];
} {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("请通过 pnpm test:pack 运行发布冒烟测试");
  }
  return {
    command: process.execPath,
    args: [pnpmCli, ...args]
  };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(
        `命令失败 (${code ?? "signal"}): ${command} ${args.join(" ")}\n${
          stderr || stdout
        }`
      ));
    });
  });
}

async function runPnpm(args: string[], cwd: string): Promise<string> {
  const invocation = pnpmCommand(args);
  return run(invocation.command, invocation.args, cwd, {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
  });
}

function tarballSpec(filePath: string): string {
  return `file:${filePath.split(path.sep).join("/")}`;
}

async function buildAndPack(
  entry: Omit<PackedPackage, "tarball">,
  archiveDirectory: string
): Promise<PackedPackage> {
  await runPnpm(["run", "build"], entry.directory);
  const before = new Set(await readdir(archiveDirectory));
  await runPnpm(
    ["pack", "--pack-destination", archiveDirectory],
    entry.directory
  );
  const created = (await readdir(archiveDirectory))
    .filter((fileName) => fileName.endsWith(".tgz") && !before.has(fileName));
  if (created.length !== 1) {
    throw new Error(
      `${entry.name} 应生成一个 tarball，实际得到 ${created.length} 个`
    );
  }
  return {
    ...entry,
    tarball: path.join(archiveDirectory, created[0]!)
  };
}

function smokeProgram(): string {
  return `import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION
} from "@magicskysword/fairygui-mcp-headless";

assert.equal(PACKAGE_NAME, "@magicskysword/fairygui-mcp-headless");
assert.equal(PACKAGE_VERSION, "0.1.1");
const serverEntry = path.resolve(
  "node_modules",
  "@magicskysword",
  "fairygui-mcp-headless",
  "dist",
  "cli.js"
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  stderr: "pipe"
});
const client = new Client(
  { name: "pack-smoke", version: "1.0.0" },
  { capabilities: {} }
);
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "fairygui.project",
    "fairygui.query",
    "fairygui.apply_dom_patch",
    "fairygui.apply_resource_operations",
    "fairygui.render_component",
    "fairygui.publish",
    "fairygui.validate"
  ]);
  process.stdout.write(JSON.stringify({
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    tools: listed.tools.map((tool) => tool.name)
  }));
}
finally {
  await client.close();
}
`;
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "fairygui-mcp-pack-smoke-")
);
const relativeToTemp = path.relative(os.tmpdir(), temporaryRoot);
assert.ok(
  relativeToTemp !== ""
  && relativeToTemp !== ".."
  && !relativeToTemp.startsWith(`..${path.sep}`)
  && !path.isAbsolute(relativeToTemp),
  "发布冒烟临时目录必须位于 os.tmpdir() 内"
);
let completed = false;

try {
  const archiveDirectory = path.join(temporaryRoot, "archives");
  const installDirectory = path.join(temporaryRoot, "install");
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true });

  const packed: PackedPackage[] = [];
  for (const entry of packages) {
    packed.push(await buildAndPack(entry, archiveDirectory));
  }
  const byName = new Map(packed.map((entry) => [entry.name, entry]));
  const manifest = {
    name: "fairygui-mcp-pack-smoke",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@magicskysword/openfairygui-core": tarballSpec(
        byName.get("@magicskysword/openfairygui-core")!.tarball
      ),
      "@magicskysword/openfairygui-functions": tarballSpec(
        byName.get("@magicskysword/openfairygui-functions")!.tarball
      ),
      "@magicskysword/fairygui-dom": tarballSpec(
        byName.get("@magicskysword/fairygui-dom")!.tarball
      ),
      "@magicskysword/fairygui-mcp-headless": tarballSpec(
        byName.get("@magicskysword/fairygui-mcp-headless")!.tarball
      ),
      "@modelcontextprotocol/sdk": "^1.29.0"
    },
    pnpm: {
      overrides: {
        "@magicskysword/openfairygui-core": tarballSpec(
          byName.get("@magicskysword/openfairygui-core")!.tarball
        ),
        "@magicskysword/openfairygui-functions": tarballSpec(
          byName.get("@magicskysword/openfairygui-functions")!.tarball
        ),
        "@magicskysword/fairygui-dom": tarballSpec(
          byName.get("@magicskysword/fairygui-dom")!.tarball
        )
      }
    }
  };
  await writeFile(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(installDirectory, "smoke.mjs"),
    smokeProgram(),
    "utf8"
  );
  await runPnpm(
    [
      "install",
      "--config.link-workspace-packages=false",
      "--ignore-scripts"
    ],
    installDirectory
  );
  for (const entry of packed) {
    const installedManifest = JSON.parse(await readFile(
      path.join(
        installDirectory,
        "node_modules",
        ...entry.name.split("/"),
        "package.json"
      ),
      "utf8"
    )) as { name: string; version: string };
    assert.equal(installedManifest.name, entry.name);
    assert.equal(installedManifest.version, entry.version);
  }
  const smokeOutput = await run(
    process.execPath,
    ["smoke.mjs"],
    installDirectory
  );
  const smoke = JSON.parse(smokeOutput) as {
    packageName: string;
    packageVersion: string;
    tools: string[];
  };
  process.stdout.write(`${JSON.stringify({
    isolatedInstall: true,
    packed: packed.map((entry) => ({
      name: entry.name,
      version: entry.version,
      tarball: path.basename(entry.tarball)
    })),
    ...smoke
  }, null, 2)}\n`);
  completed = true;
}
finally {
  if (completed || process.env.KEEP_PACK_SMOKE !== "1") {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  else {
    process.stderr.write(`保留失败现场：${temporaryRoot}\n`);
  }
}
