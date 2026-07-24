import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Document,
  GearType
} from "@magicskysword/openfairygui-core";
import {
  ApplyResourceOperationsInputSchema,
  type ApplyResourceOperationsInput
} from "../../src/contracts/tools.js";
import { ResourceOperationsEngine } from "../../src/resources/resource-operations-engine.js";
import type { ImportInboxFile } from "../../src/resources/import-inbox.js";

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
  pkg.addResource(
    document.createImageResource("Icon")
      .setId("img01")
      .setPath("/icons/")
      .setFileName("Icon.png")
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

function deletionFixture(): {
  document: Document;
  sourcePackageId: string;
  sourceComponentId: string;
} {
  const document = fixture();
  const sourcePackageId = "source01";
  const sourceComponentId = "host1";
  const sourcePackage = document.createPackage("Source").setId(sourcePackageId);
  const sourceComponent = document.createComponent("Host")
    .setId(sourceComponentId)
    .setPath("/")
    .setSize(320, 180);
  sourcePackage.addResource(sourceComponent);
  sourceComponent.addChild(
    document.createGImage("direct")
      .setId("n0")
      .setSrc("img01")
      .setPackageId(PACKAGE_ID)
  );
  sourceComponent.addChild(
    document.createGLoader("loader")
      .setId("n1")
      .setUrl(`ui://${PACKAGE_ID}img01`)
  );
  sourceComponent.addChild(
    document.createGList("items")
      .setId("n2")
      .setDefaultItem(`ui://${PACKAGE_ID}cmp01`)
      .setListItems([{
        title: "Item",
        icon: `ui://${PACKAGE_ID}img01`,
        url: `ui://${PACKAGE_ID}cmp01`,
        name: null,
        selectedTitle: null,
        selectedIcon: null,
        level: 0,
        isFolder: null
      }])
  );
  const label = document.createGTextField("label")
    .setId("n3")
    .setFont(`ui://${PACKAGE_ID}img01`);
  label.addGear(
    document.createGear("icon")
      .setGearType(GearType.Icon)
      .setValues(`page0,ui://${PACKAGE_ID}img01`)
  );
  sourceComponent.addChild(label);
  sourceComponent.addChild(
    document.createGComponent("main")
      .setId("n4")
      .setSrc("cmp01")
      .setPackageId(PACKAGE_ID)
  );
  return { document, sourcePackageId, sourceComponentId };
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

test("resource deletion reject reports references without mutating the model", () => {
  const { document } = deletionFixture();
  const result = new ResourceOperationsEngine().apply(document, input([{
    op: "delete-resource",
    packageId: PACKAGE_ID,
    resourceId: "img01",
    mode: "reject"
  }]));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RESOURCE_IN_USE");
  assert.equal(result.error.path, "operations[0].resourceId");
  assert.equal(
    document.getRoot().getPackageById(PACKAGE_ID)?.getResourceById("img01")
      ?.getName(),
    "Icon"
  );
  assert.equal(
    Array.isArray(result.error.actual)
      && result.error.actual.some((reference) =>
        reference.source?.field === "gear.values"
      ),
    true
  );
});

test("resource deletion cascade clears supported references and exposes fallback", () => {
  const {
    document,
    sourcePackageId,
    sourceComponentId
  } = deletionFixture();
  const result = new ResourceOperationsEngine().apply(document, input([{
    op: "delete-resource",
    packageId: PACKAGE_ID,
    resourceId: "img01",
    mode: "cascade"
  }]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    document.getRoot().getPackageById(PACKAGE_ID)?.getResourceById("img01"),
    null
  );
  const host = document.getRoot().getPackageById(sourcePackageId)
    ?.getResourceById(sourceComponentId) as unknown as {
      listChildren(): Array<Record<string, unknown> & {
        getId(): string;
      }>;
    };
  assert.deepEqual(host.listChildren().map((child) => child.getId()), [
    "n1",
    "n2",
    "n3",
    "n4"
  ]);
  const loader = host.listChildren()[0] as unknown as { getUrl(): string };
  const list = host.listChildren()[1] as unknown as {
    getListItems(): Array<{ icon: string | null }>;
  };
  const label = host.listChildren()[2] as unknown as {
    getFont(): string;
    listGears(): Array<{ getValues(): string }>;
  };
  assert.equal(loader.getUrl(), "");
  assert.equal(list.getListItems()[0]?.icon, null);
  assert.equal(label.getFont(), "");
  assert.equal(
    label.listGears()[0]?.getValues(),
    `page0,ui://${PACKAGE_ID}img01`
  );
  assert.equal(result.data.projectMayBeInvalid, true);
  assert.deepEqual(result.data.deleteResults, [{
    kind: "resource",
    packageId: PACKAGE_ID,
    resourceId: "img01",
    requestedMode: "cascade",
    effectiveMode: "cascade-with-force-fallback",
    removedReferences: 4,
    unsupportedReferences: 1
  }]);
  assert.deepEqual(result.data.affectedPackageIds, [
    PACKAGE_ID,
    sourcePackageId
  ]);
  assert.deepEqual(result.data.affectedComponents, [{
    packageId: sourcePackageId,
    componentId: sourceComponentId
  }]);
  assert.deepEqual(result.data.deletedAssetFiles, [
    "assets/Demo/icons/Icon.png"
  ]);
  assert.deepEqual(result.data.operationResults, [{
    index: 0,
    op: "delete-resource",
    before: {
      kind: "resource",
      packageId: PACKAGE_ID,
      resourceId: "img01",
      name: "Icon",
      type: "ImageResource",
      path: "/icons/",
      exported: false,
      fileName: "Icon.png"
    },
    after: null
  }]);
  assert.equal(
    result.data.affectedReferences.some((change) =>
      change.change === "removed"
      && change.reference.target.packageId === PACKAGE_ID
      && change.reference.target.resourceId === "img01"
      && change.reference.source.objectId === "n0"
    ),
    true
  );
});

test("resource operation summaries follow same-batch client refs", () => {
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
      path: "/screens/",
      width: 640,
      height: 360
    },
    {
      op: "rename-resource",
      packageId: PACKAGE_ID,
      resourceId: "img01",
      name: "Badge"
    }
  ]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const widgetsId = result.data.clientRefs.widgets!.packageId;
  const dialogId = result.data.clientRefs.dialog!.resourceId!;
  assert.deepEqual(result.data.operationResults, [
    {
      index: 0,
      op: "create-package",
      before: null,
      after: {
        kind: "package",
        packageId: widgetsId,
        name: "Widgets",
        resourceCount: 0,
        componentCount: 0
      }
    },
    {
      index: 1,
      op: "create-component",
      before: null,
      after: {
        kind: "resource",
        packageId: widgetsId,
        resourceId: dialogId,
        name: "Dialog",
        type: "Component",
        path: "/screens/",
        exported: false,
        width: 640,
        height: 360
      }
    },
    {
      index: 2,
      op: "rename-resource",
      before: {
        kind: "resource",
        packageId: PACKAGE_ID,
        resourceId: "img01",
        name: "Icon",
        type: "ImageResource",
        path: "/icons/",
        exported: false,
        fileName: "Icon.png"
      },
      after: {
        kind: "resource",
        packageId: PACKAGE_ID,
        resourceId: "img01",
        name: "Badge",
        type: "ImageResource",
        path: "/icons/",
        exported: false,
        fileName: "Badge.png"
      }
    }
  ]);
});

test("component cascade removes instances and clears list item references", () => {
  const {
    document,
    sourcePackageId,
    sourceComponentId
  } = deletionFixture();
  const result = new ResourceOperationsEngine().apply(document, input([{
    op: "delete-resource",
    packageId: PACKAGE_ID,
    resourceId: "cmp01",
    mode: "cascade"
  }]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const host = document.getRoot().getPackageById(sourcePackageId)
    ?.getResourceById(sourceComponentId) as unknown as {
      listChildren(): Array<Record<string, unknown> & {
        getId(): string;
      }>;
    };
  assert.deepEqual(host.listChildren().map((child) => child.getId()), [
    "n0",
    "n1",
    "n2",
    "n3"
  ]);
  const list = host.listChildren()[2] as unknown as {
    getDefaultItem(): string;
    getListItems(): Array<{ url: string | null }>;
  };
  assert.equal(list.getDefaultItem(), "");
  assert.equal(list.getListItems()[0]?.url, null);
  assert.equal(result.data.projectMayBeInvalid, false);
  assert.deepEqual(result.data.deletedFiles, [
    "assets/Demo/Main.xml"
  ]);
  assert.equal(result.data.deleteResults[0]?.effectiveMode, "cascade");
  assert.equal(result.data.deleteResults[0]?.removedReferences, 3);
});

test("force package deletion removes all package files and declares risk", () => {
  const { document } = deletionFixture();
  const result = new ResourceOperationsEngine().apply(document, input([{
    op: "delete-package",
    packageId: PACKAGE_ID,
    mode: "force"
  }]));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(document.getRoot().getPackageById(PACKAGE_ID), null);
  assert.equal(result.data.projectMayBeInvalid, true);
  assert.deepEqual(result.data.deletedFiles, [
    "assets/Demo/Main.xml",
    "assets/Demo/package.xml"
  ]);
  assert.deepEqual(result.data.deletedAssetFiles, [
    "assets/Demo/icons/Icon.png"
  ]);
  assert.deepEqual(result.data.deleteResults, [{
    kind: "package",
    packageId: PACKAGE_ID,
    requestedMode: "force",
    effectiveMode: "force",
    removedReferences: 0,
    unsupportedReferences: 0
  }]);
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

function inboxFile(
  fileName: string,
  sourceRelativePath: string,
  bytes: number[]
): ImportInboxFile {
  return {
    fileName,
    sourceRelativePath,
    content: new Uint8Array(bytes)
  };
}

test("resource import applies reject, rename and replace conflict policies", () => {
  {
    const document = fixture();
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "import",
      packageId: PACKAGE_ID,
      clientRef: "sword",
      inboxPath: "sword.png",
      name: "Sword",
      path: "/icons/",
      conflict: "reject"
    }]), {
      importFiles: new Map([[
        0,
        inboxFile(
          "sword.png",
          ".fairygui-mcp/import-inbox/sword.png",
          [1, 2, 3]
        )
      ]])
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const created = result.data.clientRefs.sword!;
    assert.equal(created.kind, "resource");
    assert.match(created.resourceId ?? "", /^[a-z0-9]{5}$/);
    const resource = document.getRoot().getPackageById(PACKAGE_ID)!
      .getResourceById(created.resourceId!) as {
        propertyType: string;
        getFileName(): string;
      };
    assert.equal(resource.propertyType, "ImageResource");
    assert.equal(resource.getFileName(), "Sword.png");
    assert.deepEqual(result.data.assetWrites.map((write) => ({
      relativePath: write.relativePath,
      content: [...write.content]
    })), [{
      relativePath: "assets/Demo/icons/Sword.png",
      content: [1, 2, 3]
    }]);
    assert.deepEqual(result.data.consumedInboxPaths, [
      ".fairygui-mcp/import-inbox/sword.png"
    ]);
  }

  {
    const document = fixture();
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "import",
      packageId: PACKAGE_ID,
      clientRef: "renamed-icon",
      inboxPath: "icon.png",
      name: "Icon",
      path: "/icons/",
      conflict: "rename"
    }]), {
      importFiles: new Map([[
        0,
        inboxFile(
          "icon.png",
          ".fairygui-mcp/import-inbox/icon.png",
          [4]
        )
      ]])
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const created = document.getRoot().getPackageById(PACKAGE_ID)!
      .getResourceById(result.data.clientRefs["renamed-icon"]!.resourceId!)!;
    assert.equal(created.getName(), "Icon_2");
    assert.equal(result.data.assetWrites[0]?.relativePath, (
      "assets/Demo/icons/Icon_2.png"
    ));
  }

  {
    const document = fixture();
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "import",
      packageId: PACKAGE_ID,
      clientRef: "replaced-icon",
      inboxPath: "replacement.png",
      name: "Icon",
      path: "/icons/",
      conflict: "replace",
      resourceId: "img01"
    }]), {
      importFiles: new Map([[
        0,
        inboxFile(
          "replacement.png",
          ".fairygui-mcp/import-inbox/replacement.png",
          [9, 8]
        )
      ]])
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.data.clientRefs["replaced-icon"]?.resourceId,
      "img01"
    );
    assert.equal(result.data.assetWrites[0]?.relativePath, (
      "assets/Demo/icons/Icon.png"
    ));
  }
});

test("replace-resource preserves id, updates extension and rejects type changes", () => {
  {
    const document = fixture();
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "replace-resource",
      packageId: PACKAGE_ID,
      resourceId: "img01",
      inboxPath: "replacement.jpg"
    }]), {
      importFiles: new Map([[
        0,
        inboxFile(
          "replacement.jpg",
          ".fairygui-mcp/import-inbox/replacement.jpg",
          [7, 7]
        )
      ]])
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const resource = document.getRoot().getPackageById(PACKAGE_ID)!
      .getResourceById("img01") as { getFileName(): string };
    assert.equal(resource.getFileName(), "Icon.jpg");
    assert.deepEqual(result.data.assetMoves, [{
      from: "assets/Demo/icons/Icon.png",
      to: "assets/Demo/icons/Icon.jpg"
    }]);
    assert.equal(
      result.data.assetWrites[0]?.relativePath,
      "assets/Demo/icons/Icon.jpg"
    );
  }

  {
    const document = fixture();
    const result = new ResourceOperationsEngine().apply(document, input([{
      op: "replace-resource",
      packageId: PACKAGE_ID,
      resourceId: "cmp01",
      inboxPath: "replacement.png"
    }]), {
      importFiles: new Map([[
        0,
        inboxFile(
          "replacement.png",
          ".fairygui-mcp/import-inbox/replacement.png",
          [1]
        )
      ]])
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_ARGUMENT");
      assert.equal(result.error.path, "operations[0].inboxPath");
    }
  }
});
