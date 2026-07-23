import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FAIRYGUI_TOOL_NAMES } from "../../src/contracts/tools.js";
import { FairyGuiMcpServer } from "../../src/server/fairygui-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-server-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="server-project" type="Unity" version="5.0"/>`,
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
<component size="200,100">
  <displayList>
    <text id="n0" name="title" xy="10,10" size="180,40"
      text="MCP Preview" fontSize="20"/>
    <image id="n1" name="broken" src="missing" xy="10,55" size="40,40"/>
  </displayList>
</component>`,
    "utf8"
  );
  return directory;
}

async function connectServer(): Promise<{
  app: FairyGuiMcpServer;
  client: Client;
}> {
  const app = new FairyGuiMcpServer();
  const client = new Client(
    { name: "fairygui-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await app.connect(serverTransport);
  await client.connect(clientTransport);
  return { app, client };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
} {
  assert.ok("structuredContent" in result);
  return result.structuredContent as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

test("MCP initialization advertises instructions and exactly six strict tools", async () => {
  const { app, client } = await connectServer();
  try {
    assert.match(client.getInstructions() ?? "", /打开.*批量查询.*渲染.*校验/s);
    assert.match(client.getInstructions() ?? "", /磁盘.*唯一事实来源/s);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...FAIRYGUI_TOOL_NAMES]
    );
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.outputSchema?.type, "object");
      assert.ok(tool.description);
    }
  }
  finally {
    await client.close();
    await app.close();
  }
});

test("invalid arguments return the common envelope with MCP isError:true", async () => {
  const { app, client } = await connectServer();
  try {
    const result = await client.callTool({
      name: "fairygui.project",
      arguments: { action: "open" }
    });
    assert.equal("isError" in result && result.isError, true);
    const envelope = structured(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "INVALID_ARGUMENT");
    assert.match(envelope.error?.message ?? "", /参数/);
  }
  finally {
    await client.close();
    await app.close();
  }
});

test("stdio-facing handlers complete the M1 open-query-render-validate loop", async () => {
  const projectDirectory = await createProject();
  const { app, client } = await connectServer();
  try {
    const opened = await client.callTool({
      name: "fairygui.project",
      arguments: { action: "open", path: projectDirectory }
    });
    assert.equal("isError" in opened && opened.isError, false);
    const openedEnvelope = structured(opened);
    assert.equal(openedEnvelope.ok, true);
    const projectId = String(openedEnvelope.data?.projectId);

    const queried = await client.callTool({
      name: "fairygui.query",
      arguments: {
        projectId,
        queries: {
          components: { kind: "components" },
          dom: {
            kind: "dom",
            packageId: "pkg00001",
            componentId: "cmp01"
          }
        }
      }
    });
    assert.equal(structured(queried).ok, true);

    const rendered = await client.callTool({
      name: "fairygui.render_component",
      arguments: {
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01"
      }
    });
    assert.equal(structured(rendered).ok, true);
    const renderedContent = "content" in rendered
      ? rendered.content as Array<{ type: string }>
      : [];
    assert.ok(
      renderedContent.some((item) => item.type === "image")
    );

    const validated = await client.callTool({
      name: "fairygui.validate",
      arguments: { projectId, mode: "quick" }
    });
    assert.equal("isError" in validated && validated.isError, false);
    const validationEnvelope = structured(validated);
    assert.equal(validationEnvelope.ok, true);
    assert.equal(validationEnvelope.data?.valid, false);
  }
  finally {
    await client.close();
    await app.close();
  }
});

test("stdio-facing DOM patch handler atomically writes and immediately re-queries", async () => {
  const projectDirectory = await createProject();
  const { app, client } = await connectServer();
  try {
    const opened = structured(await client.callTool({
      name: "fairygui.project",
      arguments: { action: "open", path: projectDirectory }
    }));
    assert.equal(opened.ok, true);
    const projectId = String(opened.data?.projectId);

    const beforeRender = structured(await client.callTool({
      name: "fairygui.render_component",
      arguments: {
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01"
      }
    }));
    assert.equal(beforeRender.ok, true);
    const beforeImage = beforeRender.data?.image as {
      data: string;
    };

    const result = await client.callTool({
      name: "fairygui.apply_dom_patch",
      arguments: {
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01",
        operations: [
          {
            op: "set-text",
            selector: "#n0",
            expectedMatches: 1,
            text: "Written through MCP"
          },
          {
            op: "set-style",
            selector: "#n0",
            expectedMatches: 1,
            changes: { opacity: 0.4 }
          }
        ]
      }
    });
    assert.equal("isError" in result && result.isError, false);
    const patched = structured(result);
    assert.equal(patched.ok, true);
    assert.deepEqual(patched.data?.affectedFiles, ["assets/Demo/Main.xml"]);
    assert.equal(patched.data?.appliedOperations, 2);

    const componentXml = await readFile(
      path.join(projectDirectory, "assets", "Demo", "Main.xml"),
      "utf8"
    );
    assert.match(componentXml, /text="Written through MCP"/);
    assert.match(componentXml, /\balpha="0\.4"/);

    const queried = structured(await client.callTool({
      name: "fairygui.query",
      arguments: {
        projectId,
        queries: {
          dom: {
            kind: "dom",
            packageId: "pkg00001",
            componentId: "cmp01",
            selector: "#n0"
          }
        }
      }
    }));
    assert.equal(queried.ok, true);
    const queries = queried.data?.results as Record<string, {
      ok: boolean;
      data: { matches: Array<{
        style: { opacity?: number };
        content: { text?: string };
      }> };
    }>;
    assert.ok(queries.dom);
    assert.equal(
      queries.dom?.data.matches[0]?.content.text,
      "Written through MCP"
    );
    assert.equal(queries.dom?.data.matches[0]?.style.opacity, 0.4);

    const rendered = await client.callTool({
      name: "fairygui.render_component",
      arguments: {
        projectId,
        packageId: "pkg00001",
        componentId: "cmp01"
      }
    });
    assert.equal("isError" in rendered && rendered.isError, false);
    const renderedEnvelope = structured(rendered);
    assert.equal(renderedEnvelope.ok, true);
    assert.equal(renderedEnvelope.data?.backend, "fairygui-dom");
    const renderedImage = renderedEnvelope.data?.image as {
      mediaType: string;
      data: string;
    };
    assert.equal(renderedImage.mediaType, "image/png");
    assert.notEqual(renderedImage.data, beforeImage.data);
    const renderedContent = "content" in rendered
      ? rendered.content as Array<{ type: string }>
      : [];
    assert.ok(renderedContent.some((item) => item.type === "image"));
  }
  finally {
    await client.close();
    await app.close();
  }
});

test("stdio-facing resource operations create a package and component atomically", async () => {
  const projectDirectory = await createProject();
  const { app, client } = await connectServer();
  try {
    const opened = structured(await client.callTool({
      name: "fairygui.project",
      arguments: { action: "open", path: projectDirectory }
    }));
    assert.equal(opened.ok, true);
    const projectId = String(opened.data?.projectId);

    const result = await client.callTool({
      name: "fairygui.apply_resource_operations",
      arguments: {
        projectId,
        operations: [
          {
            op: "create-package",
            clientRef: "widgets",
            name: "Widgets"
          },
          {
            op: "create-component",
            packageRef: "widgets",
            clientRef: "dialog",
            name: "Dialog",
            width: 640,
            height: 360
          }
        ]
      }
    });
    assert.equal("isError" in result && result.isError, false);
    const applied = structured(result);
    assert.equal(applied.ok, true);
    assert.equal(applied.data?.appliedOperations, 2);
    const clientRefs = applied.data?.clientRefs as Record<string, {
      packageId: string;
      resourceId?: string;
    }>;
    const packageId = clientRefs.widgets!.packageId;
    const componentId = clientRefs.dialog!.resourceId!;
    assert.deepEqual(applied.data?.affectedFiles, [
      "assets/Widgets/Dialog.xml",
      "assets/Widgets/package.xml"
    ]);

    const queried = structured(await client.callTool({
      name: "fairygui.query",
      arguments: {
        projectId,
        queries: {
          components: {
            kind: "components",
            packageId
          }
        }
      }
    }));
    assert.equal(queried.ok, true);
    const results = queried.data?.results as Record<string, {
      ok: boolean;
      data: { items: Array<{ componentId: string; name: string }> };
    }>;
    assert.equal(results.components?.ok, true);
    assert.deepEqual(results.components?.data.items, [{
      packageId,
      componentId,
      name: "Dialog",
      path: "/",
      width: 640,
      height: 360,
      exported: false
    }]);
    assert.match(
      await readFile(
        path.join(
          projectDirectory,
          "assets",
          "Widgets",
          "Dialog.xml"
        ),
        "utf8"
      ),
      /size="640,360"/
    );
  }
  finally {
    await client.close();
    await app.close();
  }
});
