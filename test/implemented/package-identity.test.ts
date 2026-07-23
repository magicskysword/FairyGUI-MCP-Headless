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
const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const benchmarkPath = fileURLToPath(
  new URL("../../scripts/performance-baseline.ts", import.meta.url)
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
  assert.equal(PACKAGE_NAME, manifest.name);
  assert.equal(PACKAGE_VERSION, manifest.version);
  assert.equal(SERVER_NAME, "fairygui-mcp-headless");
  assert.equal(manifest.bin[SERVER_NAME], "./dist/cli.js");
  assert.equal(manifest.engines.node, ">=24");
  assert.ok(manifest.files.includes("skills/"));
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
    "^0.2.0"
  );
  assert.equal(
    manifest.dependencies["@magicskysword/openfairygui-functions"],
    "^0.2.0"
  );
  assert.equal(
    manifest.dependencies["@magicskysword/fairygui-dom"],
    "^1.1.0"
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
