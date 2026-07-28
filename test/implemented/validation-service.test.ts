import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ValidateInputSchema } from "../../src/contracts/tools.js";
import { ProjectRegistry } from "../../src/project/project-registry.js";
import { ValidationService } from "../../src/validation/validation-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createProject(options: {
  brokenReference?: boolean;
  codeGeneration?: boolean;
  duplicateSourceOutput?: boolean;
  extraEmptyComponents?: number;
} = {}): Promise<{
  directory: string;
  componentFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fgui-validate-"));
  temporaryDirectories.push(directory);
  const packageDirectory = path.join(directory, "assets", "Demo");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(directory, "Demo.fairy"),
    `<?xml version="1.0" encoding="utf-8"?>
<projectDescription id="validation-project" type="Unity" version="5.0"/>`,
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "package.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<packageDescription id="pkg00001">
  ${options.codeGeneration
    ? '<publish genCode="true" codePath="generated"/>'
    : ""}
  <resources>
    <component id="cmp01" name="Main.xml" path="/" exported="true"/>
    ${Array.from(
      { length: options.extraEmptyComponents ?? 0 },
      (_, index) =>
        `<component id="e${String(index).padStart(4, "0")}" `
        + `name="Empty${index}.xml" path="/"/>`
    ).join("\n    ")}
    <image id="img01" name="hero.png" path="/" exported="true"/>
    ${options.duplicateSourceOutput
    ? '<image id="img02" name="hero.png" path="/" exported="false"/>'
    : ""}
  </resources>
</packageDescription>`,
    "utf8"
  );
  if (options.codeGeneration) {
    const settingsDirectory = path.join(directory, "settings");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(
      path.join(settingsDirectory, "Publish.json"),
      JSON.stringify({
        codeGeneration: {
          allowGenCode: true,
          codePath: "generated"
        }
      }),
      "utf8"
    );
  }
  const componentFile = path.join(packageDirectory, "Main.xml");
  await writeFile(
    componentFile,
    `<?xml version="1.0" encoding="utf-8"?>
<component size="320,180">
  <displayList>
    <image id="n0" name="hero" src="${
      options.brokenReference ? "missing" : "img01"
    }" xy="8,8" size="64,64"/>
    <text id="n1" name="title" xy="80,20" size="200,40" text="Validate"/>
  </displayList>
</component>`,
    "utf8"
  );
  await Promise.all(Array.from(
    { length: options.extraEmptyComponents ?? 0 },
    (_, index) => writeFile(
      path.join(packageDirectory, `Empty${index}.xml`),
      `<?xml version="1.0" encoding="utf-8"?>
<component size="32,32"><displayList/></component>`,
      "utf8"
    )
  ));
  return { directory, componentFile };
}

async function openValidator(options: {
  brokenReference?: boolean;
  codeGeneration?: boolean;
  duplicateSourceOutput?: boolean;
  extraEmptyComponents?: number;
} = {}): Promise<{
  registry: ProjectRegistry;
  validator: ValidationService;
  projectId: string;
  projectDirectory: string;
  componentFile: string;
}> {
  const fixture = await createProject(options);
  const registry = new ProjectRegistry();
  const opened = await registry.open(fixture.directory);
  if (!opened.ok) assert.fail(opened.error.message);
  return {
    registry,
    validator: new ValidationService(registry),
    projectId: opened.data.projectId,
    projectDirectory: fixture.directory,
    componentFile: fixture.componentFile
  };
}

test("quick validation returns valid:false as a successful project finding", async () => {
  const { registry, validator, projectId } = await openValidator({
    brokenReference: true
  });
  try {
    const result = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "quick",
      detail: "full"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.valid, false);
    assert.deepEqual(result.data.phases.map((phase) => phase.name), ["quick"]);
    assert.ok(result.data.diagnostics.some((diagnostic) =>
      diagnostic.code === "BROKEN_RESOURCE_REFERENCE"
      && diagnostic.severity === "error"
    ));
    assert.equal(result.data.checked.packageCount, 1);
    assert.equal(result.data.checked.componentCount, 1);
  }
  finally {
    await registry.closeAll();
  }
});

test("quick validation reports every producer of a duplicate source output", async () => {
  const { registry, validator, projectId } = await openValidator({
    duplicateSourceOutput: true
  });
  try {
    const result = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "quick",
      detail: "full"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.valid, false);
    const finding = result.data.diagnostics.find((diagnostic) =>
      diagnostic.code === "DUPLICATE_SOURCE_OUTPUT"
    );
    assert.ok(finding);
    assert.equal(finding.severity, "error");
    assert.equal(finding.path, "assets/Demo/hero.png");
    assert.deepEqual(finding.details, {
      packageId: "pkg00001",
      packageName: "Demo",
      branch: "",
      outputPath: "hero.png",
      first: {
        kind: "resource",
        packageId: "pkg00001",
        packageName: "Demo",
        branch: "",
        resourceId: "img01",
        resourceType: "ImageResource",
        resourceName: "hero",
        resourcePath: "/"
      },
      conflicting: {
        kind: "resource",
        packageId: "pkg00001",
        packageName: "Demo",
        branch: "",
        resourceId: "img02",
        resourceType: "ImageResource",
        resourceName: "hero",
        resourcePath: "/"
      }
    });
  }
  finally {
    await registry.closeAll();
  }
});

test("validation summary reports counts and limits diagnostics without full ids", async () => {
  const { registry, validator, projectId } = await openValidator({
    brokenReference: true,
    extraEmptyComponents: 25
  });
  try {
    const summary = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "quick"
    }));

    assert.equal(summary.ok, true, JSON.stringify(summary));
    if (!summary.ok) return;
    assert.equal(summary.data.detail, "summary");
    assert.equal(summary.data.valid, false);
    assert.deepEqual(summary.data.checked, {
      packageCount: 1,
      componentCount: 26
    });
    assert.equal("packageIds" in summary.data.checked, false);
    assert.equal(summary.data.diagnosticCount, 26);
    assert.deepEqual(summary.data.counts.bySeverity, {
      error: 1,
      warning: 0,
      info: 25
    });
    assert.equal(summary.data.counts.byCode.EMPTY_COMPONENT, 25);
    assert.equal(summary.data.diagnostics.length, 20);
    assert.equal(summary.data.diagnosticsTruncated, true);
    assert.equal(summary.data.phases[0]?.diagnosticCount, 26);
    assert.equal("diagnostics" in summary.data.phases[0]!, false);

    const full = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "quick",
      detail: "full"
    }));
    assert.equal(full.ok, true, JSON.stringify(full));
    if (!full.ok) return;
    assert.equal(full.data.detail, "full");
    assert.equal(full.data.checked.packageIds.length, 1);
    assert.equal(full.data.checked.componentIds.length, 26);
    assert.equal(full.data.diagnostics.length, 26);
    assert.equal(full.data.phases[0]?.diagnostics.length, 26);
  }
  finally {
    await registry.closeAll();
  }
});

test("roundtrip validation semantically serializes and reparses without source writes", async () => {
  const { registry, validator, projectId, componentFile } =
    await openValidator();
  const before = await readFile(componentFile, "utf8");
  try {
    const result = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "roundtrip",
      packageIds: ["pkg00001"],
      componentIds: ["cmp01"]
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.valid, true);
    assert.deepEqual(
      result.data.phases.map((phase) => phase.name),
      ["quick", "roundtrip"]
    );
    assert.ok((result.data.phases[1]?.metrics?.fileCount ?? 0) >= 3);
    assert.equal(await readFile(componentFile, "utf8"), before);
  }
  finally {
    await registry.closeAll();
  }
});

test("publish and full modes execute the documented validation phase sets", async () => {
  const { registry, validator, projectId } = await openValidator();
  try {
    const published = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "publish"
    }));
    assert.equal(published.ok, true, JSON.stringify(published));
    if (published.ok) {
      assert.equal(published.data.valid, true);
      assert.deepEqual(
        published.data.phases.map((phase) => phase.name),
        ["quick", "publish"]
      );
      assert.ok((published.data.phases[1]?.metrics?.artifactCount ?? 0) >= 1);
    }

    const full = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "full"
    }));
    assert.equal(full.ok, true, JSON.stringify(full));
    if (full.ok) {
      assert.equal(full.data.valid, true);
      assert.deepEqual(
        full.data.phases.map((phase) => phase.name),
        ["quick", "roundtrip", "publish"]
      );
    }
  }
  finally {
    await registry.closeAll();
  }
});

test("publish validation never writes configured generated code", async () => {
  const {
    registry,
    validator,
    projectId,
    projectDirectory
  } = await openValidator({ codeGeneration: true });
  const generatedDirectory = path.join(projectDirectory, "generated");
  try {
    const result = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "publish"
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    await assert.rejects(
      stat(generatedDirectory),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  }
  finally {
    await registry.closeAll();
  }
});

test("validation rejects unknown requested scopes with specific errors", async () => {
  const { registry, validator, projectId } = await openValidator();
  try {
    const missingPackage = await validator.validate(ValidateInputSchema.parse({
      projectId,
      mode: "quick",
      packageIds: ["missing"]
    }));
    assert.equal(missingPackage.ok, false);
    if (!missingPackage.ok) {
      assert.equal(missingPackage.error.code, "PACKAGE_NOT_FOUND");
    }

    const missingComponent = await validator.validate(
      ValidateInputSchema.parse({
        projectId,
        mode: "quick",
        componentIds: ["missing"]
      })
    );
    assert.equal(missingComponent.ok, false);
    if (!missingComponent.ok) {
      assert.equal(missingComponent.error.code, "COMPONENT_NOT_FOUND");
    }
  }
  finally {
    await registry.closeAll();
  }
});
