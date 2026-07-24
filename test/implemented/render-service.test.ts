import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type LaunchOptions
} from "playwright";
import sharp from "sharp";
import { RenderComponentInputSchema } from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import {
  RenderService,
  type RenderBrowserType
} from "../../src/render/render-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="320,180" overflow="hidden" bgColor="#102030">
  <displayList>
    <graph id="n0" name="panel" xy="8,8" size="304,164" type="rect"
      fillColor="#335577" lineColor="#88aacc" lineSize="2"/>
    <text id="n1" name="title" xy="20,20" size="240,48"
      text="Hello FairyGUI" fontSize="24" color="#ffffff"/>
    <loader id="n2" name="remote" xy="20,80" size="100,40"
      url="https://example.invalid/blocked.png"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function createRuntimeInstanceProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-runtime-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="runtime-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="card1" name="Card.xml" path="/"/>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Card.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,60">
  <displayList>
    <graph id="n0" name="fill" xy="0,0" size="100,60" type="rect"
      fillColor="#e11d48" lineColor="#e11d48" lineSize="0"/>
  </displayList>
</component>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="120,80">
  <displayList>
    <component id="n0" name="card" src="card1" fileName="Card.xml"
      xy="10,10" size="100,60"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function createControllerStateProject(): Promise<{
  directory: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-state-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="state-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="120,80">
  <controller name="mode" pages="red,Red,blue,Blue" selected="0"/>
  <displayList>
    <graph id="redPanel" name="redPanel" xy="0,0" size="120,80"
      type="rect" fillColor="#e11d48" lineColor="#e11d48" lineSize="0">
      <gearDisplay controller="mode" pages="red"/>
    </graph>
    <graph id="bluePanel" name="bluePanel" xy="0,0" size="120,80"
      type="rect" fillColor="#2563eb" lineColor="#2563eb" lineSize="0">
      <gearDisplay controller="mode" pages="blue"/>
    </graph>
  </displayList>
</component>`,
    "utf8"
  );
  return { directory, componentFile };
}

async function createRichTextColorProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-richtext-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="richtext-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="320,80" bgColorEnabled="true" bgColor="#383838">
  <displayList>
    <richtext id="link" name="link" xy="8,8" size="304,64"
      fontSize="40" color="#68baba" ubb="true" autoSize="none"
      text="[url=open]████████[/url]"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function createAutoSizeRelationProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-text-relation-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="text-relation-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Main.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="360,48" bgColorEnabled="true" bgColor="#383838">
  <displayList>
    <richtext id="title" name="title" xy="10,8" size="166,24"
      fontSize="16" color="#68baba" ubb="true" singleLine="true"
      text="[url=open]FairyGUI-Unity-Demo[/url]"/>
    <text id="path" name="path" xy="185,10" size="160,20"
      fontSize="13" color="#ffcc00" autoSize="none" text="PATH">
      <relation target="title" sidePair="leftext-right"/>
    </text>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function createScrollStateProject(): Promise<{
  directory: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-scroll-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="scroll-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,80" overflow="scroll" scroll="vertical"
  scrollBar="hidden">
  <displayList>
    <graph id="red" name="red" xy="0,0" size="100,80"
      type="rect" fillColor="#e11d48" lineColor="#e11d48" lineSize="0"/>
    <graph id="blue" name="blue" xy="0,80" size="100,80"
      type="rect" fillColor="#2563eb" lineColor="#2563eb" lineSize="0"/>
  </displayList>
</component>`,
    "utf8"
  );
  return { directory, componentFile };
}

async function openRenderer(options: {
  browserType?: RenderBrowserType;
} = {}): Promise<{
  registry: ProjectRegistry;
  renderer: RenderService;
  projectId: string;
}> {
  const directory = await createProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  return {
    registry,
    renderer: new RenderService(registry, options),
    projectId: opened.data.projectId
  };
}

test("render_component returns a FairyGUI-dom runtime PNG preview", async () => {
  const { registry, renderer, projectId } = await openRenderer();
  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.backend, "fairygui-dom");
    assert.equal(result.data.fidelity, "runtime-preview");
    assert.equal(result.data.packageId, "pkg00001");
    assert.equal(result.data.componentId, "cmp01");
    assert.deepEqual(result.data.bounds, {
      x: 0,
      y: 0,
      width: 320,
      height: 180
    });
    assert.equal(result.data.image.mediaType, "image/png");
    assert.equal(result.data.image.width, 320);
    assert.equal(result.data.image.height, 180);
    assert.equal(result.data.image.filePath, undefined);
    assert.equal(
      Buffer.from(result.data.image.data, "base64")
        .subarray(0, 8)
        .toString("hex"),
      "89504e470d0a1a0a"
    );
    assert.ok(
      result.data.diagnostics.some((diagnostic) =>
        diagnostic.code === "EXTERNAL_RESOURCE_BLOCKED"
      )
    );
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component resolves nested component instances through the runtime package", async () => {
  const directory = await createRuntimeInstanceProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const png = Buffer.from(result.data.image.data, "base64");
    const decoded = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sampleX = 60;
    const sampleY = 40;
    const offset = (sampleY * decoded.info.width + sampleX)
      * decoded.info.channels;
    const red = decoded.data[offset] ?? 0;
    const green = decoded.data[offset + 1] ?? 0;
    const blue = decoded.data[offset + 2] ?? 0;

    assert.ok(
      red > 190 && green < 70 && blue < 110,
      `嵌套组件中心像素应为红色，实际为 rgb(${red}, ${green}, ${blue})`
    );
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component preserves a rich-text field color inside default UBB links", async () => {
  const directory = await createRichTextColorProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(result.data.image.data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sourceColorPixels = 0;
    let browserBluePixels = 0;
    for (
      let offset = 0;
      offset < decoded.data.length;
      offset += decoded.info.channels
    ) {
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (red === 104 && green === 186 && blue === 186) {
        sourceColorPixels++;
      }
      if (red === 58 && green === 103 && blue === 204) {
        browserBluePixels++;
      }
    }
    assert.ok(sourceColorPixels > 100, `源文本色像素过少：${sourceColorPixels}`);
    assert.equal(browserBluePixels, 0);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component initializes text measurement before applying auto-size relations", async () => {
  const directory = await createAutoSizeRelationProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(result.data.image.data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let pathPixels = 0;
    let misplacedPathPixels = 0;
    for (let y = 0; y < decoded.info.height; y++) {
      for (let x = 0; x < decoded.info.width; x++) {
        const offset = (y * decoded.info.width + x) * decoded.info.channels;
        const red = decoded.data[offset] ?? 0;
        const green = decoded.data[offset + 1] ?? 0;
        const blue = decoded.data[offset + 2] ?? 0;
        if (red > 200 && green > 150 && blue < 80) {
          pathPixels++;
          if (x < 150) misplacedPathPixels++;
        }
      }
    }
    assert.ok(pathPixels > 5, `未找到路径文本像素：${pathPixels}`);
    assert.equal(misplacedPathPixels, 0);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component applies controller state in memory without writing the project", async () => {
  const { directory, componentFile } = await createControllerStateProject();
  const before = await readFile(componentFile);
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "component-root",
          expectedMatches: 1,
          controller: "mode",
          selectedIndex: 1
        }]
      }
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(result.data.image.data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (40 * decoded.info.width + 60) * decoded.info.channels;
    const red = decoded.data[offset] ?? 0;
    const green = decoded.data[offset + 1] ?? 0;
    const blue = decoded.data[offset + 2] ?? 0;
    assert.ok(
      red < 80 && green > 70 && blue > 180,
      `临时控制器状态应显示蓝色，实际为 rgb(${red}, ${green}, ${blue})`
    );
    assert.deepEqual(await readFile(componentFile), before);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component rejects invalid transient controller targets and pages clearly", async () => {
  const { directory } = await createControllerStateProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const mismatch = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "#missing",
          expectedMatches: 1,
          controller: "mode",
          selectedIndex: 1
        }]
      }
    }));
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.error.code, "SELECTOR_MATCH_COUNT");
      assert.deepEqual(mismatch.error.actual, {
        selector: "#missing",
        expectedMatches: 1,
        actualMatches: 0
      });
    }

    const invalidPage = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "component-root",
          expectedMatches: 1,
          controller: "mode",
          selectedIndex: 9
        }]
      }
    }));
    assert.equal(invalidPage.ok, false);
    if (!invalidPage.ok) {
      assert.equal(invalidPage.error.code, "TRANSIENT_STATE_INVALID");
      assert.deepEqual(invalidPage.error.allowed, {
        indices: [0, 1],
        pageIds: ["red", "blue"],
        pageNames: ["Red", "Blue"]
      });
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component applies a validated transient scroll position without writing the project", async () => {
  const { directory, componentFile } = await createScrollStateProject();
  const before = await readFile(componentFile);
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "component-root",
          expectedMatches: 1,
          y: 80
        }]
      }
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(result.data.image.data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (40 * decoded.info.width + 50) * decoded.info.channels;
    const red = decoded.data[offset] ?? 0;
    const green = decoded.data[offset + 1] ?? 0;
    const blue = decoded.data[offset + 2] ?? 0;
    assert.ok(
      red < 80 && green > 70 && blue > 180,
      `临时滚动位置应显示蓝色，实际为 rgb(${red}, ${green}, ${blue})`
    );
    assert.deepEqual(await readFile(componentFile), before);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component rejects an unavailable or out-of-range transient scroll", async () => {
  const { directory } = await createScrollStateProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const unavailable = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "#red",
          expectedMatches: 1,
          y: 1
        }]
      }
    }));
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(unavailable.error.path, "state.scrolls[0].selector");
    }

    const outOfRange = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "component-root",
          expectedMatches: 1,
          y: 81
        }]
      }
    }));
    assert.equal(outOfRange.ok, false);
    if (!outOfRange.ok) {
      assert.equal(outOfRange.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(outOfRange.error.path, "state.scrolls[0].y");
      assert.deepEqual(outOfRange.error.allowed, { min: 0, max: 80 });
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component applies explicit viewport scale and only saves on request", async () => {
  const { registry, renderer, projectId } = await openRenderer();
  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      width: 200,
      height: 100,
      scale: 2,
      background: "#ffffff",
      saveToFile: true
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.image.width, 400);
    assert.equal(result.data.image.height, 200);
    assert.ok(result.data.image.filePath);
    assert.equal(
      path.relative(os.tmpdir(), result.data.image.filePath!).startsWith(".."),
      false
    );
    await access(result.data.image.filePath!);
    assert.deepEqual(
      await readFile(result.data.image.filePath!),
      Buffer.from(result.data.image.data, "base64")
    );
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component reuses Chromium while isolating every render context", async () => {
  let launchCount = 0;
  let contextCount = 0;
  let launchedBrowser: Browser | undefined;
  const countingBrowser: RenderBrowserType = {
    executablePath: () => chromium.executablePath(),
    launch: async (options?: LaunchOptions): Promise<Browser> => {
      launchCount++;
      const browser = await chromium.launch(options);
      launchedBrowser = browser;
      return new Proxy(browser, {
        get(target, property) {
          if (property === "newContext") {
            return async (contextOptions?: BrowserContextOptions) => {
              contextCount++;
              return target.newContext(contextOptions);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
  const { registry, renderer, projectId } = await openRenderer({
    browserType: countingBrowser
  });
  try {
    for (let index = 0; index < 2; index++) {
      const result = await renderer.render(RenderComponentInputSchema.parse({
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01"
      }));
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal(launchCount, 1);
    assert.equal(contextCount, 2);
    assert.equal(launchedBrowser?.contexts().length, 0);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component relaunches Chromium after a disconnected browser", async () => {
  let launchCount = 0;
  let launchedBrowser: Browser | undefined;
  const reconnectingBrowser: RenderBrowserType = {
    executablePath: () => chromium.executablePath(),
    launch: async (options?: LaunchOptions): Promise<Browser> => {
      launchCount++;
      launchedBrowser = await chromium.launch(options);
      return launchedBrowser;
    }
  };
  const { registry, renderer, projectId } = await openRenderer({
    browserType: reconnectingBrowser
  });
  try {
    const input = RenderComponentInputSchema.parse({
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });
    const first = await renderer.render(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(launchCount, 1);

    await launchedBrowser!.close();
    const second = await renderer.render(input);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(launchCount, 2);
    if (first.ok && second.ok) {
      assert.equal(
        second.data.image.data,
        first.data.image.data
      );
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component reports a missing browser without downloading or fallback", async () => {
  let launchCount = 0;
  const missingBrowser: RenderBrowserType = {
    executablePath: () =>
      path.join(os.tmpdir(), "definitely-missing-fgui-chromium", "chrome"),
    launch: async (): Promise<Browser> => {
      launchCount++;
      throw new Error("launch must not be attempted");
    }
  };
  const { registry, renderer, projectId } = await openRenderer({
    browserType: missingBrowser
  });
  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    }));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "BROWSER_NOT_INSTALLED");
    assert.match(
      result.error.suggestedFix ?? "",
      /pnpm exec playwright install chromium/
    );
    assert.equal(launchCount, 0);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component preserves specific project and component errors", async () => {
  const { registry, renderer, projectId } = await openRenderer();
  try {
    const missingSession = await renderer.render(
      RenderComponentInputSchema.parse({
        projectId: "missing",
        packageId: "pkg00001",
        componentId: "cmp01"
      })
    );
    assert.equal(missingSession.ok, false);
    if (!missingSession.ok) {
      assert.equal(missingSession.error.code, "SESSION_NOT_FOUND");
    }

    const missingComponent = await renderer.render(
      RenderComponentInputSchema.parse({
        projectId,
        packageId: "pkg00001",
        componentId: "missing"
      })
    );
    assert.equal(missingComponent.ok, false);
    if (!missingComponent.ok) {
      assert.equal(missingComponent.error.code, "COMPONENT_NOT_FOUND");
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});
