import {
  generatePackageId,
  generateResourceId,
  PropertyType,
  type Document,
  type Package
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

const PACKAGE_ID_PATTERN = /^[a-z0-9]{8}$/;
const INVALID_FILE_NAME_CHARACTERS = /[\u0000-\u001f<>:"/\\|?*]/u;
const RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export interface ResourceOperationClientRef {
  kind: "package" | "component";
  packageId: string;
  resourceId?: string;
}

export interface ResourceOperationsEngineData {
  appliedOperations: number;
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
  kind: "包" | "组件"
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
    assertPortableName(operation.name, `${operationPath}.name`, "组件");
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

export class ResourceOperationsEngine {
  public apply(
    document: Document,
    input: ApplyResourceOperationsInput
  ): ResultEnvelope<ResourceOperationsEngineData> {
    const initialFilePaths = modelFilePaths(document);
    const data: ResourceOperationsEngineData = {
      appliedOperations: 0,
      clientRefs: {},
      affectedPackageIds: [],
      affectedComponents: [],
      fileMoves: [],
      deletedFiles: []
    };
    try {
      input.operations.forEach((operation, index) => {
        const operationPath = `operations[${index}]`;
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
          default:
            operationError(
              "CAPABILITY_NOT_IMPLEMENTED",
              `资源操作 ${operation.op} 尚未实现`,
              {
                path: `${operationPath}.op`,
                actual: operation.op
              }
            );
        }
        data.appliedOperations++;
      });
      data.affectedPackageIds = [...new Set(data.affectedPackageIds)].sort();
      data.affectedComponents.sort((left, right) =>
        left.packageId.localeCompare(right.packageId)
        || left.componentId.localeCompare(right.componentId)
      );
      data.affectedComponents = data.affectedComponents.filter(
        (value, index, values) =>
          index === 0
          || value.packageId !== values[index - 1]!.packageId
          || value.componentId !== values[index - 1]!.componentId
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
