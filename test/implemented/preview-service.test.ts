import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreviewService } from "../../src/preview/preview-service.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { EditService } from "../../src/edit/edit-service.js";
import { FileTransactionManager } from "../../src/write/file-transaction.js";

async function fixture(t: { after(fn: () => Promise<unknown>): void }, now?: () => number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-preview-"));
  const assets = path.join(directory, "assets", "UI");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(directory, "test.fairy"), '<projectDescription id="test" type="DOM" version="5.0"/>');
  await writeFile(path.join(assets, "package.xml"), '<packageDescription id="package1"><resources><component id="panel" name="Panel.xml" path="/"/></resources></packageDescription>');
  const componentFile = path.join(assets, "Panel.xml");
  await writeFile(componentFile, '<component size="100,60"><displayList><text id="n0" name="title" xy="2,2" size="90,25" text="Initial"/></displayList></component>');
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) throw new Error(opened.error.message);
  const edits = new EditService(registry, { transactions: new FileTransactionManager({ baseDirectory: path.join(directory, "logs") }) });
  const preview = new PreviewService(registry, { edits, temporaryRoot: path.join(directory, "results"), ...(now ? { now } : {}) });
  t.after(async () => { await preview.closeAll(); await registry.closeAll(); await rm(directory, { recursive: true, force: true }); });
  return { directory, componentFile, preview, edits, projectId: opened.data.projectId, source: { projectId: opened.data.projectId, packageId: "package1", componentId: "panel" } };
}

test('persistent preview snapshots reset deterministically and reload explicitly', async t => {
  const f = await fixture(t);
  const before = await readFile(f.componentFile, 'utf8');
  const opened = await f.preview.execute({ action: 'open', source: f.source, recipe: { setup: [{ op: 'script', code: 'ctx.root.x = Math.random();' }] } });
  assert.equal(opened.ok, true, JSON.stringify(opened)); if (!opened.ok) return;
  const previewId = opened.data.previewId;
  const initial = opened.data.state.nodes[0]!.props.x;
  await f.preview.execute({ action: 'run', previewId, run: { operations: [{ op: 'set', target: ':root', props: { x: 77 } }] } });
  assert.equal(await readFile(f.componentFile, 'utf8'), before);
  const reset = await f.preview.execute({ action: 'reset', previewId });
  assert.equal(reset.ok, true, JSON.stringify(reset)); if (!reset.ok) return;
  assert.equal(reset.data.state.nodes[0]!.props.x, initial);
  await writeFile(f.componentFile, before.replace('Initial', 'Updated'));
  const stale = await f.preview.execute({ action: 'inspect', previewId });
  assert.equal(stale.ok, true, JSON.stringify(stale)); if (!stale.ok) return;
  assert.equal(stale.data.sourceStatus, 'changed');
  assert.equal(stale.data.state.nodes.find(node => node.name === 'title')?.props.text, 'Initial');
  const reloaded = await f.preview.execute({ action: 'reload', previewId });
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded)); if (!reloaded.ok) return;
  assert.equal(reloaded.data.state.nodes.find(node => node.name === 'title')?.props.text, 'Updated');
  assert.equal(reloaded.data.sourceStatus, 'current');
});

test('multiframe preview writes frame indexes and contact sheet while reusing immutable compilation', async t => {
  const f = await fixture(t);
  const before = await readFile(f.componentFile, 'utf8');
  const input = { action: 'run' as const, source: f.source, recipe: {}, run: { times: [0, 100, 200] } };
  const first = await f.preview.execute(input);
  assert.equal(first.ok, true, JSON.stringify(first)); if (!first.ok) return;
  assert.equal(first.data.frames.length, 3);
  assert.ok(first.data.contactSheet?.path);
  assert.equal(first.data.images.length, 1);
  for (const frame of first.data.frames) assert.ok((await readFile(frame.path)).length > 100);
  const second = await f.preview.execute(input);
  assert.equal(second.ok, true, JSON.stringify(second)); if (!second.ok) return;
  assert.equal(second.data.cacheHit, true);
  assert.equal(f.preview.compilationCount, 1);
  assert.equal(await readFile(f.componentFile, 'utf8'), before);
});

test('edit plans can be previewed before commit without changing sources', async t => {
  const f = await fixture(t);
  const before = await readFile(f.componentFile, 'utf8');
  const planned = await f.edits.execute({ action: 'plan', projectId: f.projectId, operations: [{ op: 'update', target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' }, props: { text: 'Planned' } }] });
  assert.equal(planned.ok, true, JSON.stringify(planned)); if (!planned.ok) return;
  const result = await f.preview.execute({ action: 'run', source: { ...f.source, planId: planned.data.planId }, run: { times: [0] } });
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
  assert.equal(result.data.state.nodes.find(node => node.name === 'title')?.props.text, 'Planned');
  assert.equal(result.data.sourceStatus, 'plan');
  assert.equal(await readFile(f.componentFile, 'utf8'), before);
});

test('persistent preview count and idle lifetime are bounded', async t => {
  let now = 0;
  const f = await fixture(t, () => now);
  const first = await f.preview.execute({ action: 'open', source: f.source });
  const second = await f.preview.execute({ action: 'open', source: f.source });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
  const third = await f.preview.execute({ action: 'open', source: f.source });
  assert.equal(third.ok, false); if (!third.ok) assert.equal(third.error.code, 'PREVIEW_SESSION_LIMIT');
  now = 15 * 60 * 1000;
  await f.preview.reapIdle();
  if (first.ok) {
    const expired = await f.preview.execute({ action: 'inspect', previewId: first.data.previewId });
    assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.error.code, 'PREVIEW_NOT_FOUND');
  }
});

test('close interrupts a running persistent script and capture state excludes image bytes', async t => {
  const f = await fixture(t);
  const opened = await f.preview.execute({ action: 'open', source: f.source });
  assert.equal(opened.ok, true, JSON.stringify(opened)); if (!opened.ok) return;
  const previewId = opened.data.previewId;
  const captured = await f.preview.execute({ action: 'capture', previewId });
  assert.equal(captured.ok, true, JSON.stringify(captured)); if (!captured.ok) return;
  assert.equal('png' in captured.data.state, false);
  const running = f.preview.execute({ action: 'run', previewId, run: { operations: [{ op: 'script', code: 'while(true) {}' }] } });
  await new Promise(resolve => setTimeout(resolve, 200));
  const closed = await f.preview.execute({ action: 'close', previewId });
  assert.equal(closed.ok, true);
  const result = await running;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PREVIEW_CLOSED');
});
