import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY_REGISTRY,
  getCapability,
  requireWritableCapability
} from "../../src/contracts/capabilities.js";

test("capability registry has unique stable ids and explicit access", () => {
  const ids = CAPABILITY_REGISTRY.map((capability) => capability.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY));
  for (const capability of CAPABILITY_REGISTRY) {
    assert.ok(["implemented", "planned"].includes(capability.state));
    assert.ok(["read-write", "read-only"].includes(capability.access));
  }
});

test("V1 core nodes and layouts are writable while advanced domains are planned", () => {
  for (const id of [
    "node.image",
    "node.text",
    "node.rich-text",
    "node.input-text",
    "node.loader",
    "node.graph",
    "node.movie-clip",
    "node.group",
    "node.list-static",
    "node.instance",
    "node.component-root",
    "layout.absolute",
    "layout.relations",
    "layout.component-overflow",
    "layout.list-static",
    "layout.group"
  ]) {
    const result = requireWritableCapability(id);
    assert.equal(result.ok, true, id);
    if (result.ok) assert.equal(result.data.id, id);
  }

  for (const id of [
    "node.tree",
    "list.virtual",
    "layout.controller-gear",
    "animation.transition",
    "node.loader3d",
    "resource.skeleton",
    "extension.custom"
  ]) {
    const capability = getCapability(id);
    assert.equal(capability?.state, "planned", id);
    assert.equal(capability?.access, "read-only", id);
    assert.equal(requireWritableCapability(id).ok, false, id);
  }
});

test("unknown and planned capabilities return distinct stable errors", () => {
  assert.deepEqual(requireWritableCapability("missing"), {
    ok: false,
    error: {
      code: "CAPABILITY_NOT_IMPLEMENTED",
      message: "未声明能力：missing",
      path: "capability",
      actual: "missing",
      suggestedFix: "先查询 capabilities 获取当前能力矩阵"
    }
  });
  const planned = requireWritableCapability("node.tree");
  assert.equal(planned.ok ? undefined : planned.error.code, "READ_ONLY_CAPABILITY");
});
