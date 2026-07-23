import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCapability,
  requireWritableCapability
} from "../../src/contracts/capabilities.js";

const PLANNED_CONTRACTS = [
  "node.tree",
  "list.virtual",
  "layout.controller-gear",
  "animation.transition",
  "node.loader3d",
  "resource.skeleton",
  "extension.custom"
] as const;

for (const capabilityId of PLANNED_CONTRACTS) {
  test(`planned contract remains explicit and read-only: ${capabilityId}`, () => {
    const capability = getCapability(capabilityId);
    assert.deepEqual(capability, {
      id: capabilityId,
      state: "planned",
      access: "read-only",
      fidelity: capabilityId === "node.loader3d"
        || capabilityId === "resource.skeleton"
        ? "structural-preview"
        : "project-model"
    });
    const writable = requireWritableCapability(capabilityId);
    assert.equal(writable.ok, false);
    if (!writable.ok) {
      assert.equal(writable.error.code, "READ_ONLY_CAPABILITY");
      assert.deepEqual(writable.error.allowed, ["implemented/read-write"]);
    }
  });
}
