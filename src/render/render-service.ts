import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Route
} from "playwright";
import type { FairyDomDocument, FairyDomNode } from "../contracts/dom.js";
import type { RenderComponentData } from "../contracts/render.js";
import {
  fail,
  ok,
  type Diagnostic,
  type ResultEnvelope
} from "../contracts/result.js";
import type {
  RenderComponentInput,
  RenderTransientState
} from "../contracts/tools.js";
import {
  DomProjectionError,
  toFairyDomDocument
} from "../dom/openfairygui-adapter.js";
import {
  parseFairyDomSelector,
  SelectorSyntaxError,
  type ParsedFairyDomSelector
} from "../dom/selector.js";
import type { ProjectRegistry } from "../project/project-registry.js";
import { PACKAGE_VERSION } from "../version.js";
import {
  PREVIEW_HTML,
  PREVIEW_ORIGIN,
  PREVIEW_SCRIPT
} from "./preview-runtime.js";
import {
  compileRuntimeArtifacts,
  type CompiledRuntimeArtifacts
} from "./runtime-compiler.js";

const MAX_RENDER_DIMENSION = 4096;
const DEFAULT_RENDER_DIMENSION = 1;
const RENDER_TIMEOUT_MS = 15_000;
const RUNTIME_PATH = fileURLToPath(
  import.meta.resolve("@magicskysword/fairygui-dom")
);

export interface RenderBrowserType {
  executablePath(): string;
  launch(options?: LaunchOptions): Promise<Browser>;
}

export interface RenderServiceOptions {
  browserType?: RenderBrowserType;
  runtimeScriptPath?: string;
  temporaryRoot?: string;
}

interface PreviewState {
  status: "loading" | "ready" | "failed";
  details?: {
    message?: string;
    stack?: string;
    failure?: PreviewStateFailure;
    bounds?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
}

interface PreviewStateFailure {
  code: "SELECTOR_MATCH_COUNT" | "TRANSIENT_STATE_INVALID";
  message: string;
  path?: string;
  actual?: unknown;
  allowed?: unknown;
  suggestedFix?: string;
}

interface PreviewControllerState {
  selector: ParsedFairyDomSelector;
  expectedMatches: number;
  controller: string;
  selection:
    | { kind: "index"; value: number }
    | { kind: "pageId"; value: string }
    | { kind: "pageName"; value: string };
}

interface PreviewScrollState {
  selector: ParsedFairyDomSelector;
  expectedMatches: number;
  x?: number;
  y?: number;
}

interface PreviewListState {
  selector: ParsedFairyDomSelector;
  expectedMatches: number;
  selection: {
    kind: "index" | "indices";
    indices: number[];
  };
}

interface PreviewTreeState {
  selector: ParsedFairyDomSelector;
  expectedMatches: number;
  expansions: Array<{
    nodePath: number[];
    expanded: boolean;
  }>;
  selectedPath?: number[] | null;
}

interface PreviewTransientState {
  controllers: PreviewControllerState[];
  scrolls: PreviewScrollState[];
  lists: PreviewListState[];
  trees: PreviewTreeState[];
}

interface PreviewPayload {
  packages: Array<{
    packageId: string;
    packageName: string;
    url: string;
  }>;
  packageId: string;
  componentId: string;
  viewport: {
    width: number;
    height: number;
  };
  background?: string;
  state?: PreviewTransientState;
}

interface PreparedRender {
  dom: FairyDomDocument;
  runtime: CompiledRuntimeArtifacts;
}

interface RuntimeCompilationCacheEntry {
  generation: number;
  compilation: Promise<CompiledRuntimeArtifacts>;
}

function projectionFailure(error: DomProjectionError): ResultEnvelope<never> {
  return fail(error.code, error.message, {
    path: `${error.packageId}/${error.componentId}`,
    actual: {
      packageId: error.packageId,
      componentId: error.componentId
    }
  });
}

function dimension(
  requested: number | undefined,
  componentValue: number | undefined
): number {
  const value = requested ?? componentValue ?? DEFAULT_RENDER_DIMENSION;
  return Math.max(
    DEFAULT_RENDER_DIMENSION,
    Math.min(MAX_RENDER_DIMENSION, Math.ceil(value))
  );
}

function externalResourceDiagnostics(
  nodes: FairyDomNode[]
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    if (
      (node.type === "loader" || node.type === "loader3d")
      && node.content.externalUrl
    ) {
      diagnostics.push({
        severity: "warning",
        code: "EXTERNAL_RESOURCE_BLOCKED",
        message: "结构预览不会请求外部网络资源，已用占位结构表示",
        path: `#${node.id}`,
        details: { url: node.content.externalUrl }
      });
    }
  }
  return diagnostics;
}

function isBrowserMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /executable.*(?:doesn't exist|not found)|playwright install/i.test(message);
}

function prepareTransientState(
  state: RenderTransientState | undefined
): ResultEnvelope<PreviewTransientState | undefined> {
  if (state === undefined) return ok(undefined);
  const controllers: PreviewControllerState[] = [];
  for (const [index, entry] of (state.controllers ?? []).entries()) {
    try {
      controllers.push({
        selector: parseFairyDomSelector(entry.selector),
        expectedMatches: entry.expectedMatches,
        controller: entry.controller,
        selection: "selectedIndex" in entry
          ? { kind: "index", value: entry.selectedIndex }
          : "pageId" in entry
            ? { kind: "pageId", value: entry.pageId }
            : { kind: "pageName", value: entry.pageName }
      });
    }
    catch (error) {
      if (error instanceof SelectorSyntaxError) {
        return fail("INVALID_SELECTOR", error.message, {
          path: `state.controllers[${index}].selector[${error.index}]`,
          actual: error.selector,
          suggestedFix: error.suggestedFix
        });
      }
      throw error;
    }
  }

  const scrolls: PreviewScrollState[] = [];
  for (const [index, entry] of (state.scrolls ?? []).entries()) {
    try {
      scrolls.push({
        selector: parseFairyDomSelector(entry.selector),
        expectedMatches: entry.expectedMatches,
        ...("x" in entry ? { x: entry.x } : {}),
        ...("y" in entry ? { y: entry.y } : {})
      });
    }
    catch (error) {
      if (error instanceof SelectorSyntaxError) {
        return fail("INVALID_SELECTOR", error.message, {
          path: `state.scrolls[${index}].selector[${error.index}]`,
          actual: error.selector,
          suggestedFix: error.suggestedFix
        });
      }
      throw error;
    }
  }

  const lists: PreviewListState[] = [];
  for (const [index, entry] of (state.lists ?? []).entries()) {
    try {
      lists.push({
        selector: parseFairyDomSelector(entry.selector),
        expectedMatches: entry.expectedMatches,
        selection: "selectedIndex" in entry
          ? {
              kind: "index",
              indices: entry.selectedIndex === -1 ? [] : [entry.selectedIndex]
            }
          : { kind: "indices", indices: entry.selectedIndices }
      });
    }
    catch (error) {
      if (error instanceof SelectorSyntaxError) {
        return fail("INVALID_SELECTOR", error.message, {
          path: `state.lists[${index}].selector[${error.index}]`,
          actual: error.selector,
          suggestedFix: error.suggestedFix
        });
      }
      throw error;
    }
  }

  const trees: PreviewTreeState[] = [];
  for (const [index, entry] of (state.trees ?? []).entries()) {
    try {
      trees.push({
        selector: parseFairyDomSelector(entry.selector),
        expectedMatches: entry.expectedMatches,
        expansions: entry.expansions ?? [],
        ...(entry.selectedPath !== undefined
          ? { selectedPath: entry.selectedPath }
          : {})
      });
    }
    catch (error) {
      if (error instanceof SelectorSyntaxError) {
        return fail("INVALID_SELECTOR", error.message, {
          path: `state.trees[${index}].selector[${error.index}]`,
          actual: error.selector,
          suggestedFix: error.suggestedFix
        });
      }
      throw error;
    }
  }

  return ok({ controllers, scrolls, lists, trees });
}

export class RenderService {
  private readonly projects: ProjectRegistry;
  private readonly browserType: RenderBrowserType;
  private readonly runtimeScriptPath: string;
  private readonly temporaryRoot: string;
  private browser: Browser | undefined;
  private browserLaunch: Promise<Browser> | undefined;
  private runtimeScript: Promise<string> | undefined;
  private readonly runtimeCompilations = new Map<
    string,
    RuntimeCompilationCacheEntry
  >();

  public constructor(
    projects: ProjectRegistry,
    options: RenderServiceOptions = {}
  ) {
    this.projects = projects;
    this.browserType = options.browserType ?? chromium;
    this.runtimeScriptPath = options.runtimeScriptPath ?? RUNTIME_PATH;
    this.temporaryRoot = options.temporaryRoot
      ?? path.join(os.tmpdir(), "fairygui-mcp-headless", "renders");
  }

  public async render(
    input: RenderComponentInput
  ): Promise<ResultEnvelope<RenderComponentData>> {
    const preparedState = prepareTransientState(input.state);
    if (!preparedState.ok) return preparedState;

    const prepared = await this.projects.read(input.projectId, async (document) => {
      try {
        const dom = toFairyDomDocument(
          document,
          input.packageId,
          input.componentId
        );
        const summary = this.projects.status(input.projectId);
        if (!summary.ok) return summary;
        try {
          const runtime = await this.getRuntimeCompilation(
            input.projectId,
            summary.data.generation,
            summary.data.projectFile,
            summary.data.projectDirectory
          );
          return ok<PreparedRender>({ dom, runtime });
        }
        catch (error) {
          return fail(
            "RUNTIME_COMPILE_FAILED",
            "无法从未发布工程编译 FairyGUI runtime 预览数据",
            {
              path: summary.data.projectFile,
              actual: error instanceof Error ? error.message : String(error),
              suggestedFix: "检查源资源、包引用和运行时二进制诊断后重试"
            }
          );
        }
      }
      catch (error) {
        if (error instanceof DomProjectionError) {
          return projectionFailure(error);
        }
        throw error;
      }
    });
    if (!prepared.ok) return prepared;
    if (!prepared.data.ok) return prepared.data;

    const { dom, runtime } = prepared.data.data;
    const width = dimension(input.width, dom.root.style.width);
    const height = dimension(input.height, dom.root.style.height);
    const diagnostics = externalResourceDiagnostics(dom.root.children);
    if (
      input.width === undefined
      && (dom.root.style.width ?? 0) > MAX_RENDER_DIMENSION
      || input.height === undefined
      && (dom.root.style.height ?? 0) > MAX_RENDER_DIMENSION
    ) {
      diagnostics.push({
        severity: "warning",
        code: "RENDER_SIZE_CLAMPED",
        message: `组件预览尺寸已限制在 ${MAX_RENDER_DIMENSION}px 以内`
      });
    }

    const browserResult = await this.getBrowser();
    if (!browserResult.ok) return browserResult;

    let context: BrowserContext | undefined;
    try {
      const background = input.background ?? dom.root.content.backgroundColor;
      const payload: PreviewPayload = {
        packages: runtime.packages.map((pkg) => ({
          packageId: pkg.packageId,
          packageName: pkg.packageName,
          url: `/packages/${encodeURIComponent(pkg.fileName)}`
        })),
        packageId: input.packageId,
        componentId: input.componentId,
        viewport: { width, height },
        ...(background === undefined ? {} : { background }),
        ...(preparedState.data === undefined
          ? {}
          : { state: preparedState.data })
      };
      const runtimeScript = await this.loadRuntimeScript();
      context = await browserResult.data.newContext({
        viewport: { width, height },
        deviceScaleFactor: input.scale,
        serviceWorkers: "block",
        colorScheme: "light"
      });
      await this.installRoutes(context, runtimeScript, payload, runtime);
      const page = await context.newPage();
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.goto(`${PREVIEW_ORIGIN}/preview.html`, {
        waitUntil: "load",
        timeout: RENDER_TIMEOUT_MS
      });
      await page.waitForFunction(() => {
        const state = (globalThis as {
          __fairyguiPreview?: PreviewState;
        }).__fairyguiPreview;
        return state?.status === "ready" || state?.status === "failed";
      });
      const previewState = await page.evaluate(() =>
        (globalThis as unknown as { __fairyguiPreview: PreviewState })
          .__fairyguiPreview
      );
      if (previewState.status !== "ready") {
        const stateFailure = previewState.details?.failure;
        if (stateFailure) {
          return fail(stateFailure.code, stateFailure.message, {
            ...(stateFailure.path === undefined
              ? {}
              : { path: stateFailure.path }),
            ...(stateFailure.actual === undefined
              ? {}
              : { actual: stateFailure.actual }),
            ...(stateFailure.allowed === undefined
              ? {}
              : { allowed: stateFailure.allowed }),
            ...(stateFailure.suggestedFix === undefined
              ? {}
              : { suggestedFix: stateFailure.suggestedFix })
          });
        }
        return fail("RENDER_FAILED", "FairyGUI-dom runtime 预览运行失败", {
          actual: previewState.details
        });
      }

      const root = page.locator('[data-fairy-component-root="true"]');
      const bounds = await root.boundingBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return fail("RENDER_FAILED", "FairyGUI-dom runtime 未生成可截图的组件边界", {
          actual: bounds
        });
      }
      const png = await root.screenshot({
        type: "png",
        timeout: RENDER_TIMEOUT_MS
      });
      let filePath: string | undefined;
      if (input.saveToFile) {
        await mkdir(this.temporaryRoot, { recursive: true });
        filePath = path.join(this.temporaryRoot, `${randomUUID()}.png`);
        await writeFile(filePath, png);
      }

      return ok({
        backend: "fairygui-dom",
        fidelity: "runtime-preview",
        rendererVersion: PACKAGE_VERSION,
        packageId: input.packageId,
        componentId: input.componentId,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        },
        diagnostics,
        image: {
          mediaType: "image/png",
          data: png.toString("base64"),
          width: Math.round(bounds.width * input.scale),
          height: Math.round(bounds.height * input.scale),
          ...(filePath === undefined ? {} : { filePath })
        }
      });
    }
    catch (error) {
      if (isBrowserMissingError(error)) return this.browserMissing(error);
      return fail("RENDER_FAILED", "FairyGUI-dom runtime 预览失败", {
        actual: error instanceof Error ? error.message : String(error),
        suggestedFix: "检查运行时包、资源和组件渲染诊断后重试"
      });
    }
    finally {
      await context?.close().catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    const pending = this.browserLaunch;
    this.browserLaunch = undefined;
    const browser = this.browser ?? await pending?.catch(() => undefined);
    this.browser = undefined;
    this.runtimeCompilations.clear();
    await browser?.close().catch(() => undefined);
  }

  private getRuntimeCompilation(
    projectId: string,
    generation: number,
    projectFile: string,
    projectDirectory: string
  ): Promise<CompiledRuntimeArtifacts> {
    const cached = this.runtimeCompilations.get(projectId);
    if (cached?.generation === generation) return cached.compilation;

    const compilation = compileRuntimeArtifacts(
      projectFile,
      projectDirectory
    );
    const entry = { generation, compilation };
    this.runtimeCompilations.set(projectId, entry);
    void compilation.catch(() => {
      if (this.runtimeCompilations.get(projectId) === entry) {
        this.runtimeCompilations.delete(projectId);
      }
    });
    return compilation;
  }

  private async getBrowser(): Promise<ResultEnvelope<Browser>> {
    if (this.browser?.isConnected()) return ok(this.browser);
    if (this.browserLaunch) {
      try {
        return ok(await this.browserLaunch);
      }
      catch (error) {
        return isBrowserMissingError(error)
          ? this.browserMissing(error)
          : fail("RENDER_FAILED", "无法启动 Playwright Chromium", {
            actual: error instanceof Error ? error.message : String(error)
          });
      }
    }

    let executablePath: string;
    try {
      executablePath = this.browserType.executablePath();
      await access(executablePath);
    }
    catch (error) {
      return this.browserMissing(error);
    }

    this.browserLaunch = this.browserType.launch({ headless: true });
    try {
      const browser = await this.browserLaunch;
      this.browser = browser;
      this.browserLaunch = undefined;
      browser.once("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return ok(browser);
    }
    catch (error) {
      this.browserLaunch = undefined;
      return isBrowserMissingError(error)
        ? this.browserMissing(error)
        : fail("RENDER_FAILED", "无法启动 Playwright Chromium", {
          path: executablePath,
          actual: error instanceof Error ? error.message : String(error)
        });
    }
  }

  private browserMissing(error: unknown): ResultEnvelope<never> {
    return fail("BROWSER_NOT_INSTALLED", "未找到 Playwright Chromium", {
      actual: error instanceof Error ? error.message : String(error),
      suggestedFix: "在 MCP 包目录执行：pnpm exec playwright install chromium"
    });
  }

  private loadRuntimeScript(): Promise<string> {
    this.runtimeScript ??= readFile(this.runtimeScriptPath, "utf8");
    return this.runtimeScript;
  }

  private async installRoutes(
    context: BrowserContext,
    runtimeScript: string,
    payload: PreviewPayload,
    runtime: CompiledRuntimeArtifacts
  ): Promise<void> {
    const artifacts = new Map(
      runtime.artifacts.map((artifact) => [artifact.fileName, artifact] as const)
    );
    await context.route("**/*", async (route: Route) => {
      const requestUrl = route.request().url();
      let url: URL;
      try {
        url = new URL(requestUrl);
      }
      catch {
        await route.abort("blockedbyclient");
        return;
      }
      if (url.origin !== PREVIEW_ORIGIN) {
        await route.abort("blockedbyclient");
        return;
      }

      switch (url.pathname) {
        case "/preview.html":
          await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: PREVIEW_HTML
          });
          return;
        case "/runtime.js":
          await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: runtimeScript
          });
          return;
        case "/preview.js":
          await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: PREVIEW_SCRIPT
          });
          return;
        case "/payload.json":
          await route.fulfill({
            status: 200,
            contentType: "application/json; charset=utf-8",
            body: JSON.stringify(payload)
          });
          return;
        default:
          if (
            url.pathname.startsWith("/packages/")
            || url.pathname.startsWith("/assets/")
          ) {
            let fileName: string;
            try {
              fileName = decodeURIComponent(
                url.pathname.slice(url.pathname.lastIndexOf("/") + 1)
              );
            }
            catch {
              await route.fulfill({ status: 400, body: "Invalid artifact path" });
              return;
            }
            const artifact = artifacts.get(fileName);
            if (artifact) {
              await route.fulfill({
                status: 200,
                contentType: artifact.mediaType,
                body: Buffer.from(
                  artifact.data.buffer,
                  artifact.data.byteOffset,
                  artifact.data.byteLength
                )
              });
              return;
            }
          }
          await route.fulfill({ status: 404, body: "Not found" });
      }
    });
  }
}
