import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { QueryInputSchema } from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { QueryService } from "../../src/query/query-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-query-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="query-project" type="DOM" version="5.0" mysteryProject="yes"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001" mysteryPackage="yes">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
    <component id="card1" name="Card.xml" path="/" exported="true"/>
    <image id="img01" name="hero.png" path="/"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="800,600" mysteryComponent="yes">
  <controller name="start" pages="0,hidden,1,shown" selected="0"/>
  <displayList>
    <image id="n0" name="hero" src="img01" xy="10,20" size="64,64">
      <gearDisplay controller="start" pages="0"/>
    </image>
    <text id="n1" name="title" xy="100,20" size="200,40" text="Hello">
      <gearDisplay controller="start" pages="1"/>
      <gearXY controller="start" pages="0,1" values="100,20|120,20"/>
      <gearSize controller="start" pages="0,1" values="200,40,1,1|240,40,1,1"/>
      <gearLook controller="start" pages="0,1" values="1,0,0,0|0.5,0,0,0"/>
      <gearColor controller="start" pages="0,1" values="#ffffff,#000000|#ff0000,#000000"/>
      <gearAni controller="start" pages="0,1" values="true,0|false,1"/>
      <gearText controller="start" pages="0,1" values="Hello|Shown"/>
      <gearIcon controller="start" pages="0,1" values="ui://pkg00001img01|ui://pkg00001img01"/>
      <gearDisplay2 controller="start" pages="0" condition="0"/>
      <gearFontSize controller="start" pages="0,1" values="12|18"/>
    </text>
    <component id="n2" name="card" src="card1" xy="100,100" size="100,50"/>
  </displayList>
</component>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Card.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,50">
  <displayList>
    <text id="n0" name="inside" xy="1,2" size="80,20" text="Inside"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function openService(): Promise<{
  registry: ProjectRegistry;
  service: QueryService;
  projectId: string;
}> {
  const directory = await createProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  return {
    registry,
    service: new QueryService(registry),
    projectId: opened.data.projectId
  };
}

test("named query batches return packages, resources, DOM, refs and capabilities", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const result = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        packages: { kind: "packages" },
        resources: {
          kind: "resources",
          packageId: "pkg00001",
          detail: "full"
        },
        components: {
          kind: "components",
          packageId: "pkg00001",
          detail: "full"
        },
        dom: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "cmp01",
          selector: 'text[name="title"]',
          detail: "full",
          instanceProjection: "full"
        },
        refs: {
          kind: "references",
          packageId: "pkg00001",
          resourceId: "img01"
        },
        capabilities: { kind: "capabilities", detail: "full" },
        audit: { kind: "audit", detail: "full" }
      }
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const results = result.data.results;
    assert.equal(results.packages?.ok, true);
    assert.equal(results.resources?.ok, true);
    assert.equal(results.components?.ok, true);
    assert.equal(results.dom?.ok, true, JSON.stringify(results.dom));
    assert.equal(results.refs?.ok, true);
    assert.equal(results.capabilities?.ok, true);
    assert.equal(results.audit?.ok, true);

    if (results.dom?.ok) {
      const data = results.dom.data as {
        matches: Array<{ id: string }>;
        projections: Array<{ instanceId: string; readOnly: true }>;
      };
      assert.deepEqual(data.matches.map((node) => node.id), ["n1"]);
      assert.deepEqual(data.projections.map((entry) => entry.instanceId), ["n2"]);
      assert.equal(data.projections[0]?.readOnly, true);
    }
    if (results.refs?.ok) {
      const data = results.refs.data as {
        items: Array<{ source: { objectId?: string } }>;
      };
      assert.deepEqual(
        data.items.map((item) => item.source.objectId),
        ["n0", "n1"]
      );
    }
    if (results.audit?.ok) {
      const data = results.audit.data as {
        total: number;
        items: Array<{ name: string }>;
      };
      assert.ok(data.total >= 3);
      assert.ok(data.items.some((item) => item.name === "mysteryComponent"));
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("one failed query preserves successful siblings in PARTIAL_QUERY_FAILURE", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const result = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        packages: { kind: "packages" },
        missing: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "missing"
        }
      }
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.warnings?.map((warning) => warning.code),
      ["PARTIAL_QUERY_FAILURE"]
    );
    assert.equal(result.data.results.packages?.ok, true);
    assert.equal(result.data.results.missing?.ok, false);
    assert.equal(
      result.data.results.missing?.ok
        ? undefined
        : result.data.results.missing?.error.code,
      "COMPONENT_NOT_FOUND"
    );
  }
  finally {
    await registry.closeAll();
  }
});

test("DOM query explains controllers, all gear types and effective visibility", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const result = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        dom: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "cmp01",
          detail: "full"
        }
      }
    }));

    assert.equal(result.ok, true);
    if (!result.ok || !result.data.results.dom?.ok) return;
    const stateModel = (result.data.results.dom.data as {
      stateModel: {
        controllers: Array<{
          name: string;
          selectedIndex: number;
          selectedPage: { id: string; name: string } | null;
          pages: Array<{ id: string; name: string }>;
        }>;
        gears: Array<{
          nodeId: string;
          type: string;
          controller: string | null;
          pages: string[];
          active: { status: string; pageId?: string; value?: unknown };
        }>;
        effectiveVisibility: Array<{
          nodeId: string;
          baseVisible: boolean;
          value: boolean | "unknown";
          hiddenBy: Array<{ type: string; controller: string | null }>;
        }>;
      };
    }).stateModel;

    assert.deepEqual(stateModel.controllers, [{
      name: "start",
      selectedIndex: 0,
      selectedPage: { id: "0", name: "hidden" },
      pages: [
        { id: "0", name: "hidden" },
        { id: "1", name: "shown" }
      ]
    }]);
    assert.deepEqual(
      stateModel.gears
        .filter((gear) => gear.nodeId === "n1")
        .map((gear) => gear.type),
      [
        "display",
        "xy",
        "size",
        "look",
        "color",
        "animation",
        "text",
        "icon",
        "display2",
        "font-size"
      ]
    );
    assert.deepEqual(
      stateModel.gears.find((gear) =>
        gear.nodeId === "n1" && gear.type === "text"
      )?.active,
      { status: "resolved", pageId: "0", value: "Hello" }
    );
    assert.deepEqual(
      stateModel.effectiveVisibility.map((entry) => ({
        nodeId: entry.nodeId,
        value: entry.value,
        hiddenBy: entry.hiddenBy.map((reason) => reason.type)
      })),
      [
        { nodeId: "n0", value: true, hiddenBy: [] },
        { nodeId: "n1", value: false, hiddenBy: ["display"] },
        { nodeId: "n2", value: true, hiddenBy: [] }
      ]
    );
  }
  finally {
    await registry.closeAll();
  }
});

test("pagination cursors are opaque, deterministic and query-kind scoped", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const first = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        resources: { kind: "resources", limit: 2 }
      }
    }));
    assert.equal(first.ok, true);
    if (!first.ok || !first.data.results.resources?.ok) return;
    const firstData = first.data.results.resources.data as {
      items: unknown[];
      returned: number;
      nextCursor?: string;
    };
    assert.equal(firstData.items.length, 2);
    assert.equal(firstData.returned, 2);
    assert.ok(firstData.nextCursor);

    const second = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        resources: {
          kind: "resources",
          limit: 2,
          cursor: firstData.nextCursor
        }
      }
    }));
    assert.equal(second.ok, true);
    if (second.ok && second.data.results.resources?.ok) {
      const data = second.data.results.resources.data as {
        items: unknown[];
        returned: number;
      };
      assert.equal(data.items.length, 1);
      assert.equal(data.returned, 1);
    }

    const wrongKind = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        packages: {
          kind: "packages",
          cursor: firstData.nextCursor
        }
      }
    }));
    assert.equal(wrongKind.ok, true);
    if (wrongKind.ok) {
      const result = wrongKind.data.results.packages;
      assert.equal(result?.ok, false);
      assert.equal(
        result?.ok ? undefined : result?.error.code,
        "INVALID_ARGUMENT"
      );
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("large queries default to compact summaries and expose full detail explicitly", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const summary = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        resources: { kind: "resources", packageId: "pkg00001" },
        components: { kind: "components", packageId: "pkg00001" },
        dom: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "cmp01"
        },
        capabilities: { kind: "capabilities" },
        audit: { kind: "audit" }
      }
    }));
    assert.equal(summary.ok, true);
    if (!summary.ok) return;

    const resources = summary.data.results.resources;
    assert.equal(resources?.ok, true);
    if (resources?.ok) {
      const item = (resources.data as {
        items: Array<Record<string, unknown>>;
        returned: number;
      }).items[0]!;
      assert.deepEqual(Object.keys(item).sort(), [
        "name",
        "packageId",
        "resourceId",
        "type"
      ]);
      assert.equal((resources.data as { returned: number }).returned, 3);
    }

    const components = summary.data.results.components;
    assert.equal(components?.ok, true);
    if (components?.ok) {
      const item = (components.data as {
        items: Array<Record<string, unknown>>;
      }).items[0]!;
      assert.deepEqual(Object.keys(item).sort(), [
        "componentId",
        "name",
        "packageId"
      ]);
    }

    const dom = summary.data.results.dom;
    assert.equal(dom?.ok, true);
    if (dom?.ok) {
      const data = dom.data as {
        document: {
          root: {
            childCount: number;
            children: Array<Record<string, unknown>>;
          };
        };
        stateModel: {
          gears: Array<Record<string, unknown>>;
        };
        projections?: unknown;
      };
      assert.equal(data.document.root.childCount, 3);
      assert.equal(data.document.root.children.length, 3);
      assert.equal("content" in data.document.root.children[0]!, false);
      assert.equal("values" in data.stateModel.gears[0]!, false);
      assert.equal("pageValues" in data.stateModel.gears[0]!, false);
      assert.equal(data.projections, undefined);
    }

    const capabilities = summary.data.results.capabilities;
    assert.equal(capabilities?.ok, true);
    if (capabilities?.ok) {
      const item = (capabilities.data as {
        items: Array<Record<string, unknown>>;
      }).items[0]!;
      assert.equal("fidelity" in item, false);
    }

    const audit = summary.data.results.audit;
    assert.equal(audit?.ok, true);
    if (audit?.ok) {
      const data = audit.data as Record<string, unknown>;
      assert.equal(typeof data.total, "number");
      assert.equal(typeof data.counts, "object");
      assert.equal("items" in data, false);
    }

    const full = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        resources: {
          kind: "resources",
          packageId: "pkg00001",
          detail: "full"
        },
        components: {
          kind: "components",
          packageId: "pkg00001",
          detail: "full"
        },
        dom: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "cmp01",
          detail: "full",
          instanceProjection: "summary"
        },
        capabilities: { kind: "capabilities", detail: "full" },
        audit: {
          kind: "audit",
          detail: "full",
          packageId: "pkg00001",
          componentId: "cmp01",
          sourceKinds: ["component"],
          findingKinds: ["attribute"],
          nameContains: "mystery",
          pathContains: "component"
        }
      }
    }));
    assert.equal(full.ok, true);
    if (!full.ok) return;

    const fullResources = full.data.results.resources;
    if (fullResources?.ok) {
      const item = (fullResources.data as {
        items: Array<Record<string, unknown>>;
      }).items[0]!;
      assert.equal("path" in item, true);
      assert.equal("exported" in item, true);
    }
    const fullComponents = full.data.results.components;
    if (fullComponents?.ok) {
      const item = (fullComponents.data as {
        items: Array<Record<string, unknown>>;
      }).items[0]!;
      assert.equal("width" in item, true);
      assert.equal("height" in item, true);
    }
    const fullDom = full.data.results.dom;
    if (fullDom?.ok) {
      const data = fullDom.data as {
        document: { root: { children: Array<{ content: unknown }> } };
        stateModel: { gears: Array<Record<string, unknown>> };
        projections: Array<{
          component: { nodeCount: number };
          dom?: unknown;
        }>;
      };
      assert.equal("content" in data.document.root.children[0]!, true);
      assert.equal("values" in data.stateModel.gears[0]!, true);
      assert.equal(data.projections[0]?.component.nodeCount, 1);
      assert.equal("dom" in data.projections[0]!, false);
    }
    const fullCapabilities = full.data.results.capabilities;
    if (fullCapabilities?.ok) {
      const item = (fullCapabilities.data as {
        items: Array<Record<string, unknown>>;
      }).items[0]!;
      assert.equal("fidelity" in item, true);
    }
    const fullAudit = full.data.results.audit;
    if (fullAudit?.ok) {
      const data = fullAudit.data as {
        total: number;
        returned: number;
        items: Array<{
          sourceKind: string;
          kind: string;
          name: string;
        }>;
      };
      assert.equal(data.total, 1);
      assert.equal(data.returned, 1);
      assert.deepEqual(data.items.map((item) => ({
        sourceKind: item.sourceKind,
        kind: item.kind,
        name: item.name
      })), [{
        sourceKind: "component",
        kind: "attribute",
        name: "mysteryComponent"
      }]);
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("invalid DOM selectors fail only their named query", async () => {
  const { registry, service, projectId } = await openService();
  try {
    const result = await service.execute(QueryInputSchema.parse({
      projectId,
      queries: {
        invalidSelector: {
          kind: "dom",
          packageId: "pkg00001",
          componentId: "cmp01",
          selector: "text:first-child"
        },
        capabilities: { kind: "capabilities" }
      }
    }));

    assert.equal(result.ok, true);
    if (result.ok) {
      const invalidSelector = result.data.results.invalidSelector;
      assert.equal(invalidSelector?.ok, false);
      assert.equal(
        invalidSelector?.ok ? undefined : invalidSelector?.error.code,
        "INVALID_SELECTOR"
      );
      assert.equal(result.data.results.capabilities?.ok, true);
    }
  }
  finally {
    await registry.closeAll();
  }
});
