import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { readImportInboxFile } from "../../src/resources/import-inbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function fixture(): Promise<{
  projectDirectory: string;
  inboxDirectory: string;
}> {
  const projectDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fgui-inbox-")
  );
  temporaryDirectories.push(projectDirectory);
  const inboxDirectory = path.join(
    projectDirectory,
    ".fairygui-mcp",
    "import-inbox"
  );
  await mkdir(path.join(inboxDirectory, "icons"), { recursive: true });
  await writeFile(
    path.join(inboxDirectory, "icons", "sword.png"),
    new Uint8Array([1, 2, 3, 4])
  );
  return { projectDirectory, inboxDirectory };
}

test("import inbox reads one canonical regular file inside the project", async () => {
  const context = await fixture();
  const result = await readImportInboxFile(
    context.projectDirectory,
    "icons/sword.png",
    "operations[0].inboxPath"
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.fileName, "sword.png");
  assert.equal(
    result.data.sourceRelativePath,
    ".fairygui-mcp/import-inbox/icons/sword.png"
  );
  assert.deepEqual([...result.data.content], [1, 2, 3, 4]);
});

test("import inbox rejects absolute, traversal and non-canonical paths", async () => {
  const context = await fixture();
  for (const inboxPath of [
    "/absolute.png",
    "C:\\absolute.png",
    "../outside.png",
    "icons/../sword.png",
    "./icons/sword.png",
    "icons//sword.png",
    "icons\\sword.png"
  ]) {
    const result = await readImportInboxFile(
      context.projectDirectory,
      inboxPath,
      "operations[0].inboxPath"
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "IMPORT_PATH_INVALID");
      assert.equal(result.error.path, "operations[0].inboxPath");
    }
  }
});

test("import inbox rejects missing files and directories", async () => {
  const context = await fixture();
  for (const inboxPath of ["missing.png", "icons"]) {
    const result = await readImportInboxFile(
      context.projectDirectory,
      inboxPath,
      "operations[0].inboxPath"
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "IMPORT_NOT_REGULAR_FILE");
    }
  }
});

test("import inbox rejects symbolic links in every path segment", async (context) => {
  const fixtureValue = await fixture();
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "fgui-outside-"));
  temporaryDirectories.push(outsideDirectory);
  await writeFile(path.join(outsideDirectory, "outside.png"), "outside");
  const linkPath = path.join(fixtureValue.inboxDirectory, "linked");
  try {
    await symlink(outsideDirectory, linkPath, "junction");
  }
  catch (error) {
    context.skip(`当前环境不能创建符号链接：${String(error)}`);
    return;
  }

  const result = await readImportInboxFile(
    fixtureValue.projectDirectory,
    "linked/outside.png",
    "operations[0].inboxPath"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "IMPORT_SYMLINK_REJECTED");
});
