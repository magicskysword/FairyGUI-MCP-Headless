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
    version: "0.2.3",
    directory: path.join(workspaceRoot, "OpenFairyGUI", "packages", "core")
  },
  {
    name: "@magicskysword/openfairygui-functions",
    version: "0.2.3",
    directory: path.join(workspaceRoot, "OpenFairyGUI", "packages", "functions")
  },
  {
    name: "@magicskysword/fairygui-dom",
    version: "1.1.2",
    directory: path.join(workspaceRoot, "FairyGUI-dom")
  },
  {
    name: "@magicskysword/fairygui-mcp-headless",
    version: "0.1.3",
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

async function createSmokeProject(temporaryRoot: string): Promise<string> {
  const projectDirectory = path.join(temporaryRoot, "project");
  const packageDirectory = path.join(projectDirectory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(projectDirectory, "PackSmoke.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="pack-smoke-project" type="Unity" version="5.0"/>`,
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
<component size="320,180">
  <displayList>
    <text id="n0" name="title" xy="20,20" size="280,40"
      text="Pack smoke" fontSize="24"/>
  </displayList>
</component>`,
    "utf8"
  );
  return projectDirectory;
}

function smokeProgram(): string {
  return `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION
} from "@magicskysword/fairygui-mcp-headless";

assert.equal(PACKAGE_NAME, "@magicskysword/fairygui-mcp-headless");
assert.equal(PACKAGE_VERSION, "0.1.3");
const projectDirectory = process.env.FAIRYGUI_PACK_SMOKE_PROJECT;
assert.ok(projectDirectory, "缺少隔离冒烟工程路径");
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

function successful(result, label) {
  assert.ok(
    "structuredContent" in result,
    label + " 缺少 structuredContent"
  );
  const envelope = result.structuredContent;
  assert.notEqual(
    result.isError,
    true,
    label + " 返回 MCP isError: " + JSON.stringify(envelope)
  );
  assert.equal(envelope.ok, true, label + ": " + JSON.stringify(envelope));
  return envelope.data;
}

async function callTool(name, argumentsValue) {
  return successful(
    await client.callTool({ name, arguments: argumentsValue }),
    name
  );
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "fairygui.project",
    "fairygui.query",
    "fairygui.apply_dom_patch",
    "fairygui.apply_resource_operations",
    "fairygui.render_component",
    "fairygui.publish",
    "fairygui.validate"
  ]);

  const opened = await callTool("fairygui.project", {
    action: "open",
    path: projectDirectory
  });
  const projectId = opened.projectId;
  assert.ok(projectId);

  const queried = await callTool("fairygui.query", {
    projectId,
    queries: {
      packages: { kind: "packages", limit: 50 },
      compact: {
        kind: "components",
        packageId: "pkg00001",
        detail: "summary"
      },
      full: {
        kind: "dom",
        packageId: "pkg00001",
        componentId: "cmp01",
        detail: "full",
        instanceProjection: "none"
      }
    }
  });
  assert.deepEqual(Object.keys(queried.results), [
    "packages",
    "compact",
    "full"
  ]);
  for (const result of Object.values(queried.results)) {
    assert.equal(result.ok, true, JSON.stringify(result));
  }

  const resourceOperations = [
    {
      op: "create-package",
      clientRef: "widgets",
      name: "SmokeWidgets"
    },
    {
      op: "create-component",
      packageRef: "widgets",
      clientRef: "panel",
      name: "Panel",
      width: 320,
      height: 180
    }
  ];
  const resourcePreview = await callTool(
    "fairygui.apply_resource_operations",
    {
      projectId,
      dryRun: true,
      operations: resourceOperations
    }
  );
  assert.equal(resourcePreview.dryRun, true);
  assert.equal("transactionId" in resourcePreview, false);

  const resourceApplied = await callTool(
    "fairygui.apply_resource_operations",
    {
      projectId,
      dryRun: false,
      operations: resourceOperations
    }
  );
  assert.equal(resourceApplied.dryRun, false);
  assert.ok(resourceApplied.transactionId);
  const generatedPackageId = resourceApplied.clientRefs.widgets.packageId;
  const generatedComponentId =
    resourceApplied.clientRefs.panel.resourceId;
  assert.ok(generatedPackageId);
  assert.ok(generatedComponentId);

  const patched = await callTool("fairygui.apply_dom_patch", {
    projectId,
    packageId: generatedPackageId,
    componentId: generatedComponentId,
    operations: [
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "background",
        node: {
          type: "graph",
          name: "background",
          style: { width: 320, height: 180 },
          relations: [],
          content: {
            shape: "rectangle",
            fillColor: "#203040"
          }
        }
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "label",
        node: {
          type: "text",
          name: "label",
          style: {
            left: 20,
            top: 60,
            width: 280,
            height: 50
          },
          relations: [],
          content: {
            text: "Before update",
            fontSize: 24,
            color: "#FFFFFF"
          }
        }
      },
      {
        op: "update",
        targetRef: "label",
        expectedMatches: 1,
        changes: {
          name: "headline",
          style: { left: 24 },
          relations: [{
            targetId: "background",
            type: "Left_Left",
            percent: false
          }],
          content: { text: "Repository MCP smoke" }
        }
      }
    ]
  });
  assert.equal(patched.appliedOperations, 3);
  assert.deepEqual(
    patched.affectedNodeIds,
    [patched.clientRefs.background, patched.clientRefs.label]
  );
  assert.equal("dom" in patched, false);

  const patchedQuery = await callTool("fairygui.query", {
    projectId,
    queries: {
      full: {
        kind: "dom",
        packageId: generatedPackageId,
        componentId: generatedComponentId,
        detail: "full",
        instanceProjection: "none"
      }
    }
  });
  assert.equal(
    patchedQuery.results.full.ok,
    true,
    JSON.stringify(patchedQuery.results.full)
  );
  const patchedChildren =
    patchedQuery.results.full.data.document.root.children;
  assert.equal(patchedChildren.length, 2);
  const headline = patchedChildren.find((node) => node.name === "headline");
  assert.ok(headline);
  assert.equal(
    headline.content.text,
    "Repository MCP smoke"
  );

  const rendered = await callTool("fairygui.render_component", {
    projectId,
    imageResult: "file",
    stateDetail: "full",
    renders: {
      normal: {
        packageId: generatedPackageId,
        componentId: generatedComponentId,
        background: "#101820"
      },
      compact: {
        packageId: generatedPackageId,
        componentId: generatedComponentId,
        width: 160,
        height: 90,
        scale: 1
      }
    }
  });
  for (const key of ["normal", "compact"]) {
    const result = rendered.results[key];
    assert.equal(result.ok, true, JSON.stringify(result));
    const filePath = result.data.image.filePath;
    assert.ok(filePath);
    assert.equal(
      (await readFile(filePath)).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a"
    );
  }

  const published = await callTool("fairygui.publish", {
    projectId,
    packageIds: [generatedPackageId],
    publishType: "definitions",
    outputPath: "smoke-release"
  });
  assert.equal(published.publishType, "definitions");
  assert.equal(published.outputPathSource, "override");
  assert.ok(published.writtenFiles.length > 0);
  await readFile(published.writtenFiles[0].path);

  const validated = await callTool("fairygui.validate", {
    projectId,
    mode: "full",
    detail: "summary",
    packageIds: [generatedPackageId],
    componentIds: [generatedComponentId]
  });
  assert.equal(validated.valid, true, JSON.stringify(validated));

  const closed = await callTool("fairygui.project", {
    action: "close",
    projectId
  });
  assert.equal(closed.projectId, projectId);

  process.stdout.write(JSON.stringify({
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    tools: toolNames,
    workflow: {
      queried: Object.keys(queried.results),
      resourceDryRun: resourcePreview.dryRun,
      resourceApplied: resourceApplied.appliedOperations,
      patched: patched.appliedOperations,
      rendered: Object.keys(rendered.results),
      published: published.writtenFiles.length,
      valid: validated.valid,
      closed: closed.projectId
    }
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
  const projectDirectory = await createSmokeProject(temporaryRoot);
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
    installDirectory,
    {
      ...process.env,
      FAIRYGUI_PACK_SMOKE_PROJECT: projectDirectory
    }
  );
  const smoke = JSON.parse(smokeOutput) as {
    packageName: string;
    packageVersion: string;
    tools: string[];
    workflow: {
      queried: string[];
      resourceDryRun: boolean;
      resourceApplied: number;
      patched: number;
      rendered: string[];
      published: number;
      valid: boolean;
      closed: string;
    };
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
