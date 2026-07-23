import {
  fail,
  ok,
  type ResultEnvelope
} from "./result.js";

export type CapabilityState = "implemented" | "planned";
export type CapabilityAccess = "read-write" | "read-only";
export type CapabilityFidelity = "project-model" | "structural-preview";

export interface Capability {
  readonly id: string;
  readonly state: CapabilityState;
  readonly access: CapabilityAccess;
  readonly fidelity: CapabilityFidelity;
}

function capability(
  id: string,
  state: CapabilityState,
  access: CapabilityAccess,
  fidelity: CapabilityFidelity = "project-model"
): Capability {
  return Object.freeze({ id, state, access, fidelity });
}

export const CAPABILITY_REGISTRY: readonly Capability[] = Object.freeze([
  capability("node.image", "implemented", "read-write"),
  capability("node.text", "implemented", "read-write"),
  capability("node.rich-text", "implemented", "read-write"),
  capability("node.input-text", "implemented", "read-write"),
  capability("node.loader", "implemented", "read-write"),
  capability("node.graph", "implemented", "read-write"),
  capability("node.movie-clip", "implemented", "read-write"),
  capability("node.group", "implemented", "read-write"),
  capability("node.list-static", "implemented", "read-write"),
  capability("node.instance", "implemented", "read-write"),
  capability("node.component-root", "implemented", "read-write"),
  capability("layout.absolute", "implemented", "read-write"),
  capability("layout.relations", "implemented", "read-write"),
  capability("layout.component-overflow", "implemented", "read-write"),
  capability("layout.list-static", "implemented", "read-write"),
  capability("layout.group", "implemented", "read-write"),
  capability("resource.package", "implemented", "read-write"),
  capability("resource.component", "implemented", "read-write"),
  capability("resource.inbox-import", "implemented", "read-write"),
  capability("resource.reference-index", "implemented", "read-only"),
  capability("transaction.recovery", "implemented", "read-write"),
  capability(
    "render.structural-preview",
    "implemented",
    "read-only",
    "structural-preview"
  ),
  capability("validate.quick", "implemented", "read-only"),
  capability("validate.roundtrip", "implemented", "read-only"),
  capability("validate.publish", "implemented", "read-only"),
  capability("node.tree", "planned", "read-only"),
  capability("list.virtual", "planned", "read-only"),
  capability("layout.controller-gear", "planned", "read-only"),
  capability("animation.transition", "planned", "read-only"),
  capability(
    "node.loader3d",
    "planned",
    "read-only",
    "structural-preview"
  ),
  capability(
    "resource.skeleton",
    "planned",
    "read-only",
    "structural-preview"
  ),
  capability("extension.custom", "planned", "read-only")
]);

const CAPABILITIES_BY_ID = new Map(
  CAPABILITY_REGISTRY.map((entry) => [entry.id, entry] as const)
);

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES_BY_ID.get(id);
}

export function requireWritableCapability(
  id: string
): ResultEnvelope<Capability> {
  const capabilityEntry = getCapability(id);
  if (!capabilityEntry) {
    return fail("CAPABILITY_NOT_IMPLEMENTED", `未声明能力：${id}`, {
      path: "capability",
      actual: id,
      suggestedFix: "先查询 capabilities 获取当前能力矩阵"
    });
  }
  if (
    capabilityEntry.state !== "implemented"
    || capabilityEntry.access !== "read-write"
  ) {
    return fail("READ_ONLY_CAPABILITY", `能力 ${id} 当前只读`, {
      path: "capability",
      actual: capabilityEntry,
      allowed: ["implemented/read-write"],
      suggestedFix: "保留该结构但不要尝试写入，或选择已实现能力"
    });
  }
  return ok(capabilityEntry);
}

