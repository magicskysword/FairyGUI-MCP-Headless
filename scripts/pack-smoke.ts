import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface PackedPackage { name: string; version: string; directory: string; tarball: string; }
const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const mcpDirectory = path.resolve(import.meta.dirname, '..');
const packageDirectories = [path.join(workspaceRoot, 'OpenFairyGUI/packages/core'), path.join(workspaceRoot, 'OpenFairyGUI/packages/functions'), path.join(workspaceRoot, 'FairyGUI-dom'), mcpDirectory];

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, stream = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stream) process.stderr.write(chunk); }); child.stderr.on('data', chunk => { stderr += chunk; if (stream) process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`命令失败 (${code}): ${command} ${args.join(' ')}\n${stderr}\n${stdout}`)));
  });
}
async function runPnpm(args: string[], cwd: string): Promise<string> {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('请通过 pnpm test:pack 运行安装冒烟测试');
  return run(process.execPath, [cli, ...args], cwd, { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, args[0] === 'install');
}
const tarballSpec = (file: string) => `file:${file.split(path.sep).join('/')}`;

async function buildAndPack(directory: string, archives: string): Promise<PackedPackage> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { name: string; version: string };
  process.stderr.write(`构建并打包 ${manifest.name}@${manifest.version}\n`);
  await runPnpm(['run', 'build'], directory);
  const before = new Set(await readdir(archives));
  await runPnpm(['pack', '--pack-destination', archives], directory);
  const added = (await readdir(archives)).filter(file => file.endsWith('.tgz') && !before.has(file));
  assert.equal(added.length, 1);
  return { ...manifest, directory, tarball: path.join(archives, added[0]!) };
}

async function createSmokeProject(temporaryRoot: string): Promise<string> {
  const directory = path.join(temporaryRoot, 'project');
  const assets = path.join(directory, 'assets/Demo'); await mkdir(assets, { recursive: true });
  await writeFile(path.join(directory, 'PackSmoke.fairy'), '<projectDescription id="pack-smoke" type="Unity" version="5.0"/>');
  await writeFile(path.join(assets, 'package.xml'), '<packageDescription id="pkg00001"><resources><component id="cmp01" name="Main.xml" path="/" exported="true"/><component id="row01" name="Row.xml" path="/" exported="true"/></resources></packageDescription>');
  await writeFile(path.join(assets, 'Main.xml'), '<component size="320,180"><displayList><text id="n0" name="title" xy="20,20" size="200,30" text="Pack smoke" fontSize="24"/></displayList></component>');
  await writeFile(path.join(assets, 'Row.xml'), '<component size="150,24" extention="Label"><displayList><text id="n0" name="title" xy="0,0" size="150,24" text="Row"/></displayList><Label/></component>');
  return directory;
}

function smokeProgram(): string {
  return String.raw`import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '@magicskysword/fairygui-mcp-headless';

const projectDirectory = process.env.FAIRYGUI_PACK_SMOKE_PROJECT;
const expectedVersions = JSON.parse(process.env.FAIRYGUI_PACK_SMOKE_VERSIONS);
assert.equal(PACKAGE_VERSION, expectedVersions[PACKAGE_NAME]);
const client = new Client({ name: 'pack-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('node_modules/@magicskysword/fairygui-mcp-headless/dist/cli.js')], stderr: 'pipe' });
async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  const envelope = result.structuredContent;
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope.data;
}
const hash = data => createHash('sha256').update(data).digest('hex');
async function sourceHashes(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sourceHashes(file)); else result[file] = hash(await readFile(file));
  }
  return result;
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(tools, ['fairygui.project', 'fairygui.query', 'fairygui.edit', 'fairygui.preview', 'fairygui.validate', 'fairygui.publish']);
  const opened = await callTool('fairygui.project', { action: 'open', path: projectDirectory });
  const projectId = opened.projectId;
  assert.equal(opened.service.version, PACKAGE_VERSION);
  for (const [name, version] of Object.entries(opened.service.runtimeVersions)) assert.equal(version, expectedVersions[name]);
  const skillDirectory = path.dirname(opened.service.skillPath);
  await readFile(opened.service.skillPath);
  const definitions = JSON.parse(await readFile(path.join(skillDirectory, 'definitions/index.json'), 'utf8'));
  assert.deepEqual(definitions.versions, expectedVersions);
  for (const entry of [...definitions.authoring, ...definitions.preview, ...definitions.runtime]) await access(path.join(skillDirectory, 'definitions', entry.file));
  await readFile(path.join(skillDirectory, 'examples/list.json'));
  const queried = await callTool('fairygui.query', { projectId, queries: {
    packages: { kind: 'packages', limit: 50 }, compact: { kind: 'components', packageId: 'pkg00001', detail: "summary" },
    full: { kind: 'object', target: { kind: 'node', packageId: 'pkg00001', componentId: 'cmp01', nodeId: 'n0' }, detail: "full" }
  } });
  for (const result of Object.values(queried.results)) assert.equal(result.ok, true);
  assert.equal(queried.results.full.data.items.length, 1);
  await readFile(queried.results.full.data.items[0].definition.file);

  const common = { packageId: 'pkg00001', componentId: '@panel' };
  const before = await sourceHashes(projectDirectory);
  const planned = await callTool('fairygui.edit', { action: "plan", projectId, operations: [
    { op: 'clone', target: { kind: 'component', packageId: 'pkg00001', componentId: 'cmp01' }, props: { name: 'Panel' }, clientRef: 'panel' },
    { op: 'create', target: { ...common, kind: 'controller' }, props: { name: 'mode' } },
    { op: 'create', target: { ...common, kind: 'page', controllerName: 'mode' }, props: { name: 'Rest' } },
    { op: 'create', target: { ...common, kind: 'page', controllerName: 'mode' }, props: { name: 'Active' } },
    { op: 'create', target: { ...common, kind: 'gear', nodeId: 'n0', controllerName: 'mode' }, props: { gearType: 1, pages: '0,1', values: '20,20|80,20', tween: true, tweenDuration: 0.5, easeType: 0 } },
    { op: 'create', target: { ...common, kind: 'node' }, type: 'GList', props: { name: 'rows', x: 20, y: 60, width: 180, height: 90, defaultItem: 'ui://pkg00001row01' } },
    { op: 'create', target: { ...common, kind: 'transition' }, props: { name: 'rotate' } },
    { op: 'create', target: { ...common, kind: 'transition-item', transitionName: 'rotate' }, props: { actionType: 5, targetId: 'n0', tween: true, duration: 12, startValue: [0], endValue: [30], easeType: 0 } },
    { op: 'xml', action: 'insert', target: { ...common, kind: 'component' }, xml: '<graph id="marker" name="marker" xy="270,130" size="20,20" type="rect" fillColor="#38bdf8"/>' }
  ] });
  assert.deepEqual(await sourceHashes(projectDirectory), before);
  const componentId = planned.clientRefs.panel.componentId;
  const previewInput = { action: 'run', source: { projectId, packageId: 'pkg00001', componentId, planId: planned.planId }, imageResult: "file", recipe: {
    data: ['Apple', 'Pear'], setup: [
      { op: 'script', code: "const list = ctx.root.getChild('rows'); list.itemRenderer = (i, cell) => cell.text = ctx.data[i]; list.numItems = ctx.data.length;" },
      { op: 'controller', name: 'mode', index: 1 }
    ]
  }, run: { times: [0, 250, 500], properties: ['x', 'text'] } };
  const preview = await callTool('fairygui.preview', previewInput);
  assert.equal(preview.complete, true); assert.equal(preview.sourceStatus, 'plan'); assert.equal(preview.frames.length, 3);
  assert.ok(preview.frames[2].nodes.some(node => node.props.text === 'Apple'));
  assert.equal(preview.frames[2].nodes.find(node => node.id === 'n0' && node.parentRef === preview.state.nodes[0].ref).props.x, 80);
  assert.deepEqual(preview.images, []); assert.ok(preview.contactSheet.path);
  for (const frame of preview.frames) assert.equal((await readFile(frame.path)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await callTool('fairygui.preview', previewInput)).cacheHit, true);
  assert.deepEqual(await sourceHashes(projectDirectory), before);
  const commit = { action: "commit", projectId, planId: planned.planId, requestId: 'commit-panel' };
  const committed = await callTool('fairygui.edit', commit);
  assert.deepEqual(await callTool('fairygui.edit', commit), committed);
  assert.ok(committed.transactionId);

  const inbox = path.join(projectDirectory, '.fairygui-mcp/import-inbox'); await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  await callTool('fairygui.edit', { action: 'apply', projectId, requestId: 'import-pixel', operations: [{ op: 'import', target: { kind: 'resource', packageId: 'pkg00001' }, inboxPath: 'pixel.png' }] });
  await assert.rejects(() => access(path.join(inbox, 'pixel.png')));
  const published = await callTool('fairygui.publish', { projectId, packageIds: ['pkg00001'], publishType: "definitions", outputPath: 'smoke-release' });
  assert.ok(published.writtenFiles.length > 0);
  const validated = await callTool('fairygui.validate', { projectId, mode: "full", detail: "summary" });
  assert.equal(validated.valid, true, JSON.stringify(validated));
  await callTool('fairygui.project', { action: "close", projectId });
  process.stdout.write(JSON.stringify({ packageName: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, tools, workflow: { planId: planned.planId, operations: planned.operationResults.length, frames: preview.frames.length, cacheHit: true, idempotent: true, sourceUnchangedDuringPreview: true, valid: validated.valid, published: published.writtenFiles.length } }));
} finally { await client.close(); }
`;
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'fairygui-mcp-pack-smoke-'));
const relative = path.relative(os.tmpdir(), temporaryRoot);
assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
let completed = false;
try {
  const archives = path.join(temporaryRoot, 'archives'); const installation = path.join(temporaryRoot, 'install');
  await mkdir(archives); await mkdir(installation);
  const packed: PackedPackage[] = [];
  for (const directory of packageDirectories) packed.push(await buildAndPack(directory, archives));
  assert.deepEqual(packed.map(entry => entry.name), ['@magicskysword/openfairygui-core', '@magicskysword/openfairygui-functions', '@magicskysword/fairygui-dom', '@magicskysword/fairygui-mcp-headless']);
  const overrides = Object.fromEntries(packed.filter(entry => entry.directory !== mcpDirectory).map(entry => [entry.name, tarballSpec(entry.tarball)]));
  const dependencies = { ...Object.fromEntries(packed.map(entry => [entry.name, tarballSpec(entry.tarball)])), '@modelcontextprotocol/sdk': '^1.29.0' };
  await writeFile(path.join(installation, 'package.json'), JSON.stringify({ name: 'fairygui-mcp-pack-smoke', version: '1.0.0', private: true, type: 'module', dependencies, pnpm: { overrides } }, null, 2));
  await writeFile(path.join(installation, 'smoke.mjs'), smokeProgram());
  process.stderr.write('在独立目录安装四个 tarball\n');
  await runPnpm(['install', '--config.link-workspace-packages=false', '--ignore-scripts', '--prefer-offline', '--network-concurrency=4', '--fetch-timeout=30000', '--fetch-retries=1'], installation);
  for (const entry of packed) {
    const installed = JSON.parse(await readFile(path.join(installation, 'node_modules', ...entry.name.split('/'), 'package.json'), 'utf8'));
    assert.equal(installed.name, entry.name); assert.equal(installed.version, entry.version);
  }
  const projectDirectory = await createSmokeProject(temporaryRoot);
  process.stderr.write('运行独立 stdio 创作、计划预览、提交与发布校验\n');
  const smoke = JSON.parse(await run(process.execPath, ['smoke.mjs'], installation, { ...process.env, FAIRYGUI_PACK_SMOKE_PROJECT: projectDirectory, FAIRYGUI_PACK_SMOKE_VERSIONS: JSON.stringify(Object.fromEntries(packed.map(entry => [entry.name, entry.version]))) }));
  const artifactRoot = path.join(workspaceRoot, 'artifacts'); await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, 'v2-local-'));
  const delivered = [];
  for (const entry of packed) {
    const target = path.join(output, path.basename(entry.tarball)); await copyFile(entry.tarball, target);
    delivered.push({ name: entry.name, version: entry.version, tarball: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
  }
  const localDependencies = Object.fromEntries(delivered.map(entry => [entry.name, `file:./${path.basename(entry.tarball)}`]));
  const runtimeManifest = JSON.parse(await readFile(path.join(mcpDirectory, 'package.json'), 'utf8'));
  const localOverrides = Object.fromEntries(delivered.filter(entry => entry.name !== runtimeManifest.name).map(entry => [entry.name, localDependencies[entry.name]]));
  await writeFile(path.join(output, 'package.json'), JSON.stringify({ name: 'fairygui-local-bundle', version: runtimeManifest.version, private: true, type: 'module', engines: { node: '>=24' }, scripts: { start: 'fairygui-mcp-headless' }, dependencies: { ...localDependencies, playwright: runtimeManifest.dependencies.playwright }, pnpm: { overrides: localOverrides } }, null, 2) + '\n');
  await writeFile(path.join(output, 'README.md'), '# FairyGUI 本地安装包\n\n使用 Node.js 24 或更新版本，在此目录执行：\n\n```sh\npnpm install --ignore-workspace\npnpm exec playwright install chromium\npnpm start\n```\n\nMCP 客户端可启动 `node node_modules/@magicskysword/fairygui-mcp-headless/dist/cli.js`，通过标准输入输出连接。\n\n包版本、SHA-256 和独立安装验收结果见 [verification.json](verification.json)。\n');
  const result = { isolatedInstall: true, artifactDirectory: output, packed: delivered, ...smoke };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); completed = true;
} finally {
  if (completed || process.env.KEEP_PACK_SMOKE !== '1') await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else process.stderr.write(`保留失败现场：${temporaryRoot}\n`);
}
