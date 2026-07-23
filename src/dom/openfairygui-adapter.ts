import {
  AlignType,
  AutoSizeType,
  FillMethod,
  FlipType,
  GraphType,
  GroupLayoutType,
  ListLayoutType,
  OverflowType,
  parseURL,
  PropertyType,
  ScrollType,
  VertAlignType,
  type Component,
  type Document,
  type GObject,
  type Package,
  type RelationDef
} from "@magicskysword/openfairygui-core";
import {
  FAIRYGUI_RELATION_TYPES,
  FairyDomDocumentSchema,
  type FairyDomDocument,
  type FairyDomListItem,
  type FairyDomNode,
  type FairyDomRelation,
  type FairyDomResourceReference,
  type FairyDomStyle
} from "../contracts/dom.js";

type GetterOwner = {
  propertyType: string;
  getId(): string;
  getName(): string;
  [key: string]: unknown;
};

export class DomProjectionError extends Error {
  public readonly code: "PACKAGE_NOT_FOUND" | "COMPONENT_NOT_FOUND" | "INVALID_DOM";
  public readonly packageId: string;
  public readonly componentId: string;

  public constructor(
    code: "PACKAGE_NOT_FOUND" | "COMPONENT_NOT_FOUND" | "INVALID_DOM",
    message: string,
    packageId: string,
    componentId: string
  ) {
    super(message);
    this.name = "DomProjectionError";
    this.code = code;
    this.packageId = packageId;
    this.componentId = componentId;
  }
}

export interface ComponentInstanceProjection {
  instanceId: string;
  instancePath: string[];
  source: {
    packageId: string;
    componentId: string;
  };
  readOnly: true;
  dom: FairyDomDocument;
}

function getter(owner: GetterOwner, method: string): unknown {
  const value = owner[method];
  return typeof value === "function"
    ? (value as (...args: never[]) => unknown).call(owner)
    : undefined;
}

function stringGetter(owner: GetterOwner, method: string): string | undefined {
  const value = getter(owner, method);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberGetter(owner: GetterOwner, method: string): number | undefined {
  const value = getter(owner, method);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanGetter(owner: GetterOwner, method: string): boolean | undefined {
  const value = getter(owner, method);
  return typeof value === "boolean" ? value : undefined;
}

function styleFor(owner: GetterOwner): FairyDomStyle {
  const style: FairyDomStyle = {};
  const numbers = [
    ["left", "getX"],
    ["top", "getY"],
    ["width", "getWidth"],
    ["height", "getHeight"],
    ["minWidth", "getMinWidth"],
    ["maxWidth", "getMaxWidth"],
    ["minHeight", "getMinHeight"],
    ["maxHeight", "getMaxHeight"],
    ["opacity", "getAlpha"],
    ["rotation", "getRotation"],
    ["scaleX", "getScaleX"],
    ["scaleY", "getScaleY"],
    ["skewX", "getSkewX"],
    ["skewY", "getSkewY"],
    ["pivotX", "getPivotX"],
    ["pivotY", "getPivotY"]
  ] as const;
  for (const [field, method] of numbers) {
    const value = numberGetter(owner, method);
    if (value !== undefined) style[field] = value;
  }
  const booleans = [
    ["pivotAsAnchor", "getPivotAsAnchor"],
    ["visible", "getVisible"],
    ["touchable", "getTouchable"],
    ["grayed", "getGrayed"]
  ] as const;
  for (const [field, method] of booleans) {
    const value = booleanGetter(owner, method);
    if (value !== undefined) style[field] = value;
  }
  return style;
}

function resourceReference(
  value: string | undefined,
  fallbackPackageId: string
): FairyDomResourceReference | undefined {
  if (!value) return undefined;
  const parsed = parseURL(value);
  if (parsed?.resourceId) return parsed;
  return { packageId: fallbackPackageId, resourceId: value };
}

function uiResourceOrExternal(
  value: string | undefined,
  fallbackPackageId: string
): {
  resource?: FairyDomResourceReference;
  externalUrl?: string;
} {
  if (!value) return {};
  if (value.startsWith("ui://")) {
    const resource = resourceReference(value, fallbackPackageId);
    return resource ? { resource } : { externalUrl: value };
  }
  return { externalUrl: value };
}

function relationFor(
  relation: RelationDef,
  componentId: string
): FairyDomRelation {
  const type = FAIRYGUI_RELATION_TYPES[relation.type];
  if (!type) {
    throw new DomProjectionError(
      "INVALID_DOM",
      `未知 FairyGUI RelationType：${relation.type}`,
      "",
      componentId
    );
  }
  return {
    targetId: relation.target || componentId,
    type,
    percent: relation.usePercent
  };
}

function relationsFor(
  owner: GetterOwner,
  componentId: string
): FairyDomRelation[] {
  const relations = getter(owner, "getRelations");
  if (!Array.isArray(relations)) return [];
  return relations.map((relation) =>
    relationFor(relation as RelationDef, componentId)
  );
}

function baseFor(
  child: GObject,
  componentId: string
): {
  id: string;
  name: string;
  groupId?: string;
  style: FairyDomStyle;
  relations: FairyDomRelation[];
} {
  const owner = child as unknown as GetterOwner;
  const base = {
    id: child.getId(),
    name: child.getName(),
    style: styleFor(owner),
    relations: relationsFor(owner, componentId)
  };
  const groupId = stringGetter(owner, "getGroup");
  return groupId ? { ...base, groupId } : base;
}

function alignName(value: number | undefined): "left" | "center" | "right" {
  if (value === AlignType.Center) return "center";
  if (value === AlignType.Right) return "right";
  return "left";
}

function verticalAlignName(
  value: number | undefined
): "top" | "middle" | "bottom" {
  if (value === VertAlignType.Middle) return "middle";
  if (value === VertAlignType.Bottom) return "bottom";
  return "top";
}

function autoSizeName(
  value: number | undefined
): "none" | "both" | "height" | "shrink" {
  if (value === AutoSizeType.Both) return "both";
  if (value === AutoSizeType.Height) return "height";
  if (value === AutoSizeType.Shrink || value === AutoSizeType.Ellipsis) {
    return "shrink";
  }
  return "none";
}

function flipName(
  value: number | undefined
): "none" | "horizontal" | "vertical" | "both" {
  if (value === FlipType.Horizontal) return "horizontal";
  if (value === FlipType.Vertical) return "vertical";
  if (value === FlipType.Both) return "both";
  return "none";
}

function fillMethodName(value: number | undefined): (
  | "none"
  | "horizontal"
  | "vertical"
  | "radial-90"
  | "radial-180"
  | "radial-360"
) {
  const names = [
    "none",
    "horizontal",
    "vertical",
    "radial-90",
    "radial-180",
    "radial-360"
  ] as const;
  return names[value ?? FillMethod.None] ?? "none";
}

function listLayoutName(value: number | undefined): (
  | "single-column"
  | "single-row"
  | "flow-horizontal"
  | "flow-vertical"
  | "pagination"
) {
  const names = [
    "single-column",
    "single-row",
    "flow-horizontal",
    "flow-vertical",
    "pagination"
  ] as const;
  return names[value ?? ListLayoutType.SingleColumn] ?? "single-column";
}

function groupLayoutName(
  value: number | undefined
): "none" | "horizontal" | "vertical" {
  if (value === GroupLayoutType.Horizontal) return "horizontal";
  if (value === GroupLayoutType.Vertical) return "vertical";
  return "none";
}

function graphTypeName(value: number | undefined): (
  | "empty"
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "regular-polygon"
) {
  const names = [
    "empty",
    "rectangle",
    "ellipse",
    "polygon",
    "regular-polygon"
  ] as const;
  return names[value ?? GraphType.Empty] ?? "empty";
}

function scrollAxisName(
  value: number | undefined
): "horizontal" | "vertical" | "both" {
  if (value === ScrollType.Horizontal) return "horizontal";
  if (value === ScrollType.Both) return "both";
  return "vertical";
}

function overflowName(
  value: number | undefined
): "visible" | "hidden" | "scroll" {
  if (value === OverflowType.Hidden) return "hidden";
  if (value === OverflowType.Scroll) return "scroll";
  return "visible";
}

function listItemsFor(
  owner: GetterOwner,
  packageId: string
): FairyDomListItem[] {
  const raw = getter(owner, "getListItems");
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      name: typeof value.name === "string" && value.name
        ? value.name
        : undefined,
      title: typeof value.title === "string" && value.title
        ? value.title
        : undefined,
      selectedTitle:
        typeof value.selectedTitle === "string" && value.selectedTitle
          ? value.selectedTitle
          : undefined,
      icon: resourceReference(
        typeof value.icon === "string" ? value.icon : undefined,
        packageId
      ),
      selectedIcon: resourceReference(
        typeof value.selectedIcon === "string" ? value.selectedIcon : undefined,
        packageId
      ),
      resource: resourceReference(
        typeof value.url === "string" ? value.url : undefined,
        packageId
      )
    };
  });
}

function textContent(owner: GetterOwner, packageId: string): Record<string, unknown> {
  const fontValue = stringGetter(owner, "getFont");
  const font = fontValue?.startsWith("ui://")
    ? resourceReference(fontValue, packageId)
    : undefined;
  return {
    text: String(getter(owner, "getText") ?? ""),
    font,
    fontSize: numberGetter(owner, "getFontSize"),
    color: stringGetter(owner, "getColor"),
    align: alignName(numberGetter(owner, "getAlign")),
    verticalAlign: verticalAlignName(numberGetter(owner, "getVAlign")),
    autoSize: autoSizeName(numberGetter(owner, "getAutoSize")),
    singleLine: booleanGetter(owner, "getSingleLine"),
    bold: booleanGetter(owner, "getBold"),
    italic: booleanGetter(owner, "getItalic"),
    underline: booleanGetter(owner, "getUnderline"),
    strikethrough: booleanGetter(owner, "getStrikethrough"),
    lineSpacing: numberGetter(owner, "getLeading"),
    letterSpacing: numberGetter(owner, "getLetterSpacing")
  };
}

function instanceNode(
  child: GObject,
  packageId: string,
  componentId: string
): FairyDomNode {
  const owner = child as unknown as GetterOwner;
  const sourcePackageId = stringGetter(owner, "getPackageId") ?? packageId;
  const resource = resourceReference(
    stringGetter(owner, "getSrc"),
    sourcePackageId
  );
  if (!resource) {
    throw new DomProjectionError(
      "INVALID_DOM",
      `组件实例 ${child.getId()} 缺少来源资源`,
      packageId,
      componentId
    );
  }
  const iconValue = stringGetter(owner, "getInstanceIcon");
  return {
    ...baseFor(child, componentId),
    type: "instance",
    content: {
      resource,
      text: stringGetter(owner, "getInstanceTitle"),
      icon: iconValue
        ? resourceReference(iconValue, packageId)
        : undefined,
      selected: booleanGetter(owner, "getInstanceChecked")
    }
  };
}

function nodeFor(
  child: GObject,
  packageId: string,
  componentId: string
): FairyDomNode {
  const owner = child as unknown as GetterOwner;
  const base = baseFor(child, componentId);
  switch (child.propertyType) {
    case PropertyType.G_IMAGE: {
      const sourcePackageId = stringGetter(owner, "getPackageId") ?? packageId;
      const amount = numberGetter(owner, "getFillAmount");
      return {
        ...base,
        type: "image",
        content: {
          resource: resourceReference(
            stringGetter(owner, "getSrc"),
            sourcePackageId
          ),
          flip: flipName(numberGetter(owner, "getFlip")),
          fillMethod: fillMethodName(numberGetter(owner, "getFillMethod")),
          fillAmount: amount === undefined
            ? undefined
            : Math.max(0, Math.min(1, amount > 1 ? amount / 100 : amount)),
          color: stringGetter(owner, "getColor")
        }
      };
    }
    case PropertyType.G_TEXT_FIELD:
      return {
        ...base,
        type: "text",
        content: textContent(owner, packageId)
      } as FairyDomNode;
    case PropertyType.G_RICH_TEXT_FIELD:
      return {
        ...base,
        type: "rich-text",
        content: {
          ...textContent(owner, packageId),
          ubb: booleanGetter(owner, "getUbbEnabled")
        }
      } as FairyDomNode;
    case PropertyType.G_TEXT_INPUT: {
      const keyboardNames = [
        "default",
        "number",
        "url",
        "email",
        "phone"
      ] as const;
      return {
        ...base,
        type: "input-text",
        content: {
          ...textContent(owner, packageId),
          prompt: stringGetter(owner, "getPromptText"),
          restrict: stringGetter(owner, "getRestrict"),
          maxLength: numberGetter(owner, "getMaxLength"),
          password: booleanGetter(owner, "getPassword"),
          keyboardType:
            keyboardNames[numberGetter(owner, "getKeyboardType") ?? 0]
            ?? "default"
        }
      } as FairyDomNode;
    }
    case PropertyType.G_LOADER:
      return {
        ...base,
        type: "loader",
        content: {
          ...uiResourceOrExternal(stringGetter(owner, "getUrl"), packageId),
          fill: [
            "none",
            "scale",
            "scale-match-height",
            "scale-match-width",
            "scale-free",
            "scale-no-border"
          ][numberGetter(owner, "getFill") ?? 0] as
            | "none"
            | "scale"
            | "scale-match-height"
            | "scale-match-width"
            | "scale-free"
            | "scale-no-border",
          align: alignName(numberGetter(owner, "getAlign")),
          verticalAlign: verticalAlignName(numberGetter(owner, "getVAlign")),
          autoSize: booleanGetter(owner, "getAutoSize"),
          playing: booleanGetter(owner, "getPlaying"),
          frame: numberGetter(owner, "getFrame")
        }
      };
    case PropertyType.G_GRAPH: {
      const points = getter(owner, "getPoints");
      const pointPairs = Array.isArray(points)
        ? Array.from({ length: Math.floor(points.length / 2) }, (_, index) => ({
          x: Number(points[index * 2] ?? 0),
          y: Number(points[index * 2 + 1] ?? 0)
        }))
        : undefined;
      const rawCornerRadius = getter(owner, "getCornerRadius");
      const cornerRadius = Array.isArray(rawCornerRadius)
        && rawCornerRadius.length === 4
        && rawCornerRadius.every((value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
        )
        ? rawCornerRadius as [number, number, number, number]
        : undefined;
      const rawSides = numberGetter(owner, "getSides");
      const sides = rawSides !== undefined && rawSides >= 3
        ? Math.floor(rawSides)
        : undefined;
      return {
        ...base,
        type: "graph",
        content: {
          shape: graphTypeName(numberGetter(owner, "getGraphType")),
          fillColor: stringGetter(owner, "getFillColor"),
          lineColor: stringGetter(owner, "getLineColor"),
          lineSize: numberGetter(owner, "getLineSize"),
          cornerRadius,
          sides,
          points: pointPairs
        }
      };
    }
    case PropertyType.G_MOVIE_CLIP: {
      const sourcePackageId = stringGetter(owner, "getPackageId") ?? packageId;
      return {
        ...base,
        type: "movie-clip",
        content: {
          resource: resourceReference(
            stringGetter(owner, "getSrc"),
            sourcePackageId
          ),
          playing: booleanGetter(owner, "getPlaying"),
          frame: numberGetter(owner, "getFrame"),
          color: stringGetter(owner, "getColor")
        }
      };
    }
    case PropertyType.G_GROUP:
      return {
        ...base,
        type: "group",
        content: {
          layout: groupLayoutName(numberGetter(owner, "getLayout")),
          lineGap: numberGetter(owner, "getLineGap"),
          columnGap: numberGetter(owner, "getColumnGap"),
          excludeInvisibles: booleanGetter(owner, "getExcludeInvisibles"),
          autoSizeDisabled: booleanGetter(owner, "getAutoSizeDisabled"),
          mainGridIndex: numberGetter(owner, "getMainGridIndex"),
          mainGridMinSize: numberGetter(owner, "getMainGridMinSize")
        }
      };
    case PropertyType.G_LIST:
      return {
        ...base,
        type: "list",
        content: {
          layout: listLayoutName(numberGetter(owner, "getLayout")),
          defaultItem: resourceReference(
            stringGetter(owner, "getDefaultItem"),
            packageId
          ),
          lineGap: numberGetter(owner, "getLineGap"),
          columnGap: numberGetter(owner, "getColumnGap"),
          lineCount: numberGetter(owner, "getLineCount"),
          columnCount: numberGetter(owner, "getColumnCount"),
          autoResizeItem: booleanGetter(owner, "getAutoResizeItem"),
          align: alignName(numberGetter(owner, "getAlign")),
          verticalAlign: verticalAlignName(numberGetter(owner, "getVAlign")),
          items: listItemsFor(owner, packageId)
        }
      };
    case PropertyType.G_TREE:
      return {
        ...base,
        type: "tree",
        readOnly: true,
        capability: "node.tree",
        content: {
          layout: listLayoutName(numberGetter(owner, "getLayout")),
          defaultItem: resourceReference(
            stringGetter(owner, "getDefaultItem"),
            packageId
          ),
          lineGap: numberGetter(owner, "getLineGap"),
          columnGap: numberGetter(owner, "getColumnGap"),
          items: listItemsFor(owner, packageId)
        }
      };
    case PropertyType.G_LOADER_3D:
      return {
        ...base,
        type: "loader3d",
        readOnly: true,
        capability: "node.loader3d",
        content: {
          ...uiResourceOrExternal(stringGetter(owner, "getUrl"), packageId),
          playing: booleanGetter(owner, "getPlaying"),
          frame: numberGetter(owner, "getFrame"),
          color: stringGetter(owner, "getColor")
        }
      };
    case PropertyType.G_COMPONENT:
    case PropertyType.G_BUTTON:
    case PropertyType.G_LABEL:
    case PropertyType.G_COMBO_BOX:
    case PropertyType.G_PROGRESS_BAR:
    case PropertyType.G_SLIDER:
    case PropertyType.G_SCROLL_BAR:
      return instanceNode(child, packageId, componentId);
    default:
      throw new DomProjectionError(
        "INVALID_DOM",
        `显示对象类型 ${child.propertyType} 尚无 DOM 投影契约`,
        packageId,
        componentId
      );
  }
}

function findComponent(
  document: Document,
  packageId: string,
  componentId: string
): { pkg: Package; component: Component } {
  const pkg = document.getRoot().getPackageById(packageId);
  if (!pkg) {
    throw new DomProjectionError(
      "PACKAGE_NOT_FOUND",
      `包不存在：${packageId}`,
      packageId,
      componentId
    );
  }
  const resource = pkg.getResourceById(componentId);
  if (!resource || resource.propertyType !== PropertyType.COMPONENT) {
    throw new DomProjectionError(
      "COMPONENT_NOT_FOUND",
      `组件不存在：${packageId}/${componentId}`,
      packageId,
      componentId
    );
  }
  return { pkg, component: resource };
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function toFairyDomDocument(
  document: Document,
  packageId: string,
  componentId: string
): FairyDomDocument {
  const { component } = findComponent(document, packageId, componentId);
  const overflow = overflowName(component.getOverflow());
  const content = {
    overflow,
    scrollAxis: overflow === "scroll"
      ? scrollAxisName(component.getScrollType())
      : undefined,
    opaque: component.getOpaque(),
    backgroundColor: component.getBgColorEnabled()
      ? component.getBgColor()
      : undefined,
    maskId: component.getMask() || undefined,
    reversedMask: component.getReversedMask() || undefined
  };
  const projected = {
    schemaVersion: 1 as const,
    packageId,
    componentId,
    root: {
      type: "component-root" as const,
      id: componentId,
      name: component.getName(),
      style: {
        width: component.getWidth(),
        height: component.getHeight()
      },
      content,
      relations: component.getRelations().map((relation) =>
        relationFor(relation, componentId)
      ),
      children: component.listChildren().map((child) =>
        nodeFor(child, packageId, componentId)
      )
    }
  };
  return FairyDomDocumentSchema.parse(withoutUndefined(projected));
}

function componentInstanceSource(
  child: GObject,
  packageId: string
): { packageId: string; componentId: string } | undefined {
  const instanceTypes = new Set<string>([
    PropertyType.G_COMPONENT,
    PropertyType.G_BUTTON,
    PropertyType.G_LABEL,
    PropertyType.G_COMBO_BOX,
    PropertyType.G_PROGRESS_BAR,
    PropertyType.G_SLIDER,
    PropertyType.G_SCROLL_BAR
  ]);
  if (!instanceTypes.has(child.propertyType)) return undefined;
  const owner = child as unknown as GetterOwner;
  const sourcePackageId = stringGetter(owner, "getPackageId") ?? packageId;
  const resource = resourceReference(
    stringGetter(owner, "getSrc"),
    sourcePackageId
  );
  return resource
    ? { packageId: resource.packageId, componentId: resource.resourceId }
    : undefined;
}

export function projectComponentInstances(
  document: Document,
  packageId: string,
  componentId: string
): ComponentInstanceProjection[] {
  const projections: ComponentInstanceProjection[] = [];

  const visit = (
    currentPackageId: string,
    currentComponentId: string,
    instancePath: string[],
    ancestors: Set<string>
  ): void => {
    const { component } = findComponent(
      document,
      currentPackageId,
      currentComponentId
    );
    for (const child of component.listChildren()) {
      const source = componentInstanceSource(child, currentPackageId);
      if (!source) continue;
      const nextPath = [...instancePath, child.getId()];
      const sourceKey = `${source.packageId}\0${source.componentId}`;
      const dom = toFairyDomDocument(
        document,
        source.packageId,
        source.componentId
      );
      projections.push({
        instanceId: child.getId(),
        instancePath: nextPath,
        source,
        readOnly: true,
        dom
      });
      if (!ancestors.has(sourceKey)) {
        visit(
          source.packageId,
          source.componentId,
          nextPath,
          new Set([...ancestors, sourceKey])
        );
      }
    }
  };

  visit(
    packageId,
    componentId,
    [],
    new Set([`${packageId}\0${componentId}`])
  );
  return projections;
}
