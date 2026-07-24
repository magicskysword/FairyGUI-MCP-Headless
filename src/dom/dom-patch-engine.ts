import {
  AlignType,
  AutoSizeType,
  buildURL,
  FillMethod,
  FlipType,
  generateChildId,
  GraphType,
  GroupLayoutType,
  ListLayoutType,
  LoaderFillType,
  OverflowType,
  PropertyType,
  ScrollType,
  VertAlignType,
  type Component,
  type Document,
  type GObject,
  type RelationDef
} from "@magicskysword/openfairygui-core";
import {
  FAIRYGUI_RELATION_TYPES,
  FairyDomComponentRootSchema,
  FairyDomNewNodeSchema,
  type FairyDomComponentRoot,
  type FairyDomDocument,
  type FairyDomListItem,
  type FairyDomNewNode,
  type FairyDomNode,
  type FairyDomRelation,
  type FairyDomResourceReference,
  type FairyDomStyle
} from "../contracts/dom.js";
import {
  fail,
  ok,
  type ErrorCode,
  type ErrorOptions,
  type ResultEnvelope
} from "../contracts/result.js";
import type {
  ApplyDomPatchInput,
  DomPatchOperation,
  DomUpdateChanges
} from "../contracts/tools.js";
import { InternalApplyDomPatchInputSchema } from "../contracts/tools.js";
import {
  DomProjectionError,
  toFairyDomDocument
} from "./openfairygui-adapter.js";
import {
  INSTANCE_OVERLAY_EXTENSIONS,
  supportsInstanceOverlay,
  type InstanceOverlayField
} from "./instance-extension.js";
import {
  matchFairyDomSelector,
  parseFairyDomSelector,
  SelectorSyntaxError,
  type FairyDomSelectorNode,
  type ParsedFairyDomSelector
} from "./selector.js";

type MutableObject = GObject & Record<string, unknown>;
type MutableOwner = MutableObject | (Component & Record<string, unknown>);

interface RootTarget {
  kind: "root";
  component: Component;
}

interface NodeTarget {
  kind: "node";
  object: GObject;
}

type PatchTarget = RootTarget | NodeTarget;

interface EngineContext {
  document: Document;
  packageId: string;
  componentId: string;
  component: Component;
  clientRefs: Record<string, string>;
  clientRefTypes: Map<string, FairyDomNewNode["type"]>;
  reservedNodeTypes: Map<string, FairyDomNewNode["type"]>;
  replacementScope: boolean;
}

export interface DomPatchEngineData {
  appliedOperations: number;
  operationResults: DomPatchOperationResult[];
  affectedNodeIds: string[];
  clientRefs: Record<string, string>;
  dom: FairyDomDocument;
}

export interface DomPatchOperationResult {
  index: number;
  op: DomPatchOperation["op"];
  affectedNodeIds: string[];
}

class DomPatchEngineError extends Error {
  public readonly code: ErrorCode;
  public readonly options: ErrorOptions;

  public constructor(
    code: ErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message);
    this.name = "DomPatchEngineError";
    this.code = code;
    this.options = options;
  }
}

function patchError(
  code: ErrorCode,
  message: string,
  options: ErrorOptions = {}
): never {
  throw new DomPatchEngineError(code, message, options);
}

interface PatchValidationIssue {
  code: string;
  path: PropertyKey[];
  message: string;
  errors?: PatchValidationIssue[][];
  expected?: unknown;
  values?: unknown;
  keys?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

function validationLeaves(
  issues: readonly PatchValidationIssue[]
): PatchValidationIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" && issue.errors
      ? issue.errors.flatMap((branch) => validationLeaves(branch))
      : [issue]
  );
}

function patchIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "arguments";
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`;
    const value = String(segment);
    return result.length === 0 ? value : `${result}.${value}`;
  }, "");
}

function patchValueAtPath(
  value: unknown,
  issuePath: readonly PropertyKey[]
): unknown {
  let current = value;
  for (const segment of issuePath) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function patchAllowed(issue: PatchValidationIssue): unknown {
  if (issue.expected !== undefined) return issue.expected;
  if (issue.values !== undefined) return issue.values;
  if (issue.keys !== undefined) {
    return {
      recognizedFieldsOnly: true,
      disallowedKeys: issue.keys
    };
  }
  if (issue.minimum !== undefined || issue.maximum !== undefined) {
    return {
      ...(issue.minimum === undefined ? {} : { minimum: issue.minimum }),
      ...(issue.maximum === undefined ? {} : { maximum: issue.maximum })
    };
  }
  return issue.message;
}

function invalidPatchValidation(
  input: ApplyDomPatchInput,
  issues: readonly PatchValidationIssue[]
): ResultEnvelope<never> {
  const expectedRoot = "operations";
  const leaves = validationLeaves(issues);
  const relevant = leaves.filter((issue) =>
    String(issue.path[0] ?? "") === expectedRoot
  );
  const issue = [...(relevant.length > 0 ? relevant : leaves)]
    .sort((left, right) => right.path.length - left.path.length)[0];
  const path = issue?.path ?? [expectedRoot];
  return fail("INVALID_PATCH", "DOM 补丁未通过内部强类型校验", {
    path: patchIssuePath(path),
    actual: {
      value: patchValueAtPath(input, path),
      issue: issue?.message ?? "补丁结构不合法"
    },
    allowed: issue ? patchAllowed(issue) : "有效的 FairyGUI DOM 补丁",
    suggestedFix:
      "先使用 query 的 detail:\"full\" 取得完整 DOM 字段，再按该节点类型修正补丁"
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)])
    );
  }
  return value;
}

function mergeJsonObject(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = cloneJsonValue(target) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    }
    else if (isJsonObject(value)) {
      merged[key] = mergeJsonObject(
        isJsonObject(merged[key]) ? merged[key] : {},
        value
      );
    }
    else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function mergedPatchError(
  operationIndex: number,
  changes: DomUpdateChanges,
  issues: readonly PatchValidationIssue[]
): never {
  const leaves = validationLeaves(issues);
  const issue = [...leaves]
    .sort((left, right) => right.path.length - left.path.length)[0];
  const issuePath = issue?.path ?? [];
  const path = [
    "operations",
    operationIndex,
    "changes",
    ...issuePath
  ];
  patchError("INVALID_PATCH", "update 结果未通过目标节点的强类型校验", {
    path: patchIssuePath(path),
    actual: {
      value: patchValueAtPath(changes, issuePath),
      issue: issue?.message ?? "合并后的节点结构不合法"
    },
    allowed: issue ? patchAllowed(issue) : "与目标节点类型兼容的 Merge Patch",
    suggestedFix:
      "先使用 query 的 detail:\"full\" 查询目标，再只修改该节点类型已有的可写字段"
  });
}

function hasMethod(
  owner: MutableOwner,
  method: string
): owner is MutableOwner & Record<string, (...args: unknown[]) => unknown> {
  return typeof owner[method] === "function";
}

function invoke(
  owner: MutableOwner,
  method: string,
  args: unknown[],
  path: string
): unknown {
  const candidate = owner[method];
  if (typeof candidate !== "function") {
    patchError("INVALID_PATCH", `目标类型不支持字段 ${path}`, {
      path,
      actual: owner.propertyType,
      suggestedFix: "查询当前 DOM，只设置该节点投影中存在且可写的字段"
    });
  }
  return (candidate as (...values: unknown[]) => unknown).apply(owner, args);
}

function optionalInvoke(
  owner: MutableOwner,
  method: string,
  args: unknown[]
): void {
  const candidate = owner[method];
  if (typeof candidate === "function") {
    (candidate as (...values: unknown[]) => unknown).apply(owner, args);
  }
}

function getterNumber(
  owner: MutableOwner,
  method: string,
  fallback: number
): number {
  const candidate = owner[method];
  if (typeof candidate !== "function") return fallback;
  const value = (candidate as () => unknown).call(owner);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resourceUrl(reference: FairyDomResourceReference): string {
  return buildURL(reference.packageId, reference.resourceId);
}

function assertResource(
  document: Document,
  reference: FairyDomResourceReference,
  path: string,
  expectedType?: PropertyType
): { propertyType: PropertyType } {
  const pkg = document.getRoot().getPackageById(reference.packageId);
  const resource = pkg?.getResourceById(reference.resourceId);
  if (!pkg || !resource) {
    patchError("RESOURCE_NOT_FOUND", "DOM 补丁引用的资源不存在", {
      path,
      actual: reference,
      suggestedFix: "先批量查询 resources，再使用返回的 packageId/resourceId"
    });
  }
  if (expectedType !== undefined && resource.propertyType !== expectedType) {
    patchError("INVALID_PATCH", "DOM 补丁引用了不兼容的资源类型", {
      path,
      actual: resource.propertyType,
      allowed: [expectedType],
      suggestedFix: "选择与目标字段类型兼容的 FairyGUI 资源"
    });
  }
  return resource;
}

function assertInstanceOverlay(
  extensionType: string,
  field: InstanceOverlayField,
  path: string
): void {
  if (supportsInstanceOverlay(extensionType, field)) return;
  patchError(
    "INVALID_PATCH",
    `来源组件类型不支持实例覆盖字段 ${field}`,
    {
      path,
      actual: extensionType || "Component",
      allowed: [...INSTANCE_OVERLAY_EXTENSIONS[field]],
      suggestedFix:
        "删除该覆盖字段，或改用支持此字段的 Button、Label 或 ComboBox 组件"
    }
  );
}

function clearUnsupportedInstanceOverlays(
  owner: MutableObject,
  extensionType: string
): void {
  if (!supportsInstanceOverlay(extensionType, "text")) {
    optionalInvoke(owner, "setInstanceTitle", [""]);
  }
  if (!supportsInstanceOverlay(extensionType, "icon")) {
    optionalInvoke(owner, "setInstanceIcon", [""]);
  }
  if (!supportsInstanceOverlay(extensionType, "selected")) {
    optionalInvoke(owner, "setInstanceChecked", [false]);
  }
}

function setPrimaryResource(
  context: EngineContext,
  target: GObject,
  reference: FairyDomResourceReference | null,
  path: string
): string | undefined {
  const owner = target as MutableObject;
  switch (target.propertyType) {
    case PropertyType.G_IMAGE:
      if (reference) {
        assertResource(
          context.document,
          reference,
          path,
          PropertyType.IMAGE_RESOURCE
        );
      }
      invoke(owner, "setSrc", [reference?.resourceId ?? ""], path);
      invoke(owner, "setPackageId", [reference?.packageId ?? ""], path);
      return undefined;
    case PropertyType.G_MOVIE_CLIP:
      if (reference) {
        assertResource(
          context.document,
          reference,
          path,
          PropertyType.MOVIE_CLIP_RESOURCE
        );
      }
      invoke(owner, "setSrc", [reference?.resourceId ?? ""], path);
      invoke(owner, "setPackageId", [reference?.packageId ?? ""], path);
      return undefined;
    case PropertyType.G_LOADER:
      if (reference) assertResource(context.document, reference, path);
      invoke(owner, "setUrl", [reference ? resourceUrl(reference) : ""], path);
      return undefined;
    case PropertyType.G_LIST:
      if (reference) {
        assertResource(
          context.document,
          reference,
          path,
          PropertyType.COMPONENT
        );
      }
      invoke(
        owner,
        "setDefaultItem",
        [reference ? resourceUrl(reference) : ""],
        path
      );
      return undefined;
    case PropertyType.G_COMPONENT:
    case PropertyType.G_BUTTON:
    case PropertyType.G_LABEL:
    case PropertyType.G_COMBO_BOX:
    case PropertyType.G_PROGRESS_BAR:
    case PropertyType.G_SLIDER:
    case PropertyType.G_SCROLL_BAR:
      if (!reference) {
        patchError("INVALID_PATCH", "组件实例的来源资源不能清空", {
          path,
          actual: null,
          suggestedFix: "替换为另一个组件资源，或删除该实例节点"
        });
      }
      const source = assertResource(
        context.document,
        reference,
        path,
        PropertyType.COMPONENT
      );
      const extensionType = (source as Component).getExtensionType();
      invoke(owner, "setSrc", [reference.resourceId], path);
      invoke(owner, "setPackageId", [reference.packageId], path);
      invoke(owner, "setInstanceExtType", [extensionType], path);
      clearUnsupportedInstanceOverlays(owner, extensionType);
      return extensionType;
    default:
      patchError("INVALID_PATCH", "目标节点没有可设置的主资源字段", {
        path,
        actual: target.propertyType,
        allowed: [
          "image",
          "loader",
          "movie-clip",
          "list",
          "instance"
        ]
      });
  }
}

function resolveReferenceId(
  context: EngineContext,
  value: string,
  path: string
): string {
  const resolved = context.clientRefs[value] ?? value;
  const allowedInScope = context.replacementScope
    ? context.reservedNodeTypes.has(resolved)
    : context.component.getChildById(resolved) !== null
      || context.reservedNodeTypes.has(resolved);
  if (resolved !== context.componentId && !allowedInScope) {
    patchError("INVALID_PATCH", "DOM 引用指向不存在的组件节点", {
      path,
      actual: value,
      suggestedFix: "使用组件根 ID、已有子节点 ID 或同批 insert 的 clientRef"
    });
  }
  return resolved;
}

function relationsFor(
  context: EngineContext,
  relations: readonly FairyDomRelation[],
  path: string
): RelationDef[] {
  return relations.map((relation, index) => {
    const type = FAIRYGUI_RELATION_TYPES.indexOf(relation.type);
    if (type < 0) {
      patchError("INVALID_DOM", "未知的 FairyGUI Relation 类型", {
        path: `${path}[${index}].type`,
        actual: relation.type,
        allowed: FAIRYGUI_RELATION_TYPES
      });
    }
    const targetId = resolveReferenceId(
      context,
      relation.targetId,
      `${path}[${index}].targetId`
    );
    return {
      target: targetId === context.componentId ? "" : targetId,
      type,
      usePercent: relation.percent
    };
  });
}

function assertWritableTarget(target: PatchTarget, path: string): void {
  if (target.kind === "root") return;
  if (target.object.propertyType === PropertyType.G_TREE) {
    patchError("READ_ONLY_CAPABILITY", "Tree 节点在 V1 中只读", {
      path,
      actual: "node.tree",
      allowed: ["implemented/read-write"],
      suggestedFix: "保留 Tree，或改用静态 List"
    });
  }
  if (target.object.propertyType === PropertyType.G_LOADER_3D) {
    patchError("READ_ONLY_CAPABILITY", "Loader3D 节点在 V1 中只读", {
      path,
      actual: "node.loader3d",
      allowed: ["implemented/read-write"]
    });
  }
}

const ROOT_STYLE_FIELDS = new Set<keyof FairyDomStyle>([
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "pivotX",
  "pivotY",
  "pivotAsAnchor"
]);

function assertRootStyleFields(
  changes: FairyDomStyle,
  path: string
): void {
  const invalid = Object.keys(changes).find(
    (field) => !ROOT_STYLE_FIELDS.has(field as keyof FairyDomStyle)
  );
  if (invalid !== undefined) {
    patchError("INVALID_PATCH", `组件根不支持样式字段 ${invalid}`, {
      path: `${path}.${invalid}`,
      actual: invalid,
      allowed: [...ROOT_STYLE_FIELDS]
    });
  }
}

function applyStyleToRoot(
  component: Component,
  changes: FairyDomStyle,
  path: string
): void {
  const owner = component as Component & Record<string, unknown>;
  assertRootStyleFields(changes, path);
  if (changes.width !== undefined || changes.height !== undefined) {
    invoke(owner, "setSize", [
      changes.width ?? component.getWidth(),
      changes.height ?? component.getHeight()
    ], path);
  }
  const scalarSetters = [
    ["minWidth", "setMinWidth"],
    ["maxWidth", "setMaxWidth"],
    ["minHeight", "setMinHeight"],
    ["maxHeight", "setMaxHeight"],
    ["pivotX", "setPivotX"],
    ["pivotY", "setPivotY"],
    ["pivotAsAnchor", "setPivotAsAnchor"]
  ] as const;
  for (const [field, method] of scalarSetters) {
    const value = changes[field];
    if (value !== undefined) invoke(owner, method, [value], `${path}.${field}`);
  }
}

const STYLE_METHODS = {
  minWidth: "setMinWidth",
  maxWidth: "setMaxWidth",
  minHeight: "setMinHeight",
  maxHeight: "setMaxHeight",
  opacity: "setAlpha",
  rotation: "setRotation",
  visible: "setVisible",
  touchable: "setTouchable",
  grayed: "setGrayed",
  pivotAsAnchor: "setPivotAsAnchor"
} as const;

function assertStyleMethods(
  owner: MutableObject,
  changes: FairyDomStyle,
  path: string
): void {
  const requirements: Array<[keyof FairyDomStyle, string]> = [];
  if (changes.left !== undefined || changes.top !== undefined) {
    requirements.push(["left", "setXY"]);
  }
  if (changes.width !== undefined || changes.height !== undefined) {
    requirements.push(["width", "setSize"]);
  }
  if (changes.scaleX !== undefined || changes.scaleY !== undefined) {
    requirements.push(["scaleX", "setScale"]);
  }
  if (
    changes.pivotX !== undefined
    || changes.pivotY !== undefined
  ) {
    requirements.push(["pivotX", "setPivot"]);
  }
  if (changes.skewX !== undefined || changes.skewY !== undefined) {
    requirements.push(["skewX", "setSkew"]);
  }
  for (const [field, method] of Object.entries(STYLE_METHODS) as Array<
    [keyof typeof STYLE_METHODS, string]
  >) {
    if (changes[field] !== undefined) requirements.push([field, method]);
  }
  for (const [field, method] of requirements) {
    if (!hasMethod(owner, method)) {
      patchError("INVALID_PATCH", `节点类型不支持样式字段 ${field}`, {
        path: `${path}.${field}`,
        actual: owner.propertyType,
        suggestedFix: "查询目标节点当前 style，并只修改该类型支持的字段"
      });
    }
  }
}

function applyStyleToNode(
  object: GObject,
  changes: FairyDomStyle,
  path: string
): void {
  const owner = object as MutableObject;
  assertStyleMethods(owner, changes, path);

  if (changes.left !== undefined || changes.top !== undefined) {
    invoke(owner, "setXY", [
      changes.left ?? getterNumber(owner, "getX", 0),
      changes.top ?? getterNumber(owner, "getY", 0)
    ], path);
  }
  if (changes.width !== undefined || changes.height !== undefined) {
    invoke(owner, "setSize", [
      changes.width ?? getterNumber(owner, "getWidth", 0),
      changes.height ?? getterNumber(owner, "getHeight", 0)
    ], path);
  }
  if (changes.scaleX !== undefined || changes.scaleY !== undefined) {
    invoke(owner, "setScale", [
      changes.scaleX ?? getterNumber(owner, "getScaleX", 1),
      changes.scaleY ?? getterNumber(owner, "getScaleY", 1)
    ], path);
  }
  if (changes.pivotX !== undefined || changes.pivotY !== undefined) {
    invoke(owner, "setPivot", [
      changes.pivotX ?? getterNumber(owner, "getPivotX", 0),
      changes.pivotY ?? getterNumber(owner, "getPivotY", 0),
      changes.pivotAsAnchor
        ?? Boolean(
          hasMethod(owner, "getPivotAsAnchor")
          && owner.getPivotAsAnchor!()
        )
    ], path);
  }
  if (changes.skewX !== undefined || changes.skewY !== undefined) {
    invoke(owner, "setSkew", [
      changes.skewX ?? getterNumber(owner, "getSkewX", 0),
      changes.skewY ?? getterNumber(owner, "getSkewY", 0)
    ], path);
  }
  for (const [field, method] of Object.entries(STYLE_METHODS) as Array<
    [keyof typeof STYLE_METHODS, string]
  >) {
    const value = changes[field];
    if (value !== undefined) invoke(owner, method, [value], `${path}.${field}`);
  }
}

function applyTextContent(
  context: EngineContext,
  owner: MutableObject,
  content: {
    text: string;
    font?: FairyDomResourceReference | undefined;
    fontSize?: number | undefined;
    color?: string | undefined;
    align?: "left" | "center" | "right" | undefined;
    verticalAlign?: "top" | "middle" | "bottom" | undefined;
    autoSize?: "none" | "both" | "height" | "shrink" | undefined;
    singleLine?: boolean | undefined;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    underline?: boolean | undefined;
    strikethrough?: boolean | undefined;
    lineSpacing?: number | undefined;
    letterSpacing?: number | undefined;
  },
  path: string,
  fields?: ReadonlySet<string>
): void {
  const includes = (field: string): boolean =>
    fields === undefined || fields.has(field);
  if (includes("text")) {
    invoke(owner, "setText", [content.text], `${path}.text`);
  }
  if (includes("font") && content.font !== undefined) {
    assertResource(
      context.document,
      content.font,
      `${path}.font`,
      PropertyType.FONT_RESOURCE
    );
    invoke(owner, "setFont", [resourceUrl(content.font)], `${path}.font`);
  }
  const scalars = [
    ["fontSize", "setFontSize"],
    ["color", "setColor"],
    ["singleLine", "setSingleLine"],
    ["bold", "setBold"],
    ["italic", "setItalic"],
    ["underline", "setUnderline"],
    ["strikethrough", "setStrikethrough"],
    ["lineSpacing", "setLeading"],
    ["letterSpacing", "setLetterSpacing"]
  ] as const;
  for (const [field, method] of scalars) {
    const value = content[field];
    if (includes(field) && value !== undefined) {
      invoke(owner, method, [value], `${path}.${field}`);
    }
  }
  if (includes("align") && content.align !== undefined) {
    const values = {
      left: AlignType.Left,
      center: AlignType.Center,
      right: AlignType.Right
    };
    invoke(owner, "setAlign", [values[content.align]], `${path}.align`);
  }
  if (includes("verticalAlign") && content.verticalAlign !== undefined) {
    const values = {
      top: VertAlignType.Top,
      middle: VertAlignType.Middle,
      bottom: VertAlignType.Bottom
    };
    invoke(
      owner,
      "setVAlign",
      [values[content.verticalAlign]],
      `${path}.verticalAlign`
    );
  }
  if (includes("autoSize") && content.autoSize !== undefined) {
    const values = {
      none: AutoSizeType.None,
      both: AutoSizeType.Both,
      height: AutoSizeType.Height,
      shrink: AutoSizeType.Shrink
    };
    invoke(
      owner,
      "setAutoSize",
      [values[content.autoSize]],
      `${path}.autoSize`
    );
  }
}

function listItemsFor(
  context: EngineContext,
  items: readonly FairyDomListItem[],
  path: string
): Array<{
  title: string | null;
  icon: string | null;
  url: string | null;
  name: string | null;
  selectedTitle: string | null;
  selectedIcon: string | null;
  level: number;
  isFolder: null;
}> {
  return items.map((item, index) => {
    for (const [field, reference] of [
      ["icon", item.icon],
      ["selectedIcon", item.selectedIcon],
      ["resource", item.resource]
    ] as const) {
      if (reference !== undefined) {
        assertResource(
          context.document,
          reference,
          `${path}[${index}].${field}`,
          field === "resource" ? PropertyType.COMPONENT : undefined
        );
      }
    }
    return {
      title: item.title ?? null,
      icon: item.icon ? resourceUrl(item.icon) : null,
      url: item.resource ? resourceUrl(item.resource) : null,
      name: item.name ?? null,
      selectedTitle: item.selectedTitle ?? null,
      selectedIcon: item.selectedIcon
        ? resourceUrl(item.selectedIcon)
        : null,
      level: 0,
      isFolder: null
    };
  });
}

function setNodeRelations(
  context: EngineContext,
  owner: MutableOwner,
  relations: readonly FairyDomRelation[],
  path: string
): void {
  invoke(owner, "setRelations", [relationsFor(context, relations, path)], path);
}

function resolveGroupId(
  context: EngineContext,
  groupId: string,
  path: string
): string {
  const resolved = resolveReferenceId(context, groupId, path);
  const existing = context.component.getChildById(resolved);
  const referencedClient = Object.entries(context.clientRefs)
    .find(([, id]) => id === resolved)?.[0];
  const futureType = context.reservedNodeTypes.get(resolved)
    ?? (referencedClient === undefined
      ? undefined
      : context.clientRefTypes.get(referencedClient));
  const isExistingGroup = !context.replacementScope
    && existing?.propertyType === PropertyType.G_GROUP;
  if (!isExistingGroup && futureType !== "group") {
    patchError("INVALID_PATCH", "groupId 必须引用同组件内的 Group 节点", {
      path,
      actual: groupId,
      allowed: ["group node id", "group insert clientRef"]
    });
  }
  return resolved;
}

function setNodeGroup(
  context: EngineContext,
  object: GObject,
  groupId: string | undefined,
  path: string
): void {
  if (groupId === undefined) return;
  const resolved = resolveGroupId(context, groupId, path);
  invoke(object as MutableObject, "setGroup", [resolved], path);
}

function applyNodeContent(
  context: EngineContext,
  object: GObject,
  node: FairyDomNewNode,
  path: string,
  fields?: ReadonlySet<string>
): void {
  const owner = object as MutableObject;
  const includes = (field: string): boolean =>
    fields === undefined || fields.has(field);
  switch (node.type) {
    case "image": {
      if (includes("resource") && node.content.resource !== undefined) {
        setPrimaryResource(
          context,
          object,
          node.content.resource,
          `${path}.resource`
        );
      }
      if (includes("flip") && node.content.flip !== undefined) {
        const values = {
          none: FlipType.None,
          horizontal: FlipType.Horizontal,
          vertical: FlipType.Vertical,
          both: FlipType.Both
        };
        invoke(
          owner,
          "setFlip",
          [values[node.content.flip]],
          `${path}.flip`
        );
      }
      if (includes("fillMethod") && node.content.fillMethod !== undefined) {
        const values = {
          none: FillMethod.None,
          horizontal: FillMethod.Horizontal,
          vertical: FillMethod.Vertical,
          "radial-90": FillMethod.Radial90,
          "radial-180": FillMethod.Radial180,
          "radial-360": FillMethod.Radial360
        };
        invoke(
          owner,
          "setFillMethod",
          [values[node.content.fillMethod]],
          `${path}.fillMethod`
        );
      }
      if (includes("fillAmount") && node.content.fillAmount !== undefined) {
        invoke(
          owner,
          "setFillAmount",
          [node.content.fillAmount],
          `${path}.fillAmount`
        );
      }
      if (includes("color") && node.content.color !== undefined) {
        invoke(owner, "setColor", [node.content.color], `${path}.color`);
      }
      return;
    }
    case "text":
      applyTextContent(context, owner, node.content, path, fields);
      return;
    case "rich-text":
      applyTextContent(context, owner, node.content, path, fields);
      if (includes("ubb") && node.content.ubb !== undefined) {
        invoke(
          owner,
          "setUbbEnabled",
          [node.content.ubb],
          `${path}.ubb`
        );
      }
      return;
    case "input-text":
      applyTextContent(context, owner, node.content, path, fields);
      for (const [field, method] of [
        ["prompt", "setPromptText"],
        ["restrict", "setRestrict"],
        ["maxLength", "setMaxLength"],
        ["password", "setPassword"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      if (includes("keyboardType") && node.content.keyboardType !== undefined) {
        const values = {
          default: 0,
          number: 1,
          url: 2,
          email: 3,
          phone: 4
        };
        invoke(
          owner,
          "setKeyboardType",
          [values[node.content.keyboardType]],
          `${path}.keyboardType`
        );
      }
      return;
    case "loader": {
      if (
        fields === undefined
        &&
        node.content.resource !== undefined
        && node.content.externalUrl !== undefined
      ) {
        patchError(
          "INVALID_DOM",
          "Loader 的 resource 与 externalUrl 不能同时设置",
          { path }
        );
      }
      if (includes("resource") && node.content.resource !== undefined) {
        setPrimaryResource(
          context,
          object,
          node.content.resource,
          `${path}.resource`
        );
      }
      else if (
        includes("externalUrl")
        && node.content.externalUrl !== undefined
      ) {
        invoke(
          owner,
          "setUrl",
          [node.content.externalUrl],
          `${path}.externalUrl`
        );
      }
      if (includes("fill") && node.content.fill !== undefined) {
        const values = {
          none: LoaderFillType.None,
          scale: LoaderFillType.Scale,
          "scale-match-height": LoaderFillType.ScaleMatchHeight,
          "scale-match-width": LoaderFillType.ScaleMatchWidth,
          "scale-free": LoaderFillType.ScaleFree,
          "scale-no-border": LoaderFillType.ScaleNoBorder
        };
        invoke(owner, "setFill", [values[node.content.fill]], `${path}.fill`);
      }
      if (includes("align") && node.content.align !== undefined) {
        const values = {
          left: AlignType.Left,
          center: AlignType.Center,
          right: AlignType.Right
        };
        invoke(
          owner,
          "setAlign",
          [values[node.content.align]],
          `${path}.align`
        );
      }
      if (
        includes("verticalAlign")
        && node.content.verticalAlign !== undefined
      ) {
        const values = {
          top: VertAlignType.Top,
          middle: VertAlignType.Middle,
          bottom: VertAlignType.Bottom
        };
        invoke(
          owner,
          "setVAlign",
          [values[node.content.verticalAlign]],
          `${path}.verticalAlign`
        );
      }
      for (const [field, method] of [
        ["autoSize", "setAutoSize"],
        ["playing", "setPlaying"],
        ["frame", "setFrame"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      return;
    }
    case "graph": {
      const types = {
        empty: GraphType.Empty,
        rectangle: GraphType.Rect,
        ellipse: GraphType.Ellipse,
        polygon: GraphType.Polygon,
        "regular-polygon": GraphType.RegularPolygon
      };
      if (includes("shape")) {
        invoke(
          owner,
          "setGraphType",
          [types[node.content.shape]],
          `${path}.shape`
        );
      }
      for (const [field, method] of [
        ["fillColor", "setFillColor"],
        ["lineColor", "setLineColor"],
        ["lineSize", "setLineSize"],
        ["cornerRadius", "setCornerRadius"],
        ["sides", "setSides"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      if (includes("points") && node.content.points !== undefined) {
        invoke(
          owner,
          "setPoints",
          [node.content.points.flatMap((point) => [point.x, point.y])],
          `${path}.points`
        );
      }
      return;
    }
    case "movie-clip":
      if (includes("resource") && node.content.resource !== undefined) {
        setPrimaryResource(
          context,
          object,
          node.content.resource,
          `${path}.resource`
        );
      }
      for (const [field, method] of [
        ["playing", "setPlaying"],
        ["frame", "setFrame"],
        ["color", "setColor"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      return;
    case "group": {
      const layouts = {
        none: GroupLayoutType.None,
        horizontal: GroupLayoutType.Horizontal,
        vertical: GroupLayoutType.Vertical
      };
      if (includes("layout")) {
        invoke(
          owner,
          "setLayout",
          [layouts[node.content.layout]],
          `${path}.layout`
        );
      }
      for (const [field, method] of [
        ["lineGap", "setLineGap"],
        ["columnGap", "setColumnGap"],
        ["excludeInvisibles", "setExcludeInvisibles"],
        ["autoSizeDisabled", "setAutoSizeDisabled"],
        ["mainGridIndex", "setMainGridIndex"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      if (
        includes("mainGridMinSize")
        && node.content.mainGridMinSize !== undefined
      ) {
        patchError(
          "CAPABILITY_NOT_IMPLEMENTED",
          "工程 XML 不提供可安全往返的 Group mainGridMinSize 字段",
          {
            path: `${path}.mainGridMinSize`,
            suggestedFix: "省略 mainGridMinSize；运行时会依据主网格成员尺寸计算"
          }
        );
      }
      return;
    }
    case "list": {
      const layouts = {
        "single-column": ListLayoutType.SingleColumn,
        "single-row": ListLayoutType.SingleRow,
        "flow-horizontal": ListLayoutType.FlowHorizontal,
        "flow-vertical": ListLayoutType.FlowVertical,
        pagination: ListLayoutType.Pagination
      };
      if (includes("layout")) {
        invoke(
          owner,
          "setLayout",
          [layouts[node.content.layout]],
          `${path}.layout`
        );
      }
      if (
        includes("defaultItem")
        && node.content.defaultItem !== undefined
      ) {
        setPrimaryResource(
          context,
          object,
          node.content.defaultItem,
          `${path}.defaultItem`
        );
      }
      for (const [field, method] of [
        ["lineGap", "setLineGap"],
        ["columnGap", "setColumnGap"],
        ["lineCount", "setLineCount"],
        ["columnCount", "setColumnCount"],
        ["autoResizeItem", "setAutoResizeItem"]
      ] as const) {
        const value = node.content[field];
        if (includes(field) && value !== undefined) {
          invoke(owner, method, [value], `${path}.${field}`);
        }
      }
      if (includes("align") && node.content.align !== undefined) {
        const values = {
          left: AlignType.Left,
          center: AlignType.Center,
          right: AlignType.Right
        };
        invoke(
          owner,
          "setAlign",
          [values[node.content.align]],
          `${path}.align`
        );
      }
      if (
        includes("verticalAlign")
        && node.content.verticalAlign !== undefined
      ) {
        const values = {
          top: VertAlignType.Top,
          middle: VertAlignType.Middle,
          bottom: VertAlignType.Bottom
        };
        invoke(
          owner,
          "setVAlign",
          [values[node.content.verticalAlign]],
          `${path}.verticalAlign`
        );
      }
      if (includes("items")) {
        invoke(
          owner,
          "setListItems",
          [listItemsFor(context, node.content.items, `${path}.items`)],
          `${path}.items`
        );
      }
      return;
    }
    case "instance": {
      const source = assertResource(
        context.document,
        node.content.resource,
        `${path}.resource`,
        PropertyType.COMPONENT
      ) as Component;
      const extensionType = source.getExtensionType();
      if (includes("resource")) {
        setPrimaryResource(
          context,
          object,
          node.content.resource,
          `${path}.resource`
        );
      }
      if (includes("text") && node.content.text !== undefined) {
        assertInstanceOverlay(extensionType, "text", `${path}.text`);
        invoke(
          owner,
          "setInstanceTitle",
          [node.content.text],
          `${path}.text`
        );
      }
      if (includes("icon") && node.content.icon !== undefined) {
        assertInstanceOverlay(extensionType, "icon", `${path}.icon`);
        assertResource(
          context.document,
          node.content.icon,
          `${path}.icon`
        );
        invoke(
          owner,
          "setInstanceIcon",
          [resourceUrl(node.content.icon)],
          `${path}.icon`
        );
      }
      if (includes("selected") && node.content.selected !== undefined) {
        assertInstanceOverlay(extensionType, "selected", `${path}.selected`);
        invoke(
          owner,
          "setInstanceChecked",
          [node.content.selected],
          `${path}.selected`
        );
      }
      if (
        includes("properties")
        &&
        node.content.properties !== undefined
        && Object.keys(node.content.properties).length > 0
      ) {
        patchError(
          "READ_ONLY_CAPABILITY",
          "自定义组件实例属性在 V1 中只读",
          {
            path: `${path}.properties`,
            actual: "extension.custom",
            allowed: ["instance resource", "text", "icon", "selected"]
          }
        );
      }
      return;
    }
  }
}

function createNode(
  context: EngineContext,
  node: FairyDomNewNode,
  id: string,
  path: string
): GObject {
  const document = context.document;
  const object = (() => {
    switch (node.type) {
      case "image":
        return document.createGImage(node.name);
      case "text":
        return document.createGTextField(node.name);
      case "rich-text":
        return document.createGRichTextField(node.name);
      case "input-text":
        return document.createGTextInput(node.name);
      case "loader":
        return document.createGLoader(node.name);
      case "graph":
        return document.createGGraph(node.name);
      case "movie-clip":
        return document.createGMovieClip(node.name);
      case "group":
        return document.createGGroup(node.name);
      case "list":
        return document.createGList(node.name);
      case "instance":
        return document.createGComponent(node.name);
    }
  })();
  object.setId(id);
  if (node.type === "group") {
    invoke(
      object as unknown as MutableObject,
      "setAdvanced",
      [true],
      `${path}.type`
    );
  }
  applyStyleToNode(object, node.style, `${path}.style`);
  setNodeGroup(context, object, node.groupId, `${path}.groupId`);
  setNodeRelations(
    context,
    object as unknown as MutableObject,
    node.relations,
    `${path}.relations`
  );
  applyNodeContent(context, object, node, `${path}.content`);
  return object;
}

function selectorCrossesInstance(
  root: FairyDomSelectorNode,
  parsed: ParsedFairyDomSelector
): boolean {
  for (let index = 0; index < parsed.steps.length - 1; index++) {
    const prefix: ParsedFairyDomSelector = {
      source: parsed.source,
      steps: parsed.steps.slice(0, index + 1)
    };
    if (
      matchFairyDomSelector(root, prefix)
        .some((node) => node.type === "instance")
    ) {
      return true;
    }
  }
  return false;
}

function selectTargets(
  context: EngineContext,
  selector: string,
  expectedMatches: number,
  path: string
): PatchTarget[] {
  const dom = toFairyDomDocument(
    context.document,
    context.packageId,
    context.componentId
  );
  const parsed = parseFairyDomSelector(selector);
  const matches = matchFairyDomSelector(dom.root, parsed);
  if (
    matches.length !== expectedMatches
    && selectorCrossesInstance(dom.root, parsed)
  ) {
    patchError(
      "INSTANCE_BOUNDARY",
      "选择器试图跨越组件实例边界",
      {
        path,
        actual: selector,
        suggestedFix: "查询实例来源组件，再对来源组件发起独立补丁"
      }
    );
  }
  if (matches.length !== expectedMatches) {
    patchError("SELECTOR_MATCH_COUNT", "选择器匹配数量与预期不一致", {
      path,
      actual: {
        selector,
        expectedMatches,
        actualMatches: matches.length
      },
      allowed: [expectedMatches],
      suggestedFix: "重新查询 DOM，并使用更精确的 #id 或 [name=\"...\"]"
    });
  }
  return matches.map((match) => {
    if (match.type === "component-root") {
      return { kind: "root", component: context.component };
    }
    const object = context.component.getChildById(match.id);
    if (!object) {
      patchError("INVALID_PATCH", "选择器结果在模型中不存在", {
        path,
        actual: match.id
      });
    }
    return { kind: "node", object };
  });
}

function operationTargets(
  context: EngineContext,
  operation: Exclude<DomPatchOperation, { op: "insert" }>,
  index: number
): PatchTarget[] {
  const path = `operations[${index}]`;
  if (operation.targetRef !== undefined) {
    const id = context.clientRefs[operation.targetRef];
    const object = id === undefined
      ? undefined
      : context.component.getChildById(id);
    if (!object) {
      patchError(
        "INVALID_PATCH",
        "targetRef 只能定位本批次中已执行 insert 的节点",
        {
          path: `${path}.targetRef`,
          actual: operation.targetRef,
          suggestedFix: "把 insert 放在引用该 clientRef 的操作之前"
        }
      );
    }
    return [{ kind: "node", object }];
  }
  return selectTargets(
    context,
    operation.selector!,
    operation.expectedMatches,
    `${path}.selector`
  );
}

interface RootUpdatePlan {
  kind: "root";
  target: RootTarget;
  value: FairyDomComponentRoot;
}

interface NodeUpdatePlan {
  kind: "node";
  target: NodeTarget;
  value: FairyDomNewNode;
}

type UpdatePlan = RootUpdatePlan | NodeUpdatePlan;

const STYLE_DEFAULTS = {
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  minWidth: 0,
  maxWidth: 0,
  minHeight: 0,
  maxHeight: 0,
  opacity: 1,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
  pivotX: 0,
  pivotY: 0,
  pivotAsAnchor: false,
  visible: true,
  touchable: true,
  grayed: false
} satisfies Record<keyof FairyDomStyle, number | boolean>;

function styleUpdateValues(
  rawChanges: Record<string, unknown>,
  merged: FairyDomStyle
): FairyDomStyle {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(rawChanges)) {
    values[key] = rawChanges[key] === null
      ? STYLE_DEFAULTS[key as keyof FairyDomStyle]
      : merged[key as keyof FairyDomStyle];
  }
  return values as FairyDomStyle;
}

function editableNode(node: FairyDomNode): Record<string, unknown> {
  const value = { ...node } as Record<string, unknown>;
  delete value.id;
  delete value.readOnly;
  delete value.capability;
  return value;
}

function prepareUpdatePlans(
  context: EngineContext,
  targets: readonly PatchTarget[],
  changes: DomUpdateChanges,
  operationIndex: number
): UpdatePlan[] {
  const dom = toFairyDomDocument(
    context.document,
    context.packageId,
    context.componentId
  );
  const nodes = new Map(dom.root.children.map((node) => [node.id, node]));
  return targets.map((target) => {
    if (target.kind === "root") {
      const merged = mergeJsonObject(
        dom.root as unknown as Record<string, unknown>,
        changes as Record<string, unknown>
      );
      const parsed = FairyDomComponentRootSchema.safeParse(merged);
      if (!parsed.success) {
        mergedPatchError(
          operationIndex,
          changes,
          parsed.error.issues as PatchValidationIssue[]
        );
      }
      return { kind: "root", target, value: parsed.data };
    }

    const current = nodes.get(target.object.getId());
    if (!current) {
      patchError("INVALID_PATCH", "update 目标无法从当前 DOM 投影中定位", {
        path: `operations[${operationIndex}]`,
        actual: target.object.getId()
      });
    }
    const merged = mergeJsonObject(
      editableNode(current),
      changes as Record<string, unknown>
    );
    const parsed = FairyDomNewNodeSchema.safeParse(merged);
    if (!parsed.success) {
      mergedPatchError(
        operationIndex,
        changes,
        parsed.error.issues as PatchValidationIssue[]
      );
    }
    return { kind: "node", target, value: parsed.data };
  });
}

function changedObject(
  value: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  return value === null || value === undefined ? undefined : value;
}

function validateRootContent(
  context: EngineContext,
  value: FairyDomComponentRoot["content"],
  path: string
): void {
  if (value.overflow !== "scroll" && value.scrollAxis !== undefined) {
    patchError(
      "INVALID_PATCH",
      "scrollAxis 只能在 overflow 为 scroll 时设置",
      {
        path: `${path}.scrollAxis`,
        actual: value.scrollAxis,
        allowed: ["overflow: scroll"]
      }
    );
  }
  if (value.maskId !== undefined) {
    const resolved = resolveReferenceId(
      context,
      value.maskId,
      `${path}.maskId`
    );
    if (resolved === context.componentId) {
      patchError("INVALID_PATCH", "组件根不能作为自身遮罩", {
        path: `${path}.maskId`,
        actual: resolved
      });
    }
  }
  if (value.reversedMask === true && value.maskId === undefined) {
    patchError("INVALID_PATCH", "reversedMask 需要同时指定 maskId", {
      path: `${path}.reversedMask`,
      actual: true
    });
  }
}

function validateNodeContentUpdate(
  context: EngineContext,
  node: FairyDomNewNode,
  rawChanges: Record<string, unknown>,
  path: string
): void {
  const changed = new Set(Object.keys(rawChanges));
  switch (node.type) {
    case "image":
      if (changed.has("resource") && node.content.resource !== undefined) {
        assertResource(
          context.document,
          node.content.resource,
          `${path}.resource`,
          PropertyType.IMAGE_RESOURCE
        );
      }
      return;
    case "text":
    case "rich-text":
    case "input-text":
      if (changed.has("font") && node.content.font !== undefined) {
        assertResource(
          context.document,
          node.content.font,
          `${path}.font`,
          PropertyType.FONT_RESOURCE
        );
      }
      return;
    case "loader":
      if (
        node.content.resource !== undefined
        && node.content.externalUrl !== undefined
      ) {
        patchError(
          "INVALID_PATCH",
          "Loader 的 resource 与 externalUrl 不能同时设置",
          { path }
        );
      }
      if (changed.has("resource") && node.content.resource !== undefined) {
        assertResource(context.document, node.content.resource, `${path}.resource`);
      }
      return;
    case "graph":
      return;
    case "movie-clip":
      if (changed.has("resource") && node.content.resource !== undefined) {
        assertResource(
          context.document,
          node.content.resource,
          `${path}.resource`,
          PropertyType.MOVIE_CLIP_RESOURCE
        );
      }
      return;
    case "group":
      if (changed.has("mainGridMinSize")) {
        patchError(
          "CAPABILITY_NOT_IMPLEMENTED",
          "工程 XML 不提供可安全往返的 Group mainGridMinSize 字段",
          {
            path: `${path}.mainGridMinSize`,
            suggestedFix:
              "省略 mainGridMinSize；运行时会依据主网格成员尺寸计算"
          }
        );
      }
      return;
    case "list":
      if (
        changed.has("defaultItem")
        && node.content.defaultItem !== undefined
      ) {
        assertResource(
          context.document,
          node.content.defaultItem,
          `${path}.defaultItem`,
          PropertyType.COMPONENT
        );
      }
      if (changed.has("items")) {
        listItemsFor(context, node.content.items, `${path}.items`);
      }
      return;
    case "instance": {
      const source = assertResource(
        context.document,
        node.content.resource,
        `${path}.resource`,
        PropertyType.COMPONENT
      ) as Component;
      const extensionType = source.getExtensionType();
      if (changed.has("text")) {
        assertInstanceOverlay(extensionType, "text", `${path}.text`);
      }
      if (changed.has("icon")) {
        assertInstanceOverlay(extensionType, "icon", `${path}.icon`);
        if (node.content.icon !== undefined) {
          assertResource(context.document, node.content.icon, `${path}.icon`);
        }
      }
      if (changed.has("selected")) {
        assertInstanceOverlay(extensionType, "selected", `${path}.selected`);
      }
      if (changed.has("properties")) {
        patchError(
          "READ_ONLY_CAPABILITY",
          "自定义组件实例属性在 V1 中只读",
          {
            path: `${path}.properties`,
            actual: "extension.custom",
            allowed: ["instance resource", "text", "icon", "selected"]
          }
        );
      }
      return;
    }
  }
}

function preflightUpdatePlans(
  context: EngineContext,
  plans: readonly UpdatePlan[],
  changes: DomUpdateChanges,
  operationIndex: number
): void {
  const path = `operations[${operationIndex}].changes`;
  for (const plan of plans) {
    if (plan.kind === "root") {
      if (Object.hasOwn(changes, "name")) {
        patchError("INVALID_PATCH", "组件根名称属于资源元数据", {
          path: `${path}.name`,
          suggestedFix: "使用 rename-resource 资源操作"
        });
      }
      const styleChanges = changedObject(changes.style);
      if (styleChanges) {
        assertRootStyleFields(
          styleUpdateValues(styleChanges, plan.value.style),
          `${path}.style`
        );
      }
      if (changes.relations !== undefined) {
        relationsFor(context, plan.value.relations, `${path}.relations`);
      }
      if (changes.content !== undefined) {
        validateRootContent(context, plan.value.content, `${path}.content`);
      }
      continue;
    }

    const styleChanges = changedObject(changes.style);
    if (styleChanges) {
      assertStyleMethods(
        plan.target.object as MutableObject,
        styleUpdateValues(styleChanges, plan.value.style),
        `${path}.style`
      );
    }
    if (Object.hasOwn(changes, "groupId") && plan.value.groupId !== undefined) {
      resolveGroupId(context, plan.value.groupId, `${path}.groupId`);
    }
    if (changes.relations !== undefined) {
      relationsFor(context, plan.value.relations, `${path}.relations`);
    }
    const contentChanges = changedObject(changes.content);
    if (contentChanges) {
      validateNodeContentUpdate(
        context,
        plan.value,
        contentChanges,
        `${path}.content`
      );
    }
  }
}

function applyRootContent(
  context: EngineContext,
  value: FairyDomComponentRoot["content"],
  path: string
): void {
  const overflowValues = {
    visible: OverflowType.Visible,
    hidden: OverflowType.Hidden,
    scroll: OverflowType.Scroll
  };
  context.component.setOverflow(overflowValues[value.overflow]);
  if (value.overflow === "scroll") {
    const scrollValues = {
      horizontal: ScrollType.Horizontal,
      vertical: ScrollType.Vertical,
      both: ScrollType.Both
    };
    context.component.setScrollType(
      scrollValues[value.scrollAxis ?? "vertical"]
    );
  }
  context.component.setOpaque(value.opaque ?? true);
  context.component.setBgColor(value.backgroundColor ?? "");
  context.component.setBgColorEnabled(value.backgroundColor !== undefined);
  context.component.setMask(
    value.maskId === undefined
      ? ""
      : resolveReferenceId(context, value.maskId, `${path}.maskId`)
  );
  context.component.setReversedMask(value.reversedMask ?? false);
}

function resetTextContentField(
  owner: MutableObject,
  field: string,
  path: string
): boolean {
  const defaults: Record<string, readonly [string, unknown]> = {
    font: ["setFont", ""],
    fontSize: ["setFontSize", 12],
    color: ["setColor", "#000000"],
    align: ["setAlign", AlignType.Left],
    verticalAlign: ["setVAlign", VertAlignType.Top],
    autoSize: ["setAutoSize", AutoSizeType.Both],
    singleLine: ["setSingleLine", false],
    bold: ["setBold", false],
    italic: ["setItalic", false],
    underline: ["setUnderline", false],
    strikethrough: ["setStrikethrough", false],
    lineSpacing: ["setLeading", 3],
    letterSpacing: ["setLetterSpacing", 0]
  };
  const entry = defaults[field];
  if (!entry) return false;
  invoke(owner, entry[0], [entry[1]], `${path}.${field}`);
  return true;
}

function resetNodeContentFields(
  context: EngineContext,
  object: GObject,
  node: FairyDomNewNode,
  rawChanges: Record<string, unknown>,
  path: string
): void {
  const nullFields = new Set(
    Object.entries(rawChanges)
      .filter(([, value]) => value === null)
      .map(([field]) => field)
  );
  if (nullFields.size === 0) return;
  const owner = object as MutableObject;
  const reset = (
    field: string,
    method: string,
    value: unknown
  ): void => {
    if (nullFields.has(field)) {
      invoke(owner, method, [value], `${path}.${field}`);
    }
  };

  switch (node.type) {
    case "image":
      if (nullFields.has("resource")) {
        setPrimaryResource(context, object, null, `${path}.resource`);
      }
      reset("flip", "setFlip", FlipType.None);
      reset("fillMethod", "setFillMethod", FillMethod.None);
      reset("fillAmount", "setFillAmount", 1);
      reset("color", "setColor", "#FFFFFF");
      return;
    case "text":
    case "rich-text":
    case "input-text":
      for (const field of nullFields) {
        resetTextContentField(owner, field, path);
      }
      if (node.type === "rich-text") {
        reset("ubb", "setUbbEnabled", false);
      }
      if (node.type === "input-text") {
        reset("prompt", "setPromptText", "");
        reset("restrict", "setRestrict", "");
        reset("maxLength", "setMaxLength", 0);
        reset("password", "setPassword", false);
        reset("keyboardType", "setKeyboardType", 0);
      }
      return;
    case "loader":
      if (
        nullFields.has("resource")
        || nullFields.has("externalUrl")
      ) {
        const url = node.content.resource
          ? resourceUrl(node.content.resource)
          : node.content.externalUrl ?? "";
        invoke(owner, "setUrl", [url], path);
      }
      reset("fill", "setFill", LoaderFillType.None);
      reset("align", "setAlign", AlignType.Left);
      reset("verticalAlign", "setVAlign", VertAlignType.Top);
      reset("autoSize", "setAutoSize", false);
      reset("playing", "setPlaying", true);
      reset("frame", "setFrame", 0);
      return;
    case "graph":
      reset("fillColor", "setFillColor", "#FFFFFF");
      reset("lineColor", "setLineColor", "#000000");
      reset("lineSize", "setLineSize", 1);
      reset("cornerRadius", "setCornerRadius", null);
      reset("sides", "setSides", 0);
      reset("points", "setPoints", null);
      return;
    case "movie-clip":
      if (nullFields.has("resource")) {
        setPrimaryResource(context, object, null, `${path}.resource`);
      }
      reset("playing", "setPlaying", true);
      reset("frame", "setFrame", 0);
      reset("color", "setColor", "#FFFFFF");
      return;
    case "group":
      reset("lineGap", "setLineGap", 0);
      reset("columnGap", "setColumnGap", 0);
      reset("excludeInvisibles", "setExcludeInvisibles", false);
      reset("autoSizeDisabled", "setAutoSizeDisabled", false);
      reset("mainGridIndex", "setMainGridIndex", -1);
      return;
    case "list":
      if (nullFields.has("defaultItem")) {
        setPrimaryResource(context, object, null, `${path}.defaultItem`);
      }
      reset("lineGap", "setLineGap", 0);
      reset("columnGap", "setColumnGap", 0);
      reset("lineCount", "setLineCount", 0);
      reset("columnCount", "setColumnCount", 0);
      reset("autoResizeItem", "setAutoResizeItem", true);
      reset("align", "setAlign", AlignType.Left);
      reset("verticalAlign", "setVAlign", VertAlignType.Top);
      return;
    case "instance":
      reset("text", "setInstanceTitle", "");
      reset("icon", "setInstanceIcon", "");
      reset("selected", "setInstanceChecked", false);
      return;
  }
}

function applyUpdatePlan(
  context: EngineContext,
  plan: UpdatePlan,
  changes: DomUpdateChanges,
  operationIndex: number
): void {
  const path = `operations[${operationIndex}].changes`;
  const styleChanges = changedObject(changes.style);
  if (plan.kind === "root") {
    if (styleChanges) {
      applyStyleToRoot(
        plan.target.component,
        styleUpdateValues(styleChanges, plan.value.style),
        `${path}.style`
      );
    }
    if (changes.relations !== undefined) {
      setNodeRelations(
        context,
        plan.target.component as Component & Record<string, unknown>,
        plan.value.relations,
        `${path}.relations`
      );
    }
    if (changes.content !== undefined) {
      applyRootContent(context, plan.value.content, `${path}.content`);
    }
    return;
  }

  if (Object.hasOwn(changes, "name")) {
    plan.target.object.setName(plan.value.name);
  }
  if (Object.hasOwn(changes, "groupId")) {
    if (changes.groupId === null) {
      invoke(
        plan.target.object as MutableObject,
        "setGroup",
        [""],
        `${path}.groupId`
      );
    }
    else {
      setNodeGroup(
        context,
        plan.target.object,
        plan.value.groupId,
        `${path}.groupId`
      );
    }
  }
  if (styleChanges) {
    applyStyleToNode(
      plan.target.object,
      styleUpdateValues(styleChanges, plan.value.style),
      `${path}.style`
    );
  }
  if (changes.relations !== undefined) {
    setNodeRelations(
      context,
      plan.target.object as MutableObject,
      plan.value.relations,
      `${path}.relations`
    );
  }
  const contentChanges = changedObject(changes.content);
  if (contentChanges) {
    resetNodeContentFields(
      context,
      plan.target.object,
      plan.value,
      contentChanges,
      `${path}.content`
    );
    const nonNullFields = new Set(
      Object.entries(contentChanges)
        .filter(([, value]) => value !== null)
        .map(([field]) => field)
    );
    if (nonNullFields.size > 0) {
      applyNodeContent(
        context,
        plan.target.object,
        plan.value,
        `${path}.content`,
        nonNullFields
      );
    }
  }
}

function cleanupRemovedReferences(
  context: EngineContext,
  removedIds: ReadonlySet<string>
): void {
  const cleanRelations = (owner: MutableOwner): void => {
    if (!hasMethod(owner, "getRelations") || !hasMethod(owner, "setRelations")) {
      return;
    }
    const current = owner.getRelations!();
    if (!Array.isArray(current)) return;
    owner.setRelations!(
      current.filter((relation) => {
        const value = relation as Partial<RelationDef>;
        return !value.target || !removedIds.has(value.target);
      })
    );
  };
  cleanRelations(context.component as Component & Record<string, unknown>);
  for (const child of context.component.listChildren()) {
    const owner = child as MutableObject;
    cleanRelations(owner);
    if (
      hasMethod(owner, "getGroup")
      && hasMethod(owner, "setGroup")
      && removedIds.has(String(owner.getGroup!()))
    ) {
      owner.setGroup!("");
    }
  }
  if (removedIds.has(context.component.getMask())) {
    context.component.setMask("");
    context.component.setReversedMask(false);
  }
}

function executeOperation(
  context: EngineContext,
  operation: DomPatchOperation,
  index: number
): string[] {
  const path = `operations[${index}]`;
  if (operation.op === "insert") {
    const parents = selectTargets(
      context,
      operation.parentSelector,
      operation.expectedMatches,
      `${path}.parentSelector`
    );
    const parent = parents[0]!;
    if (parent.kind === "node") {
      if (
        parent.object.propertyType === PropertyType.G_COMPONENT
        || parent.object.propertyType === PropertyType.G_BUTTON
        || parent.object.propertyType === PropertyType.G_LABEL
        || parent.object.propertyType === PropertyType.G_COMBO_BOX
        || parent.object.propertyType === PropertyType.G_PROGRESS_BAR
        || parent.object.propertyType === PropertyType.G_SLIDER
        || parent.object.propertyType === PropertyType.G_SCROLL_BAR
      ) {
        patchError("INSTANCE_BOUNDARY", "不能向组件实例内部插入节点", {
          path: `${path}.parentSelector`,
          suggestedFix: "对实例来源组件单独执行补丁"
        });
      }
      patchError("INVALID_PATCH", "V1 显示树只允许组件根作为插入父节点", {
        path: `${path}.parentSelector`,
        actual: parent.object.propertyType,
        allowed: ["component-root"]
      });
    }
    const id = context.clientRefs[operation.clientRef]!;
    const object = createNode(
      context,
      operation.node,
      id,
      `${path}.node`
    );
    const insertionIndex = operation.index ?? context.component.listChildren().length;
    try {
      context.component.insertChild(object, insertionIndex);
    }
    catch (error) {
      patchError("INVALID_PATCH", "插入显示节点失败", {
        path: `${path}.index`,
        actual: error instanceof Error ? error.message : String(error),
        allowed: {
          min: 0,
          max: context.component.listChildren().length
        }
      });
    }
    return [id];
  }

  const targets = operationTargets(context, operation, index);
  for (const target of targets) assertWritableTarget(target, path);

  switch (operation.op) {
    case "update": {
      const plans = prepareUpdatePlans(
        context,
        targets,
        operation.changes,
        index
      );
      preflightUpdatePlans(context, plans, operation.changes, index);
      for (const plan of plans) {
        applyUpdatePlan(context, plan, operation.changes, index);
      }
      return targets.map((target) =>
        target.kind === "root"
          ? context.componentId
          : target.object.getId()
      );
    }
    case "remove": {
      if (targets.some((target) => target.kind === "root")) {
        patchError("INVALID_PATCH", "不能通过 DOM 补丁删除组件根", {
          path,
          suggestedFix: "使用资源操作删除组件资源"
        });
      }
      const removed = new Set<string>();
      for (const target of targets) {
        if (target.kind !== "node") continue;
        removed.add(target.object.getId());
        context.component.removeChild(target.object);
      }
      cleanupRemovedReferences(context, removed);
      return [...removed];
    }
    case "move": {
      const target = targets[0]!;
      if (target.kind === "root") {
        patchError("INVALID_PATCH", "不能移动组件根", { path });
      }
      try {
        context.component.moveChild(target.object, operation.toIndex);
      }
      catch (error) {
        patchError("INVALID_PATCH", "移动显示节点失败", {
          path: `${path}.toIndex`,
          actual: error instanceof Error ? error.message : String(error),
          allowed: {
            min: 0,
            max: context.component.listChildren().length - 1
          }
        });
      }
      return [target.object.getId()];
    }
    case "replace": {
      const target = targets[0]!;
      if (target.kind === "root") {
        patchError("INVALID_PATCH", "不能用普通节点替换组件根", { path });
      }
      const replacement = createNode(
        context,
        operation.node,
        target.object.getId(),
        `${path}.node`
      );
      context.component.replaceChild(target.object, replacement);
      return [replacement.getId()];
    }
  }
}

function findComponent(
  document: Document,
  packageId: string,
  componentId: string
): Component {
  const pkg = document.getRoot().getPackageById(packageId);
  if (!pkg) {
    patchError("PACKAGE_NOT_FOUND", `包不存在：${packageId}`, {
      path: "packageId",
      actual: packageId
    });
  }
  const resource = pkg.getResourceById(componentId);
  if (!resource || resource.propertyType !== PropertyType.COMPONENT) {
    patchError(
      "COMPONENT_NOT_FOUND",
      `组件不存在：${packageId}/${componentId}`,
      {
        path: "componentId",
        actual: componentId
      }
    );
  }
  return resource;
}

function allocateClientRefs(
  component: Component,
  operations: readonly DomPatchOperation[]
): {
  clientRefs: Record<string, string>;
  clientRefTypes: Map<string, FairyDomNewNode["type"]>;
} {
  const existingIds = component.listChildren().map((child) => child.getId());
  const clientRefs: Record<string, string> = {};
  const clientRefTypes = new Map<string, FairyDomNewNode["type"]>();
  for (const operation of operations) {
    if (operation.op !== "insert") continue;
    const id = generateChildId([
      ...existingIds,
      ...Object.values(clientRefs)
    ]);
    clientRefs[operation.clientRef] = id;
    clientRefTypes.set(operation.clientRef, operation.node.type);
  }
  return { clientRefs, clientRefTypes };
}

export class DomPatchEngine {
  public apply(
    document: Document,
    input: ApplyDomPatchInput
  ): ResultEnvelope<DomPatchEngineData> {
    const validated = InternalApplyDomPatchInputSchema.safeParse(input);
    if (!validated.success) {
      return invalidPatchValidation(
        input,
        validated.error.issues as PatchValidationIssue[]
      );
    }
    const patch = validated.data;
    try {
      const component = findComponent(
        document,
        patch.packageId,
        patch.componentId
      );
      const allocated = allocateClientRefs(component, patch.operations);
      const context: EngineContext = {
        document,
        packageId: patch.packageId,
        componentId: patch.componentId,
        component,
        ...allocated,
        reservedNodeTypes: new Map(
          Object.entries(allocated.clientRefs).map(([clientRef, id]) => [
            id,
            allocated.clientRefTypes.get(clientRef)!
          ])
        ),
        replacementScope: false
      };
      const affectedNodeIds = new Set<string>();
      const operationResults = patch.operations.map((operation, index) => {
        const affected = executeOperation(context, operation, index);
        for (const id of affected) affectedNodeIds.add(id);
        return {
          index,
          op: operation.op,
          affectedNodeIds: affected
        };
      });
      return ok({
        appliedOperations: patch.operations.length,
        operationResults,
        affectedNodeIds: [...affectedNodeIds],
        clientRefs: { ...context.clientRefs },
        dom: toFairyDomDocument(
          document,
          patch.packageId,
          patch.componentId
        )
      });
    }
    catch (error) {
      if (error instanceof DomPatchEngineError) {
        return fail(error.code, error.message, error.options);
      }
      if (error instanceof SelectorSyntaxError) {
        return fail("INVALID_SELECTOR", error.message, {
          path: "selector",
          actual: {
            selector: error.selector,
            index: error.index
          },
          suggestedFix: error.suggestedFix
        });
      }
      if (error instanceof DomProjectionError) {
        return fail(error.code, error.message, {
          path: error.code === "PACKAGE_NOT_FOUND"
            ? "packageId"
            : "componentId",
          actual: error.code === "PACKAGE_NOT_FOUND"
            ? error.packageId
            : error.componentId
        });
      }
      return fail("INTERNAL_ERROR", "执行 DOM 内存补丁失败", {
        actual: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
