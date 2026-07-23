export const FAIRY_DOM_SELECTOR_TYPES = [
  "component-root",
  "image",
  "text",
  "rich-text",
  "input-text",
  "loader",
  "graph",
  "movie-clip",
  "group",
  "list",
  "instance"
] as const;

export type FairyDomSelectorType = typeof FAIRY_DOM_SELECTOR_TYPES[number];
export type FairyDomSelectorCombinator = "descendant" | "child";

export interface FairyDomSelectorCompound {
  type?: FairyDomSelectorType;
  id?: string;
  name?: string;
}

export interface FairyDomSelectorStep {
  combinator: FairyDomSelectorCombinator | null;
  compound: FairyDomSelectorCompound;
}

export interface ParsedFairyDomSelector {
  source: string;
  steps: FairyDomSelectorStep[];
}

export interface FairyDomSelectorNode {
  type: string;
  id: string;
  name: string;
  children?: readonly FairyDomSelectorNode[];
}

export interface FairyDomSelectorMatchOptions {
  crossInstanceBoundaries?: boolean;
}

const SELECTOR_TYPE_SET = new Set<string>(FAIRY_DOM_SELECTOR_TYPES);
const TYPE_START = /[a-z]/;
const TYPE_PART = /[a-z0-9-]/;
const ID_PART = /[A-Za-z0-9_.-]/;

export class SelectorSyntaxError extends Error {
  public readonly code = "INVALID_SELECTOR";
  public readonly selector: string;
  public readonly index: number;
  public readonly suggestedFix =
    "仅使用类型、#id、[name=\"...\"]、后代空格和 > 子级组合器";

  public constructor(selector: string, index: number, detail: string) {
    super(`选择器在字符 ${index} 处无效：${detail}`);
    this.name = "SelectorSyntaxError";
    this.selector = selector;
    this.index = index;
  }
}

function syntaxError(selector: string, index: number, detail: string): never {
  throw new SelectorSyntaxError(selector, index, detail);
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/.test(value);
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (isWhitespace(source[index])) index++;
  return index;
}

function parseType(
  source: string,
  start: number
): { value: FairyDomSelectorType; next: number } | undefined {
  if (!TYPE_START.test(source[start] ?? "")) return undefined;
  let next = start + 1;
  while (TYPE_PART.test(source[next] ?? "")) next++;
  const value = source.slice(start, next);
  if (!SELECTOR_TYPE_SET.has(value)) {
    syntaxError(source, start, `不支持类型选择器 ${JSON.stringify(value)}`);
  }
  return { value: value as FairyDomSelectorType, next };
}

function parseId(
  source: string,
  start: number
): { value: string; next: number } {
  let next = start;
  while (ID_PART.test(source[next] ?? "")) next++;
  if (next === start) syntaxError(source, start, "# 后缺少合法 ID");
  return { value: source.slice(start, next), next };
}

function parseNameAttribute(
  source: string,
  start: number
): { value: string; next: number } {
  const prefix = "[name=\"";
  if (!source.startsWith(prefix, start)) {
    syntaxError(source, start, "仅支持双引号形式的 [name=\"...\"] 属性选择器");
  }

  let index = start + prefix.length;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped !== "\\" && escaped !== "\"") {
        syntaxError(source, index, "name 仅支持转义反斜杠和双引号");
      }
      value += escaped;
      index += 2;
      continue;
    }
    if (char === "\"") {
      if (source[index + 1] !== "]") {
        syntaxError(source, index + 1, "name 结束引号后必须紧跟 ]");
      }
      return { value, next: index + 2 };
    }
    value += char;
    index++;
  }

  syntaxError(source, start, "name 属性选择器未闭合");
}

function parseCompound(
  source: string,
  start: number
): { compound: FairyDomSelectorCompound; next: number } {
  let index = start;
  const compound: FairyDomSelectorCompound = {};
  const type = parseType(source, index);
  if (type) {
    compound.type = type.value;
    index = type.next;
  }

  while (index < source.length) {
    if (source[index] === "#") {
      if (compound.id !== undefined) {
        syntaxError(source, index, "同一复合选择器不能重复声明 #id");
      }
      const parsed = parseId(source, index + 1);
      compound.id = parsed.value;
      index = parsed.next;
      continue;
    }
    if (source[index] === "[") {
      if (compound.name !== undefined) {
        syntaxError(source, index, "同一复合选择器不能重复声明 name");
      }
      const parsed = parseNameAttribute(source, index);
      compound.name = parsed.value;
      index = parsed.next;
      continue;
    }
    break;
  }

  if (
    compound.type === undefined
    && compound.id === undefined
    && compound.name === undefined
  ) {
    syntaxError(source, start, "缺少类型、#id 或 [name=\"...\"]");
  }
  return { compound, next: index };
}

export function parseFairyDomSelector(source: string): ParsedFairyDomSelector {
  if (typeof source !== "string") {
    throw new SelectorSyntaxError(String(source), 0, "选择器必须是字符串");
  }

  let index = skipWhitespace(source, 0);
  if (index === source.length) syntaxError(source, index, "选择器不能为空");

  const steps: FairyDomSelectorStep[] = [];
  let combinator: FairyDomSelectorCombinator | null = null;

  while (index < source.length) {
    const parsed = parseCompound(source, index);
    steps.push({ combinator, compound: parsed.compound });
    index = parsed.next;

    const beforeWhitespace = index;
    index = skipWhitespace(source, index);
    const hadWhitespace = index > beforeWhitespace;
    if (index === source.length) break;

    if (source[index] === ">") {
      combinator = "child";
      index = skipWhitespace(source, index + 1);
      if (index === source.length) {
        syntaxError(source, index, "> 后缺少选择器");
      }
      continue;
    }

    if (hadWhitespace) {
      combinator = "descendant";
      continue;
    }

    syntaxError(source, index, `不支持字符 ${JSON.stringify(source[index])}`);
  }

  return { source, steps };
}

interface SelectorEntry {
  node: FairyDomSelectorNode;
  parent: SelectorEntry | undefined;
}

function matchesCompound(
  node: FairyDomSelectorNode,
  compound: FairyDomSelectorCompound
): boolean {
  if (compound.type !== undefined && node.type !== compound.type) return false;
  if (compound.id !== undefined && node.id !== compound.id) return false;
  if (compound.name !== undefined && node.name !== compound.name) return false;
  return true;
}

function matchesStep(
  entry: SelectorEntry,
  steps: readonly FairyDomSelectorStep[],
  stepIndex: number
): boolean {
  const step = steps[stepIndex];
  if (!step || !matchesCompound(entry.node, step.compound)) return false;
  if (stepIndex === 0) return true;

  if (step.combinator === "child") {
    return entry.parent !== undefined
      && matchesStep(entry.parent, steps, stepIndex - 1);
  }

  if (step.combinator === "descendant") {
    let ancestor = entry.parent;
    while (ancestor) {
      if (matchesStep(ancestor, steps, stepIndex - 1)) return true;
      ancestor = ancestor.parent;
    }
  }
  return false;
}

export function matchFairyDomSelector(
  root: FairyDomSelectorNode,
  selector: string | ParsedFairyDomSelector,
  options: FairyDomSelectorMatchOptions = {}
): FairyDomSelectorNode[] {
  const parsed = typeof selector === "string"
    ? parseFairyDomSelector(selector)
    : selector;
  const entries: SelectorEntry[] = [];

  const visit = (
    node: FairyDomSelectorNode,
    parent: SelectorEntry | undefined
  ): void => {
    const entry: SelectorEntry = { node, parent };
    entries.push(entry);
    if (node.type === "instance" && !options.crossInstanceBoundaries) return;
    for (const child of node.children ?? []) visit(child, entry);
  };
  visit(root, undefined);

  const lastStep = parsed.steps.length - 1;
  return entries
    .filter((entry) => matchesStep(entry, parsed.steps, lastStep))
    .map((entry) => entry.node);
}

