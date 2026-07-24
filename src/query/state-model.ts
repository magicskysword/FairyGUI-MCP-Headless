import {
  GearType,
  type Component,
  type Controller,
  type Gear,
  type GObject
} from "@magicskysword/openfairygui-core";

const GEAR_TYPE_NAMES = {
  [GearType.Display]: "display",
  [GearType.XY]: "xy",
  [GearType.Size]: "size",
  [GearType.Look]: "look",
  [GearType.Color]: "color",
  [GearType.Animation]: "animation",
  [GearType.Text]: "text",
  [GearType.Icon]: "icon",
  [GearType.Display2]: "display2",
  [GearType.FontSize]: "font-size"
} as const;

export type StateGearType =
  typeof GEAR_TYPE_NAMES[keyof typeof GEAR_TYPE_NAMES];

export interface StateControllerPage {
  id: string;
  name: string;
}

export interface StateController {
  name: string;
  selectedIndex: number;
  selectedPage: StateControllerPage | null;
  pages: StateControllerPage[];
}

export interface StateGearActiveValue {
  status: "resolved" | "unknown";
  pageId?: string;
  value?: unknown;
  reason?: string;
}

export interface StateGear {
  nodeId: string;
  nodeName: string;
  type: StateGearType;
  controller: string | null;
  pages: string[];
  values: string;
  defaultValue: unknown;
  pageValues: Record<string, unknown>;
  condition?: "and" | "or" | "unknown";
  active: StateGearActiveValue;
}

export interface VisibilityReason {
  type: "display" | "display2";
  controller: string | null;
  pageId?: string;
  pages: string[];
}

export interface EffectiveVisibility {
  nodeId: string;
  nodeName: string;
  baseVisible: boolean;
  value: boolean | "unknown";
  hiddenBy: VisibilityReason[];
  unknownBecause?: string[];
}

export interface ComponentStateModel {
  controllers: StateController[];
  gears: StateGear[];
  effectiveVisibility: EffectiveVisibility[];
}

function pagesFor(gear: Gear): string[] {
  return gear.getPages()
    .split(",")
    .map((page) => page.trim())
    .filter((page) => page.length > 0);
}

function controllerPage(controller: Controller | null): StateControllerPage | null {
  if (!controller) return null;
  const page = controller.listPages()[controller.getSelectedIndex()];
  return page ? { id: page.getId(), name: page.getName() } : null;
}

function expandedPageValues(gear: Gear, pages: readonly string[]): (
  Record<string, unknown>
) {
  const values = { ...gear.getPageValues() };
  const serialized = gear.getValues();
  if (serialized.length === 0) return values;
  const entries = serialized.split("|");
  pages.forEach((pageId, index) => {
    if (!(pageId in values) && index < entries.length) {
      values[pageId] = entries[index];
    }
  });
  return values;
}

function activeFor(
  gear: Gear,
  pages: readonly string[],
  pageValues: Readonly<Record<string, unknown>>
): StateGearActiveValue {
  const selectedPage = controllerPage(gear.getController());
  if (!gear.getController()) {
    return {
      status: "unknown",
      reason: "gear 未关联到组件内 Controller"
    };
  }
  if (!selectedPage) {
    return {
      status: "unknown",
      reason: "Controller selectedIndex 未指向有效页面"
    };
  }
  if (
    gear.getGearType() === GearType.Display
    || gear.getGearType() === GearType.Display2
  ) {
    return {
      status: "resolved",
      pageId: selectedPage.id,
      value: pages.length === 0 || pages.includes(selectedPage.id)
    };
  }
  return {
    status: "resolved",
    pageId: selectedPage.id,
    value: pageValues[selectedPage.id] ?? gear.getDefaultValue()
  };
}

function conditionFor(gear: Gear): "and" | "or" | "unknown" | undefined {
  if (gear.getGearType() !== GearType.Display2) return undefined;
  const condition = gear.getCondition();
  if (condition === "" || condition === "0") return "and";
  if (condition === "1") return "or";
  return "unknown";
}

function stateGear(node: GObject, gear: Gear): StateGear | undefined {
  const type = GEAR_TYPE_NAMES[
    gear.getGearType() as keyof typeof GEAR_TYPE_NAMES
  ];
  if (!type) return undefined;
  const pages = pagesFor(gear);
  const pageValues = expandedPageValues(gear, pages);
  const condition = conditionFor(gear);
  return {
    nodeId: node.getId(),
    nodeName: node.getName(),
    type,
    controller: gear.getController()?.getName() ?? null,
    pages,
    values: gear.getValues(),
    defaultValue: gear.getDefaultValue(),
    pageValues,
    ...(condition === undefined ? {} : { condition }),
    active: activeFor(gear, pages, pageValues)
  };
}

type TriState = boolean | "unknown";

function and(left: TriState, right: TriState): TriState {
  if (left === false || right === false) return false;
  if (left === "unknown" || right === "unknown") return "unknown";
  return true;
}

function or(left: TriState, right: TriState): TriState {
  if (left === true || right === true) return true;
  if (left === "unknown" || right === "unknown") return "unknown";
  return false;
}

function effectiveVisibility(
  node: GObject,
  gears: readonly StateGear[]
): EffectiveVisibility {
  const baseVisible = (
    node as unknown as { getVisible?(): boolean }
  ).getVisible?.() ?? true;
  if (!baseVisible) {
    return {
      nodeId: node.getId(),
      nodeName: node.getName(),
      baseVisible,
      value: false,
      hiddenBy: []
    };
  }

  const display = gears.find((gear) => gear.type === "display");
  const display2 = gears.find((gear) => gear.type === "display2");
  let connected: TriState = display
    ? display.active.status === "resolved"
      ? Boolean(display.active.value)
      : "unknown"
    : true;
  if (display2) {
    const secondary: TriState = display2.active.status === "resolved"
      ? Boolean(display2.active.value)
      : "unknown";
    connected = display2.condition === "or"
      ? or(connected, secondary)
      : display2.condition === "unknown"
        ? "unknown"
        : and(connected, secondary);
  }

  const unknownBecause = gears
    .filter((gear) =>
      (gear.type === "display" || gear.type === "display2")
      && gear.active.status === "unknown"
    )
    .map((gear) => gear.active.reason ?? `${gear.type} 状态未知`);
  if (display2?.condition === "unknown") {
    unknownBecause.push("gearDisplay2 condition 不是 0 或 1");
  }
  const hiddenBy = connected === false
    ? [display, display2]
      .filter((gear): gear is StateGear =>
        gear !== undefined
        && gear.active.status === "resolved"
        && gear.active.value === false
      )
      .map((gear) => ({
        type: gear.type as "display" | "display2",
        controller: gear.controller,
        ...(gear.active.pageId === undefined
          ? {}
          : { pageId: gear.active.pageId }),
        pages: gear.pages
      }))
    : [];
  return {
    nodeId: node.getId(),
    nodeName: node.getName(),
    baseVisible,
    value: connected,
    hiddenBy,
    ...(unknownBecause.length === 0 ? {} : { unknownBecause })
  };
}

export function buildComponentStateModel(
  component: Component
): ComponentStateModel {
  const controllers = component.listControllers().map((controller) => {
    const pages = controller.listPages().map((page) => ({
      id: page.getId(),
      name: page.getName()
    }));
    return {
      name: controller.getName(),
      selectedIndex: controller.getSelectedIndex(),
      selectedPage: pages[controller.getSelectedIndex()] ?? null,
      pages
    };
  });
  const gears: StateGear[] = [];
  const byNode = new Map<string, StateGear[]>();
  for (const node of component.listChildren()) {
    const nodeGears = node.listGears()
      .map((gear) => stateGear(node, gear))
      .filter((gear): gear is StateGear => gear !== undefined);
    gears.push(...nodeGears);
    byNode.set(node.getId(), nodeGears);
  }
  return {
    controllers,
    gears,
    effectiveVisibility: component.listChildren().map((node) =>
      effectiveVisibility(node, byNode.get(node.getId()) ?? [])
    )
  };
}
