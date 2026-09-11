import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildProjectReferenceGraph } from '@magicskysword/openfairygui-core';
import { NativeQueryService } from '../src/query/native-query-service.js';
import { NativeQueryInputSchema } from '../src/contracts/native-query.js';
import { ProjectRegistry } from '../src/project/project-registry.js';
import { EditService } from '../src/edit/edit-service.js';
import { PreviewService } from '../src/preview/preview-service.js';
import { snapshotProject, projectSourceFileSystem } from '../src/project/source-snapshot.js';
import { PROJECT_SERVICE_INFO } from '../src/version.js';

const workspace = path.resolve(import.meta.dirname, '../..');
const output = path.join(workspace, 'acceptance-evidence/native-preview');
const cases = [
  { file: 'FairyGUI-Editor/ui/FairyGUI-Editor.fairy', packageId: 'nk9ejx23', componentId: 'xualm' },
  { file: 'NewUI/NewUI.fairy', packageId: 'zuvkwb6n', componentId: '7kw8cz' }
];
const records = [];
await mkdir(output, { recursive: true });
for (const entry of cases) {
  const file = path.join(workspace, entry.file);
  const registry = new ProjectRegistry(); const edits = new EditService(registry);
  const previews = new PreviewService(registry, { edits, temporaryRoot: output });
  const started = performance.now();
  try {
    process.stderr.write(`验收 ${entry.file}\n`);
    const opened = await registry.open(file); assert.ok(opened.ok, JSON.stringify(opened));
    if (!opened.ok) continue;
    const openMs = performance.now() - started;
    const snapshot = await snapshotProject(file); const document = await snapshot.readDocument();
    const component = document.getRoot().getPackageById(entry.packageId)!.listComponents().find(item => item.getId() === entry.componentId)!;
    const node = component.listChildren()[0]!;
    const query = new NativeQueryService(registry);
    const queryTimes = [];
    let queryBytes = 0;
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const result = await query.execute(NativeQueryInputSchema.parse({ projectId: opened.data.projectId, queries: { node: { kind: 'nodes', packageId: entry.packageId, componentId: entry.componentId, nodeId: node.getId(), detail: 'full' } } }));
      queryTimes.push(performance.now() - start); assert.ok(result.ok, JSON.stringify(result)); queryBytes = Buffer.byteLength(JSON.stringify(result));
    }
    const plannedAt = performance.now();
    const plan = await edits.execute({ action: 'plan', projectId: opened.data.projectId, operations: [{ op: 'update', target: { kind: 'component', packageId: entry.packageId, componentId: entry.componentId }, props: { width: component.getWidth() + 1 } }] });
    assert.ok(plan.ok, JSON.stringify(plan)); if (!plan.ok) continue;
    const planMs = performance.now() - plannedAt;
    const source = { projectId: opened.data.projectId, packageId: entry.packageId, componentId: entry.componentId, planId: plan.data.planId };
    const captures = [];
    for (let index = 0; index < 2; index++) {
      const start = performance.now();
      const result = await previews.execute({ action: 'run', source, imageResult: 'file', run: { times: [0, 100, 300], properties: ['x', 'y', 'alpha', 'visible'] } });
      assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) continue;
      assert.equal(result.data.complete, true, JSON.stringify(result.data.error));
      captures.push({ ms: performance.now() - start, cacheHit: result.data.cacheHit, contactSheet: result.data.contactSheet?.path, frames: await Promise.all(result.data.frames.map(async frame => ({ requested: frame.requestedTime, actual: frame.time, frame: frame.frame, file: frame.path, hash: createHash('sha256').update(await readFile(frame.path)).digest('hex'), props: frame.nodes.map(node => ({ id: node.id, props: node.props })) }))) });
    }
    assert.equal(previews.compilationCount, 1);
    assert.deepEqual(captures[0]!.frames.map(frame => frame.hash), captures[1]!.frames.map(frame => frame.hash));
    const unchanged = await snapshot.changedSources(projectSourceFileSystem(path.dirname(file)));
    assert.deepEqual(unchanged, []);
    records.push({ source: entry, componentName: component.getName(), fingerprint: snapshot.fingerprint, capturedFileCount: snapshot.listFiles().length, existingDiagnostics: buildProjectReferenceGraph(document).diagnostics, openMs, queryMs: queryTimes, queryBytes, planMs, plannedFiles: plan.data.files, captures, sourceUnchanged: true });
    await writeFile(path.join(output, 'verification.json'), JSON.stringify({ service: PROJECT_SERVICE_INFO, records }, null, 2));
  } finally { await previews.closeAll(); await registry.closeAll(); }
}
process.stdout.write(JSON.stringify({ output, records: records.map(record => ({ source: record.source.file, existingDiagnostics: record.existingDiagnostics.length, openMs: record.openMs, queryMs: record.queryMs, planMs: record.planMs, previews: record.captures.map(capture => ({ ms: capture.ms, cacheHit: capture.cacheHit })), sourceUnchanged: record.sourceUnchanged })) }, null, 2) + '\n');
