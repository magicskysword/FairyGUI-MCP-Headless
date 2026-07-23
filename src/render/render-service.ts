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
import type { RenderComponentInput } from "../contracts/tools.js";
import {
  DomProjectionError,
  toFairyDomDocument
} from "../dom/openfairygui-adapter.js";
import type { ProjectRegistry } from "../project/project-registry.js";
import { PACKAGE_VERSION } from "../version.js";
import {
  PREVIEW_HTML,
  PREVIEW_ORIGIN,
  PREVIEW_SCRIPT
} from "./preview-runtime.js";

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
    bounds?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
}

interface PreviewPayload {
  dom: FairyDomDocument;
  viewport: {
    width: number;
    height: number;
  };
  background?: string;
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

export class RenderService {
  private readonly projects: ProjectRegistry;
  private readonly browserType: RenderBrowserType;
  private readonly runtimeScriptPath: string;
  private readonly temporaryRoot: string;
  private browser: Browser | undefined;
  private browserLaunch: Promise<Browser> | undefined;
  private runtimeScript: Promise<string> | undefined;

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
    const projected = await this.projects.read(input.projectId, (document) => {
      try {
        return ok(toFairyDomDocument(
          document,
          input.packageId,
          input.componentId
        ));
      }
      catch (error) {
        if (error instanceof DomProjectionError) {
          return projectionFailure(error);
        }
        throw error;
      }
    });
    if (!projected.ok) return projected;
    if (!projected.data.ok) return projected.data;

    const dom = projected.data.data;
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
      const payload: PreviewPayload = {
        dom,
        viewport: { width, height },
        ...(input.background === undefined
          ? {}
          : { background: input.background })
      };
      const runtimeScript = await this.loadRuntimeScript();
      context = await browserResult.data.newContext({
        viewport: { width, height },
        deviceScaleFactor: input.scale,
        serviceWorkers: "block",
        colorScheme: "light"
      });
      await this.installRoutes(context, runtimeScript, payload);
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
        return fail("RENDER_FAILED", "FairyGUI-dom 结构预览运行失败", {
          actual: previewState.details
        });
      }

      const root = page.locator('[data-fairy-component-root="true"]');
      const bounds = await root.boundingBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return fail("RENDER_FAILED", "FairyGUI-dom 未生成可截图的组件边界", {
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
        fidelity: "structural-preview",
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
      return fail("RENDER_FAILED", "FairyGUI-dom 结构预览失败", {
        actual: error instanceof Error ? error.message : String(error),
        suggestedFix: "检查组件 DOM 与渲染诊断后重试"
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
    await browser?.close().catch(() => undefined);
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
    payload: PreviewPayload
  ): Promise<void> {
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
          await route.fulfill({ status: 404, body: "Not found" });
      }
    });
  }
}
