import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  QueryInputSchema,
  RenderComponentInputSchema,
  ValidateInputSchema
} from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { QueryService } from "../../src/query/query-service.js";
import { RenderService } from "../../src/render/render-service.js";
import { ValidationService } from "../../src/validation/validation-service.js";

interface PackageItem {
  packageId: string;
  name: string;
  componentCount: number;
}

interface ComponentItem {
  packageId: string;
  componentId: string;
  name: string;
  width: number;
  height: number;
}

const sourceExtensions = new Set([".fairy", ".xml", ".json"]);

async function sourceDigest(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".fairygui-mcp") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (
        entry.isFile()
        && sourceExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(entryPath);
      }
    }
  };
  await visit(directory);
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(path.relative(directory, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function queryData<T>(
  result: Awaited<ReturnType<QueryService["execute"]>>,
  key: string
): T {
  if (!result.ok) throw new Error(result.error.message);
  assert.equal(result.ok, true, JSON.stringify(result));
  const item = result.data.results[key];
  if (!item) throw new Error(`query result is missing: ${key}`);
  if (!item.ok) throw new Error(item.error.message);
  assert.equal(item.ok, true, JSON.stringify(item));
  return item.data as T;
}

const projectDirectory = path.resolve(
  process.env.FAIRYGUI_UNITY_PROJECT
    ?? path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "FairyGUI-unity",
      "UIProject"
    )
);
const beforeDigest = await sourceDigest(projectDirectory);
const startedAt = performance.now();
const registry = new ProjectRegistry();
const query = new QueryService(registry);
const renderer = new RenderService(registry);
const validator = new ValidationService(registry);

try {
  const openStartedAt = performance.now();
  const opened = await registry.open(projectDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const openMs = performance.now() - openStartedAt;
  const projectId = opened.data.projectId;
  assert.equal(opened.data.packageCount, 30);

  const inventory = await query.execute(QueryInputSchema.parse({
    projectId,
    queries: {
      packages: { kind: "packages", limit: 100 },
      components: { kind: "components", limit: 500 }
    }
  }));
  const packagePage = queryData<{
    items: PackageItem[];
    total: number;
    nextCursor?: string;
  }>(inventory, "packages");
  const componentPage = queryData<{
    items: ComponentItem[];
    total: number;
    nextCursor?: string;
  }>(inventory, "components");
  assert.equal(packagePage.total, 30);
  assert.equal(packagePage.nextCursor, undefined);
  assert.equal(componentPage.nextCursor, undefined);

  const representatives = packagePage.items.map((pkg) => {
    const component = componentPage.items.find((item) =>
      item.packageId === pkg.packageId
    );
    assert.ok(component, `包 ${pkg.name} 没有可查询组件`);
    return component;
  });
  const projectionQueries = Object.fromEntries(
    representatives.map((component, index) => [
      `component_${index}`,
      {
        kind: "dom" as const,
        packageId: component.packageId,
        componentId: component.componentId,
        resolvedPreview: true
      }
    ])
  );
  const projections = await query.execute(QueryInputSchema.parse({
    projectId,
    queries: projectionQueries
  }));
  assert.equal(projections.ok, true, JSON.stringify(projections));

  const renderFailures: Array<{
    packageId: string;
    componentId: string;
    error: unknown;
  }> = [];
  const renderStartedAt = performance.now();
  let firstPngHash: string | undefined;
  for (const [index, component] of representatives.entries()) {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId,
      packageId: component.packageId,
      componentId: component.componentId,
      width: Math.max(1, Math.min(800, Math.ceil(component.width || 1))),
      height: Math.max(1, Math.min(600, Math.ceil(component.height || 1)))
    }));
    if (!result.ok) {
      renderFailures.push({
        packageId: component.packageId,
        componentId: component.componentId,
        error: result.error
      });
      continue;
    }
    assert.ok(result.data.image.data);
    const pngHash = createHash("sha256")
      .update(Buffer.from(result.data.image.data, "base64"))
      .digest("hex");
    if (index === 0) firstPngHash = pngHash;
  }
  assert.deepEqual(renderFailures, []);
  const renderMs = performance.now() - renderStartedAt;

  const first = representatives[0]!;
  const repeated = await renderer.render(RenderComponentInputSchema.parse({
    projectId,
    packageId: first.packageId,
    componentId: first.componentId,
    width: Math.max(1, Math.min(800, Math.ceil(first.width || 1))),
    height: Math.max(1, Math.min(600, Math.ceil(first.height || 1)))
  }));
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  if (repeated.ok) {
    assert.ok(repeated.data.image.data);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(repeated.data.image.data, "base64"))
        .digest("hex"),
      firstPngHash
    );
  }

  const quick = await validator.validate(ValidateInputSchema.parse({
    projectId,
    mode: "quick"
  }));
  assert.equal(quick.ok, true, JSON.stringify(quick));
  const afterDigest = await sourceDigest(projectDirectory);
  assert.equal(afterDigest, beforeDigest, "M1 只读闭环修改了工程源文件");

  process.stdout.write(`${JSON.stringify({
    projectDirectory,
    packageCount: packagePage.total,
    componentCount: componentPage.total,
    projectedComponentCount: representatives.length,
    renderedComponentCount: representatives.length,
    quickValid: quick.ok ? quick.data.valid : false,
    quickDiagnosticCount: quick.ok ? quick.data.diagnostics.length : 0,
    quickDiagnosticCodes: quick.ok
      ? [...new Set(quick.data.diagnostics.map((diagnostic) =>
        diagnostic.code
      ))].sort()
      : [],
    timingsMs: {
      open: Math.round(openMs * 100) / 100,
      renderRepresentatives: Math.round(renderMs * 100) / 100,
      total: Math.round((performance.now() - startedAt) * 100) / 100
    },
    sourceDigest: afterDigest
  }, null, 2)}\n`);
}
finally {
  await renderer.close();
  await registry.closeAll();
}
