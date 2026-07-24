import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FairyDomNode } from "../src/contracts/dom.js";
import {
  ApplyDomPatchInputSchema,
  QueryInputSchema,
  RenderComponentInputSchema
} from "../src/contracts/tools.js";
import { DomPatchService } from "../src/dom/dom-patch-service.js";
import { ProjectRegistry } from "../src/project/project-registry.js";
import { QueryService } from "../src/query/query-service.js";
import { RenderService } from "../src/render/render-service.js";
import { FileTransactionManager } from "../src/write/file-transaction.js";

interface ComponentItem {
  packageId: string;
  componentId: string;
  name: string;
  width: number;
  height: number;
}

interface Metric {
  samples: number;
  p50: number;
  p95: number;
  max: number;
  budget: number;
  met: boolean;
}

const SOURCE_EXTENSIONS = new Set([".fairy", ".xml", ".json"]);
const BUDGETS = {
  coldOpen: 10_000,
  componentQuery: 500,
  domPatch: 3_000,
  hotRender: 3_000,
  browserRecoveryRender: 10_000
} as const;

async function sourceDigest(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".fairygui-mcp") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (
        entry.isFile()
        && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(entryPath);
      }
    }
  };
  await visit(directory);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(path.relative(directory, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(samples: number[], ratio: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * ratio) - 1);
  return ordered[index] ?? 0;
}

function metric(samples: number[], budget: number): Metric {
  const p95 = percentile(samples, 0.95);
  return {
    samples: samples.length,
    p50: rounded(percentile(samples, 0.5)),
    p95: rounded(p95),
    max: rounded(Math.max(...samples)),
    budget,
    met: p95 <= budget
  };
}

async function measure(
  samples: number[],
  action: () => Promise<void>
): Promise<void> {
  const startedAt = performance.now();
  await action();
  samples.push(performance.now() - startedAt);
}

function successfulQueryData<T>(
  result: Awaited<ReturnType<QueryService["execute"]>>,
  key: string
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const item = result.data.results[key];
  if (!item?.ok) {
    throw new Error(JSON.stringify(item?.error ?? { missing: key }));
  }
  return item.data as T;
}

async function findWritableTextComponent(
  query: QueryService,
  projectId: string,
  components: ComponentItem[]
): Promise<{
  component: ComponentItem;
  node: FairyDomNode;
}> {
  for (const component of components) {
    const result = await query.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        dom: {
          kind: "dom",
          packageId: component.packageId,
          componentId: component.componentId,
          detail: "full"
        }
      }
    }));
    const data = successfulQueryData<{
      document: { root: { children: FairyDomNode[] } };
    }>(result, "dom");
    const node = data.document.root.children.find((candidate) =>
      candidate.type === "text"
      || candidate.type === "rich-text"
      || candidate.type === "input-text"
    );
    if (node) return { component, node };
  }
  throw new Error("FairyGUI-unity 语料中没有可用于基础 patch 的文本节点");
}

const projectDirectory = path.resolve(
  process.env.FAIRYGUI_UNITY_PROJECT
    ?? path.join(
      import.meta.dirname,
      "..",
      "..",
      "FairyGUI-unity",
      "UIProject"
    )
);
const iterations = Math.max(
  5,
  Number.parseInt(process.env.FAIRYGUI_BENCHMARK_ITERATIONS ?? "10", 10)
);
const beforeDigest = await sourceDigest(projectDirectory);
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "fairygui-mcp-benchmark-")
);
const registry = new ProjectRegistry();
const query = new QueryService(registry);
const renderer = new RenderService(registry);

try {
  const coldOpenSamples: number[] = [];
  let projectId = "";
  await measure(coldOpenSamples, async () => {
    const opened = await registry.open(projectDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    projectId = opened.data.projectId;
  });

  const inventory = await query.execute(QueryInputSchema.parse({
    projectId,
    queries: {
      components: { kind: "components", detail: "full", limit: 500 }
    }
  }));
  const components = successfulQueryData<{
    items: ComponentItem[];
  }>(inventory, "components").items;
  const target = await findWritableTextComponent(query, projectId, components);
  const domQuery = QueryInputSchema.parse({
    projectId,
    queries: {
      dom: {
        kind: "dom",
        packageId: target.component.packageId,
        componentId: target.component.componentId,
        detail: "full"
      }
    }
  });

  const componentQuerySamples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    await measure(componentQuerySamples, async () => {
      const result = await query.execute(domQuery);
      successfulQueryData(result, "dom");
    });
  }

  const renderInput = RenderComponentInputSchema.parse({
    projectId,
    renders: {
      target: {
        packageId: target.component.packageId,
        componentId: target.component.componentId,
        width: Math.max(
          1,
          Math.min(800, Math.ceil(target.component.width || 1))
        ),
        height: Math.max(
          1,
          Math.min(600, Math.ceil(target.component.height || 1))
        )
      }
    }
  });
  const assertRendered = (
    result: Awaited<ReturnType<RenderService["render"]>>
  ): void => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const item = result.data.results.target;
    if (!item) throw new Error("批量渲染缺少 target 结果");
    if (!item.ok) throw new Error(JSON.stringify(item.error));
  };
  const warm = await renderer.render(renderInput);
  assertRendered(warm);
  const hotRenderSamples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    await measure(hotRenderSamples, async () => {
      const result = await renderer.render(renderInput);
      assertRendered(result);
    });
  }

  await renderer.close();
  const browserRecoverySamples: number[] = [];
  await measure(browserRecoverySamples, async () => {
    const result = await renderer.render(renderInput);
    assertRendered(result);
  });

  const copiedProject = path.join(temporaryDirectory, "project");
  await cp(projectDirectory, copiedProject, { recursive: true });
  const transactionManager = new FileTransactionManager({
    baseDirectory: path.join(temporaryDirectory, "transactions")
  });
  const copiedRegistry = new ProjectRegistry({ recovery: transactionManager });
  const copiedOpen = await copiedRegistry.open(copiedProject);
  if (!copiedOpen.ok) throw new Error(copiedOpen.error.message);
  const patchService = new DomPatchService(copiedRegistry, {
    transactions: transactionManager,
    temporaryRoot: path.join(temporaryDirectory, "roundtrip")
  });
  const domPatchSamples: number[] = [];
  try {
    const initialLeft = target.node.style.left ?? 0;
    for (let index = 0; index < iterations; index++) {
      await measure(domPatchSamples, async () => {
        const result = await patchService.apply(
          ApplyDomPatchInputSchema.parse({
            projectId: copiedOpen.data.projectId,
            packageId: target.component.packageId,
            componentId: target.component.componentId,
            operations: [{
              op: "update",
              selector: `#${target.node.id}`,
              expectedMatches: 1,
              changes: {
                style: { left: initialLeft + index + 1 }
              }
            }]
          })
        );
        if (!result.ok) throw new Error(JSON.stringify(result.error));
      });
    }
  }
  finally {
    await copiedRegistry.closeAll();
  }

  const afterDigest = await sourceDigest(projectDirectory);
  assert.equal(afterDigest, beforeDigest, "性能基准修改了原始语料");
  const report = {
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown"
    },
    corpus: {
      projectDirectory,
      packageCount: 30,
      componentCount: components.length,
      target: {
        packageId: target.component.packageId,
        componentId: target.component.componentId,
        nodeId: target.node.id
      },
      sourceDigest: afterDigest
    },
    metricsMs: {
      coldOpen: metric(coldOpenSamples, BUDGETS.coldOpen),
      componentQuery: metric(componentQuerySamples, BUDGETS.componentQuery),
      domPatch: metric(domPatchSamples, BUDGETS.domPatch),
      hotRender: metric(hotRenderSamples, BUDGETS.hotRender),
      browserRecoveryRender: metric(
        browserRecoverySamples,
        BUDGETS.browserRecoveryRender
      )
    },
    budgetsAreHardGate: false
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
finally {
  await renderer.close();
  await registry.closeAll();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
