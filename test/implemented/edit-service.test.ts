import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
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
