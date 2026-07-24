import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SERVER_NAME
} from "../../src/index.js";

const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const skillPath = fileURLToPath(
  new URL("../../skills/fairygui-headless/SKILL.md", import.meta.url)
);
const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
const architecturePath = fileURLToPath(
  new URL("../../docs/architecture.md", import.meta.url)
);
const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const benchmarkPath = fileURLToPath(
  new URL("../../scripts/performance-baseline.ts", import.meta.url)
);
const packSmokePath = fileURLToPath(
  new URL("../../scripts/pack-smoke.ts", import.meta.url)
);
const publishWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/publish.yml", import.meta.url)
);
const sourceDirectory = fileURLToPath(new URL("../../src/", import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
};

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function hardCodedBackslashPathArguments(
  source: string,
  fileName: string
): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "path"
      && (
        node.expression.name.text === "join"
        || node.expression.name.text === "resolve"
      )
    ) {
      for (const argument of node.arguments) {
        if (
          (
            ts.isStringLiteral(argument)
            || ts.isNoSubstitutionTemplateLiteral(argument)
          )
          && argument.text.includes("\\")
        ) {
          matches.push(argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

test("package identity and executable contract remain stable", () => {
  assert.equal(manifest.name, "@magicskysword/fairygui-mcp-headless");
  assert.equal(manifest.version, "0.1.2");
  assert.equal(PACKAGE_NAME, manifest.name);
  assert.equal(PACKAGE_VERSION, manifest.version);
  assert.equal(SERVER_NAME, "fairygui-mcp-headless");
  assert.equal(manifest.bin[SERVER_NAME], "./dist/cli.js");
  assert.equal(manifest.engines.node, ">=24");
  assert.ok(manifest.files.includes("skills/"));
  assert.ok(manifest.files.includes("docs/"));
});

test("runtime dependencies use registry semver instead of sibling paths", () => {
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, name);
    assert.doesNotMatch(version, /^(?:file|link|workspace):/, name);
    assert.doesNotMatch(version, /[\\/]/, name);
  }
});

test("fork package ranges match the local V1 package contracts", () => {
  assert.equal(
    manifest.dependencies["@magicskysword/openfairygui-core"],
    "^0.2.2"
  );
  assert.equal(
    manifest.dependencies["@magicskysword/openfairygui-functions"],
    "^0.2.2"
  );
  assert.equal(
    manifest.dependencies["@magicskysword/fairygui-dom"],
    "^1.1.1"
  );
});

test("package ships an AI workflow skill and a portable stdio entry point", async () => {
  const [skill, cli] = await Promise.all([
    readFile(skillPath, "utf8"),
    readFile(cliPath, "utf8")
  ]);
  assert.match(skill, /^---\r?\nname: fairygui-headless\r?\n/m);
  assert.match(skill, /打开[\s\S]*批量查询[\s\S]*渲染[\s\S]*校验/);
  for (const toolName of [
    "fairygui.project",
    "fairygui.query",
    "fairygui.apply_dom_patch",
    "fairygui.apply_resource_operations",
    "fairygui.render_component",
    "fairygui.publish",
    "fairygui.validate"
  ]) {
    assert.match(skill, new RegExp(toolName.replace(".", "\\.")));
  }
  assert.ok(cli.startsWith("#!/usr/bin/env node"));
  assert.doesNotMatch(cli, /[A-Za-z]:\\\\|\\\\node_modules\\\\/);
});

test("source and runtime dependencies avoid Windows-only assumptions", async () => {
  const windowsOnlyPackages = new Set([
    "edge-js",
    "node-windows",
    "registry-js",
    "winax",
    "windows-shortcuts"
  ]);
  for (const dependency of Object.keys(manifest.dependencies)) {
    assert.equal(
      windowsOnlyPackages.has(dependency),
      false,
      `Windows-only dependency: ${dependency}`
    );
  }

  for (const filePath of await sourceFiles(sourceDirectory)) {
    const source = await readFile(filePath, "utf8");
    const logicalPath = path.relative(sourceDirectory, filePath)
      .split(path.sep)
      .join("/");
    assert.doesNotMatch(
      source,
      /["'`][A-Za-z]:[\\/](?:[^"'`\r\n]|\\.)*/u,
      `${logicalPath} contains a drive-letter path`
    );
    assert.doesNotMatch(
      source,
      /\b(?:cmd\.exe|powershell(?:\.exe)?|wscript\.exe|cscript\.exe)\b/iu,
      `${logicalPath} invokes a Windows shell`
    );
    assert.doesNotMatch(
      source,
      /process\.platform\s*={2,3}\s*["']win32["']/u,
      `${logicalPath} contains Windows-only business logic`
    );
    assert.deepEqual(
      hardCodedBackslashPathArguments(source, logicalPath),
      [],
      `${logicalPath} joins a hard-coded backslash path`
    );
  }
});

test("package exposes a non-gating FairyGUI-unity performance baseline", async () => {
  assert.equal(
    manifest.scripts["benchmark:corpus"],
    "node --import tsx scripts/performance-baseline.ts"
  );
  const benchmark = await readFile(benchmarkPath, "utf8");
  for (const metric of [
    "coldOpen",
    "componentQuery",
    "domPatch",
    "hotRender",
    "browserRecoveryRender"
  ]) {
    assert.match(benchmark, new RegExp(metric));
  }
  assert.match(benchmark, /p95/);
  assert.match(benchmark, /met/);
  assert.doesNotMatch(benchmark, /process\.exitCode\s*=\s*1/);
});

test("package exposes an isolated tarball installation smoke test", async () => {
  assert.equal(
    manifest.scripts["test:pack"],
    "node --import tsx scripts/pack-smoke.ts"
  );
  const smoke = await readFile(packSmokePath, "utf8");
  assert.match(smoke, /pnpm[\s\S]*pack/);
  assert.match(smoke, /link-workspace-packages=false/);
  assert.match(smoke, /StdioClientTransport/);
  for (const packageName of [
    "@magicskysword/openfairygui-core",
    "@magicskysword/openfairygui-functions",
    "@magicskysword/fairygui-dom",
    "@magicskysword/fairygui-mcp-headless"
  ]) {
    assert.match(smoke, new RegExp(packageName.replaceAll("/", "\\/")));
  }
});

test("npm trusted publishing builds fixed GitHub dependency sources", async () => {
  const workflow = await readFile(publishWorkflowPath, "utf8");

  assert.match(workflow, /tags:\s*\r?\n\s*-\s*["']npm-v\*["']/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /name:\s*Checkout Headless[\s\S]*path:\s*FairyGUI-MCP-Headless/);
  assert.match(
    workflow,
    /repository:\s*magicskysword\/OpenFairyGUI[\s\S]*ref:\s*["']v0\.2\.2["'][\s\S]*path:\s*OpenFairyGUI/
  );
  assert.match(
    workflow,
    /repository:\s*magicskysword\/FairyGUI-dom[\s\S]*ref:\s*["']v1\.1\.1["'][\s\S]*path:\s*FairyGUI-dom/
  );
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /version:\s*["']10\.14\.0["']/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version:\s*["']24["']/);
  assert.match(workflow, /package-manager-cache:\s*false/);
  assert.match(workflow, /FairyGUI-MCP-Headless\/package\.json/);
  assert.match(workflow, /-run\\\./);
  assert.match(workflow, /Verify source dependency versions/);
  assert.match(workflow, /pnpm --dir OpenFairyGUI install --frozen-lockfile/);
  assert.match(
    workflow,
    /pnpm --dir OpenFairyGUI --filter @magicskysword\/openfairygui-core build/
  );
  assert.match(
    workflow,
    /pnpm --dir OpenFairyGUI --filter @magicskysword\/openfairygui-functions build/
  );
  assert.match(workflow, /pnpm --dir FairyGUI-dom install --frozen-lockfile/);
  assert.match(workflow, /pnpm --dir FairyGUI-dom build/);
  assert.match(
    workflow,
    /pnpm --dir FairyGUI-MCP-Headless install --frozen-lockfile/
  );
  assert.doesNotMatch(workflow, /Wait for published dependencies/);
  assert.doesNotMatch(workflow, /dependency_tarballs/);
  assert.doesNotMatch(workflow, /npm install --ignore-scripts/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /pnpm --dir FairyGUI-MCP-Headless typecheck/);
  assert.match(workflow, /pnpm --dir FairyGUI-MCP-Headless test:implemented/);
  assert.match(workflow, /pnpm --dir FairyGUI-MCP-Headless build/);
  assert.match(workflow, /npm publish \. --access public/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|--provenance/);
});

test("shipped documentation explains installation, tools and V1 boundaries", async () => {
  const [readme, architecture] = await Promise.all([
    readFile(readmePath, "utf8"),
    readFile(architecturePath, "utf8")
  ]);
  for (const content of [readme, architecture]) {
    assert.match(content, /Node\.js 24/);
    assert.match(content, /Windows/);
    assert.match(content, /runtime-preview/);
    assert.match(content, /pnpm exec playwright install chromium/);
    for (const toolName of [
      "fairygui.project",
      "fairygui.query",
      "fairygui.apply_dom_patch",
      "fairygui.apply_resource_operations",
      "fairygui.render_component",
      "fairygui.publish",
      "fairygui.validate"
    ]) {
      assert.match(content, new RegExp(toolName.replace(".", "\\.")));
    }
  }
  assert.match(architecture, /SemVer/);
  assert.match(architecture, /pnpm-workspace\.yaml/);
  assert.match(architecture, /pnpm pack/);
  assert.match(architecture, /cascade-with-force-fallback/);
  assert.match(architecture, /7 天/);
  assert.match(architecture, /1 GiB/);
  assert.match(readme, /BROWSER_NOT_INSTALLED/);
});
