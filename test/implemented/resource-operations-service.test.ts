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
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-resources-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  const projectFile = path.join(directory, "Demo.fairy");
  const packageFile = path.join(packageDirectory, "package.xml");
  const mainFile = path.join(packageDirectory, "Main.xml");
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
  </resources>
</packageDescription>`,
    "utf8"
  );
  await writeFile(
    mainFile,
    '<component size="320,180"><displayList/></component>',
    "utf8"
  );
  return { directory, projectFile, packageFile, mainFile };
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
