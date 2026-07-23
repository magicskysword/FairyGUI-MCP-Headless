import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  FileTransactionManager,
  SimulatedTransactionCrash
} from "../../src/write/file-transaction.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFilesFixture(): Promise<{
  projectDirectory: string;
  logDirectory: string;
  first: string;
  second: string;
}> {
  const projectDirectory = await temporaryDirectory("fgui-tx-project-");
  const logDirectory = await temporaryDirectory("fgui-tx-log-");
  const assets = path.join(projectDirectory, "assets");
  await mkdir(assets);
  const first = path.join(assets, "first.xml");
  const second = path.join(assets, "second.xml");
  await writeFile(first, "first-before", "utf8");
  await writeFile(second, "second-before", "utf8");
  return { projectDirectory, logDirectory, first, second };
}

test("a file transaction commits all affected files and a terminal journal", async () => {
  const fixture = await createFilesFixture();
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory,
    idFactory: () => "tx_commit"
  });

  const result = await manager.commit(fixture.projectDirectory, [
    { relativePath: "assets/first.xml", content: "first-after" },
    {
      relativePath: "assets/second.xml",
      content: new TextEncoder().encode("second-after")
    }
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.transactionId, "tx_commit");
  assert.deepEqual(result.data.affectedFiles, [
    "assets/first.xml",
    "assets/second.xml"
  ]);
  assert.equal(await readFile(fixture.first, "utf8"), "first-after");
  assert.equal(await readFile(fixture.second, "utf8"), "second-after");
  const journal = JSON.parse(
    await readFile(path.join(result.data.logPath, "journal.json"), "utf8")
  ) as { state: string };
  assert.equal(journal.state, "committed");
});

test("an ordinary commit failure rolls every changed file back", async () => {
  const fixture = await createFilesFixture();
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory,
    idFactory: () => "tx_rollback",
    faultInjector(point, context) {
      if (point === "after-replace" && context.fileIndex === 0) {
        throw new Error("injected replacement failure");
      }
    }
  });

  const result = await manager.commit(fixture.projectDirectory, [
    { relativePath: "assets/first.xml", content: "first-after" },
    { relativePath: "assets/second.xml", content: "second-after" }
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "TRANSACTION_FAILED");
  assert.equal(result.error.transactionId, "tx_rollback");
  assert.match(result.error.logPath ?? "", /tx_rollback$/);
  assert.equal(await readFile(fixture.first, "utf8"), "first-before");
  assert.equal(await readFile(fixture.second, "utf8"), "second-before");
  const journal = JSON.parse(
    await readFile(path.join(result.error.logPath!, "journal.json"), "utf8")
  ) as { state: string };
  assert.equal(journal.state, "rolled-back");
});

test("startup recovery restores an interrupted multi-file transaction", async () => {
  const fixture = await createFilesFixture();
  const crashingManager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory,
    idFactory: () => "tx_interrupted",
    faultInjector(point, context) {
      if (point === "after-replace" && context.fileIndex === 0) {
        throw new SimulatedTransactionCrash("simulated process exit");
      }
    }
  });

  const interrupted = await crashingManager.commit(fixture.projectDirectory, [
    { relativePath: "assets/first.xml", content: "first-after" },
    { relativePath: "assets/second.xml", content: "second-after" }
  ]);
  assert.equal(interrupted.ok, false);
  assert.equal(await readFile(fixture.first, "utf8"), "first-after");
  assert.equal(await readFile(fixture.second, "utf8"), "second-before");

  const recoveringManager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory
  });
  await recoveringManager.recover(fixture.projectDirectory);

  assert.equal(await readFile(fixture.first, "utf8"), "first-before");
  assert.equal(await readFile(fixture.second, "utf8"), "second-before");
  if (interrupted.ok) return;
  const journal = JSON.parse(
    await readFile(path.join(interrupted.error.logPath!, "journal.json"), "utf8")
  ) as { state: string };
  assert.equal(journal.state, "rolled-back");
});

test("rollback removes files that did not exist before the transaction", async () => {
  const fixture = await createFilesFixture();
  const created = path.join(fixture.projectDirectory, "assets", "created.xml");
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory,
    idFactory: () => "tx_created",
    faultInjector(point, context) {
      if (point === "after-replace" && context.fileIndex === 0) {
        throw new Error("stop after creating the first file");
      }
    }
  });

  const result = await manager.commit(fixture.projectDirectory, [
    { relativePath: "assets/created.xml", content: "created" },
    { relativePath: "assets/second.xml", content: "second-after" }
  ]);

  assert.equal(result.ok, false);
  await assert.rejects(readFile(created), { code: "ENOENT" });
  assert.equal(await readFile(fixture.second, "utf8"), "second-before");
});

test("a file transaction can delete a regular file atomically", async () => {
  const fixture = await createFilesFixture();
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory,
    idFactory: () => "tx_delete"
  });

  const result = await manager.commit(fixture.projectDirectory, [{
    relativePath: "assets/first.xml",
    content: null
  }]);

  assert.equal(result.ok, true);
  await assert.rejects(readFile(fixture.first), { code: "ENOENT" });
  assert.equal(await readFile(fixture.second, "utf8"), "second-before");
});

test("failed and interrupted deletion transactions restore removed files", async () => {
  for (const simulatedCrash of [false, true]) {
    const fixture = await createFilesFixture();
    const manager = new FileTransactionManager({
      baseDirectory: fixture.logDirectory,
      idFactory: () => simulatedCrash
        ? "tx_delete_crash"
        : "tx_delete_rollback",
      faultInjector(point, context) {
        if (point !== "after-replace" || context.fileIndex !== 0) return;
        if (simulatedCrash) {
          throw new SimulatedTransactionCrash("crash after delete");
        }
        throw new Error("fail after delete");
      }
    });

    const result = await manager.commit(fixture.projectDirectory, [
      { relativePath: "assets/first.xml", content: null },
      { relativePath: "assets/second.xml", content: "second-after" }
    ]);
    assert.equal(result.ok, false);

    if (simulatedCrash) {
      await assert.rejects(readFile(fixture.first), { code: "ENOENT" });
      await new FileTransactionManager({
        baseDirectory: fixture.logDirectory
      }).recover(fixture.projectDirectory);
    }

    assert.equal(await readFile(fixture.first, "utf8"), "first-before");
    assert.equal(await readFile(fixture.second, "utf8"), "second-before");
  }
});

test("transaction paths must be unique canonical project-relative paths", async () => {
  const fixture = await createFilesFixture();
  const outside = path.join(path.dirname(fixture.projectDirectory), "outside.txt");
  temporaryDirectories.push(outside);
  await writeFile(outside, "outside-before", "utf8");
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory
  });

  for (const changes of [
    [{ relativePath: "../outside.txt", content: "bad" }],
    [{ relativePath: outside, content: "bad" }],
    [
      { relativePath: "assets/first.xml", content: "one" },
      { relativePath: "assets/./first.xml", content: "two" }
    ]
  ]) {
    const result = await manager.commit(fixture.projectDirectory, changes);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
  }

  assert.equal(await readFile(outside, "utf8"), "outside-before");
  assert.equal(await readFile(fixture.first, "utf8"), "first-before");
});

test("transaction targets reject symbolic links", async (context) => {
  const fixture = await createFilesFixture();
  const outside = path.join(path.dirname(fixture.projectDirectory), "linked.txt");
  temporaryDirectories.push(outside);
  await writeFile(outside, "outside-before", "utf8");
  const link = path.join(fixture.projectDirectory, "assets", "linked.xml");
  try {
    await symlink(outside, link, "file");
  }
  catch (error) {
    context.skip(`当前环境不能创建符号链接：${String(error)}`);
    return;
  }
  const manager = new FileTransactionManager({
    baseDirectory: fixture.logDirectory
  });

  const result = await manager.commit(fixture.projectDirectory, [
    { relativePath: "assets/linked.xml", content: "bad" }
  ]);

  assert.equal(result.ok, false);
  assert.equal(await readFile(outside, "utf8"), "outside-before");
});

test("ProjectRegistry runs transaction recovery before parsing a project", async () => {
  const projectDirectory = await temporaryDirectory("fgui-tx-open-");
  const logDirectory = await temporaryDirectory("fgui-tx-open-log-");
  const packageDirectory = path.join(projectDirectory, "assets", "Package1");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(projectDirectory, "Demo.fairy"),
    '<projectDescription id="Demo" type="DOM" version="5.0"/>',
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<packageDescription id="pkg00001"><resources>
      <component id="cmp01" name="Main.xml" path="/" exported="true"/>
    </resources></packageDescription>`,
    "utf8"
  );
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    '<component size="100,100"><displayList/></component>',
    "utf8"
  );
  const crashingManager = new FileTransactionManager({
    baseDirectory: logDirectory,
    idFactory: () => "tx_open_recovery",
    faultInjector(point) {
      if (point === "after-replace") {
        throw new SimulatedTransactionCrash("simulated process exit");
      }
    }
  });
  await crashingManager.commit(projectDirectory, [
    { relativePath: "assets/Package1/Main.xml", content: "<broken" }
  ]);

  const registry = new ProjectRegistry({
    recovery: new FileTransactionManager({ baseDirectory: logDirectory })
  });
  try {
    const opened = await registry.open(projectDirectory);
    assert.equal(opened.ok, true);
    assert.equal(
      await readFile(componentFile, "utf8"),
      '<component size="100,100"><displayList/></component>'
    );
  }
  finally {
    await registry.closeAll();
  }
});
