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
import sharp from "sharp";
import { PublishInputSchema } from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { PublishService } from "../../src/publish/publish-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(options: {
  configuredPath?: string;
  generateCode?: boolean;
  publishFileName?: string;
  customProperties?: Record<string, string>;
} = {}): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-publish-"));
  temporaryDirectories.push(directory);
  const settingsDirectory = path.join(directory, "settings");
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="publish-project" type="Unity" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(settingsDirectory, "Publish.json"),
    JSON.stringify({
      ...(options.configuredPath === undefined
        ? {}
        : { path: options.configuredPath }),
      ...(options.publishFileName === undefined
        ? {}
        : { fileName: options.publishFileName }),
      binaryFormat: true,
      compressDesc: true,
      codeGeneration: {
        allowGenCode: options.generateCode ?? false,
        codePath: "generated",
        codeType: ""
      },
      atlasSetting: {
        maxSize: 256,
        paging: true,
        sizeOption: "pot",
        allowRotation: false,
        trimImage: false
      }
    }),
    "utf8"
  );
  if (options.customProperties !== undefined) {
    await writeFile(
      path.join(settingsDirectory, "CustomProperties.json"),
      JSON.stringify(options.customProperties),
      "utf8"
    );
  }

  for (const pkg of [
    {
      name: "Demo",
      id: "pkg00001",
      componentId: "cmp01",
      color: { r: 40, g: 120, b: 200 },
      genCode: options.generateCode ?? false
    },
    {
      name: "Other",
      id: "pkg00002",
      componentId: "cmp02",
      color: { r: 200, g: 80, b: 40 },
      genCode: false
    }
  ]) {
    const packageDirectory = path.join(directory, "assets", pkg.name);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="${pkg.id}">
  <publish genCode="${pkg.genCode}"/>
  <resources>
    <image id="img01" name="icon.png" path="/" exported="true"/>
    <component id="${pkg.componentId}" name="Main.xml" path="/" exported="true"/>
  </resources>
</packageDescription>`,
      "utf8"
    );
    await writeFile(
      path.join(packageDirectory, "Main.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<component size="32,32">
  <displayList>
    <image id="n0" name="icon" src="img01" xy="0,0" size="32,32"/>
  </displayList>
</component>`,
      "utf8"
    );
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { ...pkg.color, alpha: 1 }
      }
    }).png().toFile(path.join(packageDirectory, "icon.png"));
  }

  return directory;
}

async function openPublisher(directory: string): Promise<{
  registry: ProjectRegistry;
  publisher: PublishService;
  projectId: string;
}> {
  const registry = new ProjectRegistry();
  const opened = await registry.open(directory);
  if (!opened.ok) assert.fail(opened.error.message);
  return {
    registry,
    publisher: new PublishService(registry),
    projectId: opened.data.projectId
  };
}

test("full publish uses project settings and preserves unrelated output files", async () => {
  const directory = await createProject({ configuredPath: "release" });
  const outputDirectory = path.join(directory, "release");
  await mkdir(outputDirectory, { recursive: true });
  const sentinel = path.join(outputDirectory, "keep.txt");
  await writeFile(sentinel, "keep", "utf8");
  const { registry, publisher, projectId } = await openPublisher(directory);

  try {
    const result = await publisher.publish(PublishInputSchema.parse({
      projectId
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.outputPath, outputDirectory);
    assert.equal(result.data.outputPathSource, "project-settings");
    assert.deepEqual(
      result.data.packages.map((pkg) => pkg.id),
      ["pkg00001", "pkg00002"]
    );
    await access(path.join(outputDirectory, "Demo_fui.bytes"));
    await access(path.join(outputDirectory, "Other_fui.bytes"));
    await access(path.join(outputDirectory, "Demo_atlas0.png"));
    await access(path.join(outputDirectory, "Other_atlas0.png"));
    assert.equal(await readFile(sentinel, "utf8"), "keep");
    assert.ok(result.data.writtenFiles.some((file) =>
      file.path === path.join(outputDirectory, "Demo_fui.bytes")
      && file.bytes > 0
    ));
  }
  finally {
    await registry.closeAll();
  }
});

test("definitions publish honors package scope and runtime path override", async () => {
  const directory = await createProject({
    configuredPath: "configured-release",
    generateCode: true
  });
  const { registry, publisher, projectId } = await openPublisher(directory);
  const outputDirectory = path.join(directory, "override-release");

  try {
    const result = await publisher.publish(PublishInputSchema.parse({
      projectId,
      packageIds: ["pkg00001"],
      publishType: "definitions",
      outputPath: "override-release"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.outputPath, outputDirectory);
    assert.equal(result.data.outputPathSource, "override");
    assert.deepEqual(result.data.packages, [{
      id: "pkg00001",
      name: "Demo"
    }]);
    await access(path.join(outputDirectory, "Demo_fui.bytes"));
    await assert.rejects(access(path.join(outputDirectory, "Other_fui.bytes")));
    await assert.rejects(access(path.join(outputDirectory, "Demo_atlas0.png")));
    await assert.rejects(access(path.join(directory, "configured-release")));
    await access(path.join(directory, "generated", "Demo", "UI_Main.cs"));
  }
  finally {
    await registry.closeAll();
  }
});

test("publish rejects missing configured paths and unknown package ids", async () => {
  const directory = await createProject();
  const { registry, publisher, projectId } = await openPublisher(directory);

  try {
    const missingPath = await publisher.publish(PublishInputSchema.parse({
      projectId
    }));
    assert.equal(missingPath.ok, false);
    if (!missingPath.ok) {
      assert.equal(missingPath.error.code, "PUBLISH_PATH_MISSING");
    }

    const missingPackage = await publisher.publish(PublishInputSchema.parse({
      projectId,
      packageIds: ["missing1"],
      outputPath: "release"
    }));
    assert.equal(missingPackage.ok, false);
    if (!missingPackage.ok) {
      assert.equal(missingPackage.error.code, "PACKAGE_NOT_FOUND");
    }
    await assert.rejects(access(path.join(directory, "release")));
  }
  finally {
    await registry.closeAll();
  }
});

test("publish resolves configured path variables and rejects invalid targets", async () => {
  const directory = await createProject({
    configuredPath: "release/{publish_file_name}/{flavor}",
    publishFileName: "RuntimeUI",
    customProperties: { flavor: "dev" }
  });
  const { registry, publisher, projectId } = await openPublisher(directory);

  try {
    const resolved = await publisher.publish(PublishInputSchema.parse({
      projectId,
      publishType: "definitions",
      packageIds: ["pkg00001"]
    }));
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    if (resolved.ok) {
      assert.equal(
        resolved.data.outputPath,
        path.join(directory, "release", "RuntimeUI", "dev")
      );
    }

    const outputFile = path.join(directory, "not-a-directory");
    await writeFile(outputFile, "occupied", "utf8");
    const invalidTarget = await publisher.publish(PublishInputSchema.parse({
      projectId,
      publishType: "definitions",
      outputPath: "not-a-directory"
    }));
    assert.equal(invalidTarget.ok, false);
    if (!invalidTarget.ok) {
      assert.equal(invalidTarget.error.code, "PUBLISH_PATH_INVALID");
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("publish rejects unresolved project path variables", async () => {
  const directory = await createProject({
    configuredPath: "release/{missing_variable}"
  });
  const { registry, publisher, projectId } = await openPublisher(directory);

  try {
    const result = await publisher.publish(PublishInputSchema.parse({
      projectId,
      publishType: "definitions"
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "PUBLISH_PATH_INVALID");
      assert.deepEqual(result.error.actual, ["missing_variable"]);
    }
  }
  finally {
    await registry.closeAll();
  }
});
