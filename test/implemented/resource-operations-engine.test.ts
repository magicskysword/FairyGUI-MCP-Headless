import assert from "node:assert/strict";
import { test } from "node:test";
import { Document } from "@magicskysword/openfairygui-core";
import {
  ApplyResourceOperationsInputSchema,
  type ApplyResourceOperationsInput
} from "../../src/contracts/tools.js";
import { ResourceOperationsEngine } from "../../src/resources/resource-operations-engine.js";

const PROJECT_ID = "project-1";
const PACKAGE_ID = "pkg00001";

function fixture(): Document {
  const document = new Document();
  document.getRoot()
    .setProjectId("resource-operations")
    .setProjectType(0)
    .setVersion("5.0")
    .setSettings({
      publish: {},
      common: {},
      adaptation: {}
    });
  const pkg = document.createPackage("Demo").setId(PACKAGE_ID);
  pkg.addResource(
    document.createComponent("Main")
      .setId("cmp01")
      .setPath("/")
      .setSize(320, 180)
  );
  return document;
}

function input(
  operations: ApplyResourceOperationsInput["operations"]
): ApplyResourceOperationsInput {
  return ApplyResourceOperationsInputSchema.parse({
    projectId: PROJECT_ID,
    operations
  });
}

test("resource operations create packages and components with typed client refs", () => {
  const document = fixture();
  const result = new ResourceOperationsEngine().apply(document, input([
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
      path: "/screens",
      width: 640,
      height: 360
    },
    {
      op: "create-component",
      packageId: PACKAGE_ID,
      clientRef: "local-card",
      name: "Card"
    }
  ]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.appliedOperations, 3);
  assert.match(result.data.clientRefs.widgets?.packageId ?? "", /^[a-z0-9]{8}$/);
  assert.match(
    result.data.clientRefs.dialog?.resourceId ?? "",
    /^[a-z0-9]{5}$/
  );
  assert.equal(result.data.clientRefs.dialog?.kind, "component");
  assert.equal(
    result.data.clientRefs.dialog?.packageId,
    result.data.clientRefs.widgets?.packageId
  );
  assert.equal(result.data.clientRefs["local-card"]?.packageId, PACKAGE_ID);

  const widgets = document.getRoot().getPackageById(
    result.data.clientRefs.widgets!.packageId
  );
  assert.equal(widgets?.getName(), "Widgets");
  const dialog = widgets?.getResourceById(
    result.data.clientRefs.dialog!.resourceId!
  );
  assert.equal(dialog?.getName(), "Dialog");
  assert.equal(dialog?.getPath(), "/screens/");
  assert.equal(
    "getWidth" in (dialog ?? {})
      ? (dialog as { getWidth(): number }).getWidth()
      : undefined,
    640
  );
  assert.deepEqual(result.data.affectedPackageIds, [
    PACKAGE_ID,
    result.data.clientRefs.widgets!.packageId
  ].sort());
});

test("resource creation rejects invalid ids, names, paths and conflicts", () => {
  const cases = [
    {
      operation: {
        op: "create-package",
        clientRef: "bad-id",
        name: "Valid",
        id: "ABC"
      },
      code: "INVALID_ARGUMENT",
      path: "operations[0].id"
    },
    {
      operation: {
        op: "create-package",
        clientRef: "bad-name",
        name: "../Widgets"
      },
      code: "INVALID_ARGUMENT",
      path: "operations[0].name"
    },
    {
      operation: {
        op: "create-package",
        clientRef: "duplicate",
        name: "demo"
      },
      code: "RESOURCE_CONFLICT",
      path: "operations[0].name"
    },
    {
      operation: {
        op: "create-component",
        packageId: PACKAGE_ID,
        clientRef: "bad-component",
        name: "Panel.xml"
      },
      code: "INVALID_ARGUMENT",
      path: "operations[0].name"
    },
    {
      operation: {
        op: "create-component",
        packageId: PACKAGE_ID,
        clientRef: "bad-path",
        name: "Panel",
        path: "../outside"
      },
      code: "INVALID_ARGUMENT",
      path: "operations[0].path"
    },
    {
      operation: {
        op: "create-component",
        packageId: PACKAGE_ID,
        clientRef: "duplicate-component",
        name: "Main",
        path: "/"
      },
      code: "RESOURCE_CONFLICT",
      path: "operations[0].name"
    }
  ] as const;

  for (const item of cases) {
    const parsed = input([
      item.operation as ApplyResourceOperationsInput["operations"][number]
    ]);
    const result = new ResourceOperationsEngine().apply(fixture(), parsed);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, item.code);
      assert.equal(result.error.path, item.path);
    }
  }
});

test("resource operations collapse package, component rename and move paths", () => {
  const document = fixture();
  const result = new ResourceOperationsEngine().apply(document, input([
    {
      op: "rename-package",
      packageId: PACKAGE_ID,
      name: "Renamed"
    },
    {
      op: "rename-resource",
      packageId: PACKAGE_ID,
      resourceId: "cmp01",
      name: "Dashboard"
    },
    {
      op: "move-resource",
      packageId: PACKAGE_ID,
      resourceId: "cmp01",
      path: "/screens/"
    }
  ]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pkg = document.getRoot().getPackageById(PACKAGE_ID)!;
  const component = pkg.getResourceById("cmp01")!;
  assert.equal(pkg.getName(), "Renamed");
  assert.equal(component.getName(), "Dashboard");
  assert.equal(component.getPath(), "/screens/");
  assert.deepEqual(result.data.fileMoves, [
    {
      from: "assets/Demo/Main.xml",
      to: "assets/Renamed/screens/Dashboard.xml"
    },
    {
      from: "assets/Demo/package.xml",
      to: "assets/Renamed/package.xml"
    }
  ]);
  assert.deepEqual(result.data.deletedFiles, []);
  assert.deepEqual(result.data.affectedComponents, [{
    packageId: PACKAGE_ID,
    componentId: "cmp01"
  }]);
});

test("resource rename and move reject collisions and cross-package targets", () => {
  {
    const document = fixture();
    const pkg = document.getRoot().getPackageById(PACKAGE_ID)!;
    pkg.addResource(
      document.createComponent("Other")
        .setId("oth01")
        .setPath("/")
        .setSize(10, 10)
    );
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "rename-resource",
      packageId: PACKAGE_ID,
      resourceId: "oth01",
      name: "Main"
    }]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RESOURCE_CONFLICT");
  }

  {
    const document = fixture();
    document.createPackage("Other").setId("other001");
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "move-resource",
      packageId: PACKAGE_ID,
      targetPackageId: "other001",
      resourceId: "cmp01",
      path: "/"
    }]));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "CROSS_PACKAGE_MOVE_UNSUPPORTED");
      assert.equal(result.error.path, "operations[0].targetPackageId");
    }
  }
});
