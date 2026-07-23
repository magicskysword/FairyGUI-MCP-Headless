import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { Document } from "@magicskysword/openfairygui-core";
import { ProjectRegistry } from "../../src/project/project-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(label: string, text = "Before"): Promise<{
  directory: string;
  projectFile: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `fgui-mcp-${label}-`));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Package1");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, `${label}.fairy`);
  const componentFile = path.join(packageDirectory, "Main.xml");

  await writeFile(
    projectFile,
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="${label}" type="DOM" version="5.0"/>`,
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
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="800,600">
  <displayList>
    <text id="n0" name="title" xy="10,20" size="200,40" text="${text}"/>
  </displayList>
</component>`,
    "utf8"
  );
  return { directory, projectFile, componentFile };
}

function readFirstText(document: Document): string {
  const component = document.getRoot().listPackages()[0]?.listComponents()[0];
  const child = component?.listChildren()[0] as
    | { getText?(): string }
    | undefined;
  return child?.getText?.() ?? "";
}

test("opening a directory and its .fairy file reuses one canonical session", async () => {
  const project = await createProject("reuse");
  const registry = new ProjectRegistry();
  try {
    const first = await registry.open(project.directory);
    const second = await registry.open(project.projectFile);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.data.projectId, second.data.projectId);
    assert.equal(first.data.packageCount, 1);
    assert.equal(first.data.reused, false);
    assert.equal(second.data.reused, true);

    const listed = registry.list();
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.data.projects.length, 1);
  }
  finally {
    await registry.closeAll();
  }
});

test("status and close return stable errors for unknown sessions", async () => {
  const project = await createProject("close");
  const registry = new ProjectRegistry();
  try {
    const opened = await registry.open(project.directory);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const status = registry.status(opened.data.projectId);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.data.state, "open");
      assert.equal(status.data.generation, 1);
      assert.equal(status.data.watching, true);
    }

    const closed = await registry.close(opened.data.projectId);
    assert.equal(closed.ok, true);
    assert.equal(registry.status(opened.data.projectId).ok, false);
    assert.equal((await registry.close("missing")).ok, false);
  }
  finally {
    await registry.closeAll();
  }
});

test("ensureFresh observes an immediate external edit before the next read", async () => {
  const project = await createProject("refresh", "Before");
  const registry = new ProjectRegistry();
  try {
    const opened = await registry.open(project.directory);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const before = await registry.read(
      opened.data.projectId,
      (document) => readFirstText(document)
    );
    assert.deepEqual(before, { ok: true, data: "Before" });

    await writeFile(
      project.componentFile,
      `<?xml version="1.0" encoding="utf-8"?>
<component size="800,600">
  <displayList>
    <text id="n0" name="title" xy="10,20" size="200,40" text="After"/>
  </displayList>
</component>`,
      "utf8"
    );

    const after = await registry.read(
      opened.data.projectId,
      (document) => readFirstText(document)
    );
    assert.deepEqual(after, { ok: true, data: "After" });
    const status = registry.status(opened.data.projectId);
    assert.equal(status.ok && status.data.generation, 2);
  }
  finally {
    await registry.closeAll();
  }
});

test("a failed external parse keeps the previous immutable snapshot", async () => {
  const project = await createProject("broken", "Healthy");
  const registry = new ProjectRegistry();
  try {
    const opened = await registry.open(project.directory);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    await rm(project.componentFile);
    const failedRead = await registry.read(
      opened.data.projectId,
      (document) => readFirstText(document)
    );
    assert.equal(failedRead.ok, false);

    const status = registry.status(opened.data.projectId);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.data.generation, 1);
      assert.equal(status.data.lastReloadError !== undefined, true);
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("two projects can open and read concurrently", async () => {
  const [firstProject, secondProject] = await Promise.all([
    createProject("parallel-a", "A"),
    createProject("parallel-b", "B")
  ]);
  const registry = new ProjectRegistry();
  try {
    const [first, second] = await Promise.all([
      registry.open(firstProject.directory),
      registry.open(secondProject.directory)
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.data.projectId, second.data.projectId);

    const values = await Promise.all([
      registry.read(first.data.projectId, readFirstText),
      registry.read(second.data.projectId, readFirstText)
    ]);
    assert.deepEqual(values, [
      { ok: true, data: "A" },
      { ok: true, data: "B" }
    ]);
  }
  finally {
    await registry.closeAll();
  }
});
