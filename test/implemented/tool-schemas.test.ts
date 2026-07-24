import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  ApplyDomPatchInputSchema,
  ApplyResourceOperationsInputSchema,
  FAIRYGUI_TOOL_NAMES,
  InternalApplyDomPatchInputSchema,
  ProjectInputSchema,
  PublishInputSchema,
  QueryInputSchema,
  RenderComponentInputSchema,
  TOOL_INPUT_SCHEMAS,
  ValidateInputSchema
} from "../../src/contracts/tools.js";

function jsonSchemaDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  const children = Object.values(value as Record<string, unknown>);
  return children.length === 0
    ? depth
    : Math.max(...children.map((child) =>
        jsonSchemaDepth(child, depth + 1)
      ));
}

function namedSingleRenderArguments(
  input: Record<string, unknown>
): Record<string, unknown> {
  const {
    projectId,
    imageResult,
    stateDetail,
    ...request
  } = input;
  return {
    projectId,
    ...(imageResult === undefined ? {} : { imageResult }),
    ...(stateDetail === undefined ? {} : { stateDetail }),
    renders: { single: request }
  };
}

function parseSingleRenderSchema(input: Record<string, unknown>) {
  return RenderComponentInputSchema.parse(namedSingleRenderArguments(input));
}

function safeParseSingleRenderSchema(input: Record<string, unknown>) {
  return RenderComponentInputSchema.safeParse(
    namedSingleRenderArguments(input)
  );
}

test("public contract exposes exactly the seven MCP tools", () => {
  assert.deepEqual(FAIRYGUI_TOOL_NAMES, [
    "fairygui.project",
    "fairygui.query",
    "fairygui.apply_dom_patch",
    "fairygui.apply_resource_operations",
    "fairygui.render_component",
    "fairygui.publish",
    "fairygui.validate"
  ]);
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS), FAIRYGUI_TOOL_NAMES);
});

test("public tool schemas stay inside discovery size and depth budgets", () => {
  for (const [name, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
    const json = z.toJSONSchema(schema, {
      target: "draft-7",
      unrepresentable: "any",
      reused: "ref"
    });
    const bytes = Buffer.byteLength(JSON.stringify(json));
    assert.ok(
      bytes <= (name === "fairygui.apply_dom_patch" ? 8_192 : 16_384),
      `${name} public schema is ${bytes} bytes`
    );
    assert.ok(
      jsonSchemaDepth(json) <= 10,
      `${name} public schema depth is ${jsonSchemaDepth(json)}`
    );
  }
});

test("publish schema separates scope, type and one-off output override", () => {
  assert.deepEqual(PublishInputSchema.parse({
    projectId: "project-1"
  }), {
    projectId: "project-1",
    publishType: "full"
  });
  assert.deepEqual(PublishInputSchema.parse({
    projectId: "project-1",
    packageIds: ["pkg00001", "pkg00002"],
    publishType: "definitions",
    outputPath: " release/ui "
  }), {
    projectId: "project-1",
    packageIds: ["pkg00001", "pkg00002"],
    publishType: "definitions",
    outputPath: "release/ui"
  });
  assert.equal(PublishInputSchema.safeParse({
    projectId: "project-1",
    packageIds: []
  }).success, false);
  assert.equal(PublishInputSchema.safeParse({
    projectId: "project-1",
    packageIds: ["pkg00001", "pkg00001"]
  }).success, false);
  assert.equal(PublishInputSchema.safeParse({
    projectId: "project-1",
    compressed: true
  }).success, false);
});

test("project schema models open/list/status/close without loose fields", () => {
  assert.deepEqual(ProjectInputSchema.parse({
    action: "open",
    path: "D:/projects/Demo"
  }), {
    action: "open",
    path: "D:/projects/Demo"
  });
  assert.equal(ProjectInputSchema.safeParse({ action: "list" }).success, true);
  assert.equal(ProjectInputSchema.safeParse({
    action: "status",
    projectId: "project-1"
  }).success, true);
  assert.equal(ProjectInputSchema.safeParse({
    action: "close",
    projectId: "project-1"
  }).success, true);
  assert.equal(ProjectInputSchema.safeParse({
    action: "list",
    path: "unexpected"
  }).success, false);
});

test("query schema accepts named heterogeneous batches and rejects empty batches", () => {
  const input = {
    projectId: "project-1",
    queries: {
      packages: { kind: "packages", limit: 50 },
      mainDom: {
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
      capabilities: { kind: "capabilities", detail: "full" }
    }
  };

  assert.deepEqual(QueryInputSchema.parse(input), input);
  assert.deepEqual(QueryInputSchema.parse({
    projectId: "project-1",
    queries: {
      resources: { kind: "resources" },
      components: { kind: "components" },
      dom: {
        kind: "dom",
        packageId: "pkg00001",
        componentId: "cmp01"
      },
      capabilities: { kind: "capabilities" },
      audit: { kind: "audit" }
    }
  }), {
    projectId: "project-1",
    queries: {
      resources: { kind: "resources", detail: "summary" },
      components: { kind: "components", detail: "summary" },
      dom: {
        kind: "dom",
        packageId: "pkg00001",
        componentId: "cmp01",
        detail: "summary",
        instanceProjection: "none"
      },
      capabilities: { kind: "capabilities", detail: "summary" },
      audit: { kind: "audit", detail: "summary" }
    }
  });
  assert.equal(QueryInputSchema.safeParse({
    projectId: "project-1",
    queries: {}
  }).success, false);
  assert.equal(QueryInputSchema.safeParse({
    projectId: "project-1",
    queries: { invalid: { kind: "anything" } }
  }).success, false);
});

test("DOM patch schema requires expected match counts and one mutation mode", () => {
  const operations = {
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    operations: [
      {
        op: "set-style",
        selector: "#n0",
        expectedMatches: 1,
        changes: { left: 10, opacity: 0.5 }
      },
      {
        op: "set-text",
        targetRef: "new-image",
        expectedMatches: 1,
        text: "New title"
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "new-image",
        node: {
          type: "image",
          name: "hero",
          style: { left: 0, top: 0, width: 64, height: 64 },
          content: {},
          relations: []
        }
      }
    ]
  };

  assert.deepEqual(ApplyDomPatchInputSchema.parse(operations), operations);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      selector: "#n0"
    }]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      selector: "#n0",
      targetRef: "new-title",
      expectedMatches: 1
    }]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      expectedMatches: 1
    }]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...operations,
    replace: {
      domain: "displayTree",
      value: []
    }
  }).success, false);
});

test("DOM patch schema makes single targets and client references unambiguous", () => {
  const base = {
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01"
  };
  const newText = {
    type: "text" as const,
    name: "title",
    style: {},
    content: { text: "" },
    relations: []
  };

  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [{
      op: "insert",
      parentSelector: "component-root",
      expectedMatches: 2,
      clientRef: "title",
      node: newText
    }]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [{
      op: "move",
      selector: "text",
      expectedMatches: 2,
      toIndex: 0
    }]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "duplicate",
        node: newText
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "duplicate",
        node: newText
      }
    ]
  }).success, false);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [{
      op: "set-text",
      targetRef: "not-declared-in-this-batch",
      expectedMatches: 1,
      text: "No target"
    }]
  }).success, false);
});

test("replace mode permits one explicit content domain per call", () => {
  const base = {
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01"
  };
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: {
      domain: "displayTree",
      value: []
    }
  }).success, true);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: {
      domain: "relations",
      selector: "#n0",
      expectedMatches: 1,
      value: []
    }
  }).success, true);
  assert.equal(InternalApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: {
      domain: "relations",
      targetRef: "transient-reference",
      expectedMatches: 1,
      value: []
    }
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: [
      { domain: "displayTree", value: [] },
      { domain: "relations", value: [] }
    ]
  }).success, false);
});

test("resource operation schema fixes collision and deletion policies", () => {
  const input = {
    projectId: "project-1",
    operations: [
      {
        op: "create-package",
        clientRef: "new-package",
        name: "Inventory"
      },
      {
        op: "import",
        packageId: "pkg00001",
        clientRef: "sword",
        inboxPath: "icons/sword.png",
        name: "Sword",
        conflict: "reject"
      },
      {
        op: "delete-resource",
        packageId: "pkg00001",
        resourceId: "old01",
        mode: "cascade"
      }
    ]
  };

  assert.deepEqual(ApplyResourceOperationsInputSchema.parse(input), {
    ...input,
    dryRun: false
  });
  assert.equal(ApplyResourceOperationsInputSchema.parse({
    ...input,
    dryRun: true
  }).dryRun, true);
  assert.equal(ApplyResourceOperationsInputSchema.safeParse({
    projectId: "project-1",
    operations: [{
      op: "import",
      packageId: "pkg00001",
      clientRef: "icon",
      inboxPath: "icon.png",
      name: "Icon",
      conflict: "replace"
    }]
  }).success, false);
  assert.equal(ApplyResourceOperationsInputSchema.safeParse({
    projectId: "project-1",
    operations: []
  }).success, false);
  assert.equal(ApplyResourceOperationsInputSchema.safeParse({
    projectId: "project-1",
    operations: [{
      op: "move-resource",
      packageId: "pkg00001",
      targetPackageId: "pkg00002",
      resourceId: "item1",
      path: "/shared/"
    }]
  }).success, true);
});

test("render and validation schemas apply deterministic defaults and limits", () => {
  assert.deepEqual(parseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01"
  }), {
    projectId: "project-1",
    imageResult: "inline",
    stateDetail: "summary",
    renders: {
      single: {
        packageId: "pkg00001",
        componentId: "cmp01",
        scale: 1
      }
    }
  });
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    width: 10000
  }).success, false);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      controllers: [{
        selector: "component-root",
        expectedMatches: 1,
        controller: "mode",
        page: { index: 1 }
      }]
    }
  }).success, true);
  for (const selection of [
    { id: "page-1" },
    { name: "" }
  ]) {
    assert.equal(safeParseSingleRenderSchema({
      projectId: "project-1",
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "#panel",
          expectedMatches: 1,
          controller: "mode",
          page: selection
        }]
      }
    }).success, true);
  }
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      controllers: [{
        selector: "component-root",
        expectedMatches: 1,
        controller: "mode",
        page: { index: 1, id: "page-1" }
      }]
    }
  }).success, false);
  for (const selectedIndices of [
    [1],
    [0, 2],
    []
  ]) {
    assert.equal(safeParseSingleRenderSchema({
      projectId: "project-1",
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        lists: [{
          selector: 'list[name="items"]',
          expectedMatches: 1,
          selectedIndices
        }]
      }
    }).success, true);
  }
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      lists: [{
        selector: 'list[name="items"]',
        expectedMatches: 1,
        selectedIndices: [1, 1]
      }]
    }
  }).success, false);
  for (const treeState of [
    {
      expansions: [{ path: [0, 1], expanded: false }]
    },
    {
      selectedPath: [0, 1]
    },
    {
      selectedPath: null
    },
    {
      expansions: [{ path: [0], expanded: true }],
      selectedPath: [0, 1]
    }
  ]) {
    assert.equal(safeParseSingleRenderSchema({
      projectId: "project-1",
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        trees: [{
          selector: 'tree[name="outline"]',
          expectedMatches: 1,
          ...treeState
        }]
      }
    }).success, true);
  }
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      trees: [{
        selector: 'tree[name="outline"]',
        expectedMatches: 1
      }]
    }
  }).success, false);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      trees: [{
        selector: 'tree[name="outline"]',
        expectedMatches: 1,
        selectedPath: []
      }]
    }
  }).success, false);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      scrolls: [{
        selector: 'instance[name="viewport"]',
        expectedMatches: 1,
        position: { x: 24, y: 48 }
      }]
    }
  }).success, true);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      scrolls: [{
        selector: "component-root",
        expectedMatches: 1,
        position: {}
      }]
    }
  }).success, false);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    imageResult: "file",
    stateDetail: "full"
  }).success, true);
  assert.equal(safeParseSingleRenderSchema({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {}
  }).success, false);

  for (const mode of ["quick", "roundtrip", "publish", "full"]) {
    assert.deepEqual(ValidateInputSchema.parse({
      projectId: "project-1",
      mode
    }), {
      projectId: "project-1",
      mode,
      detail: "summary"
    });
  }
});

test("render schema exposes only the named batch form", () => {
  const input = {
    projectId: "project-1",
    renders: {
      defaultView: {
        packageId: "pkg00001",
        componentId: "cmp01"
      },
      selectedView: {
        packageId: "pkg00001",
        componentId: "cmp01",
        scale: 2,
        state: {
          controllers: [{
            selector: "component-root",
            expectedMatches: 1,
            controller: "mode",
            page: { name: "Selected" }
          }]
        }
      }
    }
  };
  assert.deepEqual(RenderComponentInputSchema.parse(input), {
    projectId: "project-1",
    imageResult: "inline",
    stateDetail: "summary",
    renders: {
      defaultView: {
        packageId: "pkg00001",
        componentId: "cmp01",
        scale: 1
      },
      selectedView: {
        packageId: "pkg00001",
        componentId: "cmp01",
        scale: 2,
        state: {
          controllers: [{
            selector: "component-root",
            expectedMatches: 1,
            controller: "mode",
            page: { name: "Selected" }
          }]
        }
      }
    }
  });
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01"
  }).success, false);
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    renders: {}
  }).success, false);
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    renders: Object.fromEntries(Array.from(
      { length: 21 },
      (_, index) => [`view${index}`, {
        packageId: "pkg00001",
        componentId: "cmp01"
      }]
    ))
  }).success, false);
});
