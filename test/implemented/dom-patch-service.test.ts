import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { ApplyDomPatchInputSchema } from "../../src/contracts/tools.js";
import {
  DomPatchService,
  type DomPatchServiceOptions
} from "../../src/dom/dom-patch-service.js";
import { DomPatchEngine } from "../../src/dom/dom-patch-engine.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { FileTransactionManager } from "../../src/write/file-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(label: string): Promise<{
  directory: string;
  projectFile: string;
  packageFile: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `fgui-patch-${label}-`));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, `${label}.fairy`);
  const packageFile = path.join(packageDirectory, "package.xml");
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    projectFile,
    `<projectDescription id="${label}" type="DOM" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    packageFile,
    `<packageDescription id="pkg00001" vendorPackage="keep">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    componentFile,
    `<component size="320,180" vendorRoot="keep">
  <displayList>
    <text id="n0" name="title" xy="10,20" size="120,24" text="Before" vendorText="keep">
      <vendorTextChild value="owned"/>
    </text>
    <vendorWidget value="unowned"/>
    <text id="n2" name="second" xy="10,50" size="120,24" text="Second"/>
  </displayList>
  <vendorAfter value="keep"/>
</component>`,
    "utf8"
  );
  return { directory, projectFile, packageFile, componentFile };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setup(label: string, options: {
  transactionManager?: FileTransactionManager;
  beforeCommit?: DomPatchServiceOptions["beforeCommit"];
  engine?: DomPatchEngine;
} = {}) {
  const project = await createProject(label);
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-patch-log-"));
  const validationDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fgui-patch-roundtrip-")
  );
  temporaryDirectories.push(logDirectory, validationDirectory);
  const transactions = options.transactionManager
    ?? new FileTransactionManager({ baseDirectory: logDirectory });
  const registry = new ProjectRegistry({ recovery: transactions });
  const opened = await registry.open(project.directory);
  if (!opened.ok) throw new Error(opened.error.message);
  assert.equal(opened.ok, true);
  const service = new DomPatchService(registry, {
    transactions,
    temporaryRoot: validationDirectory,
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.beforeCommit === undefined
      ? {}
      : { beforeCommit: options.beforeCommit })
  });
  return {
    project,
    registry,
    service,
    projectId: opened.data.projectId
  };
}

function patch(
  projectId: string,
  operations: unknown[]
) {
  return ApplyDomPatchInputSchema.parse({
    projectId,
    packageId: "pkg00001",
    componentId: "cmp01",
    operations
  });
}

test("DOM patch service writes one component atomically and preserves opaque XML", async () => {
  const context = await setup("write");
  try {
    const projectBefore = await readFile(context.project.projectFile, "utf8");
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const result = await context.service.apply(patch(context.projectId, [
      {
        op: "set-text",
        selector: "#n0",
        expectedMatches: 1,
        text: "After"
      },
      {
        op: "move",
        selector: "#n2",
        expectedMatches: 1,
        toIndex: 0
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "badge",
        node: {
          type: "text",
          name: "badge",
          style: { left: 200, top: 20, width: 80, height: 24 },
          relations: [],
          content: { text: "New" }
        }
      }
    ]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.appliedOperations, 3);
    assert.deepEqual(result.data.clientRefs, { badge: "n3" });
    assert.deepEqual(result.data.affectedFiles, ["assets/Demo/Main.xml"]);
    assert.match(result.data.transactionId, /^tx_/);
    const output = await readFile(context.project.componentFile, "utf8");
    assert.match(output, /text="After"/);
    assert.match(output, /vendorRoot="keep"/);
    assert.match(output, /vendorText="keep"/);
    assert.match(output, /<vendorTextChild value="owned"\/>/);
    assert.match(output, /<vendorWidget value="unowned"\/>/);
    assert.match(output, /<vendorAfter value="keep"\/>/);
    assert.equal(output.indexOf('id="n2"') < output.indexOf('id="n0"'), true);
    assert.match(output, /id="n3"[^>]*name="badge"/);
    assert.equal(
      await readFile(context.project.projectFile, "utf8"),
      projectBefore
    );
    assert.equal(
      await readFile(context.project.packageFile, "utf8"),
      packageBefore
    );

    const refreshed = await context.registry.read(
      context.projectId,
      (document) => {
        const component = document
          .getRoot()
          .getPackageById("pkg00001")
          ?.getComponent("Main");
        return {
          text: (
            component?.getChildById("n0") as
              | { getText(): string }
              | null
          )?.getText(),
          ids: component?.listChildren().map((child) => child.getId())
        };
      }
    );
    assert.deepEqual(refreshed, {
      ok: true,
      data: { text: "After", ids: ["n2", "n0", "n3"] }
    });
  }
  finally {
    await context.registry.closeAll();
  }
});

test("invalid DOM patch and transaction failure both leave source bytes unchanged", async () => {
  {
    const context = await setup("invalid");
    try {
      const before = await readFile(context.project.componentFile, "utf8");
      const result = await context.service.apply(patch(context.projectId, [{
        op: "set-text",
        selector: "#missing",
        expectedMatches: 1,
        text: "No"
      }]));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SELECTOR_MATCH_COUNT");
      assert.equal(await readFile(context.project.componentFile, "utf8"), before);
    }
    finally {
      await context.registry.closeAll();
    }
  }

  {
    const project = await createProject("rollback");
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-patch-fail-"));
    const validationDirectory = await mkdtemp(
      path.join(os.tmpdir(), "fgui-patch-fail-validate-")
    );
    temporaryDirectories.push(logDirectory, validationDirectory);
    const transactions = new FileTransactionManager({
      baseDirectory: logDirectory,
      faultInjector(point) {
        if (point === "after-replace") throw new Error("injected commit failure");
      }
    });
    const registry = new ProjectRegistry({ recovery: transactions });
    try {
      const opened = await registry.open(project.directory);
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      const service = new DomPatchService(registry, {
        transactions,
        temporaryRoot: validationDirectory
      });
      const before = await readFile(project.componentFile, "utf8");
      const result = await service.apply(patch(opened.data.projectId, [{
        op: "set-text",
        selector: "#n0",
        expectedMatches: 1,
        text: "No"
      }]));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "TRANSACTION_FAILED");
        assert.equal(typeof result.error.transactionId, "string");
        assert.equal(typeof result.error.logPath, "string");
      }
      assert.equal(await readFile(project.componentFile, "utf8"), before);
    }
    finally {
      await registry.closeAll();
    }
  }
});

test("a valid external edit before commit causes a fresh reparse and retry", async () => {
  let project: Awaited<ReturnType<typeof createProject>> | undefined;
  let hookCalls = 0;
  const context = await setup("retry", {
    async beforeCommit(attempt) {
      hookCalls++;
      if (attempt !== 0 || !project) return;
      const current = await readFile(project.componentFile, "utf8");
      await writeFile(
        project.componentFile,
        current.replace('text="Before"', 'text="External"'),
        "utf8"
      );
    }
  });
  project = context.project;
  try {
    const result = await context.service.apply(patch(context.projectId, [{
      op: "set-style",
      selector: "#n0",
      expectedMatches: 1,
      changes: { left: 44 }
    }]));

    assert.equal(result.ok, true);
    assert.equal(hookCalls >= 2, true);
    const output = await readFile(context.project.componentFile, "utf8");
    assert.match(output, /text="External"/);
    assert.match(output, /xy="44,20"/);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("same-project concurrent patches commit in call order and later fields win", async () => {
  const context = await setup("queue");
  try {
    const first = context.service.apply(patch(context.projectId, [{
      op: "set-text",
      selector: "#n0",
      expectedMatches: 1,
      text: "First"
    }]));
    const second = context.service.apply(patch(context.projectId, [{
      op: "set-text",
      selector: "#n0",
      expectedMatches: 1,
      text: "Second"
    }]));
    const results = await Promise.all([first, second]);

    assert.equal(results.every((result) => result.ok), true);
    assert.match(
      await readFile(context.project.componentFile, "utf8"),
      /text="Second"/
    );
  }
  finally {
    await context.registry.closeAll();
  }
});

test("a queued patch fails clearly when an earlier patch deleted its target", async () => {
  const context = await setup("deleted");
  try {
    const removing = context.service.apply(patch(context.projectId, [{
      op: "remove",
      selector: "#n0",
      expectedMatches: 1
    }]));
    const editing = context.service.apply(patch(context.projectId, [{
      op: "set-text",
      selector: "#n0",
      expectedMatches: 1,
      text: "Too late"
    }]));
    const [removed, failed] = await Promise.all([removing, editing]);

    assert.equal(removed.ok, true);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "SELECTOR_MATCH_COUNT");
    const output = await readFile(context.project.componentFile, "utf8");
    assert.doesNotMatch(output, /id="n0"/);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("successful patch output is the semantically re-read DOM", async () => {
  const context = await setup("roundtrip");
  try {
    const before = digest(await readFile(context.project.componentFile, "utf8"));
    const result = await context.service.apply(patch(context.projectId, [{
      op: "set-style",
      selector: "#n0",
      expectedMatches: 1,
      changes: { width: 180, opacity: 0.4 }
    }]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(
      digest(await readFile(context.project.componentFile, "utf8")),
      before
    );
    const node = result.data.dom.root.children.find((item) => item.id === "n0");
    assert.equal(node?.style.width, 180);
    assert.equal(node?.style.opacity, 0.4);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("a semantic DOM mismatch fails before any source file is written", async () => {
  class DivergentDomEngine extends DomPatchEngine {
    public override apply(
      ...args: Parameters<DomPatchEngine["apply"]>
    ): ReturnType<DomPatchEngine["apply"]> {
      const result = super.apply(...args);
      if (result.ok) {
        const target = result.data.dom.root.children.find(
          (item) => item.id === "n0"
        );
        if (target) target.style.opacity = 0.9;
      }
      return result;
    }
  }

  const context = await setup("semantic-mismatch", {
    engine: new DivergentDomEngine()
  });
  try {
    const before = await readFile(context.project.componentFile, "utf8");
    const result = await context.service.apply(patch(context.projectId, [{
      op: "set-style",
      selector: "#n0",
      expectedMatches: 1,
      changes: { width: 180 }
    }]));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SERIALIZATION_FAILED");
    assert.equal(await readFile(context.project.componentFile, "utf8"), before);
  }
  finally {
    await context.registry.closeAll();
  }
});
