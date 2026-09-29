import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import sharp from "sharp";
import { EditService } from "../../src/edit/edit-service.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { FileTransactionManager } from "../../src/write/file-transaction.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { now?: () => number; failWrite?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-edit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "assets", "UI");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(directory, "test.fairy"), '<projectDescription id="test" type="DOM" version="5.0"/>');
  await writeFile(path.join(assets, "package.xml"), '<packageDescription id="package1"><resources><component id="panel" name="Panel.xml" path="/"/><component id="other" name="Other.xml" path="/"/></resources></packageDescription>');
  for (const name of ["Panel", "Other"]) await writeFile(path.join(assets, `${name}.xml`), '<component size="100,100"><displayList><text id="n0" name="title" xy="0,0" size="80,20" text="Before"/></displayList></component>');
  const transactions = new FileTransactionManager({ baseDirectory: path.join(directory, "logs"),
    ...(options.failWrite ? { faultInjector: (point: string) => { if (point === "after-replace") throw new Error("write fault"); } } : {}) });
  const registry = new ProjectRegistry({ recovery: transactions });
  cleanups.push(() => registry.closeAll());
  const opened = await registry.open(directory);
  if (!opened.ok) throw new Error(opened.error.message);
  const projectId = opened.data.projectId;
  const service = new EditService(registry, { transactions, ...(options.now ? { now: options.now } : {}) });
  const target = { kind: "node" as const, packageId: "package1", componentId: "panel", nodeId: "n0" };
  return { directory, assets, transactions, registry, projectId, service, target };
}

test("native edits reject fractional geometry before committing any source", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.assets, "Panel.xml"));
  const result = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "fractional-loader", operations: [
    { op: "create", target: { kind: "node", packageId: "package1", componentId: "panel" }, type: "GLoader",
      props: { name: "progress", x: 817.5, y: 417.5, width: 125, height: 125 } }
  ] });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PROPERTY");
    assert.equal(result.error.path, "operations[0].props.x");
  }
  assert.deepEqual(await readFile(path.join(f.assets, "Panel.xml")), before);
  assert.equal(await f.transactions.findReceipt(f.directory, "fractional-loader"), undefined);
});

test("XML edits reject fractional coordinates and valid loader edits survive reopening", async () => {
  const f = await fixture();
  const target = { kind: "component" as const, packageId: "package1", componentId: "panel" };
  const before = await readFile(path.join(f.assets, "Panel.xml"));
  const invalid = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "fractional-xml", operations: [
    { op: "xml", action: "insert", target, xml: '<loader id="progress" xy="817.5,417.5" size="125,125"/>' }
  ] });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_XML");
  assert.deepEqual(await readFile(path.join(f.assets, "Panel.xml")), before);
  const valid = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "integer-loader", operations: [
    { op: "create", target: { ...target, kind: "node" }, type: "GLoader", props: {
      name: "progress", x: 818, y: 418, width: 125, height: 125, pivotX: 0.5, pivotY: 0.5, alpha: 0.5
    } }
  ] });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  const xml = await readFile(path.join(f.assets, "Panel.xml"), "utf8");
  assert.match(xml, /xy="818,418"/);
  assert.match(xml, /pivot="0.5,0.5"/);
  const reopened = await f.registry.open(f.directory);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
});

test("resource plans preserve inbox bytes, reject stale imports and consume only successful commits", async () => {
  const f = await fixture();
  const inbox = path.join(f.directory, ".fairygui-mcp", "import-inbox");
  await mkdir(inbox, { recursive: true });
  const file = path.join(inbox, "icon.png");
  const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: "red" } }).png().toBuffer();
  await writeFile(file, png);
  const input = { action: "plan" as const, projectId: f.projectId, operations: [{ op: "import" as const, target: { kind: "resource" as const, packageId: "package1" }, inboxPath: "icon.png", props: { name: "Icon" }, clientRef: "icon" }] };
  const planned = await f.service.execute(input);
  assert.equal(planned.ok, true, JSON.stringify(planned)); if (!planned.ok) return;
  assert.deepEqual(await readFile(file), png);
  assert.ok(planned.data.files.some(change => change.relativePath === ".fairygui-mcp/import-inbox/icon.png" && change.action === "remove"));
  await writeFile(file, Buffer.concat([png, Buffer.from([1])]));
  const stale = await f.service.execute({ action: "commit", projectId: f.projectId, planId: planned.data.planId, requestId: "stale-import" });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "SOURCE_CONFLICT");
  await writeFile(file, png);
  const committed = await f.service.execute({ action: "commit", projectId: f.projectId, planId: planned.data.planId, requestId: "import-success" });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(f.assets, "Icon.png")), png);
  const replay = await f.service.execute({ action: "commit", projectId: f.projectId, planId: planned.data.planId, requestId: "import-success" });
  assert.deepEqual(replay, committed);
});

test("failed resource transactions restore both inbox and project assets", async () => {
  const f = await fixture({ failWrite: true });
  const inbox = path.join(f.directory, ".fairygui-mcp", "import-inbox");
  await mkdir(inbox, { recursive: true }); await writeFile(path.join(inbox, "data.bin"), new Uint8Array([1, 2]));
  const before = await readFile(path.join(f.assets, "package.xml"));
  const result = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "failed-import", operations: [{ op: "import", target: { kind: "resource", packageId: "package1" }, inboxPath: "data.bin", props: { name: "Data" } }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
  assert.deepEqual(await readFile(path.join(inbox, "data.bin")), Buffer.from([1, 2]));
  assert.deepEqual(await readFile(path.join(f.assets, "package.xml")), before);
  await assert.rejects(readFile(path.join(f.assets, "Data.bin")), { code: "ENOENT" });
});

test("edit plans capture native and XML changes without writes and commit atomically", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.assets, "Panel.xml"), "utf8");
  const planned = await f.service.execute({ action: "plan", projectId: f.projectId, operations: [
    { op: "update", target: f.target, props: { text: "After" } },
    { op: "xml", action: "insert", target: { kind: "component", packageId: "package1", componentId: "other" }, xml: '<graph id="box" name="box" xy="2,3" size="4,5"/>' }
  ] });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  if (!planned.ok) return;
  assert.equal(await readFile(path.join(f.assets, "Panel.xml"), "utf8"), before);
  assert.equal(planned.data.files.length, 2);
  assert.ok(planned.data.clientRefs.box);
  const snapshot = f.service.getPlanSnapshot(f.projectId, planned.data.planId);
  assert.ok(snapshot);
  const committed = await f.service.execute({ action: "commit", projectId: f.projectId, planId: planned.data.planId, requestId: "commit-one" });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.match(await readFile(path.join(f.assets, "Panel.xml"), "utf8"), /text="After"/);
  assert.match(await readFile(path.join(f.assets, "Other.xml"), "utf8"), /name="box"/);
});

test("apply request receipts return identical IDs after service recreation", async () => {
  const f = await fixture();
  const { nodeId, ...parent } = f.target;
  const input = { action: "apply" as const, projectId: f.projectId, requestId: "create-one", operations: [{ op: "create" as const, target: parent, type: "GGraph", props: { name: "box" }, clientRef: "box" }] };
  const first = await f.service.execute(input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await new EditService(f.registry, { transactions: new FileTransactionManager({ baseDirectory: path.join(f.directory, "logs") }) }).execute(input);
  assert.deepEqual(second, first);
  assert.equal((await readFile(path.join(f.assets, "Panel.xml"), "utf8")).match(/name="box"/g)?.length, 1);
  const reused = await f.service.execute({ ...input, operations: [{ ...input.operations[0]!, props: { name: "different" } }] });
  assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.error.code, "REQUEST_ID_CONFLICT");
});

test("stale source dependencies and expired plans reject without writes", async () => {
  let now = 0;
  const f = await fixture({ now: () => now });
  const input = { action: "plan" as const, projectId: f.projectId, operations: [{ op: "update" as const, target: f.target, props: { x: 42 } }] };
  const planned = await f.service.execute(input);
  assert.equal(planned.ok, true, JSON.stringify(planned));
  if (!planned.ok) return;
  await writeFile(path.join(f.assets, "Other.xml"), '<component size="3,3"/>');
  const stale = await f.service.execute({ action: "commit", projectId: f.projectId, planId: planned.data.planId, requestId: "stale" });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "SOURCE_CONFLICT");
  const next = await f.service.execute(input);
  assert.equal(next.ok, true, JSON.stringify(next));
  if (!next.ok) return;
  now = 30 * 60 * 1000;
  const expired = await f.service.execute({ action: "commit", projectId: f.projectId, planId: next.data.planId, requestId: "expired" });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "PLAN_EXPIRED");
  assert.doesNotMatch(await readFile(path.join(f.assets, "Panel.xml"), "utf8"), /xy="42,/);
});

test("invalid mixed edits leave every source unchanged", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.assets, "Panel.xml"), "utf8");
  const result = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "invalid", operations: [
    { op: "update", target: f.target, props: { x: 42 } },
    { op: "xml", action: "insert", target: { kind: "component", packageId: "package1", componentId: "panel" }, xml: '<transition name="broken"><item type="Rotation" target="missing" time="0"/></transition>' }
  ] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "REFERENCE_VALIDATION_FAILED");
  assert.equal(await readFile(path.join(f.assets, "Panel.xml"), "utf8"), before);
});

test("simultaneous identical apply requests execute once", async () => {
  const f = await fixture();
  const input = { action: "apply" as const, projectId: f.projectId, requestId: "parallel", operations: [{ op: "clone" as const, target: f.target, props: { name: "copy" }, clientRef: "copy" }] };
  const results = await Promise.all([f.service.execute(input), f.service.execute(input)]);
  assert.equal(results[0]!.ok, true, JSON.stringify(results[0]));
  assert.deepEqual(results[0], results[1]);
});

test("a failed cross-file edit restores sources and does not persist success", async () => {
  const f = await fixture({ failWrite: true });
  const before = await Promise.all(["Panel", "Other"].map((name) => readFile(path.join(f.assets, `${name}.xml`), "utf8")));
  const result = await f.service.execute({ action: "apply", projectId: f.projectId, requestId: "failed", operations: [
    { op: "update", target: f.target, props: { x: 30 } },
    { op: "update", target: { ...f.target, componentId: "other" }, props: { y: 20 } }
  ] });
  assert.equal(result.ok, false);
  assert.deepEqual(await Promise.all(["Panel", "Other"].map((name) => readFile(path.join(f.assets, `${name}.xml`), "utf8"))), before);
  assert.equal(await f.transactions.findReceipt(f.directory, "failed"), undefined);
});
