import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { SafeEmptyDirectoryCleaner } from "../../src/resources/empty-directory-cleaner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-cleaner-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "assets", "Demo", "empty"), {
    recursive: true
  });
  return directory;
}

test("empty-directory cleanup never follows symbolic links or removes assets", async () => {
  const directory = await projectDirectory();
  const external = await mkdtemp(path.join(os.tmpdir(), "fgui-cleaner-target-"));
  temporaryDirectories.push(external);
  const link = path.join(directory, "assets", "Demo", "linked");
  await symlink(
    external,
    link,
    process.platform === "win32" ? "junction" : "dir"
  );
  const cleaner = new SafeEmptyDirectoryCleaner();

  const result = await cleaner.cleanup(directory, [
    "assets/Demo/linked/Icon.png",
    "assets/root.dat"
  ]);

  assert.deepEqual(result.directories, []);
  assert.equal(
    result.warnings.some((warning) =>
      warning.code === "EMPTY_DIRECTORY_CLEANUP_SKIPPED"
      && warning.path === "assets/Demo/linked"
    ),
    true
  );
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal((await lstat(external)).isDirectory(), true);
  assert.equal(
    (await lstat(path.join(directory, "assets"))).isDirectory(),
    true
  );
});

test("empty-directory cleanup failures become warnings", async () => {
  const directory = await projectDirectory();
  const cleaner = new SafeEmptyDirectoryCleaner({
    async removeDirectory() {
      const error = new Error("injected cleanup failure") as Error & {
        code: string;
      };
      error.code = "EACCES";
      throw error;
    }
  });

  const result = await cleaner.cleanup(directory, [
    "assets/Demo/empty/deleted.png"
  ]);

  assert.deepEqual(result.directories, []);
  assert.deepEqual(result.warnings.map((warning) => ({
    code: warning.code,
    path: warning.path
  })), [{
    code: "EMPTY_DIRECTORY_CLEANUP_FAILED",
    path: "assets/Demo/empty"
  }]);
  assert.equal(
    (await lstat(path.join(directory, "assets", "Demo", "empty"))).isDirectory(),
    true
  );
});
