import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  files: string[];
};

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
