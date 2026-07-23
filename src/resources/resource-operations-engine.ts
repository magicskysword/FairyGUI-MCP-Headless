import {
  generatePackageId,
  generateResourceId,
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

function samePortableName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
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
      && normalizeResourcePath(
        resource.getPath?.() ?? "/",
        `${operationPath}.path`
      ) === resourcePath
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

export class ResourceOperationsEngine {
  public apply(
    document: Document,
    input: ApplyResourceOperationsInput
  ): ResultEnvelope<ResourceOperationsEngineData> {
    const data: ResourceOperationsEngineData = {
      appliedOperations: 0,
      clientRefs: {},
      affectedPackageIds: [],
      affectedComponents: []
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
