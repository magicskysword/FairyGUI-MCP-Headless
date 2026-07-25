import {
  FillMethod,
  FillOrigin,
  FillOrigin90
} from "@magicskysword/openfairygui-core";
import type {
  FairyDomFillMethod,
  FairyDomFillOrigin
} from "../contracts/dom.js";

const METHOD_VALUES: Record<FairyDomFillMethod, number> = {
  none: FillMethod.None,
  horizontal: FillMethod.Horizontal,
  vertical: FillMethod.Vertical,
  "radial-90": FillMethod.Radial90,
  "radial-180": FillMethod.Radial180,
  "radial-360": FillMethod.Radial360
};

const METHOD_NAMES = [
  "none",
  "horizontal",
  "vertical",
  "radial-90",
  "radial-180",
  "radial-360"
] as const satisfies readonly FairyDomFillMethod[];

const ORIGIN_VALUES: Record<
  Exclude<FairyDomFillMethod, "none">,
  Partial<Record<FairyDomFillOrigin, number>>
> = {
  horizontal: {
    left: FillOrigin.Left,
    right: FillOrigin.Right
  },
  vertical: {
    top: FillOrigin.Top,
    bottom: FillOrigin.Bottom
  },
  "radial-90": {
    "top-left": FillOrigin90.TopLeft,
    "top-right": FillOrigin90.TopRight,
    "bottom-left": FillOrigin90.BottomLeft,
    "bottom-right": FillOrigin90.BottomRight
  },
  "radial-180": {
    top: FillOrigin.Top,
    bottom: FillOrigin.Bottom,
    left: FillOrigin.Left,
    right: FillOrigin.Right
  },
  "radial-360": {
    top: FillOrigin.Top,
    bottom: FillOrigin.Bottom,
    left: FillOrigin.Left,
    right: FillOrigin.Right
  }
};

const DEFAULT_ORIGINS: Record<
  Exclude<FairyDomFillMethod, "none">,
  FairyDomFillOrigin
> = {
  horizontal: "left",
  vertical: "top",
  "radial-90": "top-left",
  "radial-180": "top",
  "radial-360": "top"
};

export function fillMethodName(value: number | undefined): FairyDomFillMethod {
  return METHOD_NAMES[value ?? FillMethod.None] ?? "none";
}

export function fillMethodValue(method: FairyDomFillMethod): number {
  return METHOD_VALUES[method];
}

export function isRadialFillMethod(method: FairyDomFillMethod): boolean {
  return method === "radial-90"
    || method === "radial-180"
    || method === "radial-360";
}

export function allowedFillOrigins(
  method: FairyDomFillMethod
): readonly FairyDomFillOrigin[] {
  if (method === "none") return [];
  return Object.keys(ORIGIN_VALUES[method]) as FairyDomFillOrigin[];
}

export function defaultFillOrigin(
  method: FairyDomFillMethod
): FairyDomFillOrigin | undefined {
  return method === "none" ? undefined : DEFAULT_ORIGINS[method];
}

export function fillOriginName(
  method: FairyDomFillMethod,
  value: number | undefined
): FairyDomFillOrigin | undefined {
  if (method === "none") return undefined;
  const entries = Object.entries(ORIGIN_VALUES[method]) as Array<
    [FairyDomFillOrigin, number]
  >;
  return entries.find(([, candidate]) => candidate === value)?.[0]
    ?? DEFAULT_ORIGINS[method];
}

export function fillOriginValue(
  method: FairyDomFillMethod,
  origin?: FairyDomFillOrigin
): number {
  if (method === "none") return FillOrigin.Top;
  const normalized = origin ?? DEFAULT_ORIGINS[method];
  return ORIGIN_VALUES[method][normalized] ?? ORIGIN_VALUES[method][
    DEFAULT_ORIGINS[method]
  ]!;
}
