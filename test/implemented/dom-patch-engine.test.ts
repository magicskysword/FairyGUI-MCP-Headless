import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Document,
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
        op: "set-text",
        targetRef: "label",
        expectedMatches: 1,
        text: "Created"
      },
      {
        op: "set-style",
        selector: 'text[name="created-label"]',
        expectedMatches: 1,
        changes: { opacity: 0.75, left: 24 }
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
            lineCount: 2,
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

test("set, move, remove and replace-node enforce compatible writable targets", () => {
  const { document } = fixture();
  const engine = new DomPatchEngine();
  const input = parsePatch({
    operations: [
      {
        op: "set-name",
        selector: "#n3",
        expectedMatches: 1,
        name: "renamed"
      },
      {
        op: "set-relations",
        selector: "#n3",
        expectedMatches: 1,
        relations: [{
          targetId: COMPONENT_ID,
          type: "Center_Center",
          percent: true
        }]
      },
      {
        op: "set-list-items",
        selector: "#n7",
        expectedMatches: 1,
        items: [{ title: "One" }, { title: "Two" }]
      },
      {
        op: "set-resource",
        selector: "#n9",
        expectedMatches: 1,
        resource: { packageId: PACKAGE_ID, resourceId: "card1" }
      },
      {
        op: "replace-node",
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

  assert.equal(data.appliedOperations, 6);
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
        op: "set-text",
        selector: "text:hover",
        expectedMatches: 1,
        text: "bad"
      },
      code: "INVALID_SELECTOR"
    },
    {
      operation: {
        op: "set-text",
        selector: "text",
        expectedMatches: 2,
        text: "bad"
      },
      code: "SELECTOR_MATCH_COUNT"
    },
    {
      operation: {
        op: "set-style",
        selector: "#n8",
        expectedMatches: 1,
        changes: { left: 1 }
      },
      code: "READ_ONLY_CAPABILITY"
    },
    {
      operation: {
        op: "set-text",
        selector: "instance > text",
        expectedMatches: 1,
        text: "bad"
      },
      code: "INSTANCE_BOUNDARY"
    },
    {
      operation: {
        op: "set-style",
        selector: "component-root",
        expectedMatches: 1,
        changes: { opacity: 0.5 }
      },
      code: "INVALID_PATCH"
    },
    {
      operation: {
        op: "set-resource",
        selector: "#n9",
        expectedMatches: 1,
        resource: { packageId: PACKAGE_ID, resourceId: "missing" }
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

test("an operation cannot target a clientRef before its insert executes", () => {
  const { document } = fixture();
  const input = parsePatch({
    operations: [
      {
        op: "set-text",
        targetRef: "later",
        expectedMatches: 1,
        text: "Too early"
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

test("replace displayTree preserves supplied stable ids, order and references", () => {
  const { document, main } = fixture();
  const input = parsePatch({
    replace: {
      domain: "displayTree",
      value: [
        {
          id: "legacy-title",
          type: "text",
          name: "title",
          groupId: "layout-group",
          style: { left: 8, top: 9 },
          relations: [{
            targetId: "layout-group",
            type: "Left_Left",
            percent: false
          }],
          content: { text: "Replacement" }
        },
        {
          id: "layout-group",
          type: "group",
          name: "layout",
          style: {},
          relations: [],
          content: { layout: "vertical", lineGap: 5 }
        }
      ]
    }
  });

  const data = successData(new DomPatchEngine().apply(document, input));

  assert.equal(data.appliedOperations, 1);
  assert.deepEqual(data.clientRefs, {});
  assert.deepEqual(
    main.listChildren().map((child) => child.getId()),
    ["legacy-title", "layout-group"]
  );
  assert.equal(data.dom.root.children[0]?.groupId, "layout-group");
  assert.deepEqual(data.dom.root.children[0]?.relations, [{
    targetId: "layout-group",
    type: "Left_Left",
    percent: false
  }]);
});

test("replace componentProperties, relations and listItems update one complete domain", () => {
  {
    const { document, main } = fixture();
    const data = successData(new DomPatchEngine().apply(document, parsePatch({
      replace: {
        domain: "componentProperties",
        value: {
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
      }
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
  }

  {
    const { document } = fixture();
    const data = successData(new DomPatchEngine().apply(document, parsePatch({
      replace: {
        domain: "relations",
        selector: "#n3",
        expectedMatches: 1,
        value: [{
          targetId: COMPONENT_ID,
          type: "Width",
          percent: true
        }]
      }
    })));
    assert.deepEqual(
      data.dom.root.children.find((node) => node.id === "n3")?.relations,
      [{ targetId: COMPONENT_ID, type: "Width", percent: true }]
    );
  }

  {
    const { document } = fixture();
    const data = successData(new DomPatchEngine().apply(document, parsePatch({
      replace: {
        domain: "listItems",
        selector: "#n7",
        expectedMatches: 1,
        value: [{ title: "A" }, { title: "B" }, { title: "C" }]
      }
    })));
    const list = data.dom.root.children.find((node) => node.id === "n7");
    assert.equal(list?.type === "list" && list.content.items.length, 3);
  }
});

test("planned replacement domains return their declared read-only capabilities", () => {
  for (const domain of ["gears", "controllers", "transitions"] as const) {
    const { document } = fixture();
    const result = new DomPatchEngine().apply(document, parsePatch({
      replace: { domain, value: [] }
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "READ_ONLY_CAPABILITY");
      assert.equal(result.error.path, "replace.domain");
    }
  }
});

test("opaque content conflicts reject unsafe domain replacement before mutation", () => {
  const opaqueXml = `<component size="320,180">
  <displayList vendorDisplay="keep">
    <text id="n3" name="title" text="Before">
      <relation target="" sidePair="left-left" vendorRelation="keep"/>
    </text>
    <list id="n7"><item title="Before" vendorItem="keep"/></list>
    <vendorWidget value="keep"/>
  </displayList>
</component>`;

  for (const replace of [
    {
      domain: "displayTree" as const,
      value: []
    },
    {
      domain: "relations" as const,
      selector: "#n3",
      expectedMatches: 1,
      value: []
    },
    {
      domain: "listItems" as const,
      selector: "#n7",
      expectedMatches: 1,
      value: []
    }
  ]) {
    const { document, main } = fixture();
    main.setExtras({
      ...main.getExtras(),
      _sourceComponentXml: opaqueXml
    });
    const beforeIds = main.listChildren().map((child) => child.getId());

    const result = new DomPatchEngine().apply(document, parsePatch({ replace }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "OPAQUE_CONTENT_CONFLICT");
      assert.equal(result.error.path, `replace.${replace.domain}`);
    }
    assert.deepEqual(
      main.listChildren().map((child) => child.getId()),
      beforeIds
    );
  }
});

test("displayTree replacement rejects duplicate ids and planned node types", () => {
  const textNode = {
    id: "duplicate",
    type: "text" as const,
    name: "text",
    style: {},
    relations: [],
    content: { text: "" }
  };
  {
    const { document } = fixture();
    const result = new DomPatchEngine().apply(document, parsePatch({
      replace: {
        domain: "displayTree",
        value: [textNode, { ...textNode, name: "other" }]
      }
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_DOM");
  }
  {
    const { document } = fixture();
    const result = new DomPatchEngine().apply(document, parsePatch({
      replace: {
        domain: "displayTree",
        value: [{
          id: "tree",
          type: "tree",
          name: "tree",
          readOnly: true,
          capability: "node.tree",
          style: {},
          relations: [],
          content: {
            layout: "single-column",
            items: []
          }
        }]
      }
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "READ_ONLY_CAPABILITY");
  }
});
