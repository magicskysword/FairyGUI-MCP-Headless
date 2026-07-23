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
import { ApplyResourceOperationsInputSchema } from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { ResourceOperationsService } from "../../src/resources/resource-operations-service.js";
import { FileTransactionManager } from "../../src/write/file-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(): Promise<{
  directory: string;
  projectFile: string;
  packageFile: string;
  mainFile: string;
  imageFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-resources-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, "Demo.fairy");
  const packageFile = path.join(packageDirectory, "package.xml");
  const mainFile = path.join(packageDirectory, "Main.xml");
  const imageFile = path.join(packageDirectory, "icons", "Icon.png");
  await mkdir(path.dirname(imageFile), { recursive: true });
  await writeFile(
    projectFile,
    '<projectDescription id="resources" type="DOM" version="5.0"/>',
    "utf8"
  );
  await writeFile(
    packageFile,
    `<packageDescription id="pkg00001" vendorPackage="keep">
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
    <image id="img01" name="Icon.png" path="/icons/" exported="true"/>
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    mainFile,
    '<component size="320,180"><displayList/></component>',
    "utf8"
  );
  await writeFile(imageFile, new Uint8Array([10, 20, 30]));
  return { directory, projectFile, packageFile, mainFile, imageFile };
}

async function writeInboxFile(
  projectDirectory: string,
  relativePath: string,
  content: number[]
): Promise<string> {
  const filePath = path.join(
    projectDirectory,
    ".fairygui-mcp",
    "import-inbox",
    ...relativePath.split("/")
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, new Uint8Array(content));
  return filePath;
}

async function setup(options: {
  transactions?: FileTransactionManager;
} = {}) {
  const project = await createProject();
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-resource-log-"));
  const roundtripDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fgui-resource-roundtrip-")
  );
  temporaryDirectories.push(logDirectory, roundtripDirectory);
  const transactions = options.transactions
    ?? new FileTransactionManager({ baseDirectory: logDirectory });
  const registry = new ProjectRegistry({ recovery: transactions });
  const opened = await registry.open(project.directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return {
    project,
    registry,
    projectId: opened.data.projectId,
    service: new ResourceOperationsService(registry, {
      transactions,
      temporaryRoot: roundtripDirectory
    })
  };
}

function createBatch(projectId: string) {
  return ApplyResourceOperationsInputSchema.parse({
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
        path: "/screens/",
        width: 640,
        height: 360
      },
      {
        op: "create-component",
        packageId: "pkg00001",
        clientRef: "card",
        name: "Card",
        width: 100,
        height: 40
      }
    ]
  });
}

test("resource service atomically creates package and component files", async () => {
  const context = await setup();
  try {
    const mainBefore = await readFile(context.project.mainFile, "utf8");
    const result = await context.service.apply(createBatch(context.projectId));

    if (!result.ok) {
      assert.fail(`${result.error.code}: ${result.error.message} ${
        JSON.stringify(result.error.actual)
      }`);
    }
    const widgetsId = result.data.clientRefs.widgets!.packageId;
    const dialogId = result.data.clientRefs.dialog!.resourceId!;
    const cardId = result.data.clientRefs.card!.resourceId!;
    assert.deepEqual(result.data.affectedFiles, [
      "assets/Demo/Card.xml",
      "assets/Demo/package.xml",
      "assets/Widgets/package.xml",
      "assets/Widgets/screens/Dialog.xml"
    ]);
    assert.match(
      await readFile(
        path.join(context.project.directory, "assets", "Widgets", "package.xml"),
        "utf8"
      ),
      new RegExp(`id="${widgetsId}"`)
    );
    assert.match(
      await readFile(
        path.join(
          context.project.directory,
          "assets",
          "Widgets",
          "screens",
          "Dialog.xml"
        ),
        "utf8"
      ),
      /size="640,360"/
    );
    const demoPackage = await readFile(context.project.packageFile, "utf8");
    assert.match(demoPackage, new RegExp(`id="${cardId}"`));
    assert.match(demoPackage, /vendorPackage="keep"/);
    assert.equal(await readFile(context.project.mainFile, "utf8"), mainBefore);

    const reparsed = await context.registry.read(
      context.projectId,
      (document) => ({
        widgets: document.getRoot().getPackageById(widgetsId)?.getResourceById(
          dialogId
        )?.getName(),
        card: document.getRoot().getPackageById("pkg00001")?.getResourceById(
          cardId
        )?.getName()
      })
    );
    assert.equal(reparsed.ok, true);
    if (reparsed.ok) {
      assert.deepEqual(reparsed.data, {
        widgets: "Dialog",
        card: "Card"
      });
    }
  }
  finally {
    await context.registry.closeAll();
  }
});

test("resource creation transaction failure leaves all source files unchanged", async () => {
  let failed = false;
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-resource-fail-"));
  temporaryDirectories.push(logDirectory);
  const transactions = new FileTransactionManager({
    baseDirectory: logDirectory,
    faultInjector(point) {
      if (point === "after-replace" && !failed) {
        failed = true;
        throw new Error("injected creation failure");
      }
    }
  });
  const context = await setup({ transactions });
  try {
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const result = await context.service.apply(createBatch(context.projectId));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
    assert.equal(
      await readFile(context.project.packageFile, "utf8"),
      packageBefore
    );
    await assert.rejects(
      readFile(
        path.join(context.project.directory, "assets", "Demo", "Card.xml")
      ),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(
        path.join(
          context.project.directory,
          "assets",
          "Widgets",
          "package.xml"
        )
      ),
      { code: "ENOENT" }
    );
  }
  finally {
    await context.registry.closeAll();
  }
});

test("package rename and component move commit old-path deletion with new files", async () => {
  const context = await setup();
  try {
    const result = await context.service.apply(
      ApplyResourceOperationsInputSchema.parse({
        projectId: context.projectId,
        operations: [
          {
            op: "rename-package",
            packageId: "pkg00001",
            name: "Renamed"
          },
          {
            op: "rename-resource",
            packageId: "pkg00001",
            resourceId: "cmp01",
            name: "Dashboard"
          },
          {
            op: "move-resource",
            packageId: "pkg00001",
            resourceId: "cmp01",
            path: "/screens/"
          }
        ]
      })
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.affectedFiles, [
      "assets/Demo/icons/Icon.png",
      "assets/Demo/Main.xml",
      "assets/Demo/package.xml",
      "assets/Renamed/icons/Icon.png",
      "assets/Renamed/package.xml",
      "assets/Renamed/screens/Dashboard.xml"
    ]);
    await assert.rejects(readFile(context.project.packageFile), {
      code: "ENOENT"
    });
    await assert.rejects(readFile(context.project.mainFile), {
      code: "ENOENT"
    });
    await assert.rejects(readFile(context.project.imageFile), {
      code: "ENOENT"
    });
    assert.deepEqual(
      [...await readFile(path.join(
        context.project.directory,
        "assets",
        "Renamed",
        "icons",
        "Icon.png"
      ))],
      [10, 20, 30]
    );
    const renamedPackage = await readFile(
      path.join(
        context.project.directory,
        "assets",
        "Renamed",
        "package.xml"
      ),
      "utf8"
    );
    assert.match(renamedPackage, /vendorPackage="keep"/);
    assert.match(
      renamedPackage,
      /name="Dashboard\.xml" path="\/screens\/"/
    );
    assert.match(
      await readFile(
        path.join(
          context.project.directory,
          "assets",
          "Renamed",
          "screens",
          "Dashboard.xml"
        ),
        "utf8"
      ),
      /<component size="320,180"\/>/
    );
    const reparsed = await context.registry.read(
      context.projectId,
      (document) => {
        const pkg = document.getRoot().getPackageById("pkg00001");
        const component = pkg?.getResourceById("cmp01");
        return {
          packageName: pkg?.getName(),
          resourceName: component?.getName(),
          resourcePath: component?.getPath()
        };
      }
    );
    assert.equal(reparsed.ok, true);
    if (reparsed.ok) {
      assert.deepEqual(reparsed.data, {
        packageName: "Renamed",
        resourceName: "Dashboard",
        resourcePath: "/screens/"
      });
    }
  }
  finally {
    await context.registry.closeAll();
  }
});

test("resource import writes bytes, updates package metadata and consumes inbox", async () => {
  const context = await setup();
  const inboxFile = await writeInboxFile(
    context.project.directory,
    "weapons/sword.png",
    [1, 2, 3, 4]
  );
  try {
    const result = await context.service.apply(
      ApplyResourceOperationsInputSchema.parse({
        projectId: context.projectId,
        operations: [{
          op: "import",
          packageId: "pkg00001",
          clientRef: "sword",
          inboxPath: "weapons/sword.png",
          name: "Sword",
          path: "/items/",
          conflict: "reject"
        }]
      })
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const resourceId = result.data.clientRefs.sword!.resourceId!;
    assert.deepEqual(result.data.consumedInboxPaths, [
      ".fairygui-mcp/import-inbox/weapons/sword.png"
    ]);
    assert.deepEqual(result.data.affectedFiles, [
      ".fairygui-mcp/import-inbox/weapons/sword.png",
      "assets/Demo/items/Sword.png",
      "assets/Demo/package.xml"
    ]);
    assert.deepEqual(
      [...await readFile(path.join(
        context.project.directory,
        "assets",
        "Demo",
        "items",
        "Sword.png"
      ))],
      [1, 2, 3, 4]
    );
    await assert.rejects(readFile(inboxFile), { code: "ENOENT" });
    assert.match(
      await readFile(context.project.packageFile, "utf8"),
      new RegExp(
        `<image id="${resourceId}" name="Sword\\.png" path="/items/"`
      )
    );
  }
  finally {
    await context.registry.closeAll();
  }
});

test("replace-resource preserves id and atomically changes the asset extension", async () => {
  const context = await setup();
  const inboxFile = await writeInboxFile(
    context.project.directory,
    "replacement.jpg",
    [90, 91]
  );
  try {
    const result = await context.service.apply(
      ApplyResourceOperationsInputSchema.parse({
        projectId: context.projectId,
        operations: [{
          op: "replace-resource",
          packageId: "pkg00001",
          resourceId: "img01",
          inboxPath: "replacement.jpg"
        }]
      })
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    await assert.rejects(readFile(context.project.imageFile), {
      code: "ENOENT"
    });
    const replacementPath = path.join(
      context.project.directory,
      "assets",
      "Demo",
      "icons",
      "Icon.jpg"
    );
    assert.deepEqual([...await readFile(replacementPath)], [90, 91]);
    await assert.rejects(readFile(inboxFile), { code: "ENOENT" });
    const packageXml = await readFile(context.project.packageFile, "utf8");
    assert.match(packageXml, /<image id="img01" name="Icon\.jpg"/);
    assert.doesNotMatch(packageXml, /id="img01" name="Icon\.png"/);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("rejected import preserves inbox bytes and all existing resources", async () => {
  const context = await setup();
  const inboxFile = await writeInboxFile(
    context.project.directory,
    "conflict.png",
    [7, 8, 9]
  );
  try {
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const imageBefore = await readFile(context.project.imageFile);
    const result = await context.service.apply(
      ApplyResourceOperationsInputSchema.parse({
        projectId: context.projectId,
        operations: [{
          op: "import",
          packageId: "pkg00001",
          clientRef: "conflict",
          inboxPath: "conflict.png",
          name: "Icon",
          path: "/icons/",
          conflict: "reject"
        }]
      })
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RESOURCE_CONFLICT");
    assert.equal(
      await readFile(context.project.packageFile, "utf8"),
      packageBefore
    );
    assert.deepEqual(await readFile(context.project.imageFile), imageBefore);
    assert.deepEqual([...await readFile(inboxFile)], [7, 8, 9]);
  }
  finally {
    await context.registry.closeAll();
  }
});

test("failed import transaction restores the consumed inbox file", async () => {
  let injected = false;
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-import-fail-"));
  temporaryDirectories.push(logDirectory);
  const transactions = new FileTransactionManager({
    baseDirectory: logDirectory,
    faultInjector(point) {
      if (point === "after-replace" && !injected) {
        injected = true;
        throw new Error("injected import failure");
      }
    }
  });
  const context = await setup({ transactions });
  const inboxFile = await writeInboxFile(
    context.project.directory,
    "failed.png",
    [4, 5, 6]
  );
  try {
    const packageBefore = await readFile(context.project.packageFile, "utf8");
    const result = await context.service.apply(
      ApplyResourceOperationsInputSchema.parse({
        projectId: context.projectId,
        operations: [{
          op: "import",
          packageId: "pkg00001",
          clientRef: "failed",
          inboxPath: "failed.png",
          name: "Failed",
          path: "/",
          conflict: "reject"
        }]
      })
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
    assert.deepEqual([...await readFile(inboxFile)], [4, 5, 6]);
    assert.equal(
      await readFile(context.project.packageFile, "utf8"),
      packageBefore
    );
    await assert.rejects(
      readFile(path.join(
        context.project.directory,
        "assets",
        "Demo",
        "Failed.png"
      )),
      { code: "ENOENT" }
    );
  }
  finally {
    await context.registry.closeAll();
  }
});
