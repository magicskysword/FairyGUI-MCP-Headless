import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplyDomPatchInputSchema,
  ApplyResourceOperationsInputSchema,
  FAIRYGUI_TOOL_NAMES,
  ProjectInputSchema,
  QueryInputSchema,
  RenderComponentInputSchema,
  TOOL_INPUT_SCHEMAS,
  ValidateInputSchema
} from "../../src/contracts/tools.js";

test("public contract exposes exactly the six V1 MCP tools", () => {
  assert.deepEqual(FAIRYGUI_TOOL_NAMES, [
    "fairygui.project",
    "fairygui.query",
    "fairygui.apply_dom_patch",
    "fairygui.apply_resource_operations",
    "fairygui.render_component",
    "fairygui.validate"
  ]);
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS), FAIRYGUI_TOOL_NAMES);
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
        resolvedPreview: true
      },
      refs: {
        kind: "references",
        packageId: "pkg00001",
        resourceId: "img01"
      },
      capabilities: { kind: "capabilities" }
    }
  };

  assert.deepEqual(QueryInputSchema.parse(input), input);
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
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      selector: "#n0"
    }]
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      selector: "#n0",
      targetRef: "new-title",
      expectedMatches: 1
    }]
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...operations,
    operations: [{
      op: "remove",
      expectedMatches: 1
    }]
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
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

  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [{
      op: "insert",
      parentSelector: "component-root",
      expectedMatches: 2,
      clientRef: "title",
      node: newText
    }]
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...base,
    operations: [{
      op: "move",
      selector: "text",
      expectedMatches: 2,
      toIndex: 0
    }]
  }).success, false);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
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
  assert.equal(ApplyDomPatchInputSchema.safeParse({
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
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: {
      domain: "displayTree",
      value: []
    }
  }).success, true);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
    ...base,
    replace: {
      domain: "relations",
      selector: "#n0",
      expectedMatches: 1,
      value: []
    }
  }).success, true);
  assert.equal(ApplyDomPatchInputSchema.safeParse({
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

  assert.deepEqual(ApplyResourceOperationsInputSchema.parse(input), input);
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
  assert.deepEqual(RenderComponentInputSchema.parse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01"
  }), {
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    scale: 1,
    saveToFile: false
  });
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    width: 10000
  }).success, false);
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      controllers: [{
        selector: "component-root",
        expectedMatches: 1,
        controller: "mode",
        selectedIndex: 1
      }]
    }
  }).success, true);
  for (const selection of [
    { pageId: "page-1" },
    { pageName: "" }
  ]) {
    assert.equal(RenderComponentInputSchema.safeParse({
      projectId: "project-1",
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "#panel",
          expectedMatches: 1,
          controller: "mode",
          ...selection
        }]
      }
    }).success, true);
  }
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      controllers: [{
        selector: "component-root",
        expectedMatches: 1,
        controller: "mode",
        selectedIndex: 1,
        pageId: "page-1"
      }]
    }
  }).success, false);
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      scrolls: [{
        selector: 'instance[name="viewport"]',
        expectedMatches: 1,
        x: 24,
        y: 48
      }]
    }
  }).success, true);
  assert.equal(RenderComponentInputSchema.safeParse({
    projectId: "project-1",
    packageId: "pkg00001",
    componentId: "cmp01",
    state: {
      scrolls: [{
        selector: "component-root",
        expectedMatches: 1
      }]
    }
  }).success, false);
  assert.equal(RenderComponentInputSchema.safeParse({
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
      mode
    });
  }
});
