import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Document,
  FillMethod,
  FillOrigin,
  FillOrigin90,
  type GObject
} from "@magicskysword/openfairygui-core";
import {
  DomPatchEngine,
  type DomPatchEngineData
} from "../../src/dom/dom-patch-engine.js";
import {
  ApplyDomPatchInputSchema,
  type ApplyDomPatchInput
} from "../../src/contracts/tools.js";

const PACKAGE_ID = "pkg00001";
const COMPONENT_ID = "cmp01";

function fixture(): {
  document: Document;
  main: ReturnType<Document["createComponent"]>;
  tree: GObject;
  instance: GObject;
} {
  const document = new Document();
  document.getRoot()
    .setProjectId("dom-patch-engine")
    .setProjectType(0)
    .setVersion("5.0")
    .setSettings({
      publish: {},
      common: {},
      adaptation: {}
    });
  const pkg = document.createPackage("Demo").setId(PACKAGE_ID);
  const source = document.createComponent("Card")
    .setId("card1")
    .setPath("/")
    .setExtensionType("Button")
    .setSize(80, 30);
  pkg.addResource(source);
  const image = document.createImageResource("Icon")
    .setId("img01")
    .setPath("/");
  pkg.addResource(image);

  const main = document.createComponent("Main")
    .setId(COMPONENT_ID)
    .setPath("/")
    .setSize(320, 180);
  const title = document.createGTextField("title")
    .setId("n3")
    .setText("Before")
    .setXY(10, 12)
    .setSize(120, 24);
  const list = document.createGList("items")
    .setId("n7")
    .setXY(0, 50)
    .setSize(160, 80);
  const tree = document.createGTree("tree")
    .setId("n8")
    .setXY(170, 50)
    .setSize(120, 80);
  const instance = document.createGComponent("card")
    .setId("n9")
    .setSrc("card1")
    .setPackageId(PACKAGE_ID)
    .setXY(200, 10)
    .setSize(80, 30);
  main.addChild(title).addChild(list).addChild(tree).addChild(instance);
  pkg.addResource(main);
  return { document, main, tree, instance };
}

function parsePatch(
  value: Omit<ApplyDomPatchInput, "projectId" | "packageId" | "componentId">
): ApplyDomPatchInput {
  return ApplyDomPatchInputSchema.parse({
    projectId: "project-1",
    packageId: PACKAGE_ID,
    componentId: COMPONENT_ID,
    ...value
  });
}

function successData(
  result: ReturnType<DomPatchEngine["apply"]>
): DomPatchEngineData {
  if (result.ok) return result.data;
  throw new Error(result.error.message);
}

test("DOM patch operations allocate stable ids and resolve forward client references", () => {
  const { document, main } = fixture();
  const engine = new DomPatchEngine();
  const input = parsePatch({
    operations: [
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "label",
        node: {
          type: "text",
          name: "created-label",
          groupId: "layout",
          style: { left: 20, top: 30, width: 140, height: 28 },
          relations: [{
            targetId: "layout",
            type: "Left_Left",
            percent: false
          }],
          content: {
            text: "Initial",
            fontSize: 18,
            color: "#ffcc00",
            align: "center"
          }
        }
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "layout",
        index: 1,
        node: {
          type: "group",
          name: "layout-group",
          style: {},
          relations: [],
          content: {
            layout: "horizontal",
            columnGap: 6,
            excludeInvisibles: true
          }
        }
      },
      {
        op: "update",
        targetRef: "label",
        expectedMatches: 1,
        changes: { content: { text: "Created" } }
      },
      {
        op: "update",
        selector: 'text[name="created-label"]',
        expectedMatches: 1,
        changes: { style: { opacity: 0.75, left: 24 } }
      },
      {
        op: "move",
        targetRef: "layout",
        expectedMatches: 1,
        toIndex: 0
      }
    ]
  });

  const data = successData(engine.apply(document, input));

  assert.equal(data.appliedOperations, 5);
  assert.deepEqual(data.clientRefs, { label: "n10", layout: "n11" });
  assert.deepEqual(data.operationResults, [
    { index: 0, op: "insert", affectedNodeIds: ["n10"] },
    { index: 1, op: "insert", affectedNodeIds: ["n11"] },
    { index: 2, op: "update", affectedNodeIds: ["n10"] },
    { index: 3, op: "update", affectedNodeIds: ["n10"] },
    { index: 4, op: "move", affectedNodeIds: ["n11"] }
  ]);
  assert.deepEqual(data.affectedNodeIds, ["n10", "n11"]);
  assert.deepEqual(
    main.listChildren().map((child) => child.getId()),
    ["n11", "n3", "n7", "n8", "n9", "n10"]
  );
  assert.equal(
    (
      main.getChildById("n11") as
        | { getAdvanced(): boolean }
        | null
    )?.getAdvanced(),
    true
  );
  const label = data.dom.root.children.find((node) => node.id === "n10");
  assert.equal(label?.type, "text");
  assert.equal(label?.name, "created-label");
  assert.equal(label?.groupId, "n11");
  assert.equal(label?.style.left, 24);
  assert.equal(label?.style.opacity, 0.75);
  assert.deepEqual(label?.relations, [{
    targetId: "n11",
    type: "Left_Left",
    percent: false
  }]);
  assert.equal(
    label?.type === "text" ? label.content.text : undefined,
    "Created"
  );
});

test("DOM patch creates every V1 writable node content shape", () => {
  const { document, main } = fixture();
  const engine = new DomPatchEngine();
  const common = {
    parentSelector: "component-root",
    expectedMatches: 1 as const
  };
  const input = parsePatch({
    operations: [
      {
        op: "insert",
        ...common,
        clientRef: "image",
        node: {
          type: "image",
          name: "image",
          style: { width: 16, height: 16 },
          relations: [],
          content: {
            resource: { packageId: PACKAGE_ID, resourceId: "img01" },
            flip: "horizontal",
            fillMethod: "horizontal",
            fillAmount: 0.5,
            color: "#ffffff"
          }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "rich",
        node: {
          type: "rich-text",
          name: "rich",
          style: {},
          relations: [],
          content: { text: "[b]Bold[/b]", ubb: true, bold: true }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "input",
        node: {
          type: "input-text",
          name: "input",
          style: {},
          relations: [],
          content: {
            text: "",
            prompt: "Type",
            maxLength: 12,
            password: true,
            keyboardType: "email"
          }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "loader",
        node: {
          type: "loader",
          name: "loader",
          style: {},
          relations: [],
          content: {
            resource: { packageId: PACKAGE_ID, resourceId: "img01" },
            fill: "scale",
            align: "right",
            verticalAlign: "bottom",
            autoSize: true,
            playing: false,
            frame: 2
          }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "graph",
        node: {
          type: "graph",
          name: "graph",
          style: {},
          relations: [],
          content: {
            shape: "polygon",
            fillColor: "#123456",
            lineColor: "#654321",
            lineSize: 2,
            points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]
          }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "movie",
        node: {
          type: "movie-clip",
          name: "movie",
          style: {},
          relations: [],
          content: { playing: false, frame: 3, color: "#abcdef" }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "list",
        node: {
          type: "list",
          name: "list",
          style: {},
          relations: [],
          content: {
            layout: "flow-horizontal",
            defaultItem: { packageId: PACKAGE_ID, resourceId: "card1" },
            lineGap: 3,
            columnGap: 4,
            columnCount: 3,
            autoResizeItem: false,
            align: "center",
            verticalAlign: "middle",
            items: [{
              name: "first",
              title: "First",
              resource: { packageId: PACKAGE_ID, resourceId: "card1" },
              icon: { packageId: PACKAGE_ID, resourceId: "img01" }
            }]
          }
        }
      },
      {
        op: "insert",
        ...common,
        clientRef: "instance",
        node: {
          type: "instance",
          name: "instance",
          style: {},
          relations: [],
          content: {
            resource: { packageId: PACKAGE_ID, resourceId: "card1" },
            text: "Card",
            icon: { packageId: PACKAGE_ID, resourceId: "img01" },
            selected: true
          }
        }
      }
    ]
  });

  const data = successData(engine.apply(document, input));

  assert.equal(data.appliedOperations, 8);
  assert.deepEqual(
    data.dom.root.children.slice(-8).map((node) => node.type),
    [
      "image",
      "rich-text",
      "input-text",
      "loader",
      "graph",
      "movie-clip",
      "list",
      "instance"
    ]
  );
  const list = data.dom.root.children.find((node) => node.name === "list");
  assert.equal(list?.type, "list");
  if (list?.type === "list") {
    assert.equal(list.content.layout, "flow-horizontal");
    assert.equal(list.content.items[0]?.title, "First");
    assert.deepEqual(list.content.defaultItem, {
      packageId: PACKAGE_ID,
      resourceId: "card1"
    });
  }
  const instanceId = data.clientRefs.instance!;
  const instance = main.getChildById(instanceId) as GObject & {
    getInstanceExtType(): string;
  };
  assert.equal(instance.getInstanceExtType(), "Button");
  const instanceDom = data.dom.root.children.find(
    (node) => node.name === "instance"
  );
  assert.equal(
    instanceDom?.type === "instance" ? instanceDom.content.text : undefined,
    "Card"
  );
  assert.equal(
    instanceDom?.type === "instance"
      ? instanceDom.content.selected
      : undefined,
    true
  );
});

test("instance overlays reject fields unsupported by the source component", () => {
  const { document } = fixture();
  const engine = new DomPatchEngine();
  const result = engine.apply(document, parsePatch({
    operations: [{
      op: "insert",
      parentSelector: "component-root",
      expectedMatches: 1,
      clientRef: "generic-instance",
      node: {
        type: "instance",
        name: "generic-instance",
        style: {},
        relations: [],
        content: {
          resource: {
            packageId: PACKAGE_ID,
            resourceId: COMPONENT_ID
          },
          text: "Not supported"
        }
      }
    }]
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PATCH");
    assert.equal(result.error.path, "operations[0].node.content.text");
    assert.deepEqual(result.error.allowed, ["Button", "Label", "ComboBox"]);
  }
});

test("typed resource fields reject incompatible FairyGUI resource kinds", () => {
  const cases = [
    {
      node: {
        type: "image",
        name: "wrong-image",
        style: {},
        relations: [],
        content: {
          resource: {
            packageId: PACKAGE_ID,
            resourceId: "card1"
          }
        }
      },
      path: "operations[0].node.content.resource",
      allowed: ["ImageResource"]
    },
    {
      node: {
        type: "movie-clip",
        name: "wrong-movie",
        style: {},
        relations: [],
        content: {
          resource: {
            packageId: PACKAGE_ID,
            resourceId: "img01"
          }
        }
      },
      path: "operations[0].node.content.resource",
      allowed: ["MovieClipResource"]
    },
    {
      node: {
        type: "text",
        name: "wrong-font",
        style: {},
        relations: [],
        content: {
          text: "Text",
          font: {
            packageId: PACKAGE_ID,
            resourceId: "img01"
          }
        }
      },
      path: "operations[0].node.content.font",
      allowed: ["FontResource"]
    }
  ] as const;

  for (const resourceCase of cases) {
    const { document } = fixture();
    const result = new DomPatchEngine().apply(document, parsePatch({
      operations: [{
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: resourceCase.node.name,
        node: resourceCase.node
      }]
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_PATCH");
      assert.equal(result.error.path, resourceCase.path);
      assert.deepEqual(result.error.allowed, resourceCase.allowed);
    }
  }
});

test("update, move, remove and replace enforce compatible writable targets", () => {
  const { document } = fixture();
  const engine = new DomPatchEngine();
  const input = parsePatch({
    operations: [
      {
        op: "update",
        selector: "#n3",
        expectedMatches: 1,
        changes: {
          name: "renamed",
          relations: [{
            targetId: COMPONENT_ID,
            type: "Center_Center",
            percent: true
          }]
        }
      },
      {
        op: "update",
        selector: "#n7",
        expectedMatches: 1,
        changes: {
          content: {
            items: [{ title: "One" }, { title: "Two" }]
          }
        }
      },
      {
        op: "update",
        selector: "#n9",
        expectedMatches: 1,
        changes: {
          content: {
            resource: { packageId: PACKAGE_ID, resourceId: "card1" }
          }
        }
      },
      {
        op: "replace",
        selector: "#n3",
        expectedMatches: 1,
        node: {
          type: "graph",
          name: "replacement",
          style: { left: 4, top: 5, width: 60, height: 20 },
          relations: [],
          content: { shape: "rectangle", fillColor: "#00ff00" }
        }
      },
      {
        op: "remove",
        selector: "#n9",
        expectedMatches: 1
      }
    ]
  });

  const data = successData(engine.apply(document, input));

  assert.equal(data.appliedOperations, 5);
  const replacement = data.dom.root.children.find((node) => node.id === "n3");
  assert.equal(replacement?.type, "graph");
  assert.equal(replacement?.name, "replacement");
  assert.equal(data.dom.root.children.some((node) => node.id === "n9"), false);
  const list = data.dom.root.children.find((node) => node.id === "n7");
  assert.equal(list?.type === "list" && list.content.items.length, 2);
});

test("DOM patch failures use stable selector, boundary and capability errors", () => {
  for (const expectation of [
    {
      operation: {
        op: "update",
        selector: "text:hover",
        expectedMatches: 1,
        changes: { content: { text: "bad" } }
      },
      code: "INVALID_SELECTOR"
    },
    {
      operation: {
        op: "update",
        selector: "text",
        expectedMatches: 2,
        changes: { content: { text: "bad" } }
      },
      code: "SELECTOR_MATCH_COUNT"
    },
    {
      operation: {
        op: "update",
        selector: "#n8",
        expectedMatches: 1,
        changes: { style: { left: 1 } }
      },
      code: "READ_ONLY_CAPABILITY"
    },
    {
      operation: {
        op: "update",
        selector: "instance > text",
        expectedMatches: 1,
        changes: { content: { text: "bad" } }
      },
      code: "INSTANCE_BOUNDARY"
    },
    {
      operation: {
        op: "update",
        selector: "component-root",
        expectedMatches: 1,
        changes: { style: { opacity: 0.5 } }
      },
      code: "INVALID_PATCH"
    },
    {
      operation: {
        op: "update",
        selector: "#n9",
        expectedMatches: 1,
        changes: {
          content: {
            resource: { packageId: PACKAGE_ID, resourceId: "missing" }
          }
        }
      },
      code: "RESOURCE_NOT_FOUND"
    }
  ] as const) {
    const { document } = fixture();
    const input = parsePatch({
      operations: [expectation.operation]
    });
    const result = new DomPatchEngine().apply(document, input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, expectation.code);
  }
});

test("DOM patch performs strict internal validation with precise paths", () => {
  const { document } = fixture();
  const input = parsePatch({
    operations: [{
      op: "update",
      selector: "#n3",
      expectedMatches: 1,
      changes: {
        style: { left: "10px" }
      }
    }]
  });

  const result = new DomPatchEngine().apply(document, input);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_PATCH");
  assert.equal(result.error.path, "operations[0].changes.style.left");
  assert.notEqual(result.error.actual, undefined);
  assert.notEqual(result.error.allowed, undefined);
  assert.match(result.error.suggestedFix ?? "", /detail.*full|完整 DOM/i);
});

test("an operation cannot target a clientRef before its insert executes", () => {
  const { document } = fixture();
  const input = parsePatch({
    operations: [
      {
        op: "update",
        targetRef: "later",
        expectedMatches: 1,
        changes: { content: { text: "Too early" } }
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "later",
        node: {
          type: "text",
          name: "later",
          style: {},
          relations: [],
          content: { text: "" }
        }
      }
    ]
  });

  const result = new DomPatchEngine().apply(document, input);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PATCH");
    assert.equal(result.error.path, "operations[0].targetRef");
  }
});

test("update uses recursive Merge Patch, array replacement and null clearing", () => {
  const { document } = fixture();
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "layout",
        node: {
          type: "group",
          name: "layout",
          style: {},
          relations: [],
          content: { layout: "horizontal" }
        }
      },
      {
        op: "update",
        selector: "#n3",
        expectedMatches: 1,
        changes: {
          name: "updated-title",
          groupId: "layout",
          style: { left: 50, opacity: 0.4 },
          relations: [{
            targetId: "layout",
            type: "Left_Left",
            percent: false
          }],
          content: { text: "After", color: "#abcdef" }
        }
      },
      {
        op: "update",
        selector: "#n3",
        expectedMatches: 1,
        changes: {
          groupId: null,
          style: { opacity: null },
          content: { color: null }
        }
      },
      {
        op: "update",
        selector: "#n7",
        expectedMatches: 1,
        changes: {
          content: {
            items: [{ title: "Only replacement" }]
          }
        }
      }
    ]
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const title = result.data.dom.root.children.find((node) => node.id === "n3");
  assert.equal(title?.name, "updated-title");
  assert.equal(title?.groupId, undefined);
  assert.equal(title?.style.left, 50);
  assert.equal(title?.style.opacity, 1);
  assert.deepEqual(title?.relations, [{
    targetId: result.data.clientRefs.layout,
    type: "Left_Left",
    percent: false
  }]);
  assert.equal(
    title?.type === "text" ? title.content.text : undefined,
    "After"
  );
  assert.equal(
    title?.type === "text" ? title.content.color : undefined,
    "#000000"
  );
  const list = result.data.dom.root.children.find((node) => node.id === "n7");
  assert.deepEqual(
    list?.type === "list" ? list.content.items : undefined,
    [{ title: "Only replacement" }]
  );
});

test("update rejects clearing required fields without mutating its target", () => {
  const { document, main } = fixture();
  const before = main.getChildById("n3");
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: "#n3",
      expectedMatches: 1,
      changes: {
        content: { text: null }
      }
    }]
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PATCH");
    assert.equal(result.error.path, "operations[0].changes.content.text");
  }
  assert.equal(main.getChildById("n3"), before);
  assert.equal(
    (main.getChildById("n3") as unknown as { getText(): string }).getText(),
    "Before"
  );
});

test("generic update writes component roots, relations and static List items", () => {
  const { document, main } = fixture();
  const data = successData(new DomPatchEngine().apply(document, parsePatch({
    operations: [
      {
        op: "update",
        selector: "component-root",
        expectedMatches: 1,
        changes: {
          style: {
            width: 640,
            height: 360,
            minWidth: 100,
            pivotX: 0.5,
            pivotY: 0.5,
            pivotAsAnchor: true
          },
          content: {
            overflow: "scroll",
            scrollAxis: "both",
            opaque: false,
            backgroundColor: "#112233",
            maskId: "n3",
            reversedMask: true
          }
        }
      },
      {
        op: "update",
        selector: "#n3",
        expectedMatches: 1,
        changes: {
          relations: [{
            targetId: COMPONENT_ID,
            type: "Width",
            percent: true
          }]
        }
      },
      {
        op: "update",
        selector: "#n7",
        expectedMatches: 1,
        changes: {
          content: {
            items: [{ title: "A" }, { title: "B" }, { title: "C" }]
          }
        }
      }
    ]
  })));

  assert.equal(data.dom.root.style.width, 640);
  assert.equal(data.dom.root.style.height, 360);
  assert.equal(main.getMinWidth(), 100);
  assert.equal(main.getPivotX(), 0.5);
  assert.equal(main.getPivotAsAnchor(), true);
  assert.deepEqual(data.dom.root.content, {
    overflow: "scroll",
    scrollAxis: "both",
    opaque: false,
    backgroundColor: "#112233",
    maskId: "n3",
    reversedMask: true
  });
  assert.deepEqual(
    data.dom.root.children.find((node) => node.id === "n3")?.relations,
    [{ targetId: COMPONENT_ID, type: "Width", percent: true }]
  );
  const list = data.dom.root.children.find((node) => node.id === "n7");
  assert.equal(list?.type === "list" && list.content.items.length, 3);
});

test("heterogeneous multi-target update preflights every match before mutation", () => {
  const { document, main } = fixture();
  main.getChildById("n3")?.setName("shared");
  main.addChild(
    document.createGGraph("shared")
      .setId("n10")
      .setSize(20, 20)
  );
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: '[name="shared"]',
      expectedMatches: 2,
      changes: { content: { text: "Must not partially apply" } }
    }]
  }));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PATCH");
  assert.equal(
    (main.getChildById("n3") as unknown as { getText(): string }).getText(),
    "Before"
  );
});

test("ordinary update preserves opaque data owned by the target", () => {
  const opaqueXml = `<component size="320,180">
  <displayList vendorDisplay="keep">
    <text id="n3" name="title" text="Before">
      <relation target="" sidePair="left-left" vendorRelation="keep"/>
    </text>
    <list id="n7"><item title="Before" vendorItem="keep"/></list>
    <vendorWidget value="keep"/>
  </displayList>
</component>`;
  const { document, main } = fixture();
  main.setExtras({
    ...main.getExtras(),
    _sourceComponentXml: opaqueXml
  });
  const title = main.getChildById("n3");

  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: "#n3",
      expectedMatches: 1,
      changes: {
        name: "preserved",
        style: { left: 42 }
      }
    }]
  }));

  assert.equal(result.ok, true);
  assert.equal(main.getChildById("n3"), title);
  assert.equal(main.getExtras()._sourceComponentXml, opaqueXml);
});

test("replace preserves the stable id and rejects planned node types", () => {
  const { document } = fixture();
  const replaced = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "replace",
      selector: "#n3",
      expectedMatches: 1,
      node: {
        type: "graph",
        name: "replacement",
        style: { width: 20, height: 20 },
        relations: [],
        content: { shape: "ellipse" }
      }
    }]
  }));
  assert.equal(replaced.ok, true);
  if (replaced.ok) {
    assert.equal(
      replaced.data.dom.root.children.find((node) => node.id === "n3")?.type,
      "graph"
    );
  }

  const { document: rejectedDocument } = fixture();
  const rejected = new DomPatchEngine().apply(
    rejectedDocument,
    ApplyDomPatchInputSchema.parse({
      projectId: "project-1",
      packageId: PACKAGE_ID,
      componentId: COMPONENT_ID,
      operations: [{
        op: "replace",
        selector: "#n3",
        expectedMatches: 1,
        node: {
          type: "tree",
          name: "tree",
          style: {},
          relations: [],
          content: { layout: "single-column", items: [] }
        }
      }]
    })
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "INVALID_PATCH");
});

test("image and loader patches apply fill origins, deterministic defaults and null resets", () => {
  const { document, main } = fixture();
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "filledImage",
        node: {
          type: "image",
          name: "filled-image",
          style: { width: 180, height: 180 },
          relations: [],
          content: {
            fillMethod: "radial-360",
            fillOrigin: "right",
            fillClockwise: false,
            fillAmount: 0.6
          }
        }
      },
      {
        op: "insert",
        parentSelector: "component-root",
        expectedMatches: 1,
        clientRef: "filledLoader",
        node: {
          type: "loader",
          name: "filled-loader",
          style: { width: 120, height: 80 },
          relations: [],
          content: {
            fillMethod: "radial-180",
            fillOrigin: "bottom",
            fillClockwise: false,
            fillAmount: 0.4
          }
        }
      },
      {
        op: "update",
        targetRef: "filledImage",
        expectedMatches: 1,
        changes: {
          content: {
            fillMethod: "horizontal"
          }
        }
      },
      {
        op: "update",
        targetRef: "filledImage",
        expectedMatches: 1,
        changes: {
          content: {
            fillMethod: "radial-90",
            fillOrigin: "bottom-right",
            fillClockwise: false
          }
        }
      },
      {
        op: "update",
        targetRef: "filledImage",
        expectedMatches: 1,
        changes: {
          content: {
            fillOrigin: null,
            fillClockwise: null
          }
        }
      },
      {
        op: "replace",
        selector: "#n3",
        expectedMatches: 1,
        node: {
          type: "image",
          name: "vertical-fill",
          style: { width: 20, height: 40 },
          relations: [],
          content: {
            fillMethod: "vertical",
            fillOrigin: "bottom",
            fillAmount: 0.5
          }
        }
      }
    ]
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const filledImage = main.getChildById(result.data.clientRefs.filledImage!) as
    | (GObject & {
      getFillMethod(): number;
      getFillOrigin(): number;
      getFillClockwise(): boolean;
      getFillAmount(): number;
    })
    | null;
  const filledLoader = main.getChildById(result.data.clientRefs.filledLoader!) as
    | (GObject & {
      getFillMethod(): number;
      getFillOrigin(): number;
      getFillClockwise(): boolean;
      getFillAmount(): number;
    })
    | null;
  const replacement = main.getChildById("n3") as
    | (GObject & {
      getFillMethod(): number;
      getFillOrigin(): number;
    })
    | null;

  assert.equal(filledImage?.getFillMethod(), FillMethod.Radial90);
  assert.equal(filledImage?.getFillOrigin(), FillOrigin90.TopLeft);
  assert.equal(filledImage?.getFillClockwise(), true);
  assert.equal(filledImage?.getFillAmount(), 0.6);
  assert.equal(filledLoader?.getFillMethod(), FillMethod.Radial180);
  assert.equal(filledLoader?.getFillOrigin(), FillOrigin.Bottom);
  assert.equal(filledLoader?.getFillClockwise(), false);
  assert.equal(filledLoader?.getFillAmount(), 0.4);
  assert.equal(replacement?.getFillMethod(), FillMethod.Vertical);
  assert.equal(replacement?.getFillOrigin(), FillOrigin.Bottom);
});

test("fill patch rejects method-incompatible origins at the exact field path", () => {
  const { document, main } = fixture();
  main.addChild(
    document.createGImage("image")
      .setId("n10")
      .setFillMethod(FillMethod.Radial360)
      .setFillOrigin(FillOrigin.Right)
  );
  const update = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: "#n10",
      expectedMatches: 1,
      changes: {
        content: {
          fillMethod: "horizontal",
          fillOrigin: "top"
        }
      }
    }]
  }));

  assert.equal(update.ok, false);
  if (!update.ok) {
    assert.equal(update.error.code, "INVALID_PATCH");
    assert.equal(
      update.error.path,
      "operations[0].changes.content.fillOrigin"
    );
    assert.deepEqual(update.error.allowed, ["left", "right"]);
  }

  const { document: insertDocument } = fixture();
  const insert = new DomPatchEngine().apply(insertDocument, parsePatch({
    operations: [{
      op: "insert",
      parentSelector: "component-root",
      expectedMatches: 1,
      clientRef: "invalidFill",
      node: {
        type: "loader",
        name: "invalid",
        style: {},
        relations: [],
        content: {
          fillMethod: "radial-90",
          fillOrigin: "top"
        }
      }
    }]
  }));

  assert.equal(insert.ok, false);
  if (!insert.ok) {
    assert.equal(insert.error.code, "INVALID_PATCH");
    assert.equal(
      insert.error.path,
      "operations[0].node.content.fillOrigin"
    );
    assert.deepEqual(insert.error.allowed, [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right"
    ]);
  }
});

test("changing fill method replaces an incompatible old origin deterministically", () => {
  const { document, main } = fixture();
  main.addChild(
    document.createGImage("image")
      .setId("n10")
      .setFillMethod(FillMethod.Radial360)
      .setFillOrigin(FillOrigin.Top)
      .setFillClockwise(false)
      .setFillAmount(0.6)
  );
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: "#n10",
      expectedMatches: 1,
      changes: {
        content: {
          fillMethod: "horizontal"
        }
      }
    }]
  }));

  assert.equal(result.ok, true);
  const image = main.getChildById("n10") as unknown as {
    getFillMethod(): number;
    getFillOrigin(): number;
    getFillClockwise(): boolean;
    getFillAmount(): number;
  };
  assert.equal(image.getFillMethod(), FillMethod.Horizontal);
  assert.equal(image.getFillOrigin(), FillOrigin.Left);
  assert.equal(image.getFillClockwise(), true);
  assert.equal(image.getFillAmount(), 0.6);
});

test("fillClockwise is rejected for non-radial methods at its exact path", () => {
  const { document, main } = fixture();
  main.addChild(
    document.createGLoader("loader")
      .setId("n10")
      .setFillMethod(FillMethod.Horizontal)
      .setFillOrigin(FillOrigin.Left)
  );
  const result = new DomPatchEngine().apply(document, parsePatch({
    operations: [{
      op: "update",
      selector: "#n10",
      expectedMatches: 1,
      changes: {
        content: {
          fillClockwise: false
        }
      }
    }]
  }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PATCH");
    assert.equal(
      result.error.path,
      "operations[0].changes.content.fillClockwise"
    );
  }
});
