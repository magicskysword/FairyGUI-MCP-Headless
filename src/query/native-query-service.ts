import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORING_GEAR_FIELDS, buildProjectReferenceGraph, DocumentEditError, inspectOpaqueProjectXml, parseURL, readAuthoringProperties, readComponentXmlFragment, resolveAuthoringTarget, type AuthoringTarget, type Component, type Document, type GObject, type Property, type ProjectReferenceEdge } from "@magicskysword/openfairygui-core";
import { NativeQueryInputSchema, type NativeQueryInput, type NativeQueryRequest } from "../contracts/native-query.js";
import { ERROR_CODES, fail, ok, type ErrorCode, type ResultEnvelope } from "../contracts/result.js";
import type { ProjectRegistry } from "../project/project-registry.js";

export const SKILL_DIRECTORY = fileURLToPath(new URL("../../skills/fairygui-headless/", import.meta.url));
export const SKILL_ENTRY = path.join(SKILL_DIRECTORY, "SKILL.md");
const gearFields = AUTHORING_GEAR_FIELDS;
interface PageData { items: unknown[]; total: number; nextCursor?: string; }
export interface NativeQueryData { requested: number; succeeded: number; failed: number; results: Record<string, ResultEnvelope<PageData>>; }
function projectTarget(owner: Property, target: AuthoringTarget): AuthoringTarget {
  const object = owner as unknown as { getId?: () => string };
  const result = { ...target };
  if (target.kind === "node") result.nodeId = object.getId!();
  return result;
}
function projectObject(document: Document, owner: Property, target: AuthoringTarget, full: boolean): unknown {
  const resolved = projectTarget(owner, target);
  const value: Record<string, unknown> = { target: resolved, type: owner.propertyType, name: owner.getName(), definition: { file: path.join(SKILL_DIRECTORY, "definitions", "authoring", `${owner.propertyType}.schema.json`), symbol: owner.propertyType } };
  if (!full) return value;
  const props = readAuthoringProperties(owner);
  value.props = props;
  const object = owner as unknown as Record<string, unknown>;
  const scopedProperties = new Set<string>();
  if (typeof object.listGears === "function") {
    value.gears = (owner as GObject).listGears().map((gear, index) => {
      for (const field of gearFields[gear.getGearType()] ?? []) scopedProperties.add(field);
      return { target: { ...resolved, kind: "gear", index }, type: gear.getGearType(), controller: gear.getController()?.getName() ?? null, ...readAuthoringProperties(gear) };
    });
  }
  value.writable = { properties: Object.keys(props), scopedProperties: [...scopedProperties], definition: path.join(SKILL_DIRECTORY, "definitions", "authoring", "operations.schema.json") };
  if (typeof object.listPages === "function") value.pages = (object.listPages as () => Array<{ getId(): string; getName(): string }>).call(owner).map(page => ({ id: page.getId(), name: page.getName() }));
  if (typeof object.listActions === "function") value.actions = (object.listActions as () => Property[]).call(owner).map(readAuthoringProperties);
  if (typeof object.listItems === "function") value.items = (object.listItems as () => Property[]).call(owner).map(readAuthoringProperties);
  const src = props.src;
  if (typeof src === "string" && src) {
    const ref = parseURL(src) ?? { packageId: String(props.packageId || target.packageId), resourceId: src };
    const source = document.getRoot().getPackageById(ref.packageId)?.getResourceById(ref.resourceId);
    if (source) value.source = { kind: source.propertyType === "Component" ? "component" : "resource", packageId: ref.packageId, ...(source.propertyType === "Component" ? { componentId: ref.resourceId } : { resourceId: ref.resourceId }), type: source.propertyType, name: source.getName() };
  }
  return value;
}
function component(document: Document, scope: { packageId: string; componentId: string }): Component {
  return resolveAuthoringTarget(document, { kind: "component", packageId: scope.packageId, componentId: scope.componentId })[0] as Component;
}
function selects(object: GObject, selector: string): boolean {
  const id = /^#([\w-]+)$/.exec(selector); if (id) return object.getId() === id[1];
  const name = /^(?:([\w-]+))?\[name=["']([^"']*)["']\]$/.exec(selector); if (name) return object.getName() === name[2] && (!name[1] || object.propertyType === name[1]);
  if (/^[A-Za-z][\w-]*$/.test(selector)) return object.propertyType === selector;
  throw new DocumentEditError("INVALID_SELECTOR", "原生选择器格式无效", "selector");
}
function referenceMatches(edge: ProjectReferenceEdge, target: AuthoringTarget, direction: "incoming" | "outgoing" | "both"): boolean {
  const incoming = edge.target.packageId === target.packageId && (target.kind === "package" || (
    (target.componentId === undefined || edge.target.componentId === target.componentId || (edge.target.kind === "resource" && edge.target.id === target.componentId))
    && (target.nodeId === undefined || edge.target.id === target.nodeId)
    && (target.resourceId === undefined || edge.target.id === target.resourceId)
    && (target.controllerName === undefined || (target.kind === "page" ? edge.target.controller : edge.target.id) === target.controllerName)
    && (target.pageId === undefined || edge.target.id === target.pageId)
    && (target.transitionName === undefined || edge.target.id === target.transitionName)));
  const outgoing = edge.source.packageId === target.packageId && (target.componentId === undefined || edge.source.componentId === target.componentId) && (target.resourceId === undefined || (edge.source.resourceId ?? edge.source.componentId) === target.resourceId) && (target.nodeId === undefined || edge.source.nodeId === target.nodeId) && (target.controllerName === undefined || edge.source.controller === target.controllerName) && (target.transitionName === undefined || edge.source.transition === target.transitionName);
  return (direction !== "outgoing" && incoming) || (direction !== "incoming" && outgoing);
}
function values(document: Document, request: NativeQueryRequest): unknown[] {
  const full = request.detail === "full";
  const root = document.getRoot();
  if (request.kind === "packages") return root.listPackages().map(pkg => ({ ...projectObject(document, pkg, { kind: "package", packageId: pkg.getId() }, full) as object, resourceCount: pkg.listResources().length, componentCount: pkg.listComponents().length }));
  if (request.kind === "resources" || request.kind === "components") {
    const packages = request.packageId ? [resolveAuthoringTarget(document, { kind: "package", packageId: request.packageId })[0] as ReturnType<typeof root.listPackages>[number]] : root.listPackages();
    return packages.flatMap(pkg => pkg.listResources().filter(resource => (request.kind !== "components" || resource.propertyType === "Component") && (!request.types || request.types.includes(resource.propertyType)) && (!request.nameContains || resource.getName().includes(request.nameContains))).map(resource => projectObject(document, resource, { kind: resource.propertyType === "Component" ? "component" : "resource", packageId: pkg.getId(), ...(resource.propertyType === "Component" ? { componentId: resource.getId() } : { resourceId: resource.getId() }) }, full)));
  }
  if (request.kind === "nodes" || request.kind === "controllers" || request.kind === "transitions" || request.kind === "gears") {
    const owner = component(document, request);
    const scope = { packageId: request.packageId, componentId: request.componentId };
    if (request.kind === "controllers") return owner.listControllers().map(item => projectObject(document, item, { kind: "controller", ...scope, controllerName: item.getName() }, full));
    if (request.kind === "transitions") return owner.listTransitions().map(item => projectObject(document, item, { kind: "transition", ...scope, transitionName: item.getName() }, full));
    const nodes = owner.listChildren().filter(node => (!request.nodeId || node.getId() === request.nodeId) && (!request.selector || selects(node, request.selector)));
    if (request.kind === "gears") return nodes.flatMap(node => node.listGears().map((gear, index) => ({ ...projectObject(document, gear, { kind: "gear", ...scope, nodeId: node.getId(), index }, full) as object, controller: gear.getController()?.getName() ?? null })));
    return nodes.map(node => projectObject(document, node, { kind: "node", ...scope, nodeId: node.getId() }, full));
  }
  if (request.kind === "object") return resolveAuthoringTarget(document, request.target).map(owner => projectObject(document, owner, request.target, full));
  if (request.kind === "xml") {
    const owner = component(document, { packageId: request.target.packageId!, componentId: request.target.componentId! });
    return [{ target: request.target, xml: readComponentXmlFragment(String(owner.getExtras()._sourceComponentXml ?? ""), request.target) }];
  }
  if (request.kind === "references") return buildProjectReferenceGraph(document).edges.filter(edge => referenceMatches(edge, request.target, request.direction));
  if (request.kind === "audit") {
    const findings: unknown[] = buildProjectReferenceGraph(document).diagnostics.filter(item => (!request.packageId || item.path.includes(request.packageId)) && (!request.componentId || item.path.includes(request.componentId)));
    for (const pkg of root.listPackages()) for (const item of pkg.listComponents()) {
      if ((request.packageId && pkg.getId() !== request.packageId) || (request.componentId && item.getId() !== request.componentId)) continue;
      const source = item.getExtras()._sourceComponentXml;
      if (typeof source === "string") findings.push(...inspectOpaqueProjectXml("component", source).map(finding => ({ packageId: pkg.getId(), componentId: item.getId(), ...finding })));
    }
    return findings;
  }
  return [{ domain: "authoring", model: "native", maxOperations: 200, planTtlMs: 1800000, xmlFragmentBytes: 1048576, definitions: path.join(SKILL_DIRECTORY, "definitions", "index.json") }, { domain: "preview", clock: ["manual", "realtime"], maxFrames: 64, maxSimulationMs: 60000, maxPersistentSessions: 2, sessionIdleTtlMs: 900000 }];
}
function paginate(items: unknown[], request: NativeQueryRequest): PageData {
  const { cursor, limit, ...query } = request;
  const key = createHash("sha256").update(JSON.stringify(query)).digest("hex");
  let offset = 0;
  if (cursor) {
    try { const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (decoded.key !== key || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error(); offset = decoded.offset; }
    catch { throw new DocumentEditError("INVALID_ARGUMENT", "分页游标与查询不匹配", "cursor"); }
  }
  const result: PageData = { items: items.slice(offset, offset + limit), total: items.length };
  if (offset + limit < items.length) result.nextCursor = Buffer.from(JSON.stringify({ key, offset: offset + limit })).toString("base64url");
  return result;
}
export function queryAuthoringDocument(document: Document, input: NativeQueryInput): NativeQueryData {
  const parsed = NativeQueryInputSchema.parse(input);
  const results: NativeQueryData["results"] = {};
  for (const [name, request] of Object.entries(parsed.queries)) {
    try { results[name] = ok(paginate(values(document, request), request)); }
    catch (error) { results[name] = error instanceof DocumentEditError ? fail(ERROR_CODES.includes(error.code as ErrorCode) ? error.code as ErrorCode : "INVALID_ARGUMENT", error.message, { ...(error.path ? { path: error.path } : {}), actual: error.details }) : fail("INTERNAL_ERROR", "原生模型查询失败", { actual: error instanceof Error ? error.message : String(error) }); }
  }
  const succeeded = Object.values(results).filter(value => value.ok).length;
  return { requested: Object.keys(results).length, succeeded, failed: Object.keys(results).length - succeeded, results };
}
export class NativeQueryService {
  constructor(private readonly registry: ProjectRegistry) {}
  execute(input: NativeQueryInput): Promise<ResultEnvelope<NativeQueryData>> { return this.registry.read(input.projectId, document => queryAuthoringDocument(document, input)); }
}
