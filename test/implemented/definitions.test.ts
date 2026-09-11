import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateDefinitions } from "../../scripts/generate-definitions.js";

test('generated definitions have real model types, runtime declarations and resolvable index paths', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fgui-definitions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await generateDefinitions(directory);
  assert.ok(index.authoring.some(entry => entry.symbol === 'GTextField'));
  assert.ok(index.runtime.some(entry => entry.file.endsWith('/ui/GComponent.d.ts')));
  assert.ok(index.preview.some(entry => entry.symbol === 'preview-context'));
  assert.ok(index.preview.some(entry => entry.symbol === 'preview-state'));
  for (const entry of [...index.authoring, ...index.runtime, ...index.preview]) assert.ok((await readFile(path.join(directory, entry.file))).length > 0);
  const text = JSON.parse(await readFile(path.join(directory, 'authoring/GTextField.schema.json'), 'utf8'));
  assert.ok(text.properties.x);
  assert.equal(text.additionalProperties, false);
  const operations = JSON.parse(await readFile(path.join(directory, 'authoring/operations.schema.json'), 'utf8'));
  assert.deepEqual(operations.oneOf.map((entry: { properties: { op: { const: string } } }) => entry.properties.op.const), ['create', 'update', 'remove', 'move', 'replace', 'import', 'clone', 'xml']);
  assert.ok(index.versions['@magicskysword/fairygui-dom']);
  for (const entry of [...index.runtime, ...index.preview].filter(entry => entry.file.endsWith('.d.ts'))) {
    const file = path.join(directory, entry.file); const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '')) + '.d.ts';
      await access(target);
    }
  }
});

test('every shipped Skill navigation link resolves to a local artifact', async () => {
  const root = path.resolve(import.meta.dirname, '../../skills/fairygui-headless');
  const walk = async (directory: string): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(file)); else if (file.endsWith('.md')) files.push(file);
    }
    return files;
  };
  for (const file of await walk(root)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1]!.split('#')[0]!;
      if (link && !/^[a-z]+:/i.test(link)) await access(path.resolve(path.dirname(file), link));
    }
  }
});
