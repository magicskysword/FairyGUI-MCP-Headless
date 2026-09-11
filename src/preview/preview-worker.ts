import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ExecutorInput, PreviewFrame, PreviewRun, PreviewRunResult, PreviewState } from "../contracts/preview.js";
import { RUNTIME_PREVIEW_SCRIPT } from "./runtime-script.js";

const origin = "http://fairygui.internal";
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const diagnostics: Array<{ level: string; message: string; time: number }> = [];

async function evaluate<T>(method: string, ...args: unknown[]): Promise<T> {
  return page!.evaluate(({ method, args }) => {
    const api = (globalThis as unknown as { __fguiPreview: Record<string, (...args: unknown[]) => unknown> }).__fguiPreview;
    return api[method]!(...args);
  }, { method, args }) as Promise<T>;
}
async function inspect(options: unknown = {}): Promise<PreviewState> {
  const state = await evaluate<PreviewState>("inspect", options);
  state.logs.push(...diagnostics);
  return state;
}
async function capture(options: unknown = {}, requestedTime?: number): Promise<PreviewFrame> {
  const state = await inspect(options);
  const png = new Uint8Array(await page!.screenshot({ type: "png", omitBackground: true, animations: "allow", caret: "hide" }));
  return { ...state, requestedTime: requestedTime ?? state.time, png };
}
async function initialize(input: ExecutorInput & { executablePath: string }): Promise<PreviewState> {
  const environment = input.recipe.environment!;
  browser = await chromium.launch({ executablePath: input.executablePath, headless: true });
  context = await browser.newContext({ viewport: { width: environment.width!, height: environment.height! }, deviceScaleFactor: environment.scale!, acceptDownloads: false, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" });
  const runtime = await readFile(fileURLToPath(import.meta.resolve("@magicskysword/fairygui-dom")));
  const assets = new Map(input.runtime.artifacts.map(file => [`/assets/${encodeURIComponent(file.fileName)}`, file]));
  const resources = new Map((input.resources ?? []).map(file => [`/resources/${encodeURIComponent(file.name)}`, file]));
  let loaded = false;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET" || (request.isNavigationRequest() && loaded)) {
      if (diagnostics.length < 1000) diagnostics.push({ level: "warning", message: `Blocked resource or navigation: ${url.href}`, time: 0 });
      await route.abort("blockedbyclient"); return;
    }
    if (url.pathname === "/" && request.isNavigationRequest()) {
      loaded = true;
      await route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'self' blob: data:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'" }, body: '<!doctype html><html><head><style>html,body{margin:0;padding:0;overflow:hidden}body{position:relative}</style></head><body><script src="/runtime.js"></script><script src="/preview.js"></script></body></html>' }); return;
    }
    if (url.pathname === "/runtime.js") { await route.fulfill({ contentType: "text/javascript", body: runtime }); return; }
    if (url.pathname === "/preview.js") { await route.fulfill({ contentType: "text/javascript", body: RUNTIME_PREVIEW_SCRIPT }); return; }
    const file = assets.get(url.pathname) ?? resources.get(url.pathname);
    if (file) await route.fulfill({ contentType: file.mediaType, body: Buffer.from(file.data) });
    else { diagnostics.push({ level: "error", message: `Missing snapshot resource: ${url.pathname}`, time: 0 }); await route.fulfill({ status: 404, body: "Missing snapshot resource" }); }
  });
  await context.routeWebSocket("**/*", socket => socket.close());
  page = await context.newPage();
  page.on("dialog", dialog => { void dialog.dismiss(); });
  page.on("popup", popup => { void popup.close(); });
  page.on("download", download => { void download.cancel(); });
  page.on("pageerror", error => { if (diagnostics.length < 1000) diagnostics.push({ level: "error", message: error.message, time: 0 }); });
  await page.goto(origin, { waitUntil: "load", timeout: 15000 });
  return evaluate("initialize", { ...input, runtime: undefined, executablePath: undefined, packages: input.runtime.packages, resourceNames: (input.resources ?? []).map(file => file.name) });
}

async function run(input: PreviewRun): Promise<PreviewRunResult> {
  const frames: PreviewFrame[] = [];
  const options = { ...(input.properties ? { properties: input.properties } : {}), ...(input.selector ? { selector: input.selector } : {}) };
  try {
    await evaluate("runStart", input);
    for (const time of input.times) {
      await evaluate("advance", time, options);
      frames.push(await capture(options, time));
    }
    return { complete: true, frames, state: await inspect(options) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = await evaluate<{ code: string; message: string; path?: string; stack?: string; time?: number }>("failure", { message, stack: error instanceof Error ? error.stack : undefined });
    return { complete: false, frames, state: await inspect(options), error: failure };
  }
}
let tail = Promise.resolve();
process.on("message", (message: { id: number; action: string; data: unknown }) => {
  tail = tail.then(async () => {
    try {
      let result: unknown;
      if (message.action === "initialize") result = await initialize(message.data as ExecutorInput & { executablePath: string });
      else if (message.action === "run") result = await run(message.data as PreviewRun);
      else if (message.action === "inspect") result = await inspect(message.data);
      else if (message.action === "capture") result = await capture(message.data);
      else throw new Error("Unknown preview worker command");
      process.send?.({ id: message.id, result });
    } catch (error) { process.send?.({ id: message.id, error: { code: "PREVIEW_EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) } }); }
  });
});
process.on("disconnect", () => { void browser?.close().finally(() => process.exit(0)); });
