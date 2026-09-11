import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateDefinitions } from "../../scripts/generate-definitions.js";

test('generated definitions have real model types, runtime declarations and resolvable index paths', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fgui-definitions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await generateDefinitions(directory);
  assert.ok(index.authoring.some(entry => entry.symbol === 'GTextField'));
  assert.ok(index.runtime.some(entry => entry.file.endsWith('/ui/GComponent.d.ts')));
  for (const entry of [...index.authoring, ...index.runtime, ...index.preview]) assert.ok((await readFile(path.join(directory, entry.file))).length > 0);
  const text = JSON.parse(await readFile(path.join(directory, 'authoring/GTextField.schema.json'), 'utf8'));
  assert.ok(text.properties.x);
  assert.equal(text.additionalProperties, false);
  const operations = JSON.parse(await readFile(path.join(directory, 'authoring/operations.schema.json'), 'utf8'));
  assert.equal(operations.oneOf.length, 7);
  assert.ok(index.versions['@magicskysword/fairygui-dom']);
});
