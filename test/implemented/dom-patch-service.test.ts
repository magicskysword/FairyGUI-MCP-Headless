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
import type { FairyDomDocument } from "../../src/contracts/dom.js";
import {
  DomPatchService,
  type DomPatchServiceOptions
} from "../../src/dom/dom-patch-service.js";
import { DomPatchEngine } from "../../src/dom/dom-patch-engine.js";
import { toFairyDomDocument } from "../../src/dom/openfairygui-adapter.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { ProjectCommitCoordinator } from "../../src/write/commit-coordinator.js";
import { FileTransactionManager } from "../../src/write/file-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(label: string, options: {
  unrelatedOutputConflict?: boolean;
} = {}): Promise<{
  directory: string;
  projectFile: string;
  packageFile: string;
  componentFile: string;
  buttonFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `fgui-patch-${label}-`));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, `${label}.fairy`);
  const packageFile = path.join(packageDirectory, "package.xml");
  const componentFile = path.join(packageDirectory, "Main.xml");
  const buttonFile = path.join(packageDirectory, "Button.xml");
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
    <component id="btn01" name="Button.xml" path="/" exported="true"/>
    ${options.unrelatedOutputConflict
      ? '<image id="dupimg1" name="Collision.png" path="/images/" width="16" height="16"/>\n    <image id="dupimg2" name="Collision.png" path="/images/" width="16" height="16"/>'
      : ""}
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
  await writeFile(
    buttonFile,
    `<component size="80,30" extention="Button">
  <displayList/>
  <Button/>
</component>`,
    "utf8"
  );
  return {
    directory,
    projectFile,
    packageFile,
    componentFile,
    buttonFile
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setup(label: string, options: {
  transactionManager?: FileTransactionManager;
  beforeCommit?: DomPatchServiceOptions["beforeCommit"];
  engine?: DomPatchEngine;
  coordinator?: ProjectCommitCoordinator;
  unrelatedOutputConflict?: boolean;
} = {}) {
  const project = await createProject(label, options);
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
    ...(options.coordinator === undefined
      ? {}
      : { coordinator: options.coordinator }),
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

async function readDom(context: {
  registry: ProjectRegistry;
  projectId: string;
}): Promise<FairyDomDocument> {
  const result = await context.registry.read(
    context.projectId,
    (document) => toFairyDomDocument(document, "pkg00001", "cmp01")
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

test("DOM patch preparation uses the concurrent preparation queue", async () => {
  class TrackingCoordinator extends ProjectCommitCoordinator {
    public preparedCalls = 0;

    public override runPrepared<TPrepared, TResult>(
      projectId: string,
      prepare: () => Promise<TPrepared> | TPrepared,
      commit: (prepared: TPrepared) => Promise<TResult> | TResult
    ): Promise<TResult> {
      this.preparedCalls++;
      return super.runPrepared<TPrepared, TResult>(
        projectId,
        prepare,
        commit
      );
    }
  }

  const coordinator = new TrackingCoordinator();
  const context = await setup("prepared-queue", { coordinator });
  try {
    const result = await context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { content: { text: "Prepared" } }
    }]));

    assert.equal(result.ok, true);
    assert.equal(coordinator.preparedCalls, 1);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("DOM patch service writes one component atomically and preserves opaque XML", async () => {
  const context = await setup("write");
  try {
    const projectBefore = await readFile(context.project.projectFile, "utf8");
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const result = await context.service.apply(patch(context.projectId, [
      {
        op: "update",
        selector: "#n0",
        expectedMatches: 1,
        changes: { content: { text: "After" } }
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
    assert.deepEqual(result.data.operationResults, [
      { index: 0, op: "update", affectedNodeIds: ["n0"] },
      { index: 1, op: "move", affectedNodeIds: ["n2"] },
      { index: 2, op: "insert", affectedNodeIds: ["n3"] }
    ]);
    assert.deepEqual(result.data.affectedNodeIds, ["n0", "n2", "n3"]);
    assert.equal("dom" in result.data, false);
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

test("DOM patch roundtrip ignores unrelated package output conflicts", async () => {
  const context = await setup("unrelated-output-conflict", {
    unrelatedOutputConflict: true
  });
  try {
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const result = await context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { content: { text: "Conflict-safe" } }
    }]));

    if (!result.ok) {
      assert.fail(`${result.error.code}: ${result.error.message} ${
        JSON.stringify(result.error.actual)
      }`);
    }
    assert.deepEqual(result.data.affectedFiles, ["assets/Demo/Main.xml"]);
    assert.match(
      await readFile(context.project.componentFile, "utf8"),
      /text="Conflict-safe"/
    );
    assert.equal(
      await readFile(context.project.packageFile, "utf8"),
      packageBefore
    );
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
        op: "update",
        selector: "#missing",
        expectedMatches: 1,
        changes: { content: { text: "No" } }
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
        op: "update",
        selector: "#n0",
        expectedMatches: 1,
        changes: { content: { text: "No" } }
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
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { style: { left: 44 } }
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

test("an external edit after the service comparison is never overwritten", async () => {
  class LateExternalEditManager extends FileTransactionManager {
    private injected = false;

    public override async commit(
      ...args: Parameters<FileTransactionManager["commit"]>
    ): ReturnType<FileTransactionManager["commit"]> {
      if (!this.injected) {
        this.injected = true;
        const componentFile = path.join(
          args[0],
          "assets",
          "Demo",
          "Main.xml"
        );
        const current = await readFile(componentFile, "utf8");
        await writeFile(
          componentFile,
          current.replace('text="Before"', 'text="External"'),
          "utf8"
        );
      }
      return super.commit(...args);
    }
  }

  const logDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fgui-patch-late-edit-")
  );
  temporaryDirectories.push(logDirectory);
  const context = await setup("late-edit", {
    transactionManager: new LateExternalEditManager({
      baseDirectory: logDirectory
    })
  });
  try {
    const result = await context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { style: { left: 44 } }
    }]));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WRITE_FAILED");
    const output = await readFile(context.project.componentFile, "utf8");
    assert.match(output, /text="External"/);
    assert.match(output, /xy="10,20"/);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("same-project concurrent patches commit in call order and later fields win", async () => {
  const context = await setup("queue");
  try {
    const first = context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { content: { text: "First" } }
    }]));
    const second = context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { content: { text: "Second" } }
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
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { content: { text: "Too late" } }
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

test("successful patch returns a compact summary after semantic re-read", async () => {
  const context = await setup("roundtrip");
  try {
    const before = digest(await readFile(context.project.componentFile, "utf8"));
    const result = await context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { style: { width: 180, opacity: 0.4 } }
    }]));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(
      digest(await readFile(context.project.componentFile, "utf8")),
      before
    );
    assert.equal("dom" in result.data, false);
    assert.deepEqual(result.data.operationResults, [{
      index: 0,
      op: "update",
      affectedNodeIds: ["n0"]
    }]);
    assert.deepEqual(result.data.affectedNodeIds, ["n0"]);
    const dom = await readDom(context);
    const node = dom.root.children.find((item) => item.id === "n0");
    assert.equal(node?.style.width, 180);
    assert.equal(node?.style.opacity, 0.4);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("hex colors remain semantically equal when serialization changes case", async () => {
  const context = await setup("color-case");
  try {
    const result = await context.service.apply(patch(context.projectId, [{
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: {
        content: { color: "#AABBCC" }
      }
    }]));

    assert.equal(result.ok, true, JSON.stringify(result));
    const dom = await readDom(context);
    const node = dom.root.children.find((item) => item.id === "n0");
    assert.equal(
      node?.type === "text" ? node.content.color : undefined,
      "#aabbcc"
    );
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
      op: "update",
      selector: "#n0",
      expectedMatches: 1,
      changes: { style: { width: 180 } }
    }]));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SERIALIZATION_FAILED");
    assert.equal(await readFile(context.project.componentFile, "utf8"), before);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("every V1 writable node, style, Group, Relation and List survives disk round-trip", async () => {
  const context = await setup("v1-matrix");
  try {
    const common = {
      op: "insert" as const,
      parentSelector: "component-root",
      expectedMatches: 1 as const
    };
    const result = await context.service.apply(patch(context.projectId, [
      {
        ...common,
        clientRef: "layout",
        node: {
          type: "group",
          name: "layout",
          style: {
            left: 2,
            top: 3,
            width: 250,
            height: 80,
            opacity: 0.8,
            rotation: 2,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            layout: "horizontal",
            lineGap: 4,
            columnGap: 5,
            excludeInvisibles: true,
            autoSizeDisabled: true,
            mainGridIndex: 1
          }
        }
      },
      {
        ...common,
        clientRef: "image",
        node: {
          type: "image",
          name: "image",
          groupId: "layout",
          style: {
            left: 10,
            top: 11,
            width: 40,
            height: 41,
            opacity: 0.7,
            rotation: 12,
            scaleX: 1.2,
            scaleY: 0.8,
            skewX: 3,
            skewY: 4,
            pivotX: 0.5,
            pivotY: 0.25,
            pivotAsAnchor: true,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [{
            targetId: "layout",
            type: "Left_Left",
            percent: false
          }],
          content: {
            flip: "both",
            fillMethod: "radial-360",
            fillAmount: 0.5,
            color: "#aabbcc"
          }
        }
      },
      {
        ...common,
        clientRef: "text",
        node: {
          type: "text",
          name: "text",
          groupId: "layout",
          style: {
            left: 20,
            top: 21,
            width: 120,
            height: 24,
            minWidth: 40,
            maxWidth: 180,
            minHeight: 12,
            maxHeight: 48,
            opacity: 0.6,
            rotation: 6,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [{
            targetId: "layout",
            type: "Width",
            percent: true
          }],
          content: {
            text: "Plain",
            fontSize: 18,
            color: "#112233",
            align: "center",
            verticalAlign: "middle",
            autoSize: "none",
            singleLine: true,
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
            lineSpacing: 6,
            letterSpacing: 2
          }
        }
      },
      {
        ...common,
        clientRef: "rich",
        node: {
          type: "rich-text",
          name: "rich",
          style: {
            left: 30,
            top: 31,
            width: 130,
            height: 25,
            opacity: 0.55,
            rotation: 7,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            text: "[b]Rich[/b]",
            ubb: true,
            bold: true
          }
        }
      },
      {
        ...common,
        clientRef: "input",
        node: {
          type: "input-text",
          name: "input",
          style: {
            left: 40,
            top: 41,
            width: 140,
            height: 26,
            opacity: 0.5,
            rotation: 8,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            text: "",
            prompt: "Type",
            restrict: "A-Z",
            maxLength: 20,
            password: true,
            keyboardType: "email"
          }
        }
      },
      {
        ...common,
        clientRef: "loader",
        node: {
          type: "loader",
          name: "loader",
          style: {
            left: 50,
            top: 51,
            width: 50,
            height: 51,
            opacity: 0.45,
            rotation: 9,
            scaleX: 1.1,
            scaleY: 1.2,
            pivotX: 0.2,
            pivotY: 0.3,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            externalUrl: "asset://preview.png",
            fill: "scale-free",
            align: "right",
            verticalAlign: "bottom",
            autoSize: true,
            playing: false,
            frame: 2
          }
        }
      },
      {
        ...common,
        clientRef: "graph",
        node: {
          type: "graph",
          name: "graph",
          style: {
            left: 60,
            top: 61,
            width: 60,
            height: 61,
            minWidth: 20,
            maxWidth: 90,
            minHeight: 21,
            maxHeight: 91,
            opacity: 0.4,
            rotation: 10,
            skewX: 5,
            skewY: 6,
            pivotX: 0.4,
            pivotY: 0.6,
            pivotAsAnchor: true,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            shape: "polygon",
            fillColor: "#123456",
            lineColor: "#654321",
            lineSize: 2,
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
              { x: 20, y: 0 }
            ]
          }
        }
      },
      {
        ...common,
        clientRef: "movie",
        node: {
          type: "movie-clip",
          name: "movie",
          style: {
            left: 70,
            top: 71,
            width: 70,
            height: 71,
            opacity: 0.35,
            rotation: 11,
            pivotX: 0.3,
            pivotY: 0.7,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            playing: false,
            frame: 3,
            color: "#abcdef"
          }
        }
      },
      {
        ...common,
        clientRef: "list",
        node: {
          type: "list",
          name: "list",
          style: {
            left: 80,
            top: 81,
            width: 160,
            height: 90,
            opacity: 0.3,
            rotation: 13,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            layout: "flow-horizontal",
            defaultItem: {
              packageId: "pkg00001",
              resourceId: "cmp01"
            },
            lineGap: 3,
            columnGap: 4,
            columnCount: 3,
            autoResizeItem: false,
            align: "center",
            verticalAlign: "middle",
            items: [{
              name: "first",
              title: "First",
              selectedTitle: "Selected",
              resource: {
                packageId: "pkg00001",
                resourceId: "cmp01"
              }
            }]
          }
        }
      },
      {
        ...common,
        clientRef: "instance",
        node: {
          type: "instance",
          name: "instance",
          style: {
            left: 90,
            top: 91,
            width: 100,
            height: 40,
            minWidth: 50,
            maxWidth: 150,
            minHeight: 20,
            maxHeight: 60,
            opacity: 0.25,
            rotation: 14,
            scaleX: 0.9,
            scaleY: 1.1,
            pivotX: 0.5,
            pivotY: 0.5,
            pivotAsAnchor: true,
            visible: false,
            touchable: false,
            grayed: true
          },
          relations: [],
          content: {
            resource: {
              packageId: "pkg00001",
              resourceId: "cmp01"
            }
          }
        }
      }
    ]));

    if (!result.ok) {
      assert.fail(`${result.error.code} at ${result.error.path}: ${
        result.error.message
      } ${
        JSON.stringify(result.error.actual)
      }`);
    }
    assert.equal(result.ok, true);
    assert.equal(result.data.appliedOperations, 10);
    const dom = await readDom(context);
    assert.deepEqual(
      dom.root.children.slice(-10).map((node) => node.type),
      [
        "group",
        "image",
        "text",
        "rich-text",
        "input-text",
        "loader",
        "graph",
        "movie-clip",
        "list",
        "instance"
      ]
    );
    const image = dom.root.children.find(
      (node) => node.name === "image"
    );
    assert.equal(image?.style.skewX, 3);
    assert.equal(image?.style.touchable, false);
    assert.equal(image?.groupId, result.data.clientRefs.layout);
    assert.deepEqual(image?.relations, [{
      targetId: result.data.clientRefs.layout,
      type: "Left_Left",
      percent: false
    }]);
    const list = dom.root.children.find(
      (node) => node.type === "list" && node.name === "list"
    );
    assert.equal(list?.type === "list" && list.content.lineCount, 0);
    assert.equal(list?.type === "list" && list.content.columnCount, 3);
    assert.equal(list?.type === "list" && list.content.items[0]?.title, "First");
  }
  finally {
    await context.registry.closeAll();
  }
});

test("Button instance overlays inherit source extension and survive disk round-trip", async () => {
  const context = await setup("button-instance");
  try {
    const result = await context.service.apply(patch(context.projectId, [{
      op: "insert",
      parentSelector: "component-root",
      expectedMatches: 1,
      clientRef: "action",
      node: {
        type: "instance",
        name: "action",
        style: { left: 20, top: 100, width: 80, height: 30 },
        relations: [],
        content: {
          resource: {
            packageId: "pkg00001",
            resourceId: "btn01"
          },
          text: "Action",
          selected: true
        }
      }
    }]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const dom = await readDom(context);
    const instance = dom.root.children.find(
      (node) => node.name === "action"
    );
    assert.equal(
      instance?.type === "instance" ? instance.content.text : undefined,
      "Action"
    );
    assert.equal(
      instance?.type === "instance" ? instance.content.selected : undefined,
      true
    );
    const output = await readFile(context.project.componentFile, "utf8");
    assert.match(output, /src="btn01"/);
    assert.match(output, /<Button[^>]*title="Action"[^>]*checked="1"/);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("component root update survives disk round-trip without losing opaque data", async () => {
  const context = await setup("component-properties");
  try {
    const result = await context.service.apply(
      ApplyDomPatchInputSchema.parse({
        projectId: context.projectId,
        packageId: "pkg00001",
        componentId: "cmp01",
        operations: [{
          op: "update",
          selector: "component-root",
          expectedMatches: 1,
          changes: {
            style: {
              width: 640,
              height: 360,
              minWidth: 100,
              maxWidth: 800,
              minHeight: 80,
              maxHeight: 500,
              pivotX: 0.5,
              pivotY: 0.5,
              pivotAsAnchor: true
            },
            content: {
              overflow: "scroll",
              scrollAxis: "both",
              opaque: false,
              backgroundColor: "#112233",
              maskId: "n0",
              reversedMask: true
            }
          }
        }]
      })
    );

    if (!result.ok) {
      assert.fail(`${result.error.code} at ${result.error.path}: ${
        result.error.message
      } ${JSON.stringify(result.error.actual)}`);
    }
    const dom = await readDom(context);
    assert.equal(dom.root.style.width, 640);
    assert.equal(dom.root.style.maxHeight, 500);
    assert.deepEqual(dom.root.content, {
      overflow: "scroll",
      scrollAxis: "both",
      opaque: false,
      backgroundColor: "#112233",
      maskId: "n0",
      reversedMask: true
    });
    const output = await readFile(context.project.componentFile, "utf8");
    assert.match(output, /vendorRoot="keep"/);
    assert.match(output, /size="640,360"/);
    assert.match(output, /restrictSize="100,800,80,500"/);
    assert.match(output, /mask="n0"/);
    assert.match(output, /reversedMask="1"/);
  }
  finally {
    await context.registry.closeAll();
  }
});
