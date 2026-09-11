import assert from "node:assert/strict";
import { test } from "node:test";
import { EditInputSchema, PreviewInputSchema, TOOL_INPUT_SCHEMAS } from "../../src/contracts/v2-tools.js";

test("six-tool contract validates native edits and required request identities", () => {
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS), ["fairygui.project", "fairygui.query", "fairygui.edit", "fairygui.preview", "fairygui.validate", "fairygui.publish"]);
  const edit = { action: "apply", projectId: "p", requestId: "one", operations: [{ op: "update", target: { kind: "node", packageId: "pkg", componentId: "cmp", nodeId: "n0" }, props: { x: 42, alpha: 0.5 } }] };
  assert.equal(EditInputSchema.safeParse(edit).success, true);
  assert.equal(EditInputSchema.safeParse({ ...edit, operations: [{ op: "import", target: { kind: "resource", packageId: "pkg" }, inboxPath: "image.png", clientRef: "image" }] }).success, true);
  assert.equal(EditInputSchema.safeParse({ ...edit, requestId: undefined }).success, false);
  assert.equal(EditInputSchema.safeParse({ ...edit, operations: [{ ...edit.operations[0], unexpected: true }] }).success, false);
  assert.equal(EditInputSchema.safeParse({ action: "commit", projectId: "p", requestId: "one", planId: "plan", operations: [] }).success, false);
});

test("preview contract separates source initialization, session actions and named batches", () => {
  const source = { projectId: "p", packageId: "pkg", componentId: "cmp" };
  assert.equal(PreviewInputSchema.safeParse({ action: "run", source, recipe: { setup: [{ op: "script", code: "ctx.root.x = 1" }] }, run: { times: [0, 100] } }).success, true);
  assert.equal(PreviewInputSchema.safeParse({ action: "inspect", previewId: "one", properties: ["x"] }).success, true);
  assert.equal(PreviewInputSchema.safeParse({ action: "inspect", previewId: "one", recipe: {} }).success, false);
  assert.equal(PreviewInputSchema.safeParse({ action: "run", source, previewId: "one" }).success, false);
  assert.equal(PreviewInputSchema.safeParse({ previews: { first: { action: "run", source }, second: { action: "capture", previewId: "one" } } }).success, true);
  assert.equal(PreviewInputSchema.safeParse({ previews: {} }).success, false);
});
