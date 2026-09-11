import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ProjectSnapshot, buildPreviewArtifacts } from '@magicskysword/openfairygui-functions';
import { PreviewExecutor } from '../../src/preview/preview-executor.js';
import type { PreviewRecipeInput, PreviewRunInput } from '../../src/contracts/preview.js';

const directory = path.resolve(import.meta.dirname, '../../skills/fairygui-headless/examples');
async function filesIn(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(child)); else result.push(child);
  }
  return result;
}

test('every shipped preview example executes against its source fixture without source changes', async () => {
  const projectDirectory = path.join(directory, 'project');
  const files = await filesIn(projectDirectory);
  const bytes = new Map(await Promise.all(files.map(async file => [file, new Uint8Array(await readFile(file))] as const)));
  const before = new Map([...bytes].map(([file, data]) => [file, createHash('sha256').update(data).digest('hex')]));
  const snapshot = await ProjectSnapshot.fromFiles(path.join(projectDirectory, 'Examples.fairy'), bytes, new Map(), new Map(), { join: path.join, dirname: path.dirname });
  const runtime = await buildPreviewArtifacts(snapshot);
  const examples = (await readdir(directory)).filter(file => file.endsWith('.json'));
  assert.ok(examples.length >= 6);
  for (const file of examples) {
    const example = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as { recipe: PreviewRecipeInput; run: PreviewRunInput; expect: { containsText?: string[]; node?: string; property?: string; value?: unknown } };
    const executor = new PreviewExecutor();
    try {
      await executor.initialize({ previewId: file, runtime, packageId: 'example1', componentId: 'gallery', recipe: example.recipe });
      const result = await executor.run(example.run);
      assert.equal(result.complete, true, `${file}: ${JSON.stringify(result.error)}`);
      const last = result.frames.at(-1)!;
      for (const text of example.expect.containsText ?? []) assert.ok(last.nodes.some(node => node.props.text === text), `${file}: ${text}`);
      if (example.expect.node && example.expect.property) assert.equal(last.nodes.find(node => node.name === example.expect.node)?.props[example.expect.property], example.expect.value, file);
    } finally { await executor.close(); }
  }
  for (const file of files) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), before.get(file));
});
