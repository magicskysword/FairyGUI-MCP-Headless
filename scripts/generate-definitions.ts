import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Document, AUTHORING_OPERATION_SCHEMA, AUTHORING_TARGET_SCHEMA, authoringPropertySchema, type Property } from "@magicskysword/openfairygui-core";
import { PreviewRecipeSchema, PreviewRunSchema, PreviewOperationSchema } from "../src/contracts/preview.js";
import ts from 'typescript';

interface DefinitionEntry { symbol: string; file: string; }
interface DefinitionIndex { versions: Record<string, string>; authoring: DefinitionEntry[]; runtime: DefinitionEntry[]; preview: DefinitionEntry[]; }
const repository = fileURLToPath(new URL("../", import.meta.url));
async function packageManifest(name: string): Promise<{ directory: string; version: string; types?: string }> {
  let directory = name === '@magicskysword/fairygui-mcp-headless' ? repository : path.dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, version: manifest.version, ...(manifest.types ? { types: manifest.types } : {}) };
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Package manifest not found: ${name}`);
    directory = parent;
  }
}
async function declarations(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await declarations(file));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) result.push(file);
  }
  return result.sort();
}
export async function generateDefinitions(output = path.join(repository, 'skills/fairygui-headless/definitions')): Promise<DefinitionIndex> {
  const index: DefinitionIndex = { versions: {}, authoring: [], runtime: [], preview: [] };
  const write = async (file: string, data: unknown) => {
    const target = path.join(output, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', 'utf8');
  };
  const document = new Document();
  const models: Property[] = [document.getRoot()];
  for (const method of Object.getOwnPropertyNames(Document.prototype)) {
    if (!/^create(?:Package|Component|G[A-Z]\w+|Controller(?:Page|Action)?|Gear|Transition(?:Item)?|[A-Z]\w+Resource)$/.test(method)) continue;
    models.push(((document as unknown as Record<string, () => Property>)[method]!).call(document));
  }
  for (const model of models) {
    const file = `authoring/${model.propertyType}.schema.json`;
    await write(file, { $schema: 'https://json-schema.org/draft/2020-12/schema', title: model.propertyType, ...authoringPropertySchema(model) });
    index.authoring.push({ symbol: model.propertyType, file });
  }
  for (const [symbol, schema] of [['operations', AUTHORING_OPERATION_SCHEMA], ['target', AUTHORING_TARGET_SCHEMA]] as const) {
    const file = `authoring/${symbol}.schema.json`; await write(file, schema); index.authoring.push({ symbol, file });
  }
  for (const [symbol, schema] of [['recipe', PreviewRecipeSchema], ['run', PreviewRunSchema], ['operation', PreviewOperationSchema]] as const) {
    const file = `preview/${symbol}.schema.json`; await write(file, z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' })); index.preview.push({ symbol, file });
  }
  const configFile = ts.readConfigFile(path.join(repository, 'tsconfig.build.json'), ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repository);
  const program = ts.createProgram(['preview-context.ts', 'preview-state.ts'].map(file => path.join(repository, 'src/contracts', file)), { ...config.options, declaration: true, declarationMap: false, emitDeclarationOnly: true });
  const previewDeclarations = new Map<string, string>();
  const emitted = program.emit(undefined, (file, content) => {
    if (/preview-(?:context|state)\.d\.ts$/.test(file)) previewDeclarations.set(path.basename(file, '.d.ts'), content);
  });
  if (emitted.emitSkipped) throw new Error('Preview declaration build failed');
  for (const [symbol, declaration] of previewDeclarations) {
    const file = `preview/${symbol}.d.ts`;
    await write(file, declaration.replaceAll('@magicskysword/fairygui-dom', '../runtime/FairyGUI'));
    index.preview.push({ symbol, file });
  }
  for (const name of ['@magicskysword/openfairygui-core', '@magicskysword/openfairygui-functions', '@magicskysword/fairygui-dom', '@magicskysword/fairygui-mcp-headless']) {
    const manifest = await packageManifest(name);
    index.versions[name] = manifest.version;
    if (name !== '@magicskysword/fairygui-dom') continue;
    const typesDirectory = path.dirname(path.join(manifest.directory, manifest.types!));
    for (const source of await declarations(typesDirectory)) {
      const file = `runtime/${path.relative(typesDirectory, source).split(path.sep).join('/')}`;
      await write(file, await readFile(source, 'utf8'));
      index.runtime.push({ symbol: path.basename(source, '.d.ts'), file });
    }
  }
  await write('index.json', index);
  return index;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateDefinitions();
