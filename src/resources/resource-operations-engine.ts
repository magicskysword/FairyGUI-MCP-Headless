import {
  buildResourceReferenceIndex,
  generatePackageId,
  generateResourceId,
  PropertyType,
  type Document,
  type Package,
  type ResourceReference
} from "@magicskysword/openfairygui-core";
import {
  fail,
  ok,
  type ErrorCode,
  type ErrorOptions,
  type ResultEnvelope
} from "../contracts/result.js";
import type {
  ApplyResourceOperationsInput,
  ResourceOperation
} from "../contracts/tools.js";
import type { ImportInboxFile } from "./import-inbox.js";

const PACKAGE_ID_PATTERN = /^[a-z0-9]{8}$/;
const INVALID_FILE_NAME_CHARACTERS = /[\u0000-\u001f<>:"/\\|?*]/u;
const RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export interface ResourceOperationClientRef {
  kind: "package" | "component" | "resource";
  packageId: string;
  resourceId?: string;
}

export interface ResourceOperationPackageSnapshot {
  kind: "package";
  packageId: string;
  name: string;
  resourceCount: number;
  componentCount: number;
}

export interface ResourceOperationResourceSnapshot {
  kind: "resource";
  packageId: string;
  resourceId: string;
  name: string;
  type: string;
  path: string;
  exported: boolean;
  fileName?: string;
  width?: number;
  height?: number;
}

export type ResourceOperationSnapshot =
  | ResourceOperationPackageSnapshot
  | ResourceOperationResourceSnapshot;

export interface ResourceOperationResult {
  index: number;
  op: ResourceOperation["op"];
  before: ResourceOperationSnapshot | null;
  after: ResourceOperationSnapshot | null;
}

export interface AffectedResourceReference {
  change: "added" | "removed";
  reference: ResourceReference;
}

export interface ResourceOperationsEngineData {
  appliedOperations: number;
  operationResults: ResourceOperationResult[];
  affectedReferences: AffectedResourceReference[];
  clientRefs: Record<string, ResourceOperationClientRef>;
  affectedPackageIds: string[];
  affectedComponents: Array<{
    packageId: string;
    componentId: string;
  }>;
  fileMoves: Array<{
    from: string;
    to: string;
  }>;
  deletedFiles: string[];
  assetMoves: Array<{
    from: string;
    to: string;
  }>;
  deletedAssetFiles: string[];
  assetWrites: Array<{
    relativePath: string;
    content: Uint8Array;
    targetExisted: boolean;
  }>;
  consumedInboxPaths: string[];
  deleteResults: ResourceDeleteResult[];
  projectMayBeInvalid: boolean;
}

export interface ResourceDeleteResult {
  kind: "resource" | "package";
  packageId: string;
  resourceId?: string;
  requestedMode: "reject" | "cascade" | "force";
  effectiveMode:
    | "reject"
    | "cascade"
    | "cascade-with-force-fallback"
    | "force";
  removedReferences: number;
  unsupportedReferences: number;
}

export interface ResourceOperationsEngineOptions {
  importFiles?: ReadonlyMap<number, ImportInboxFile>;
}

function packageSnapshot(
  document: Document,
  packageId: string
): ResourceOperationPackageSnapshot | null {
  const pkg = document.getRoot().getPackageById(packageId);
  if (!pkg) return null;
  return {
    kind: "package",
    packageId,
    name: pkg.getName(),
    resourceCount: pkg.listResources().length,
    componentCount: pkg.listComponents().length
  };
}

function resourceSnapshot(
  document: Document,
  packageId: string,
  resourceId: string
): ResourceOperationResourceSnapshot | null {
  const resource = document.getRoot()
    .getPackageById(packageId)
    ?.getResourceById(resourceId);
  if (!resource) return null;
  const optional = resource as unknown as {
    getFileName?: () => string;
    getWidth?: () => number;
    getHeight?: () => number;
  };
  return {
    kind: "resource",
    packageId,
    resourceId,
    name: resource.getName(),
    type: resource.propertyType,
    path: resource.getPath(),
    exported: resource.getExported(),
    ...(typeof optional.getFileName === "function"
      ? { fileName: optional.getFileName() }
      : {}),
    ...(resource.propertyType === PropertyType.COMPONENT
      && typeof optional.getWidth === "function"
      && typeof optional.getHeight === "function"
      ? {
          width: optional.getWidth(),
          height: optional.getHeight()
        }
      : {})
  };
}

function clientRefSnapshot(
  document: Document,
  data: ResourceOperationsEngineData,
  clientRef: string
): ResourceOperationSnapshot | null {
  const target = data.clientRefs[clientRef];
  if (!target) return null;
  return target.resourceId === undefined
    ? packageSnapshot(document, target.packageId)
    : resourceSnapshot(document, target.packageId, target.resourceId);
}

function operationSnapshot(
  document: Document,
  operation: ResourceOperation,
  data: ResourceOperationsEngineData,
  phase: "before" | "after"
): ResourceOperationSnapshot | null {
  switch (operation.op) {
    case "create-package":
    case "create-component":
      return phase === "before"
        ? null
        : clientRefSnapshot(document, data, operation.clientRef);
    case "import":
      if (phase === "before") {
        return operation.conflict === "replace" && operation.resourceId
          ? resourceSnapshot(
              document,
              operation.packageId,
              operation.resourceId
            )
          : null;
      }
      return clientRefSnapshot(document, data, operation.clientRef);
    case "replace-resource":
    case "rename-resource":
    case "move-resource":
      return resourceSnapshot(
        document,
        operation.packageId,
        operation.resourceId
      );
    case "rename-package":
      return packageSnapshot(document, operation.packageId);
    case "delete-resource":
      return phase === "after"
        ? null
        : resourceSnapshot(
            document,
            operation.packageId,
            operation.resourceId
          );
    case "delete-package":
      return phase === "after"
        ? null
        : packageSnapshot(document, operation.packageId);
  }
}

function referenceChanges(
  before: ResourceReference[],
  after: ResourceReference[]
): AffectedResourceReference[] {
  const beforeByKey = new Map(
    before.map((reference) => [JSON.stringify(reference), reference])
  );
  const afterByKey = new Map(
    after.map((reference) => [JSON.stringify(reference), reference])
  );
  return [
    ...[...beforeByKey]
      .filter(([key]) => !afterByKey.has(key))
      .map(([key, reference]) => ({
        key,
        change: "removed" as const,
        reference
      })),
    ...[...afterByKey]
      .filter(([key]) => !beforeByKey.has(key))
      .map(([key, reference]) => ({
        key,
        change: "added" as const,
        reference
      }))
  ]
    .sort((left, right) =>
      left.change.localeCompare(right.change)
      || left.key.localeCompare(right.key)
    )
    .map(({ change, reference }) => ({ change, reference }));
}

class ResourceOperationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly options: ErrorOptions = {}
  ) {
    super(message);
    this.name = "ResourceOperationError";
  }
}

function operationError(
  code: ErrorCode,
  message: string,
  options: ErrorOptions = {}
): never {
  throw new ResourceOperationError(code, message, options);
}

function assertPortableName(
  name: string,
  path: string,
  kind: "包" | "组件" | "资源"
): void {
  if (
    name === "."
    || name === ".."
    || INVALID_FILE_NAME_CHARACTERS.test(name)
    || RESERVED_FILE_NAME.test(name)
    || name.endsWith(".")
    || name.endsWith(" ")
  ) {
    operationError("INVALID_ARGUMENT", `${kind}名称不能安全映射为工程文件名`, {
      path,
      actual: name,
      suggestedFix:
        "使用不含路径分隔符、控制字符、系统保留名或结尾点号/空格的名称"
    });
  }
}

function assertComponentName(name: string, path: string): void {
  assertPortableName(name, path, "组件");
  if (name.toLocaleLowerCase().endsWith(".xml")) {
    operationError("INVALID_ARGUMENT", "组件名称不应包含 .xml 扩展名", {
      path,
      actual: name,
      suggestedFix: `改用 ${name.slice(0, -4) || "Component"}`
    });
  }
}

function normalizeResourcePath(value: string | undefined, path: string): string {
  const source = value ?? "/";
  if (source.includes("\\")) {
    operationError("INVALID_ARGUMENT", "资源路径必须使用正斜杠", {
      path,
      actual: source,
      suggestedFix: "例如使用 /screens/dialogs/"
    });
  }
  const segments = source.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      operationError("INVALID_ARGUMENT", "资源路径不能包含 . 或 .. 段", {
        path,
        actual: source
      });
    }
    assertPortableName(segment, path, "组件");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function canonicalExistingResourcePath(value: string | undefined): string {
  const segments = (value ?? "/")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

function samePortableName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

type PackageResource = ReturnType<Package["listResources"]>[number];
type MutablePackageResource = PackageResource & Record<string, unknown>;

function resourceBranch(resource: PackageResource): string {
  return "getBranch" in resource
    ? (resource as PackageResource & { getBranch(): string }).getBranch()
    : "";
}

function modelFilePaths(document: Document): Map<string, string> {
  const files = new Map<string, string>();
  for (const pkg of document.getRoot().listPackages()) {
    const branches = new Set(
      pkg.listResources().map((resource) => resourceBranch(resource))
    );
    branches.add("");
    for (const branch of branches) {
      files.set(
        `package:${pkg.getId()}:${branch}`,
        branch
          ? `assets_${branch}/${pkg.getName()}/package_branch.xml`
          : `assets/${pkg.getName()}/package.xml`
      );
    }
    for (const component of pkg.listComponents()) {
      const branch = component.getBranch();
      const resourcePath = canonicalExistingResourcePath(
        component.getPath()
      ).replace(/^\/|\/$/g, "");
      files.set(
        `component:${pkg.getId()}:${component.getId()}`,
        [
          branch ? `assets_${branch}` : "assets",
          pkg.getName(),
          ...(resourcePath ? [resourcePath] : []),
          `${component.getName()}.xml`
        ].join("/")
      );
    }
  }
  return files;
}

function resourceFileName(resource: PackageResource): string | undefined {
  const owner = resource as MutablePackageResource;
  for (const getter of ["getFileName", "getFile"] as const) {
    const candidate = owner[getter];
    if (typeof candidate !== "function") continue;
    const value = (candidate as () => unknown).call(owner);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function assetRelativePath(
  pkg: Package,
  resource: PackageResource,
  fileName = resourceFileName(resource)
): string | undefined {
  if (!fileName || resource.propertyType === PropertyType.COMPONENT) {
    return undefined;
  }
  const branch = resourceBranch(resource);
  const resourcePath = canonicalExistingResourcePath(
    resource.getPath?.()
  ).replace(/^\/|\/$/g, "");
  return [
    branch ? `assets_${branch}` : "assets",
    pkg.getName(),
    ...(resourcePath ? [resourcePath] : []),
    fileName
  ].join("/");
}

function modelAssetPaths(document: Document): Map<string, string> {
  const files = new Map<string, string>();
  for (const pkg of document.getRoot().listPackages()) {
    for (const resource of pkg.listResources()) {
      const relativePath = assetRelativePath(pkg, resource);
      if (relativePath) {
        files.set(
          `asset:${pkg.getId()}:${resource.getId()}`,
          relativePath
        );
      }
    }
  }
  return files;
}

function invokeResource(
  resource: PackageResource,
  method: string,
  values: unknown[],
  argumentPath: string
): void {
  const candidate = (resource as MutablePackageResource)[method];
  if (typeof candidate !== "function") {
    operationError("INVALID_ARGUMENT", "资源类型不支持该文件操作", {
      path: argumentPath,
      actual: resource.propertyType
    });
  }
  (candidate as (...args: unknown[]) => unknown).apply(resource, values);
}

function setResourceFileName(
  resource: PackageResource,
  fileName: string,
  argumentPath: string
): void {
  const owner = resource as MutablePackageResource;
  if (typeof owner.setFileName === "function") {
    invokeResource(resource, "setFileName", [fileName], argumentPath);
    return;
  }
  invokeResource(resource, "setFile", [fileName], argumentPath);
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg"
]);
const SOUND_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const FONT_EXTENSIONS = new Set([
  ".fnt",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2"
]);

function importedExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index <= 0 ? "" : fileName.slice(index);
}

function importedPropertyType(fileName: string): PropertyType {
  const extension = importedExtension(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return PropertyType.IMAGE_RESOURCE;
  if (SOUND_EXTENSIONS.has(extension)) return PropertyType.SOUND_RESOURCE;
  if (FONT_EXTENSIONS.has(extension)) return PropertyType.FONT_RESOURCE;
  if (extension === ".jta") return PropertyType.MOVIE_CLIP_RESOURCE;
  return PropertyType.MISC_RESOURCE;
}

function createImportedResource(
  document: Document,
  propertyType: PropertyType,
  name: string
): PackageResource {
  switch (propertyType) {
    case PropertyType.IMAGE_RESOURCE:
      return document.createImageResource(name);
    case PropertyType.SOUND_RESOURCE:
      return document.createSoundResource(name);
    case PropertyType.FONT_RESOURCE:
      return document.createFontResource(name);
    case PropertyType.MOVIE_CLIP_RESOURCE:
      return document.createMovieClipResource(name);
    default:
      return document.createMiscResource(name);
  }
}

function packageById(
  document: Document,
  packageId: string,
  path: string
): Package {
  const pkg = document.getRoot().getPackageById(packageId);
  if (!pkg) {
    operationError("PACKAGE_NOT_FOUND", `包不存在：${packageId}`, {
      path,
      actual: packageId
    });
  }
  return pkg;
}

function resourceById(
  pkg: Package,
  resourceId: string,
  path: string
): PackageResource {
  const resource = pkg.getResourceById(resourceId);
  if (!resource) {
    operationError("RESOURCE_NOT_FOUND", `资源不存在：${resourceId}`, {
      path,
      actual: {
        packageId: pkg.getId(),
        resourceId
      }
    });
  }
  return resource;
}

function assertNoResourceNameConflict(
  pkg: Package,
  resource: PackageResource | undefined,
  name: string,
  resourcePath: string,
  path: string
): void {
  const conflict = pkg.listResources().find((candidate) =>
    candidate !== resource
    && samePortableName(candidate.getName(), name)
    && canonicalExistingResourcePath(candidate.getPath?.()) === resourcePath
  );
  if (conflict) {
    operationError("RESOURCE_CONFLICT", "目标路径中已存在同名资源", {
      path,
      actual: {
        packageId: pkg.getId(),
        resourceId: conflict.getId(),
        name,
        resourcePath
      },
      suggestedFix: "选择其他名称或资源路径"
    });
  }
}

function assertUnusedClientRef(
  clientRefs: Record<string, ResourceOperationClientRef>,
  clientRef: string,
  path: string
): void {
  if (clientRefs[clientRef] !== undefined) {
    operationError("INVALID_ARGUMENT", "同一批次不能重复声明 clientRef", {
      path,
      actual: clientRef
    });
  }
}

function packageForOperation(
  document: Document,
  clientRefs: Record<string, ResourceOperationClientRef>,
  operation: Extract<ResourceOperation, { op: "create-component" }>,
  operationPath: string
): Package {
  if (operation.packageId !== undefined) {
    const pkg = document.getRoot().getPackageById(operation.packageId);
    if (!pkg) {
      operationError("PACKAGE_NOT_FOUND", `包不存在：${operation.packageId}`, {
        path: `${operationPath}.packageId`,
        actual: operation.packageId
      });
    }
    return pkg;
  }
  const resolved = clientRefs[operation.packageRef!];
  if (!resolved || resolved.kind !== "package") {
    operationError("INVALID_ARGUMENT", "packageRef 未引用同批次已创建的包", {
      path: `${operationPath}.packageRef`,
      actual: operation.packageRef,
      suggestedFix: "先执行 create-package，再用其 clientRef 创建组件"
    });
  }
  return document.getRoot().getPackageById(resolved.packageId)!;
}

function applyCreatePackage(
  document: Document,
  operation: Extract<ResourceOperation, { op: "create-package" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  assertUnusedClientRef(
    data.clientRefs,
    operation.clientRef,
    `${operationPath}.clientRef`
  );
  assertPortableName(operation.name, `${operationPath}.name`, "包");
  const packages = document.getRoot().listPackages();
  if (packages.some((pkg) => samePortableName(pkg.getName(), operation.name))) {
    operationError("RESOURCE_CONFLICT", "包名称已存在", {
      path: `${operationPath}.name`,
      actual: operation.name,
      suggestedFix: "选择唯一包名，或操作已有包"
    });
  }
  if (operation.id !== undefined && !PACKAGE_ID_PATTERN.test(operation.id)) {
    operationError("INVALID_ARGUMENT", "新包 ID 必须为 8 位小写字母数字", {
      path: `${operationPath}.id`,
      actual: operation.id,
      allowed: PACKAGE_ID_PATTERN.source
    });
  }
  const existingIds = packages.map((pkg) => pkg.getId());
  const packageId = operation.id ?? generatePackageId(existingIds);
  if (existingIds.includes(packageId)) {
    operationError("RESOURCE_CONFLICT", "包 ID 已存在", {
      path: `${operationPath}.id`,
      actual: packageId
    });
  }
  document.createPackage(operation.name).setId(packageId);
  data.clientRefs[operation.clientRef] = {
    kind: "package",
    packageId
  };
  data.affectedPackageIds.push(packageId);
}

function applyCreateComponent(
  document: Document,
  operation: Extract<ResourceOperation, { op: "create-component" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  assertUnusedClientRef(
    data.clientRefs,
    operation.clientRef,
    `${operationPath}.clientRef`
  );
  assertComponentName(operation.name, `${operationPath}.name`);
  const resourcePath = normalizeResourcePath(
    operation.path,
    `${operationPath}.path`
  );
  const pkg = packageForOperation(
    document,
    data.clientRefs,
    operation,
    operationPath
  );
  if (
    pkg.listResources().some((resource) =>
      samePortableName(resource.getName(), operation.name)
      && canonicalExistingResourcePath(resource.getPath?.()) === resourcePath
    )
  ) {
    operationError("RESOURCE_CONFLICT", "目标路径中已存在同名资源", {
      path: `${operationPath}.name`,
      actual: {
        packageId: pkg.getId(),
        name: operation.name,
        path: resourcePath
      },
      suggestedFix: "选择其他名称或资源路径"
    });
  }
  const resourceId = generateResourceId(
    pkg.listResources().map((resource) => resource.getId())
  );
  const component = document.createComponent(operation.name)
    .setId(resourceId)
    .setPath(resourcePath)
    .setSize(operation.width ?? 0, operation.height ?? 0);
  pkg.addResource(component);
  data.clientRefs[operation.clientRef] = {
    kind: "component",
    packageId: pkg.getId(),
    resourceId
  };
  data.affectedPackageIds.push(pkg.getId());
  data.affectedComponents.push({
    packageId: pkg.getId(),
    componentId: resourceId
  });
}

function applyRenamePackage(
  document: Document,
  operation: Extract<ResourceOperation, { op: "rename-package" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  assertPortableName(operation.name, `${operationPath}.name`, "包");
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  if (pkg.getName() === operation.name) {
    operationError("INVALID_ARGUMENT", "包名称没有发生变化", {
      path: `${operationPath}.name`,
      actual: operation.name
    });
  }
  const conflict = document.getRoot().listPackages().find((candidate) =>
    candidate !== pkg
    && samePortableName(candidate.getName(), operation.name)
  );
  if (conflict) {
    operationError("RESOURCE_CONFLICT", "包名称已存在", {
      path: `${operationPath}.name`,
      actual: operation.name
    });
  }
  pkg.setName(operation.name);
  data.affectedPackageIds.push(pkg.getId());
  for (const component of pkg.listComponents()) {
    data.affectedComponents.push({
      packageId: pkg.getId(),
      componentId: component.getId()
    });
  }
}

function applyRenameResource(
  document: Document,
  operation: Extract<ResourceOperation, { op: "rename-resource" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  const resource = resourceById(
    pkg,
    operation.resourceId,
    `${operationPath}.resourceId`
  );
  if (resource.propertyType === PropertyType.COMPONENT) {
    assertComponentName(operation.name, `${operationPath}.name`);
  }
  else {
    assertPortableName(operation.name, `${operationPath}.name`, "资源");
  }
  if (resource.getName() === operation.name) {
    operationError("INVALID_ARGUMENT", "资源名称没有发生变化", {
      path: `${operationPath}.name`,
      actual: operation.name
    });
  }
  const resourcePath = canonicalExistingResourcePath(resource.getPath?.());
  assertNoResourceNameConflict(
    pkg,
    resource,
    operation.name,
    resourcePath,
    `${operationPath}.name`
  );
  if (resource.propertyType !== PropertyType.COMPONENT) {
    const fileName = resourceFileName(resource);
    if (fileName) {
      setResourceFileName(
        resource,
        `${operation.name}${importedExtension(fileName)}`,
        `${operationPath}.name`
      );
    }
  }
  resource.setName(operation.name);
  data.affectedPackageIds.push(pkg.getId());
  if (resource.propertyType === PropertyType.COMPONENT) {
    data.affectedComponents.push({
      packageId: pkg.getId(),
      componentId: resource.getId()
    });
  }
}

function applyMoveResource(
  document: Document,
  operation: Extract<ResourceOperation, { op: "move-resource" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  if (
    operation.targetPackageId !== undefined
    && operation.targetPackageId !== operation.packageId
  ) {
    operationError(
      "CROSS_PACKAGE_MOVE_UNSUPPORTED",
      "V1 仅支持包内移动资源",
      {
        path: `${operationPath}.targetPackageId`,
        actual: operation.targetPackageId,
        allowed: [operation.packageId],
        suggestedFix: "保留原 packageId，仅修改 path"
      }
    );
  }
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  const resource = resourceById(
    pkg,
    operation.resourceId,
    `${operationPath}.resourceId`
  );
  const resourcePath = normalizeResourcePath(
    operation.path,
    `${operationPath}.path`
  );
  if (canonicalExistingResourcePath(resource.getPath?.()) === resourcePath) {
    operationError("INVALID_ARGUMENT", "资源路径没有发生变化", {
      path: `${operationPath}.path`,
      actual: operation.path
    });
  }
  assertNoResourceNameConflict(
    pkg,
    resource,
    resource.getName(),
    resourcePath,
    `${operationPath}.path`
  );
  resource.setPath(resourcePath);
  data.affectedPackageIds.push(pkg.getId());
  if (resource.propertyType === PropertyType.COMPONENT) {
    data.affectedComponents.push({
      packageId: pkg.getId(),
      componentId: resource.getId()
    });
  }
}

function materializedImport(
  options: ResourceOperationsEngineOptions,
  operationIndex: number,
  operationPath: string
): ImportInboxFile {
  const file = options.importFiles?.get(operationIndex);
  if (!file) {
    operationError(
      "IMPORT_NOT_REGULAR_FILE",
      "资源操作缺少已验证的收件箱普通文件",
      {
        path: `${operationPath}.inboxPath`,
        suggestedFix: "通过 ResourceOperationsService 执行资源导入"
      }
    );
  }
  return file;
}

function consumeInboxFile(
  data: ResourceOperationsEngineData,
  file: ImportInboxFile,
  operationPath: string
): void {
  if (data.consumedInboxPaths.includes(file.sourceRelativePath)) {
    operationError("INVALID_ARGUMENT", "同一批次不能重复消费收件箱文件", {
      path: `${operationPath}.inboxPath`,
      actual: file.sourceRelativePath
    });
  }
  data.consumedInboxPaths.push(file.sourceRelativePath);
}

function addAssetWrite(
  data: ResourceOperationsEngineData,
  relativePath: string,
  content: Uint8Array,
  targetExisted: boolean,
  operationPath: string
): void {
  if (data.assetWrites.some((write) => write.relativePath === relativePath)) {
    operationError("RESOURCE_CONFLICT", "同一批次产生了重复资源文件目标", {
      path: `${operationPath}.name`,
      actual: relativePath
    });
  }
  data.assetWrites.push({
    relativePath,
    content: new Uint8Array(content),
    targetExisted
  });
}

function uniqueImportedName(
  pkg: Package,
  desiredName: string,
  resourcePath: string
): string {
  let suffix = 2;
  let candidate = desiredName;
  while (
    pkg.listResources().some((resource) =>
      samePortableName(resource.getName(), candidate)
      && canonicalExistingResourcePath(resource.getPath?.()) === resourcePath
    )
  ) {
    candidate = `${desiredName}_${suffix++}`;
  }
  return candidate;
}

function applyImport(
  document: Document,
  operation: Extract<ResourceOperation, { op: "import" }>,
  operationIndex: number,
  operationPath: string,
  data: ResourceOperationsEngineData,
  options: ResourceOperationsEngineOptions
): void {
  assertUnusedClientRef(
    data.clientRefs,
    operation.clientRef,
    `${operationPath}.clientRef`
  );
  assertPortableName(operation.name, `${operationPath}.name`, "资源");
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  const file = materializedImport(options, operationIndex, operationPath);
  consumeInboxFile(data, file, operationPath);
  const propertyType = importedPropertyType(file.fileName);
  const extension = importedExtension(file.fileName);
  const resourcePath = normalizeResourcePath(
    operation.path,
    `${operationPath}.path`
  );
  const existingAtTarget = pkg.listResources().find((resource) =>
    samePortableName(resource.getName(), operation.name)
    && canonicalExistingResourcePath(resource.getPath?.()) === resourcePath
  );

  let name = operation.name;
  let resource: PackageResource;
  let previousAssetPath: string | undefined;
  if (operation.conflict === "reject" && existingAtTarget) {
    operationError("RESOURCE_CONFLICT", "目标路径中已存在同名资源", {
      path: `${operationPath}.name`,
      actual: {
        packageId: pkg.getId(),
        resourceId: existingAtTarget.getId(),
        name,
        resourcePath
      },
      suggestedFix: "改用 conflict: rename，或明确指定 replace 与 resourceId"
    });
  }
  if (operation.conflict === "rename") {
    name = uniqueImportedName(pkg, name, resourcePath);
  }

  if (operation.conflict === "replace") {
    resource = resourceById(
      pkg,
      operation.resourceId!,
      `${operationPath}.resourceId`
    );
    if (
      existingAtTarget !== undefined
      && existingAtTarget !== resource
    ) {
      operationError("RESOURCE_CONFLICT", "replace 目标与同名冲突资源不一致", {
        path: `${operationPath}.resourceId`,
        actual: {
          requested: operation.resourceId,
          conflicting: existingAtTarget.getId()
        }
      });
    }
    if (resource.propertyType !== propertyType) {
      operationError("INVALID_ARGUMENT", "替换文件类型与已有资源不兼容", {
        path: `${operationPath}.inboxPath`,
        actual: propertyType,
        allowed: [resource.propertyType]
      });
    }
    previousAssetPath = assetRelativePath(pkg, resource);
    resource.setName(name);
    resource.setPath(resourcePath);
  }
  else {
    const resourceId = generateResourceId(
      pkg.listResources().map((item) => item.getId())
    );
    resource = createImportedResource(document, propertyType, name);
    resource.setId(resourceId);
    resource.setPath(resourcePath);
    pkg.addResource(resource);
  }

  setResourceFileName(
    resource,
    `${name}${extension}`,
    `${operationPath}.inboxPath`
  );
  addAssetWrite(
    data,
    assetRelativePath(pkg, resource)!,
    file.content,
    previousAssetPath === assetRelativePath(pkg, resource),
    operationPath
  );
  data.clientRefs[operation.clientRef] = {
    kind: "resource",
    packageId: pkg.getId(),
    resourceId: resource.getId()
  };
  data.affectedPackageIds.push(pkg.getId());
}

function applyReplaceResource(
  document: Document,
  operation: Extract<ResourceOperation, { op: "replace-resource" }>,
  operationIndex: number,
  operationPath: string,
  data: ResourceOperationsEngineData,
  options: ResourceOperationsEngineOptions
): void {
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  const resource = resourceById(
    pkg,
    operation.resourceId,
    `${operationPath}.resourceId`
  );
  const file = materializedImport(options, operationIndex, operationPath);
  consumeInboxFile(data, file, operationPath);
  const propertyType = importedPropertyType(file.fileName);
  if (resource.propertyType !== propertyType) {
    operationError("INVALID_ARGUMENT", "替换文件类型与已有资源不兼容", {
      path: `${operationPath}.inboxPath`,
      actual: propertyType,
      allowed: [resource.propertyType]
    });
  }
  const previousAssetPath = assetRelativePath(pkg, resource);
  setResourceFileName(
    resource,
    `${resource.getName()}${importedExtension(file.fileName)}`,
    `${operationPath}.inboxPath`
  );
  addAssetWrite(
    data,
    assetRelativePath(pkg, resource)!,
    file.content,
    previousAssetPath === assetRelativePath(pkg, resource),
    operationPath
  );
  data.affectedPackageIds.push(pkg.getId());
}

type MutableReferenceOwner = {
  getId?: () => string;
  getListItems?: () => Array<Record<string, unknown>>;
  setListItems?: (items: Array<Record<string, unknown>>) => unknown;
  getInstanceComboItems?: () => Array<Record<string, unknown>>;
  setInstanceComboItems?: (
    items: Array<Record<string, unknown>>
  ) => unknown;
};

type MutableReferenceComponent = PackageResource & {
  getChildById(id: string): MutableReferenceOwner | null;
  removeChild(child: MutableReferenceOwner): unknown;
};

function sourceComponent(
  document: Document,
  reference: ResourceReference
): MutableReferenceComponent {
  const source = reference.source;
  const pkg = document.getRoot().getPackageById(source.packageId);
  const component = pkg?.getResourceById(source.componentId);
  if (
    !component
    || component.propertyType !== PropertyType.COMPONENT
    || !("getChildById" in component)
  ) {
    operationError(
      "INTERNAL_ERROR",
      "引用索引指向的来源组件已不存在",
      {
        actual: reference.source
      }
    );
  }
  return component as MutableReferenceComponent;
}

function referenceOwner(
  component: MutableReferenceComponent,
  reference: ResourceReference
): MutableReferenceOwner {
  if (reference.source.objectId === undefined) {
    return component as unknown as MutableReferenceOwner;
  }
  const owner = component.getChildById(reference.source.objectId);
  if (!owner) {
    operationError(
      "INTERNAL_ERROR",
      "引用索引指向的来源节点已不存在",
      {
        actual: reference.source
      }
    );
  }
  return owner as unknown as MutableReferenceOwner;
}

function invokeReferenceSetter(
  owner: MutableReferenceOwner,
  field: string,
  reference: ResourceReference
): void {
  const setterName = `set${field[0]!.toUpperCase()}${field.slice(1)}`;
  const setter = (owner as unknown as Record<string, unknown>)[setterName];
  if (typeof setter !== "function") {
    operationError(
      "INTERNAL_ERROR",
      "引用索引将缺少写入接口的字段标记为可级联",
      {
        path: reference.source.field,
        actual: {
          ownerType: reference.source.ownerType,
          setter: setterName
        }
      }
    );
  }
  (setter as (value: string) => unknown).call(owner, "");
}

function clearIndexedReference(
  document: Document,
  reference: ResourceReference
): void {
  const component = sourceComponent(document, reference);
  const owner = referenceOwner(component, reference);
  const listItem = /^listItems\[(\d+)\]\.(icon|selectedIcon|url)$/u.exec(
    reference.source.field
  );
  if (listItem) {
    const index = Number(listItem[1]);
    const field = listItem[2]!;
    const items = owner.getListItems?.().map((item) => ({ ...item }));
    if (!items || !items[index] || typeof owner.setListItems !== "function") {
      operationError(
        "INTERNAL_ERROR",
        "引用索引中的 List 项目已不存在",
        {
          path: reference.source.field,
          actual: reference.source
        }
      );
    }
    items[index]![field] = null;
    owner.setListItems(items);
    return;
  }

  const comboItem = /^instanceComboItems\[(\d+)\]\.icon$/u.exec(
    reference.source.field
  );
  if (comboItem) {
    const index = Number(comboItem[1]);
    const items = owner.getInstanceComboItems?.()
      .map((item) => ({ ...item }));
    if (
      !items
      || !items[index]
      || typeof owner.setInstanceComboItems !== "function"
    ) {
      operationError(
        "INTERNAL_ERROR",
        "引用索引中的组件实例下拉项目已不存在",
        {
          path: reference.source.field,
          actual: reference.source
        }
      );
    }
    items[index]!.icon = null;
    owner.setInstanceComboItems(items);
    return;
  }

  invokeReferenceSetter(owner, reference.source.field, reference);
}

function cascadeReferences(
  document: Document,
  references: ResourceReference[],
  data: ResourceOperationsEngineData
): {
  removedReferences: number;
  unsupportedReferences: number;
} {
  const clearable = references.filter((reference) =>
    reference.cascadeAction === "clear-field"
  );
  const removable = references.filter((reference) =>
    reference.cascadeAction === "remove-owner"
  );
  const unsupportedReferences = references.filter((reference) =>
    reference.cascadeAction === "unsupported"
  ).length;

  for (const reference of clearable) {
    clearIndexedReference(document, reference);
  }

  const removedOwners = new Set<string>();
  for (const reference of removable) {
    const source = reference.source;
    const ownerKey = [
      source.packageId,
      source.componentId,
      source.objectId ?? ""
    ].join("\0");
    if (removedOwners.has(ownerKey)) continue;
    removedOwners.add(ownerKey);
    const component = sourceComponent(document, reference);
    const owner = referenceOwner(component, reference);
    component.removeChild(owner);
  }

  for (const reference of [...clearable, ...removable]) {
    data.affectedPackageIds.push(reference.source.packageId);
    data.affectedComponents.push({
      packageId: reference.source.packageId,
      componentId: reference.source.componentId
    });
  }
  return {
    removedReferences: clearable.length + removable.length,
    unsupportedReferences
  };
}

function relevantResourceReferences(
  document: Document,
  pkg: Package,
  resource: PackageResource
): ResourceReference[] {
  return buildResourceReferenceIndex(document)
    .find(pkg.getId(), resource.getId())
    .filter((reference) =>
      !(
        resource.propertyType === PropertyType.COMPONENT
        && reference.source.packageId === pkg.getId()
        && reference.source.componentId === resource.getId()
      )
    );
}

function assertDeletionIsUnused(
  references: ResourceReference[],
  path: string
): void {
  if (references.length === 0) return;
  operationError("RESOURCE_IN_USE", "删除目标仍被工程引用", {
    path,
    actual: references,
    suggestedFix: "改用 mode: cascade 清理支持的引用，或明确使用 force"
  });
}

function deletionResult(
  kind: ResourceDeleteResult["kind"],
  packageId: string,
  resourceId: string | undefined,
  requestedMode: ResourceDeleteResult["requestedMode"],
  removedReferences: number,
  unsupportedReferences: number
): ResourceDeleteResult {
  const effectiveMode = requestedMode === "cascade"
    ? unsupportedReferences > 0
      ? "cascade-with-force-fallback"
      : "cascade"
    : requestedMode;
  return {
    kind,
    packageId,
    ...(resourceId === undefined ? {} : { resourceId }),
    requestedMode,
    effectiveMode,
    removedReferences,
    unsupportedReferences
  };
}

function applyDeleteResource(
  document: Document,
  operation: Extract<ResourceOperation, { op: "delete-resource" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  const resource = resourceById(
    pkg,
    operation.resourceId,
    `${operationPath}.resourceId`
  );
  let removedReferences = 0;
  let unsupportedReferences = 0;
  if (operation.mode !== "force") {
    const references = relevantResourceReferences(document, pkg, resource);
    if (operation.mode === "reject") {
      assertDeletionIsUnused(references, `${operationPath}.resourceId`);
    }
    else {
      ({
        removedReferences,
        unsupportedReferences
      } = cascadeReferences(document, references, data));
    }
  }
  pkg.removeResource(resource);
  data.affectedPackageIds.push(pkg.getId());
  if (operation.mode === "force" || unsupportedReferences > 0) {
    data.projectMayBeInvalid = true;
  }
  data.deleteResults.push(deletionResult(
    "resource",
    pkg.getId(),
    resource.getId(),
    operation.mode,
    removedReferences,
    unsupportedReferences
  ));
}

function applyDeletePackage(
  document: Document,
  operation: Extract<ResourceOperation, { op: "delete-package" }>,
  operationPath: string,
  data: ResourceOperationsEngineData
): void {
  const pkg = packageById(
    document,
    operation.packageId,
    `${operationPath}.packageId`
  );
  let removedReferences = 0;
  let unsupportedReferences = 0;
  if (operation.mode !== "force") {
    const references = pkg.listResources().flatMap((resource) =>
      buildResourceReferenceIndex(document)
        .find(pkg.getId(), resource.getId())
        .filter((reference) =>
          reference.source.packageId !== pkg.getId()
        )
    );
    if (operation.mode === "reject") {
      assertDeletionIsUnused(references, `${operationPath}.packageId`);
    }
    else {
      ({
        removedReferences,
        unsupportedReferences
      } = cascadeReferences(document, references, data));
    }
  }
  (pkg as Package & { dispose(): void }).dispose();
  if (operation.mode === "force" || unsupportedReferences > 0) {
    data.projectMayBeInvalid = true;
  }
  data.deleteResults.push(deletionResult(
    "package",
    pkg.getId(),
    undefined,
    operation.mode,
    removedReferences,
    unsupportedReferences
  ));
}

export class ResourceOperationsEngine {
  public apply(
    document: Document,
    input: ApplyResourceOperationsInput,
    options: ResourceOperationsEngineOptions = {}
  ): ResultEnvelope<ResourceOperationsEngineData> {
    const initialFilePaths = modelFilePaths(document);
    const initialAssetPaths = modelAssetPaths(document);
    const initialReferences = buildResourceReferenceIndex(document).list();
    const data: ResourceOperationsEngineData = {
      appliedOperations: 0,
      operationResults: [],
      affectedReferences: [],
      clientRefs: {},
      affectedPackageIds: [],
      affectedComponents: [],
      fileMoves: [],
      deletedFiles: [],
      assetMoves: [],
      deletedAssetFiles: [],
      assetWrites: [],
      consumedInboxPaths: [],
      deleteResults: [],
      projectMayBeInvalid: false
    };
    try {
      input.operations.forEach((operation, index) => {
        const operationPath = `operations[${index}]`;
        const before = operationSnapshot(
          document,
          operation,
          data,
          "before"
        );
        switch (operation.op) {
          case "create-package":
            applyCreatePackage(document, operation, operationPath, data);
            break;
          case "create-component":
            applyCreateComponent(document, operation, operationPath, data);
            break;
          case "rename-package":
            applyRenamePackage(document, operation, operationPath, data);
            break;
          case "rename-resource":
            applyRenameResource(document, operation, operationPath, data);
            break;
          case "move-resource":
            applyMoveResource(document, operation, operationPath, data);
            break;
          case "import":
            applyImport(
              document,
              operation,
              index,
              operationPath,
              data,
              options
            );
            break;
          case "replace-resource":
            applyReplaceResource(
              document,
              operation,
              index,
              operationPath,
              data,
              options
            );
            break;
          case "delete-resource":
            applyDeleteResource(
              document,
              operation,
              operationPath,
              data
            );
            break;
          case "delete-package":
            applyDeletePackage(
              document,
              operation,
              operationPath,
              data
            );
            break;
          default:
            const unsupported = operation as { op: string };
            operationError(
              "CAPABILITY_NOT_IMPLEMENTED",
              `资源操作 ${unsupported.op} 尚未实现`,
              {
                path: `${operationPath}.op`,
                actual: unsupported.op
              }
            );
        }
        data.operationResults.push({
          index,
          op: operation.op,
          before,
          after: operationSnapshot(document, operation, data, "after")
        });
        data.appliedOperations++;
      });
      data.affectedPackageIds = [...new Set(data.affectedPackageIds)]
        .filter((packageId) =>
          document.getRoot().getPackageById(packageId) !== null
        )
        .sort();
      data.affectedComponents.sort((left, right) =>
        left.packageId.localeCompare(right.packageId)
        || left.componentId.localeCompare(right.componentId)
      );
      data.affectedComponents = data.affectedComponents.filter(
        (value, index, values) =>
          (
            index === 0
            || value.packageId !== values[index - 1]!.packageId
            || value.componentId !== values[index - 1]!.componentId
          )
          && document.getRoot()
            .getPackageById(value.packageId)
            ?.getResourceById(value.componentId)
            ?.propertyType === PropertyType.COMPONENT
      );
      const finalFilePaths = modelFilePaths(document);
      for (const [key, from] of initialFilePaths) {
        const to = finalFilePaths.get(key);
        if (to === undefined) data.deletedFiles.push(from);
        else if (to !== from) data.fileMoves.push({ from, to });
      }
      data.fileMoves.sort((left, right) =>
        left.from.localeCompare(right.from)
      );
      data.deletedFiles.sort();
      const finalAssetPaths = modelAssetPaths(document);
      for (const [key, from] of initialAssetPaths) {
        const to = finalAssetPaths.get(key);
        if (to === undefined) data.deletedAssetFiles.push(from);
        else if (to !== from) {
          data.assetMoves.push({ from, to });
        }
      }
      data.assetMoves.sort((left, right) =>
        left.from.localeCompare(right.from)
      );
      data.deletedAssetFiles.sort();
      const finalAssetPathSet = new Set(finalAssetPaths.values());
      data.assetWrites = data.assetWrites.filter((write) =>
        finalAssetPathSet.has(write.relativePath)
      );
      data.assetWrites.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      );
      data.consumedInboxPaths.sort();
      data.affectedReferences = referenceChanges(
        initialReferences,
        buildResourceReferenceIndex(document).list()
      );
      return ok(data);
    }
    catch (error) {
      if (error instanceof ResourceOperationError) {
        return fail(error.code, error.message, error.options);
      }
      return fail("INTERNAL_ERROR", "执行资源内存批处理失败", {
        actual: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
