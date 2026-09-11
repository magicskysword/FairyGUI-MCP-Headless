import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { Document, ProjectWriter, GearType, TransitionActionType, type FileSystem, type Component } from '@magicskysword/openfairygui-core';
import { buildPreviewArtifacts, captureProjectSnapshot } from '@magicskysword/openfairygui-functions';
import { PreviewExecutor } from '../../src/preview/preview-executor.js';
import type { PreviewRecipeInput, PreviewFrame } from '../../src/contracts/preview.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function createRuntime(t: { after(fn: () => unknown): void }, configure: (document: Document, root: Component) => void) {
  const files = new Map<string, Uint8Array>();
  const fs: FileSystem = {
    readFile: async p => new TextDecoder().decode(files.get(p)), readFileRaw: async p => files.get(p)!,
    writeFile: async (p, data) => { files.set(p, new TextEncoder().encode(data)); }, writeFileRaw: async (p, data) => { files.set(p, data); }, mkdir: async () => {},
    exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    readdir: async p => [...new Set([...files.keys()].filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1).split('/')[0]!))], join: path.posix.join, dirname: path.posix.dirname
  };
  const document = new Document();
  const pkg = document.createPackage('UI').setId('package1');
  const root = document.createComponent('Panel').setId('panel').setSize(320, 240); pkg.addResource(root);
  configure(document, root);
  await new ProjectWriter(fs).write(document, '/source/test.fairy');
  const hashes = () => [...files].map(([p, bytes]) => [p, digest(bytes)]);
  const before = hashes(); t.after(() => assert.deepEqual(hashes(), before));
  return buildPreviewArtifacts(await captureProjectSnapshot(fs, '/source/test.fairy'));
}

async function sample(t: { after(fn: () => Promise<unknown>): void }, runtime: Awaited<ReturnType<typeof createRuntime>>, recipe: PreviewRecipeInput, times: number[], properties?: string[]) {
  const executor = new PreviewExecutor(); t.after(() => executor.close());
  await executor.initialize({ previewId: 'dynamic', runtime, packageId: 'package1', componentId: 'panel', recipe });
  const result = await executor.run({ times, ...(properties ? { properties } : {}) });
  assert.equal(result.complete, true, JSON.stringify(result.error));
  return { executor, ...result };
}
const prop = (frame: PreviewFrame, name: string, key: string) => frame.nodes.find(n => n.name === name)!.props[key];

test('controller Gear tweens and display locks follow fixed frames with stable image hashes', async t => {
  const runtime = await createRuntime(t, (document, root) => {
    const controller = document.createController('state'); root.addController(controller);
    for (const id of ['0', '1']) controller.addPage(document.createControllerPage(id).setId(id));
    const node = document.createGTextField('title').setId('n0').setText('Tween').setSize(100, 25); root.addChild(node);
    node.addGear(document.createGear().setGearType(GearType.XY).setController(controller).setPages('0,1').setValues('0,0|100,0').setTween(true).setTweenDuration(0.5).setEaseType(0));
    node.addGear(document.createGear().setGearType(GearType.Look).setController(controller).setPages('0,1').setValues('1,0,0,1|0.25,0,0,1').setTween(true).setTweenDuration(0.5).setEaseType(0));
    node.addGear(document.createGear().setGearType(GearType.Display).setController(controller).setPages('0'));
  });
  const recipe: PreviewRecipeInput = { setup: [{ op: 'controller', name: 'state', index: 1 }] };
  const first = await sample(t, runtime, recipe, [0, 250, 500], ['x', 'alpha', 'internalVisible']);
  assert.equal(prop(first.frames[0]!, 'title', 'x'), 0);
  assert.ok(Math.abs(Number(prop(first.frames[1]!, 'title', 'x')) - 50) < 1e-6);
  assert.ok(Math.abs(Number(prop(first.frames[1]!, 'title', 'alpha')) - 0.625) < 1e-6);
  assert.equal(prop(first.frames[2]!, 'title', 'internalVisible'), false);
  const second = await sample(t, runtime, recipe, [0, 100, 250, 400, 500], ['x', 'alpha', 'internalVisible']);
  assert.equal(digest(first.frames[1]!.png), digest(second.frames[2]!.png));
  assert.equal(digest(first.frames[2]!.png), digest(second.frames[4]!.png));
});

test('transition loops, reverse, pause and nested tracks remain frame-driven', async t => {
  const runtime = await createRuntime(t, (document, root) => {
    root.addChild(document.createGTextField('title').setId('n0').setSize(100, 25).setText('Motion'));
    const move = document.createTransition('move'); root.addTransition(move);
    move.addItem(document.createTransitionItem().setActionType(TransitionActionType.XY).setTargetId('n0').setTween(true).setDuration(12).setEaseType(0).setStartValue([0, 0]).setEndValue([100, 0]));
    const wrapper = document.createTransition('wrapper'); root.addTransition(wrapper);
    wrapper.addItem(document.createTransitionItem().setActionType(TransitionActionType.Transition).setStartValue(['move', 1]));
  });
  const loop = await sample(t, runtime, { setup: [{ op: 'transition', name: 'move', action: 'play', times: 2 }] }, [250, 750, 1000]);
  assert.ok(Math.abs(Number(prop(loop.frames[0]!, 'title', 'x')) - 50) < 1e-6, JSON.stringify(loop.frames.map(f => ({ x: prop(f, 'title', 'x'), transitions: f.nodes[0]!.transitions }))));
  assert.ok(Math.abs(Number(prop(loop.frames[1]!, 'title', 'x')) - 50) < 1e-6);
  assert.equal(prop(loop.frames[2]!, 'title', 'x'), 100);
  const reverse = await sample(t, runtime, { setup: [{ op: 'transition', name: 'move', action: 'playReverse' }] }, [0, 250, 500]);
  assert.equal(prop(reverse.frames[0]!, 'title', 'x'), 100);
  assert.equal(prop(reverse.frames[2]!, 'title', 'x'), 0);
  const nested = await sample(t, runtime, { setup: [{ op: 'transition', name: 'wrapper', action: 'play' }], timeline: [{ at: 250, operations: [{ op: 'transition', name: 'wrapper', action: 'pause' }] }, { at: 500, operations: [{ op: 'transition', name: 'wrapper', action: 'resume' }] }] }, [250, 400, 800]);
  assert.equal(prop(nested.frames[0]!, 'title', 'x'), prop(nested.frames[1]!, 'title', 'x'));
  assert.equal(prop(nested.frames[2]!, 'title', 'x'), 100);
});

test('JavaScript populates List and Tree, registers extensions and changes instance state', async t => {
  const runtime = await createRuntime(t, (document, root) => {
    const pkg = document.getRoot().listPackages()[0]!;
    const cell = document.createComponent('Cell').setId('cell').setSize(100, 24).setExtensionType('Label');
    cell.addChild(document.createGTextField('title').setId('text').setSize(100, 24)); pkg.addResource(cell);
    root.addChild(document.createGList('list').setId('list').setSize(100, 72).setDefaultItem('ui://package1cell'));
    root.addChild(document.createGTree('tree').setId('tree').setXY(120, 0).setSize(100, 100).setDefaultItem('ui://package1cell'));
  });
  const result = await sample(t, runtime, {
    data: ['Alpha', 'Beta'],
    preconstruct: 'class Cell extends fgui.GLabel { onConstruct() { this.data = { extended: true }; } } fgui.UIObjectFactory.setExtension("ui://package1cell", Cell);',
    setup: [
      { op: 'script', code: 'const list = ctx.root.getChild("list"); list.itemRenderer = (i, cell) => { cell.text = ctx.data[i]; if (!cell.data.extended) throw new Error("extension missing"); }; list.numItems = ctx.data.length; ctx.root.on("business", e => ctx.root.x = e.data.amount); const progress = new fgui.GProgressBar(); progress.name = "progress"; progress.value = 37; ctx.root.addChild(progress); const text = new fgui.GTextField(); text.name = "dynamic"; text.text = "Created"; ctx.root.addChild(text);' },
      { op: 'tree', target: '[name="tree"]', items: [{ props: { text: 'Folder' }, expanded: true, children: [{ props: { text: 'Leaf' } }] }] },
      { op: 'event', type: 'business', data: { amount: 12 } }
    ]
  }, [0], ['text', 'value', 'x']);
  assert.ok(result.frames[0]!.nodes.some(n => n.props.text === 'Alpha'));
  assert.ok(result.frames[0]!.nodes.some(n => n.props.text === 'Leaf'));
  assert.equal(prop(result.frames[0]!, 'progress', 'value'), 37);
  assert.equal(prop(result.frames[0]!, 'dynamic', 'text'), 'Created');
  assert.equal(result.frames[0]!.nodes[0]!.props.x, 12);
  assert.equal(new Set(result.frames[0]!.nodes.map(n => n.ref)).size, result.frames[0]!.nodes.length);
});

test('movie clips, focus and delayed scroll layout advance under the manual clock', async t => {
  const runtime = await createRuntime(t, (document, root) => {
    root.setOverflow(2).setScrollType(1);
    root.addChild(document.createGTextField('bottom').setId('bottom').setXY(0, 500).setSize(100, 30).setText('Bottom'));
    root.addChild(document.createGTextInput('input').setId('input').setSize(100, 25));
  });
  const result = await sample(t, runtime, { setup: [
    { op: 'script', code: 'const clip = new fgui.GMovieClip(); clip.name = "clip"; clip.element.interval = 100; clip.element.frames = [{}, {}, {}]; ctx.root.addChild(clip); ctx.root.ensureBoundsCorrect(); ctx.root.getChild("input").requestFocus();' },
    { op: 'scroll', y: 100 },
  ], timeline: [{ at: 250, operations: [{ op: 'script', code: 'ctx.root.data = { y: ctx.root.scrollPane.posY }; ctx.root.x = ctx.root.data.y;' }] }] }, [100, 250], ['frame', 'playing', 'x', 'focused']);
  assert.equal(prop(result.frames[0]!, 'clip', 'frame'), 1);
  assert.equal(prop(result.frames[1]!, 'clip', 'frame'), 2);
  assert.equal(result.frames[1]!.nodes[0]!.props.x, 100);
  assert.equal(prop(result.frames[1]!, 'input', 'focused'), true);
});
