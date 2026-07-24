import {
  buildResourceReferenceIndex,
  inspectOpaqueProjectXml,
  PropertyType,
  type Document,
  type OpaqueProjectXmlKind
} from "@magicskysword/openfairygui-core";
import {
  CAPABILITY_REGISTRY
} from "../contracts/capabilities.js";
import {
  fail,
  ok,
  type ErrorCode,
  type ErrorEnvelope,
  type ResultEnvelope,
  type SuccessEnvelope
} from "../contracts/result.js";
import {
  type QueryInput,
  type QueryRequest
} from "../contracts/tools.js";
import {
  DomProjectionError,
  projectComponentInstances,
  toFairyDomDocument
} from "../dom/openfairygui-adapter.js";
import {
  matchFairyDomSelector,
  SelectorSyntaxError
} from "../dom/selector.js";
import {
  ProjectRegistry
} from "../project/project-registry.js";
import { buildComponentStateModel } from "./state-model.js";

export type QueryItemResult = SuccessEnvelope<unknown> | ErrorEnvelope;

export interface QueryBatchData {
  results: Record<string, QueryItemResult>;
}

interface ResourceLike {
  propertyType: string;
  getId(): string;
  getName(): string;
  getPath?(): string;
  getExported?(): boolean;
}

interface CursorPayload {
  version: 1;
  kind: string;
  offset: number;
}

class QueryItemError extends Error {
  public readonly code: ErrorCode;
  public readonly path?: string;
  public readonly actual?: unknown;
  public readonly suggestedFix?: string;

  public constructor(
    code: ErrorCode,
    message: string,
    options: {
      path?: string;
      actual?: unknown;
      suggestedFix?: string;
    } = {}
  ) {
    super(message);
    this.name = "QueryItemError";
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
    if (options.actual !== undefined) this.actual = options.actual;
    if (options.suggestedFix !== undefined) {
      this.suggestedFix = options.suggestedFix;
    }
  }
}

function encodeCursor(kind: string, offset: number): string {
  const payload: CursorPayload = { version: 1, kind, offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedKind: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as Partial<CursorPayload>;
    if (
      value.version !== 1
      || value.kind !== expectedKind
      || !Number.isSafeInteger(value.offset)
      || (value.offset ?? -1) < 0
    ) {
      throw new Error("cursor payload mismatch");
    }
    return value.offset!;
  }
  catch {
    throw new QueryItemError("INVALID_ARGUMENT", "分页 cursor 无效或不属于当前查询", {
      path: "cursor",
      actual: cursor,
      suggestedFix: "仅使用同一种查询上一次返回的 nextCursor"
    });
  }
}

function paginated<T>(
  items: readonly T[],
  request: { cursor?: string | undefined; limit?: number | undefined },
  kind: string
): {
  items: T[];
  total: number;
  nextCursor?: string;
} {
  const offset = request.cursor ? decodeCursor(request.cursor, kind) : 0;
  if (offset > items.length) {
    throw new QueryItemError("INVALID_ARGUMENT", "分页 cursor 已超出结果范围", {
      path: "cursor",
      actual: { offset, total: items.length },
      suggestedFix: "从不带 cursor 的第一页重新查询"
    });
  }
  const limit = request.limit ?? 100;
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const data: {
    items: T[];
    total: number;
    nextCursor?: string;
  } = {
    items: pageItems,
    total: items.length
  };
  if (nextOffset < items.length) data.nextCursor = encodeCursor(kind, nextOffset);
  return data;
}

function containsName(name: string, needle: string | undefined): boolean {
  return needle === undefined
    || name.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function resourceData(packageId: string, resource: ResourceLike): {
  packageId: string;
  resourceId: string;
  type: string;
  name: string;
  path: string;
  exported: boolean;
} {
  return {
    packageId,
    resourceId: resource.getId(),
    type: resource.propertyType,
    name: resource.getName(),
    path: resource.getPath?.() ?? "",
    exported: resource.getExported?.() ?? false
  };
}

interface AuditFinding {
  sourceKind: OpaqueProjectXmlKind;
  packageId?: string;
  componentId?: string;
  branch?: string;
  kind: "attribute" | "element";
  name: string;
  path: string;
}

function inspectSource(
  findings: AuditFinding[],
  kind: OpaqueProjectXmlKind,
  xml: unknown,
  owner: {
    packageId?: string;
    componentId?: string;
    branch?: string;
  } = {}
): void {
  if (typeof xml !== "string") return;
  for (const finding of inspectOpaqueProjectXml(kind, xml)) {
    findings.push({
      sourceKind: kind,
      ...owner,
      ...finding
    });
  }
}

function auditFindings(document: Document): AuditFinding[] {
  const findings: AuditFinding[] = [];
  inspectSource(
    findings,
    "project",
    document.getRoot().getExtras()._sourceProjectXml
  );
  for (const pkg of document.getRoot().listPackages()) {
    const sources = pkg.getExtras()._sourcePackageXmlByBranch;
    if (sources && typeof sources === "object") {
      for (const [branch, xml] of Object.entries(
        sources as Record<string, unknown>
      )) {
        inspectSource(
          findings,
          branch ? "branch" : "package",
          xml,
          {
            packageId: pkg.getId(),
            ...(branch ? { branch } : {})
          }
        );
      }
    }
    for (const component of pkg.listComponents()) {
      inspectSource(
        findings,
        "component",
        component.getExtras()._sourceComponentXml,
        {
          packageId: pkg.getId(),
          componentId: component.getId()
        }
      );
    }
  }
  return findings.sort((a, b) =>
    [
      (a.packageId ?? "").localeCompare(b.packageId ?? ""),
      (a.componentId ?? "").localeCompare(b.componentId ?? ""),
      a.path.localeCompare(b.path)
    ].find((value) => value !== 0) ?? 0
  );
}

export class QueryService {
  public constructor(private readonly projects: ProjectRegistry) {}

  public async execute(input: QueryInput): Promise<ResultEnvelope<QueryBatchData>> {
    const snapshotResult = await this.projects.read(
      input.projectId,
      (document) => this.executeDocument(document, input)
    );
    return snapshotResult.ok ? snapshotResult.data : snapshotResult;
  }

  private executeDocument(
    document: Document,
    input: QueryInput
  ): ResultEnvelope<QueryBatchData> {
    const results: Record<string, QueryItemResult> = {};
    const failedKeys: string[] = [];
    for (const [key, request] of Object.entries(input.queries)) {
      try {
        results[key] = ok(this.executeItem(document, request));
      }
      catch (error) {
        failedKeys.push(key);
        results[key] = this.itemFailure(error, key);
      }
    }
    if (failedKeys.length > 0) {
      return ok({ results }, [{
        severity: "warning",
        code: "PARTIAL_QUERY_FAILURE",
        message: `${failedKeys.length} 个命名查询失败；其余结果已保留`,
        path: "queries",
        details: { failedKeys }
      }]);
    }
    return ok({ results });
  }

  private executeItem(document: Document, request: QueryRequest): unknown {
    switch (request.kind) {
      case "packages": {
        const items = document.getRoot().listPackages()
          .map((pkg) => ({
            packageId: pkg.getId(),
            name: pkg.getName(),
            resourceCount: pkg.listResources().length,
            componentCount: pkg.listComponents().length
          }))
          .sort((a, b) => a.packageId.localeCompare(b.packageId));
        return paginated(items, request, "packages");
      }
      case "resources": {
        const allowedTypes = request.resourceTypes
          ? new Set(request.resourceTypes)
          : undefined;
        const items = document.getRoot().listPackages()
          .filter((pkg) => !request.packageId || pkg.getId() === request.packageId)
          .flatMap((pkg) =>
            pkg.listResources()
              .map((resource) =>
                resourceData(pkg.getId(), resource as ResourceLike)
              )
          )
          .filter((resource) =>
            (!allowedTypes || allowedTypes.has(resource.type))
            && containsName(resource.name, request.nameContains)
          )
          .sort((a, b) =>
            a.packageId.localeCompare(b.packageId)
            || a.resourceId.localeCompare(b.resourceId)
          );
        if (
          request.packageId
          && !document.getRoot().getPackageById(request.packageId)
        ) {
          throw new QueryItemError(
            "PACKAGE_NOT_FOUND",
            `包不存在：${request.packageId}`,
            { path: "packageId", actual: request.packageId }
          );
        }
        return paginated(items, request, "resources");
      }
      case "components": {
        if (
          request.packageId
          && !document.getRoot().getPackageById(request.packageId)
        ) {
          throw new QueryItemError(
            "PACKAGE_NOT_FOUND",
            `包不存在：${request.packageId}`,
            { path: "packageId", actual: request.packageId }
          );
        }
        const items = document.getRoot().listPackages()
          .filter((pkg) => !request.packageId || pkg.getId() === request.packageId)
          .flatMap((pkg) =>
            pkg.listComponents().map((component) => ({
              packageId: pkg.getId(),
              componentId: component.getId(),
              name: component.getName(),
              path: component.getPath(),
              width: component.getWidth(),
              height: component.getHeight(),
              exported: component.getExported()
            }))
          )
          .filter((component) =>
            containsName(component.name, request.nameContains)
          )
          .sort((a, b) =>
            a.packageId.localeCompare(b.packageId)
            || a.componentId.localeCompare(b.componentId)
          );
        return paginated(items, request, "components");
      }
      case "dom": {
        const documentProjection = toFairyDomDocument(
          document,
          request.packageId,
          request.componentId
        );
        const component = document.getRoot()
          .getPackageById(request.packageId)
          ?.listComponents()
          .find((candidate) => candidate.getId() === request.componentId);
        if (!component) {
          throw new QueryItemError(
            "COMPONENT_NOT_FOUND",
            `组件不存在：${request.packageId}/${request.componentId}`,
            {
              path: "componentId",
              actual: request.componentId
            }
          );
        }
        const data: {
          document: typeof documentProjection;
          stateModel: ReturnType<typeof buildComponentStateModel>;
          matches?: ReturnType<typeof matchFairyDomSelector>;
          projections?: ReturnType<typeof projectComponentInstances>;
        } = {
          document: documentProjection,
          stateModel: buildComponentStateModel(component)
        };
        if (request.selector) {
          data.matches = matchFairyDomSelector(
            documentProjection.root,
            request.selector
          );
        }
        if (request.resolvedPreview) {
          data.projections = projectComponentInstances(
            document,
            request.packageId,
            request.componentId
          );
        }
        return data;
      }
      case "references": {
        const pkg = document.getRoot().getPackageById(request.packageId);
        if (!pkg) {
          throw new QueryItemError(
            "PACKAGE_NOT_FOUND",
            `包不存在：${request.packageId}`,
            { path: "packageId", actual: request.packageId }
          );
        }
        if (!pkg.getResourceById(request.resourceId)) {
          throw new QueryItemError(
            "RESOURCE_NOT_FOUND",
            `资源不存在：${request.packageId}/${request.resourceId}`,
            { path: "resourceId", actual: request.resourceId }
          );
        }
        const items = buildResourceReferenceIndex(document).find(
          request.packageId,
          request.resourceId
        );
        return paginated(
          items,
          request,
          `references:${request.packageId}:${request.resourceId}`
        );
      }
      case "capabilities":
        return { items: CAPABILITY_REGISTRY };
      case "audit": {
        const findings = auditFindings(document);
        if (!request.includeOpaque) {
          const counts = findings.reduce<Record<string, number>>(
            (result, finding) => {
              const key = `${finding.sourceKind}:${finding.kind}`;
              result[key] = (result[key] ?? 0) + 1;
              return result;
            },
            {}
          );
          return { total: findings.length, counts };
        }
        return paginated(findings, request, "audit");
      }
    }
  }

  private itemFailure(error: unknown, key: string): ErrorEnvelope {
    if (error instanceof DomProjectionError) {
      return fail(error.code, error.message, {
        path: `queries.${key}`,
        actual: {
          packageId: error.packageId,
          componentId: error.componentId
        }
      });
    }
    if (error instanceof SelectorSyntaxError) {
      return fail("INVALID_SELECTOR", error.message, {
        path: `queries.${key}.selector`,
        actual: {
          selector: error.selector,
          index: error.index
        },
        suggestedFix: error.suggestedFix
      });
    }
    if (error instanceof QueryItemError) {
      return fail(error.code, error.message, {
        path: error.path
          ? `queries.${key}.${error.path}`
          : `queries.${key}`,
        ...(error.actual === undefined ? {} : { actual: error.actual }),
        ...(error.suggestedFix === undefined
          ? {}
          : { suggestedFix: error.suggestedFix })
      });
    }
    return fail("INTERNAL_ERROR", "查询执行失败", {
      path: `queries.${key}`,
      actual: error instanceof Error ? error.message : String(error)
    });
  }
}
