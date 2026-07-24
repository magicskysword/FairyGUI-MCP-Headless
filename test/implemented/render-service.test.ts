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
import {
  RenderComponentInputSchema,
  type RenderRequestInput
} from "../../src/contracts/tools.js";
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

function inlineImageData(data: { image: { data?: string } }): string {
  assert.ok(data.image.data, "inline 渲染必须携带内部 PNG attachment");
  return data.image.data;
}

async function renderSingle(
  renderer: RenderService,
  input: RenderRequestInput & {
    projectId: string;
    imageResult?: "inline" | "file" | "both";
    stateDetail?: "summary" | "full";
  }
) {
  const {
    projectId,
    imageResult,
    stateDetail,
    ...request
  } = input;
  const batch = await renderer.render(RenderComponentInputSchema.parse({
    projectId,
    ...(imageResult === undefined ? {} : { imageResult }),
    ...(stateDetail === undefined ? {} : { stateDetail }),
    renders: { single: request }
  }));
  if (!batch.ok) return batch;
  const result = batch.data.results.single;
  assert.ok(result, "单项渲染包装必须返回 single 结果");
  return result;
}

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
    <component id="hid01" name="Hidden.xml" path="/"/>
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
  await writeFile(
    path.join(packageDirectory, "Hidden.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="160,90">
  <displayList>
    <text id="n0" name="title" xy="10,20" size="140,40"
      text="Unexported preview" fontSize="18" color="#ffffff"/>
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

async function createHighResolutionImageProject(): Promise<{
  directory: string;
  sourceFiles: string[];
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-scale-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, "Demo.fairy");
  const packageFile = path.join(packageDirectory, "package.xml");
  const componentFile = path.join(packageDirectory, "Main.xml");
  const baseImageFile = path.join(packageDirectory, "icon.png");
  const highResolutionImageFile = path.join(
    packageDirectory,
    "icon@2x.png"
  );
  await writeFile(
    projectFile,
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="scale-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    packageFile,
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <image id="base1" name="icon.png" path="/" exported="true"/>
    <image id="high2" name="icon@2x.png" path="/"/>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="32,32">
  <displayList>
    <image id="n0" name="icon" src="base1" xy="0,0" size="32,32"/>
  </displayList>
</component>`,
    "utf8"
  );
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 220, g: 20, b: 60, alpha: 1 }
    }
  }).png().toFile(baseImageFile);
  await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 30, g: 100, b: 230, alpha: 1 }
    }
  }).png().toFile(highResolutionImageFile);
  return {
    directory,
    sourceFiles: [
      projectFile,
      packageFile,
      componentFile,
      baseImageFile,
      highResolutionImageFile
    ]
  };
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

async function createListStateProject(): Promise<{
  directory: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-list-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="list-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="item1" name="Item.xml" path="/"/>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "Item.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,40" extention="Button">
  <controller name="button"
    pages="0,up,1,down,2,over,3,selectedOver" selected="0"/>
  <displayList>
    <graph id="normal" name="normal" xy="0,0" size="100,40"
      type="rect" fillColor="#e11d48" lineColor="#e11d48" lineSize="0">
      <gearDisplay controller="button" pages="0,2"/>
    </graph>
    <graph id="selected" name="selected" xy="0,0" size="100,40"
      type="rect" fillColor="#2563eb" lineColor="#2563eb" lineSize="0">
      <gearDisplay controller="button" pages="1,3"/>
    </graph>
  </displayList>
  <Button mode="Check"/>
</component>`,
    "utf8"
  );
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,80">
  <displayList>
    <list id="items" name="items" xy="0,0" size="100,80"
      selectionMode="multiple" defaultItem="ui://pkg00001item1">
      <item title="First"/>
      <item title="Second"/>
    </list>
  </displayList>
</component>`,
    "utf8"
  );
  return { directory, componentFile };
}

async function createTreeStateProject(): Promise<{
  directory: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-tree-render-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="tree-render-project" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  <resources>
    <component id="item1" name="TreeItem.xml" path="/"/>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "TreeItem.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,40" extention="Button">
  <controller name="button"
    pages="0,up,1,down,2,over,3,selectedOver" selected="0"/>
  <displayList>
    <graph id="normal" name="normal" xy="0,0" size="100,40"
      type="rect" fillColor="#e11d48" lineColor="#e11d48" lineSize="0">
      <gearDisplay controller="button" pages="0,2"/>
    </graph>
    <graph id="selected" name="selected" xy="0,0" size="100,40"
      type="rect" fillColor="#2563eb" lineColor="#2563eb" lineSize="0">
      <gearDisplay controller="button" pages="1,3"/>
    </graph>
  </displayList>
  <Button mode="Check"/>
</component>`,
    "utf8"
  );
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="100,80">
  <displayList>
    <graph id="background" name="background" xy="0,0" size="100,80"
      type="rect" fillColor="#16a34a" lineColor="#16a34a" lineSize="0"/>
    <list id="tree" name="outline" xy="0,0" size="100,80"
      selectionMode="single" defaultItem="ui://pkg00001item1"
      treeView="true" indent="0">
      <item title="Parent" level="0"/>
      <item title="Child" level="1"/>
    </list>
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
    const result = await renderSingle(renderer, {
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });

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
      Buffer.from(inlineImageData(result.data), "base64")
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

test("render_component previews an unexported component without changing settings", async () => {
  const projectDirectory = await createProject();
  const packageFile = path.join(
    projectDirectory,
    "assets",
    "Demo",
    "package.xml"
  );
  const before = await readFile(packageFile, "utf8");
  const registry = new ProjectRegistry();
  const opened = await registry.open(projectDirectory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);
  try {
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "hid01"
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(
      Buffer.from(inlineImageData(result.data), "base64")
        .subarray(0, 8)
        .toString("hex"),
      "89504e470d0a1a0a"
    );
    assert.equal(await readFile(packageFile, "utf8"), before);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component batches named renders and preserves successful siblings", async () => {
  const { directory } = await createControllerStateProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);
  try {
    const result = await renderer.render(RenderComponentInputSchema.parse({
      projectId: opened.data.projectId,
      stateDetail: "full",
      renders: {
        defaultView: {
          packageId: "pkg00001",
          componentId: "cmp01"
        },
        blueView: {
          packageId: "pkg00001",
          componentId: "cmp01",
          state: {
            controllers: [{
              selector: "component-root",
              expectedMatches: 1,
              controller: "mode",
              page: { id: "blue" }
            }]
          }
        },
        badState: {
          packageId: "pkg00001",
          componentId: "cmp01",
          state: {
            controllers: [{
              selector: "#missing",
              expectedMatches: 1,
              controller: "mode",
              page: { index: 1 }
            }]
          }
        },
        missingComponent: {
          packageId: "pkg00001",
          componentId: "missing"
        }
      }
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual({
      requested: result.data.requested,
      succeeded: result.data.succeeded,
      failed: result.data.failed
    }, {
      requested: 4,
      succeeded: 2,
      failed: 2
    });
    assert.deepEqual(result.warnings?.map((warning) => warning.code), [
      "PARTIAL_RENDER_FAILURE"
    ]);

    const defaultView = result.data.results.defaultView;
    assert.equal(defaultView?.ok, true, JSON.stringify(defaultView));
    if (defaultView?.ok) {
      assert.ok(inlineImageData(defaultView.data));
      assert.deepEqual(
        defaultView.data.availableState.controllers[0]?.controllers[0]?.pages,
        [
          { index: 0, id: "red", name: "Red" },
          { index: 1, id: "blue", name: "Blue" }
        ]
      );
      assert.equal(defaultView.data.gearHidden.count, 1);
      assert.equal(
        defaultView.data.gearHidden.nodes[0]?.id,
        "bluePanel"
      );
    }

    const blueView = result.data.results.blueView;
    assert.equal(blueView?.ok, true, JSON.stringify(blueView));
    if (blueView?.ok) {
      assert.equal(
        blueView.data.appliedState.controllers[0]?.selectedPage.id,
        "blue"
      );
      assert.equal(blueView.data.gearHidden.count, 1);
      assert.equal(blueView.data.gearHidden.nodes[0]?.id, "redPanel");
    }
    if (defaultView?.ok && blueView?.ok) {
      const sampleCenter = async (data: typeof defaultView.data) => {
        const decoded = await sharp(Buffer.from(
          inlineImageData(data),
          "base64"
        )).raw().toBuffer({ resolveWithObject: true });
        const offset = (40 * decoded.info.width + 60)
          * decoded.info.channels;
        return [...decoded.data.subarray(offset, offset + 3)];
      };
      const defaultRgb = await sampleCenter(defaultView.data);
      const blueRgb = await sampleCenter(blueView.data);
      assert.ok(
        defaultRgb[0]! > 180 && defaultRgb[2]! < 120,
        `默认控制器页应显示红色：${defaultRgb.join(",")}`
      );
      assert.ok(
        blueRgb[0]! < 80 && blueRgb[2]! > 180,
        `临时控制器页应显示蓝色：${blueRgb.join(",")}`
      );
    }

    const badState = result.data.results.badState;
    assert.equal(badState?.ok, false);
    if (badState && !badState.ok) {
      assert.equal(badState.error.code, "SELECTOR_MATCH_COUNT");
      assert.equal(
        badState.error.path,
        "renders.badState.state.controllers[0].selector"
      );
    }
    const missing = result.data.results.missingComponent;
    assert.equal(missing?.ok, false);
    if (missing && !missing.ok) {
      assert.equal(missing.error.code, "COMPONENT_NOT_FOUND");
    }
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
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const png = Buffer.from(inlineImageData(result.data), "base64");
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
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
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
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
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
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "component-root",
          expectedMatches: 1,
          controller: "mode",
          page: { index: 1 }
        }]
      }
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(
      result.data.appliedState.controllers[0]?.selectedPage.id,
      "blue"
    );
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
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
    const mismatch = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "#missing",
          expectedMatches: 1,
          controller: "mode",
          page: { index: 1 }
        }]
      }
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.error.code, "SELECTOR_MATCH_COUNT");
      assert.deepEqual(mismatch.error.actual, {
        selector: "#missing",
        expectedMatches: 1,
        actualMatches: 0
      });
    }

    const invalidPage = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        controllers: [{
          selector: "component-root",
          expectedMatches: 1,
          controller: "mode",
          page: { index: 9 }
        }]
      }
    });
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
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "component-root",
          expectedMatches: 1,
          position: { y: 80 }
        }]
      }
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.data.appliedState.scrolls, [{
      selector: "component-root",
      target: {
        id: "component-root",
        name: "",
        type: "component-root"
      },
      position: { x: 0, y: 80 }
    }]);
    assert.deepEqual(result.data.availableState.scrolls[0]?.maxPosition, {
      x: 0,
      y: 80
    });
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
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
    const unavailable = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "#red",
          expectedMatches: 1,
          position: { y: 1 }
        }]
      }
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        unavailable.error.path,
        "renders.single.state.scrolls[0].selector"
      );
    }

    const outOfRange = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        scrolls: [{
          selector: "component-root",
          expectedMatches: 1,
          position: { y: 81 }
        }]
      }
    });
    assert.equal(outOfRange.ok, false);
    if (!outOfRange.ok) {
      assert.equal(outOfRange.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        outOfRange.error.path,
        "renders.single.state.scrolls[0].position.y"
      );
      assert.deepEqual(outOfRange.error.allowed, { min: 0, max: 80 });
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component applies transient list selection without writing the project", async () => {
  const { directory, componentFile } = await createListStateProject();
  const before = await readFile(componentFile);
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        lists: [{
          selector: "#items",
          expectedMatches: 1,
          selectedIndices: [1]
        }]
      }
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(
      result.data.appliedState.lists[0]?.selectedIndices,
      [1]
    );
    assert.equal(result.data.availableState.lists[0]?.itemCount, 2);
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const firstOffset = (20 * decoded.info.width + 50)
      * decoded.info.channels;
    const secondOffset = (60 * decoded.info.width + 50)
      * decoded.info.channels;
    assert.ok(
      (decoded.data[firstOffset] ?? 0) > 180
        && (decoded.data[firstOffset + 2] ?? 0) < 120,
      "未选中的第一项应保持红色"
    );
    assert.ok(
      (decoded.data[secondOffset] ?? 0) < 80
        && (decoded.data[secondOffset + 1] ?? 0) > 70
        && (decoded.data[secondOffset + 2] ?? 0) > 180,
      "选中的第二项应显示蓝色"
    );
    assert.deepEqual(await readFile(componentFile), before);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component rejects an invalid transient list target or index", async () => {
  const { directory } = await createListStateProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const invalidTarget = await renderSingle(renderer, {
        projectId: opened.data.projectId,
        packageId: "pkg00001",
        componentId: "cmp01",
        state: {
          lists: [{
            selector: "#normal",
            expectedMatches: 2,
            selectedIndices: [0]
          }]
        }
      });
    assert.equal(invalidTarget.ok, false);
    if (!invalidTarget.ok) {
      assert.equal(invalidTarget.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        invalidTarget.error.path,
        "renders.single.state.lists[0].selector"
      );
    }

    const invalidIndex = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        lists: [{
          selector: "#items",
          expectedMatches: 1,
          selectedIndices: [2]
        }]
      }
    });
    assert.equal(invalidIndex.ok, false);
    if (!invalidIndex.ok) {
      assert.equal(invalidIndex.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        invalidIndex.error.path,
        "renders.single.state.lists[0].selectedIndices[0]"
      );
      assert.deepEqual(invalidIndex.error.allowed, {
        min: -1,
        max: 1,
        itemCount: 2
      });
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component applies transient tree expansion and selection without writing", async () => {
  const { directory, componentFile } = await createTreeStateProject();
  const before = await readFile(componentFile);
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const result = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      stateDetail: "full",
      state: {
        trees: [{
          selector: "#tree",
          expectedMatches: 1,
          expansions: [{
            path: [0],
            expanded: false
          }],
          selectedPath: [0]
        }]
      }
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.data.appliedState.trees[0], {
      selector: "#tree",
      target: { id: "tree", name: "outline", type: "tree" },
      expansions: [{ path: [0], expanded: false }],
      selectedPath: [0]
    });
    assert.deepEqual(
      result.data.availableState.trees[0]?.nodes?.map((node) => node.path),
      [[0], [0, 0]]
    );
    const decoded = await sharp(Buffer.from(
      inlineImageData(result.data),
      "base64"
    ))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const parentOffset = (20 * decoded.info.width + 50)
      * decoded.info.channels;
    const childOffset = (60 * decoded.info.width + 50)
      * decoded.info.channels;
    assert.ok(
      (decoded.data[parentOffset] ?? 0) < 80
        && (decoded.data[parentOffset + 1] ?? 0) > 70
        && (decoded.data[parentOffset + 2] ?? 0) > 180,
      "选中的父节点应显示蓝色"
    );
    assert.ok(
      (decoded.data[childOffset] ?? 0) < 80
        && (decoded.data[childOffset + 1] ?? 0) > 120
        && (decoded.data[childOffset + 2] ?? 0) < 120,
      "折叠父节点后子节点区域应显示绿色背景"
    );
    assert.deepEqual(await readFile(componentFile), before);
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component rejects an invalid transient tree target or node path", async () => {
  const { directory } = await createTreeStateProject();
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  const renderer = new RenderService(registry);

  try {
    const invalidTarget = await renderSingle(renderer, {
        projectId: opened.data.projectId,
        packageId: "pkg00001",
        componentId: "cmp01",
        state: {
          trees: [{
            selector: "#background",
            expectedMatches: 1,
            selectedPath: [0]
          }]
        }
      });
    assert.equal(invalidTarget.ok, false);
    if (!invalidTarget.ok) {
      assert.equal(invalidTarget.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        invalidTarget.error.path,
        "renders.single.state.trees[0].selector"
      );
    }

    const invalidPath = await renderSingle(renderer, {
      projectId: opened.data.projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      state: {
        trees: [{
          selector: "#tree",
          expectedMatches: 1,
          selectedPath: [0, 1]
        }]
      }
    });
    assert.equal(invalidPath.ok, false);
    if (!invalidPath.ok) {
      assert.equal(invalidPath.error.code, "TRANSIENT_STATE_INVALID");
      assert.equal(
        invalidPath.error.path,
        "renders.single.state.trees[0].selectedPath[1]"
      );
      assert.deepEqual(invalidPath.error.allowed, {
        min: 0,
        max: 0,
        childCount: 1
      });
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
    const result = await renderSingle(renderer, {
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      width: 200,
      height: 100,
      scale: 2,
      background: "#ffffff",
      imageResult: "both"
    });

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
      Buffer.from(inlineImageData(result.data), "base64")
    );

    const fileOnly = await renderSingle(renderer, {
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01",
      imageResult: "file"
    });
    assert.equal(fileOnly.ok, true, JSON.stringify(fileOnly));
    if (fileOnly.ok) {
      assert.equal(fileOnly.data.image.data, undefined);
      assert.ok(fileOnly.data.image.filePath);
      await access(fileOnly.data.image.filePath!);
    }
  }
  finally {
    await renderer.close();
    await registry.closeAll();
  }
});

test("render_component selects implicit high-resolution resources at scale 2 without writing", async () => {
  const { directory, sourceFiles } = await createHighResolutionImageProject();
  const sourceBefore = await Promise.all(sourceFiles.map((file) => readFile(file)));
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) return;
  const renderer = new RenderService(registry);

  try {
    const renderAtScale = async (scale: number) => {
      const result = await renderSingle(renderer, {
        projectId: opened.data.projectId,
        packageId: "pkg00001",
        componentId: "cmp01",
        scale
      });
      if (!result.ok) assert.fail(result.error.message);
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.data;
    };
    const atOne = await renderAtScale(1);
    const atTwo = await renderAtScale(2);
    const sampleCenter = async (data: string) => {
      const { data: pixels, info } = await sharp(
        Buffer.from(data, "base64")
      ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const offset = (
        Math.floor(info.height / 2) * info.width
        + Math.floor(info.width / 2)
      ) * info.channels;
      return [...pixels.subarray(offset, offset + 4)];
    };

    assert.deepEqual(
      { width: atOne.image.width, height: atOne.image.height },
      { width: 32, height: 32 }
    );
    assert.deepEqual(
      { width: atTwo.image.width, height: atTwo.image.height },
      { width: 64, height: 64 }
    );
    assert.deepEqual(
      await sampleCenter(inlineImageData(atOne)),
      [220, 20, 60, 255]
    );
    assert.deepEqual(
      await sampleCenter(inlineImageData(atTwo)),
      [30, 100, 230, 255]
    );
    const sourceAfter = await Promise.all(sourceFiles.map((file) => readFile(file)));
    assert.deepEqual(sourceAfter, sourceBefore);
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
      const result = await renderSingle(renderer, {
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01"
      });
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
    const input = {
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    };
    const first = await renderSingle(renderer, input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(launchCount, 1);

    await launchedBrowser!.close();
    const second = await renderSingle(renderer, input);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(launchCount, 2);
    if (first.ok && second.ok) {
      assert.equal(
        inlineImageData(second.data),
        inlineImageData(first.data)
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
    const result = await renderSingle(renderer, {
      projectId,
      packageId: "pkg00001",
      componentId: "cmp01"
    });

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
    const missingSession = await renderSingle(renderer, {
        projectId: "missing",
        packageId: "pkg00001",
        componentId: "cmp01"
      });
    assert.equal(missingSession.ok, false);
    if (!missingSession.ok) {
      assert.equal(missingSession.error.code, "SESSION_NOT_FOUND");
    }

    const missingComponent = await renderSingle(renderer, {
        projectId,
        packageId: "pkg00001",
        componentId: "missing"
      });
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
