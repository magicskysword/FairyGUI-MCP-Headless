import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FAIRYGUI_TOOL_NAMES } from "../../src/contracts/v2-tools.js";
import { PROJECT_SERVICE_INFO, SKILL_PATH } from "../../src/version.js";
import { FairyGuiMcpServer } from "../../src/server/fairygui-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-v2-mcp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "assets", "Demo");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(directory, "Demo.fairy"), '<projectDescription id="server-project" type="DOM" version="5.0"/>');
  await writeFile(path.join(assets, "package.xml"), '<packageDescription id="pkg00001"><resources><component id="cmp01" name="Main.xml" path="/" exported="true"/></resources></packageDescription>');
  const file = path.join(assets, "Main.xml");
  await writeFile(file, '<component size="200,100"><displayList><text id="n0" name="title" xy="10,10" size="180,40" text="Before" fontSize="20"/></displayList></component>');
  const app = new FairyGuiMcpServer();
  const client = new Client({ name: "fairygui-v2-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.connect(serverTransport); await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await app.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = await client.callTool({ name, arguments: args });
    assert.ok("structuredContent" in raw);
    return { raw, value: raw.structuredContent as any };
  };
  const opened = await call("fairygui.project", { action: "open", path: directory });
  assert.equal(opened.value.ok, true, JSON.stringify(opened.value));
  const projectId: string = opened.value.data.projectId;
  const source = { projectId, packageId: "pkg00001", componentId: "cmp01" };
  const target = { kind: "node", packageId: "pkg00001", componentId: "cmp01", nodeId: "n0" };
  return { directory, file, app, client, call, opened, projectId, source, target };
}
function depth(value: unknown, level = 0): number {
  if (!value || typeof value !== "object") return level;
  return Math.max(level, ...Object.values(value).map(child => depth(child, level + 1)));
}
function images(raw: Awaited<ReturnType<Client["callTool"]>>) {
  return (raw.content as Array<{ type: string; data?: string }>).filter(item => item.type === "image");
}

test("MCP initialization exposes six compact tools and the installed Skill path", async () => {
  const f = await fixture();
  assert.ok(f.client.getInstructions()?.includes(SKILL_PATH));
  const listed = await f.client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), FAIRYGUI_TOOL_NAMES);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.outputSchema?.type, "object");
    assert.ok(tool.description); assert.ok(Buffer.byteLength(JSON.stringify(tool.inputSchema)) <= 16384);
    assert.ok(depth(tool.inputSchema) <= 10, `${tool.name}: ${depth(tool.inputSchema)}`);
    assert.ok(tool.annotations); assert.equal(tool.execution?.taskSupport, "forbidden");
  }
  assert.equal(f.opened.value.data.service.skillPath, SKILL_PATH);
  await readFile(SKILL_PATH);
  for (const action of ["list", "status", "close"]) {
    const result = await f.call("fairygui.project", action === "list" ? { action } : { action, projectId: f.projectId });
    assert.equal(result.value.ok, true); assert.deepEqual(result.value.data.service, PROJECT_SERVICE_INFO);
  }
});

test("invalid transport and native properties retain stable errors and atomicity", async () => {
  const f = await fixture(); const before = await readFile(f.file, "utf8");
  const invalid = await f.call("fairygui.edit", { action: "apply", projectId: f.projectId, operations: [] });
  assert.equal(invalid.raw.isError, true); assert.equal(invalid.value.error.code, "INVALID_ARGUMENT");
  assert.ok(invalid.value.error.path); assert.ok(invalid.value.error.actual); assert.ok(invalid.value.error.suggestedFix);
  const property = await f.call("fairygui.edit", { action: "apply", projectId: f.projectId, requestId: "invalid-property", operations: [
    { op: "update", target: f.target, props: { text: "Should roll back" } },
    { op: "update", target: f.target, props: { x: "10px" } }
  ] });
  assert.equal(property.raw.isError, true); assert.equal(property.value.error.code, "INVALID_PROPERTY");
  assert.equal(property.value.error.actual, '10px');
  assert.ok(property.value.error.suggestedFix);
  assert.deepEqual(property.value.error.relatedObjects, [f.target]);
  await readFile(property.value.error.definition.file);
  assert.ok(property.value.error.path); assert.equal(await readFile(f.file, "utf8"), before);
});

test("named native query keeps partial results compact and associates definition files", async () => {
  const f = await fixture();
  const result = await f.call("fairygui.query", { projectId: f.projectId, queries: {
    one: { kind: "nodes", packageId: "pkg00001", componentId: "cmp01", selector: "#n0", detail: "full" },
    missing: { kind: "object", target: { ...f.target, nodeId: "absent" } }
  } });
  assert.equal(result.value.ok, true); assert.equal(result.value.data.succeeded, 1); assert.equal(result.value.data.failed, 1);
  const found = result.value.data.results.one.data;
  assert.equal(found.total, 1); assert.equal(found.items.length, 1); assert.equal(found.items[0].props.x, 10);
  assert.equal(found.items[0].type, "GTextField"); await readFile(found.items[0].definition.file);
});

test("native plan previews without writes, commits atomically and retries idempotently", async () => {
  const f = await fixture(); const before = await readFile(f.file, "utf8");
  const planned = await f.call("fairygui.edit", { action: "plan", projectId: f.projectId, operations: [{ op: "update", target: f.target, props: { text: "After", alpha: 0.4 } }] });
  assert.equal(planned.value.ok, true, JSON.stringify(planned.value));
  const planId: string = planned.value.data.planId;
  const preview = await f.call("fairygui.preview", { action: "run", source: { ...f.source, planId }, run: { times: [0, 100], selector: "#n0", properties: ["text", "alpha"] } });
  assert.equal(preview.value.ok, true, JSON.stringify(preview.value));
  assert.equal(preview.value.data.sourceStatus, "plan"); assert.equal(preview.value.data.frames.length, 2);
  assert.equal(preview.value.data.frames[0].nodes[0].props.text, "After");
  assert.equal(images(preview.raw).length, 1); assert.equal(preview.value.data.images[0].contentIndex, 1);
  assert.equal("data" in preview.value.data.images[0], false); assert.equal(await readFile(f.file, "utf8"), before);
  const args = { action: "commit", projectId: f.projectId, planId, requestId: "plan-commit" };
  const committed = await f.call("fairygui.edit", args); assert.equal(committed.value.ok, true, JSON.stringify(committed.value));
  assert.deepEqual((await f.call("fairygui.edit", args)).value, committed.value);
  assert.match(await readFile(f.file, "utf8"), /text="After"/);
  const query = await f.call("fairygui.query", { projectId: f.projectId, queries: { one: { kind: "object", target: f.target, detail: "full" } } });
  assert.equal(query.value.data.results.one.data.items[0].props.alpha, 0.4);
});

test("named preview images detach from JSON, file-only results and source hashes remain stable", async () => {
  const f = await fixture(); const before = await readFile(f.file, "utf8");
  const result = await f.call("fairygui.preview", { previews: {
    first: { action: "run", source: f.source }, second: { action: "run", source: f.source, imageResult: "file" },
    missing: { action: "inspect", previewId: "absent" }
  } });
  assert.equal(result.value.data.succeeded, 2); assert.equal(result.value.data.failed, 1);
  const first = result.value.data.results.first.data; const second = result.value.data.results.second.data;
  assert.equal(first.images[0].contentIndex, 1); assert.equal("data" in first.images[0], false);
  assert.equal(images(result.raw).length, 1); assert.deepEqual(second.images, []);
  assert.equal((await readFile(second.frames[0].path)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("create package/component through batch refs and close associated persistent previews", async () => {
  const f = await fixture();
  const created = await f.call("fairygui.edit", { action: "apply", projectId: f.projectId, requestId: "create-widgets", operations: [
    { op: "create", target: { kind: "package" }, props: { name: "Widgets" }, clientRef: "widgets" },
    { op: "create", target: { kind: "component", packageId: "@widgets" }, props: { name: "Dialog", width: 640, height: 360 }, clientRef: "dialog" }
  ] });
  assert.equal(created.value.ok, true, JSON.stringify(created.value));
  assert.equal(created.value.data.files.length, 2);
  assert.match(await readFile(path.join(f.directory, "assets", "Widgets", "Dialog.xml"), "utf8"), /size="640,360"/);
  const opened = await f.call("fairygui.preview", { action: "open", source: f.source });
  assert.equal(opened.value.ok, true, JSON.stringify(opened.value));
  await f.call("fairygui.project", { action: "close", projectId: f.projectId });
  const inspected = await f.call("fairygui.preview", { action: "inspect", previewId: opened.value.data.previewId });
  assert.equal(inspected.value.error.code, "PREVIEW_NOT_FOUND");
});

test("publish and validation remain callable after dynamic preview", async () => {
  const f = await fixture();
  const preview = await f.call("fairygui.preview", { action: "run", source: f.source, recipe: { setup: [{ op: "script", code: 'ctx.one("#n0").text = "Temporary"' }] } });
  assert.equal(preview.value.ok, true);
  const published = await f.call("fairygui.publish", { projectId: f.projectId, packageIds: ["pkg00001"], publishType: "definitions", outputPath: "release" });
  assert.equal(published.value.ok, true, JSON.stringify(published.value));
  assert.ok(published.value.data.writtenFiles.length);
  const validated = await f.call("fairygui.validate", { projectId: f.projectId, mode: "quick" });
  assert.equal(validated.value.ok, true); assert.equal(validated.value.data.valid, true);
  await writeFile(f.file, '<component size="200,100"><displayList><image id="n1" src="missing"/></displayList></component>');
  const broken = await f.call("fairygui.validate", { projectId: f.projectId, mode: "quick" });
  assert.equal(broken.raw.isError, false); assert.equal(broken.value.data.valid, false);
});
