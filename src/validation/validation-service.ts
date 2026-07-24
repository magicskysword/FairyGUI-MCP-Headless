import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildResourceReferenceIndex,
  NodeIO,
  serializeProjectFiles,
  type Component,
  type Document,
  type Package,
  type SerializedProjectFile
} from "@magicskysword/openfairygui-core";
import {
  publish,
  type PublishFileSystem
} from "@magicskysword/openfairygui-functions";
import type {
  ValidationData,
  ValidationPhase,
  ValidationPhaseName
} from "../contracts/validation.js";
import {
  fail,
  ok,
  type Diagnostic,
  type ResultEnvelope
} from "../contracts/result.js";
import type { ValidateInput } from "../contracts/tools.js";
import { toFairyDomDocument } from "../dom/openfairygui-adapter.js";
import type { ProjectRegistry } from "../project/project-registry.js";

interface ValidationScope {
  packages: Package[];
  components: Array<{
    pkg: Package;
    component: Component;
  }>;
  packageIds: Set<string>;
  componentKeys: Set<string>;
}

interface PhaseResult {
  diagnostics: Diagnostic[];
  metrics?: Record<string, number>;
}

interface ValidationServiceOptions {
  temporaryRoot?: string;
}

function resolveScope(
  document: Document,
  input: ValidateInput
): ResultEnvelope<ValidationScope> {
  const allPackages = document.getRoot().listPackages();
  const packageIds = input.packageIds
    ? new Set(input.packageIds)
    : undefined;
  if (packageIds) {
    for (const packageId of packageIds) {
      if (!allPackages.some((pkg) => pkg.getId() === packageId)) {
        return fail("PACKAGE_NOT_FOUND", `包不存在：${packageId}`, {
          path: "packageIds",
          actual: packageId,
          suggestedFix: "先通过 fairygui.query 查询有效包 ID"
        });
      }
    }
  }

  const packages = packageIds
    ? allPackages.filter((pkg) => packageIds.has(pkg.getId()))
    : allPackages;
  const requestedComponents = input.componentIds
    ? new Set(input.componentIds)
    : undefined;
  const candidates = packages.flatMap((pkg) =>
    pkg.listComponents().map((component) => ({ pkg, component }))
  );
  if (requestedComponents) {
    for (const componentId of requestedComponents) {
      if (!candidates.some(({ component }) =>
        component.getId() === componentId
      )) {
        return fail("COMPONENT_NOT_FOUND", `组件不存在：${componentId}`, {
          path: "componentIds",
          actual: componentId,
          suggestedFix: "先通过 fairygui.query 查询所选包中的有效组件 ID"
        });
      }
    }
  }

  const components = requestedComponents
    ? candidates.filter(({ component }) =>
      requestedComponents.has(component.getId())
    )
    : candidates;
  return ok({
    packages,
    components,
    packageIds: new Set(packages.map((pkg) => pkg.getId())),
    componentKeys: new Set(components.map(({ pkg, component }) =>
      `${pkg.getId()}\0${component.getId()}`
    ))
  });
}

function quickDiagnostics(
  document: Document,
  scope: ValidationScope
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const root = document.getRoot();
  if (!root.getProjectId()) {
    diagnostics.push({
      severity: "warning",
      code: "MISSING_PROJECT_ID",
      message: "FairyGUI 工程缺少工程 ID"
    });
  }

  const seenPackageIds = new Set<string>();
  for (const pkg of scope.packages) {
    const packageId = pkg.getId();
    if (!packageId) {
      diagnostics.push({
        severity: "error",
        code: "MISSING_PACKAGE_ID",
        message: `包 ${pkg.getName()} 缺少 ID`,
        path: `assets/${pkg.getName()}/package.xml`
      });
    }
    else if (seenPackageIds.has(packageId)) {
      diagnostics.push({
        severity: "error",
        code: "DUPLICATE_PACKAGE_ID",
        message: `包 ID 重复：${packageId}`,
        path: `assets/${pkg.getName()}/package.xml`
      });
    }
    seenPackageIds.add(packageId);

    const seenResourceIds = new Set<string>();
    for (const resource of pkg.listResources()) {
      const resourceId = resource.getId();
      if (!resourceId) {
        diagnostics.push({
          severity: "error",
          code: "MISSING_RESOURCE_ID",
          message: `资源 ${pkg.getName()}/${resource.getName()} 缺少 ID`
        });
      }
      else if (seenResourceIds.has(resourceId)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_RESOURCE_ID",
          message: `包 ${pkg.getName()} 中资源 ID 重复：${resourceId}`
        });
      }
      seenResourceIds.add(resourceId);
    }
  }

  for (const { pkg, component } of scope.components) {
    const componentPath = `${pkg.getId()}/${component.getId()}`;
    if (component.listChildren().length === 0) {
      diagnostics.push({
        severity: "info",
        code: "EMPTY_COMPONENT",
        message: `组件 ${pkg.getName()}/${component.getName()} 没有显示对象`,
        path: componentPath
      });
    }
    for (const controller of component.listControllers()) {
      if (controller.listPages().length === 0) {
        diagnostics.push({
          severity: "warning",
          code: "EMPTY_CONTROLLER",
          message: `控制器 ${controller.getName()} 没有页面`,
          path: componentPath
        });
      }
    }
    try {
      toFairyDomDocument(document, pkg.getId(), component.getId());
    }
    catch (error) {
      diagnostics.push({
        severity: "error",
        code: "INVALID_DOM",
        message: `组件无法投影到强类型 DOM：${
          error instanceof Error ? error.message : String(error)
        }`,
        path: componentPath
      });
    }
  }

  const references = buildResourceReferenceIndex(document).list();
  for (const reference of references) {
    const sourceKey =
      `${reference.source.packageId}\0${reference.source.componentId}`;
    if (!scope.componentKeys.has(sourceKey)) continue;
    const targetPackage = root.getPackageById(reference.target.packageId);
    const targetResource = targetPackage?.getResourceById(
      reference.target.resourceId
    );
    if (!targetResource) {
      diagnostics.push({
        severity: "error",
        code: "BROKEN_RESOURCE_REFERENCE",
        message: `资源引用不存在：${reference.value}`,
        path: [
          reference.source.packageId,
          reference.source.componentId,
          reference.source.objectId,
          reference.source.field
        ].filter(Boolean).join("/"),
        details: {
          targetPackageId: reference.target.packageId,
          targetResourceId: reference.target.resourceId
        }
      });
    }
  }
  return diagnostics;
}

function selectedSerializedFiles(
  files: SerializedProjectFile[],
  scope: ValidationScope
): SerializedProjectFile[] {
  return files.filter((file) => {
    if (file.kind === "project" || file.kind === "setting") return true;
    if (!file.packageId || !scope.packageIds.has(file.packageId)) return false;
    if (file.kind === "package") return true;
    return file.componentId !== undefined
      && scope.componentKeys.has(`${file.packageId}\0${file.componentId}`);
  });
}

function compareSerializedFiles(
  before: SerializedProjectFile[],
  after: SerializedProjectFile[]
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const beforeMap = new Map(before.map((file) => [
    file.relativePath,
    file.content
  ]));
  const afterMap = new Map(after.map((file) => [
    file.relativePath,
    file.content
  ]));
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .sort((a, b) => a.localeCompare(b));
  for (const filePath of paths) {
    if (!beforeMap.has(filePath) || !afterMap.has(filePath)) {
      diagnostics.push({
        severity: "error",
        code: "ROUNDTRIP_FILE_SET_MISMATCH",
        message: "结构化往返前后的受管文件集合不一致",
        path: filePath
      });
    }
    else if (beforeMap.get(filePath) !== afterMap.get(filePath)) {
      diagnostics.push({
        severity: "error",
        code: "ROUNDTRIP_SEMANTIC_MISMATCH",
        message: "结构化往返后的规范序列化结果不一致",
        path: filePath
      });
    }
  }
  return diagnostics;
}

function publishFileSystem(): PublishFileSystem {
  return {
    async readFileRaw(filePath: string): Promise<Uint8Array> {
      const data = await readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
    async writeFileRaw(filePath: string, data: Uint8Array): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
    },
    async mkdir(directory: string): Promise<void> {
      await mkdir(directory, { recursive: true });
    },
    async readdir(directory: string): Promise<string[]> {
      return readdir(directory);
    },
    async deleteFile(filePath: string): Promise<void> {
      await rm(filePath, { force: true });
    },
    join(...segments: string[]): string {
      return path.join(...segments);
    }
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function phaseNamesFor(
  mode: ValidateInput["mode"]
): ValidationPhaseName[] {
  switch (mode) {
    case "quick":
      return ["quick"];
    case "roundtrip":
      return ["quick", "roundtrip"];
    case "publish":
      return ["quick", "publish"];
    case "full":
      return ["quick", "roundtrip", "publish"];
  }
}

function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export class ValidationService {
  private readonly projects: ProjectRegistry;
  private readonly temporaryRoot: string;

  public constructor(
    projects: ProjectRegistry,
    options: ValidationServiceOptions = {}
  ) {
    this.projects = projects;
    this.temporaryRoot = options.temporaryRoot
      ?? path.join(os.tmpdir(), "fairygui-mcp-headless", "validation");
  }

  public async validate(
    input: ValidateInput
  ): Promise<ResultEnvelope<ValidationData>> {
    const snapshot = await this.projects.read(input.projectId, (document) => {
      const scope = resolveScope(document, input);
      if (!scope.ok) return scope;
      return ok({ document, scope: scope.data });
    });
    if (!snapshot.ok) return snapshot;
    if (!snapshot.data.ok) return snapshot.data;

    const { document, scope } = snapshot.data.data;
    const phases: ValidationPhase[] = [];
    for (const phaseName of phaseNamesFor(input.mode)) {
      if (phaseName === "quick") {
        phases.push(await this.runPhase("quick", async () => ({
          diagnostics: quickDiagnostics(document, scope),
          metrics: {
            packageCount: scope.packages.length,
            componentCount: scope.components.length,
            referenceCount: buildResourceReferenceIndex(document).list().length
          }
        })));
      }
      else if (phaseName === "roundtrip") {
        phases.push(await this.runPhase(
          "roundtrip",
          () => this.validateRoundtrip(document, scope)
        ));
      }
      else {
        phases.push(await this.runPhase(
          "publish",
          () => this.validatePublish(input, scope)
        ));
      }
    }

    const diagnostics = phases.flatMap((phase) => phase.diagnostics);
    return ok({
      mode: input.mode,
      valid: phases.every((phase) => phase.valid),
      checked: {
        packageCount: scope.packages.length,
        componentCount: scope.components.length,
        packageIds: scope.packages.map((pkg) => pkg.getId()),
        componentIds: scope.components.map(({ component }) =>
          component.getId()
        )
      },
      phases,
      diagnostics
    });
  }

  private async runPhase(
    name: ValidationPhaseName,
    action: () => Promise<PhaseResult>
  ): Promise<ValidationPhase> {
    const startedAt = performance.now();
    try {
      const result = await action();
      const durationMs = Math.max(
        0,
        Math.round((performance.now() - startedAt) * 100) / 100
      );
      return {
        name,
        valid: !hasErrors(result.diagnostics),
        durationMs,
        diagnostics: result.diagnostics,
        ...(result.metrics === undefined ? {} : { metrics: result.metrics })
      };
    }
    catch (error) {
      return {
        name,
        valid: false,
        durationMs: Math.max(
          0,
          Math.round((performance.now() - startedAt) * 100) / 100
        ),
        diagnostics: [{
          severity: "error",
          code: `${name.toUpperCase()}_VALIDATION_FAILED`,
          message: `${name} 校验无法完成`,
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        }]
      };
    }
  }

  private async validateRoundtrip(
    document: Document,
    scope: ValidationScope
  ): Promise<PhaseResult> {
    await mkdir(this.temporaryRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      path.join(this.temporaryRoot, "roundtrip-")
    );
    try {
      const io = new NodeIO();
      const projectFile = path.join(temporaryDirectory, "Roundtrip.fairy");
      const before = selectedSerializedFiles(
        await serializeProjectFiles(document),
        scope
      );
      await io.writeProject(document, projectFile);
      const reparsed = await io.readProject(projectFile);
      const after = selectedSerializedFiles(
        await serializeProjectFiles(reparsed),
        scope
      );
      return {
        diagnostics: compareSerializedFiles(before, after),
        metrics: { fileCount: before.length }
      };
    }
    finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async validatePublish(
    input: ValidateInput,
    originalScope: ValidationScope
  ): Promise<PhaseResult> {
    const status = this.projects.status(input.projectId);
    if (!status.ok) {
      throw new Error(status.error.message);
    }
    const io = new NodeIO();
    const document = await io.readProject(status.data.projectFile);
    const freshScope = resolveScope(document, input);
    if (!freshScope.ok) throw new Error(freshScope.error.message);

    await mkdir(this.temporaryRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      path.join(this.temporaryRoot, "publish-")
    );
    try {
      await document.transform(publish({
        output: temporaryDirectory,
        packages: freshScope.data.packages.map((pkg) => pkg.getName()),
        basePath: path.join(status.data.projectDirectory, "assets"),
        fs: publishFileSystem(),
        generateCode: false
      }));
      const files = await listFiles(temporaryDirectory);
      const binaryFiles = files.filter((filePath) =>
        /\.(?:fui|bytes|bin)$/i.test(filePath)
      );
      const diagnostics: Diagnostic[] = [];
      if (binaryFiles.length < freshScope.data.packages.length) {
        diagnostics.push({
          severity: "error",
          code: "PUBLISH_ARTIFACT_MISSING",
          message: "发布产物数量少于所选包数量",
          details: {
            expected: freshScope.data.packages.length,
            actual: binaryFiles.length
          }
        });
      }
      for (const binaryFile of binaryFiles) {
        const fileStat = await stat(binaryFile);
        if (fileStat.size === 0) {
          diagnostics.push({
            severity: "error",
            code: "PUBLISH_ARTIFACT_EMPTY",
            message: "发布产物为空",
            path: path.basename(binaryFile)
          });
          continue;
        }
        try {
          await io.readBinary(binaryFile);
        }
        catch (error) {
          diagnostics.push({
            severity: "error",
            code: "PUBLISH_ARTIFACT_INVALID",
            message: "发布产物无法被 OpenFairyGUI 回读",
            path: path.basename(binaryFile),
            details: {
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      if (
        input.componentIds
        && originalScope.components.length > 0
      ) {
        diagnostics.push({
          severity: "info",
          code: "PUBLISH_COMPONENT_SCOPE_EXPANDED",
          message: "publish 校验按包执行，组件筛选仅用于 quick 与 roundtrip"
        });
      }
      return {
        diagnostics,
        metrics: {
          artifactCount: binaryFiles.length,
          artifactBytes: (await Promise.all(binaryFiles.map(async (filePath) =>
            (await stat(filePath)).size
          ))).reduce((sum, size) => sum + size, 0)
        }
      };
    }
    finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
