import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewExecutor } from "../../src/preview/preview-executor.js";
import { buildPreviewArtifacts, captureProjectSnapshot } from "@magicskysword/openfairygui-functions";
import { Document, ProjectWriter, type FileSystem } from "@magicskysword/openfairygui-core";
import path from "node:path";
import { processTreeTermination } from "../../src/preview/process-tree.js";

test('process tree termination has explicit Windows and POSIX strategies', () => {
  assert.deepEqual(processTreeTermination(1234, 'win32'), { command: 'taskkill', args: ['/PID', '1234', '/T', '/F'] });
  assert.deepEqual(processTreeTermination(1234, 'linux'), { processGroup: -1234 });
  assert.deepEqual(processTreeTermination(1234, 'darwin'), { processGroup: -1234 });
  assert.throws(() => processTreeTermination(-1, 'linux'));
});

async function runtime() {
  const files = new Map<string, Uint8Array>();
  const fs: FileSystem = {
    readFile: async p => new TextDecoder().decode(files.get(p)), readFileRaw: async p => files.get(p)!,
    writeFile: async (p, data) => { files.set(p, new TextEncoder().encode(data)); }, writeFileRaw: async (p, data) => { files.set(p, data); }, mkdir: async () => {},
    exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    readdir: async p => [...new Set([...files.keys()].filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1).split('/')[0]!))], join: path.posix.join, dirname: path.posix.dirname
  };
  const document = new Document();
  const pkg = document.createPackage('UI').setId('package1');
  const component = document.createComponent('Panel').setId('panel').setSize(160, 80);
  component.addChild(document.createGTextField('title').setId('n0').setSize(140, 25).setText('Initial'));
  pkg.addResource(component);
  await new ProjectWriter(fs).write(document, '/source/test.fairy');
  return buildPreviewArtifacts(await captureProjectSnapshot(fs, '/source/test.fairy'));
}

test('isolated previews execute setup, fixed-step timeline and screenshots deterministically', async t => {
  const executor = new PreviewExecutor();
  t.after(() => executor.close());
  const ready = await executor.initialize({ previewId: 'test', runtime: await runtime(), packageId: 'package1', componentId: 'panel', recipe: {
    environment: { width: 160, height: 80, seed: 0 }, data: { title: 'Setup' },
    setup: [{ op: 'script', code: 'ctx.root.getChild("title").text = ctx.data.title; ctx.root.getChild("title").x = Math.random(); ctx.root.getChild("title").y = Date.now(); fgui.GTween.to(0, 60, 1).setEase(0).onUpdate(t => ctx.root.getChild("title").x = t.value.x);' }],
    timeline: [{ at: 500, operations: [{ op: 'set', target: '[name="title"]', props: { text: 'Half' } }] }]
  } });
  assert.equal(ready.nodes.find(n => n.name === 'title')?.props.text, 'Setup');
  assert.equal(ready.time, 0);
  const sampled = await executor.run({ times: [0, 500, 1000], properties: ['x', 'y', 'text'] });
  assert.equal(sampled.complete, true, JSON.stringify(sampled));
  assert.equal(sampled.frames.length, 3);
  assert.ok(Math.abs(Number(sampled.frames[1]!.nodes.find(n => n.name === 'title')?.props.x) - 30) < 1e-9);
  assert.equal(sampled.frames[1]!.nodes.find(n => n.name === 'title')?.props.text, 'Half');
  assert.equal(sampled.frames[2]!.nodes.find(n => n.name === 'title')?.props.x, 60);
  assert.ok(sampled.frames.every(frame => frame.png.length > 100));
  const captured = await executor.capture();
  assert.equal(captured.time, 1000);
  assert.equal(captured.frame, 60);
});

test('sampling extra frames does not change existing states and initialization runs once', async t => {
  const artifacts = await runtime();
  const recipe = { setup: [{ op: 'script' as const, code: 'ctx.root.x = 0; setInterval(() => ctx.root.x++, 100);' }] };
  const left = new PreviewExecutor(); const right = new PreviewExecutor();
  t.after(() => Promise.all([left.close(), right.close()]));
  for (const [previewId, executor] of [['left', left], ['right', right]] as const) await executor.initialize({ previewId, runtime: artifacts, packageId: 'package1', componentId: 'panel', recipe });
  const a = await left.run({ times: [500, 1000] });
  const b = await right.run({ times: [100, 300, 500, 900, 1000] });
  assert.equal(a.frames[0]!.nodes[0]!.props.x, b.frames[2]!.nodes[0]!.props.x);
  assert.equal(a.frames[1]!.nodes[0]!.props.x, 10);
  assert.equal(b.frames[4]!.nodes[0]!.props.x, 10);
  assert.equal((await left.inspect()).time, 1000);
});

test('script failures preserve completed frames with operation and time diagnostics', async t => {
  const executor = new PreviewExecutor(); t.after(() => executor.close());
  await executor.initialize({ previewId: 'partial', runtime: await runtime(), packageId: 'package1', componentId: 'panel', recipe: {
    timeline: [{ at: 500, operations: [{ op: 'script', code: 'throw new Error("broken")' }] }]
  } });
  const result = await executor.run({ times: [100, 500, 1000] });
  assert.equal(result.complete, false);
  assert.equal(result.frames.length, 1);
  assert.match(result.error?.message ?? '', /broken/);
  assert.match(result.error?.path ?? '', /timeline\[0\]/);
  assert.equal((await executor.inspect()).time, 500);
});

test('host deadline terminates an infinite script and its worker', async t => {
  const executor = new PreviewExecutor({ timeoutMs: 3000 }); t.after(() => executor.close());
  await executor.initialize({ previewId: 'timeout', runtime: await runtime(), packageId: 'package1', componentId: 'panel', recipe: {} });
  await assert.rejects(() => executor.run({ operations: [{ op: 'script', code: 'while (true) {}' }], times: [0] }), { code: 'PREVIEW_TIMEOUT' });
  assert.equal(executor.alive, false);
});

test('async initialization and timeline scripts settle before fixed-frame sampling', async t => {
  const executor = new PreviewExecutor(); t.after(() => executor.close());
  const ready = await executor.initialize({ previewId: 'async', runtime: await runtime(), packageId: 'package1', componentId: 'panel', recipe: {
    setup: [{ op: 'script', code: 'await Promise.resolve(); ctx.root.x = 10;' }],
    timeline: [{ at: 100, operations: [{ op: 'script', code: 'await Promise.resolve(); ctx.root.x += 20; ctx.clock.requestFrame(() => ctx.root.y = ctx.root.x);' }] }]
  } });
  assert.equal(ready.nodes[0]!.props.x, 10);
  const result = await executor.run({ times: [100, 200], properties: ['x', 'y'] });
  assert.equal(result.complete, true, JSON.stringify(result.error));
  assert.equal(result.frames[0]!.nodes[0]!.props.x, 30);
  assert.equal(result.frames[0]!.nodes[0]!.props.y, 30);
  assert.equal(result.frames[1]!.nodes[0]!.props.x, 30);
});

test('realtime sampling reports measured monotonic time with native timers', async t => {
  const executor = new PreviewExecutor(); t.after(() => executor.close());
  await executor.initialize({ previewId: 'realtime', runtime: await runtime(), packageId: 'package1', componentId: 'panel', recipe: { environment: { clock: 'realtime' }, setup: [{ op: 'script', code: 'ctx.root.x = 0; setTimeout(() => ctx.root.x = 42, 50);' }] } });
  const result = await executor.run({ times: [100, 200] });
  assert.equal(result.complete, true);
  assert.ok(result.frames[0]!.time >= 100);
  assert.ok(result.frames[1]!.time >= result.frames[0]!.time);
  assert.equal(result.frames[1]!.nodes[0]!.props.x, 42);
});
