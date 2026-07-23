import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Document,
  GroupLayoutType,
  ListLayoutType,
  OverflowType,
  RelationType,
  ScrollType
} from "@magicskysword/openfairygui-core";
import { FairyDomDocumentSchema } from "../../src/contracts/dom.js";
import {
  projectComponentInstances,
  toFairyDomDocument
} from "../../src/dom/openfairygui-adapter.js";

function createDocument(): {
  document: Document;
  packageId: string;
  componentId: string;
} {
  const document = new Document();
  const packageId = "pkg00001";
  const componentId = "cmp01";
  const pkg = document.createPackage("Demo").setId(packageId);
  const imageResource = document.createImageResource("Hero").setId("img01");
  const itemComponent = document.createComponent("Card").setId("card1");
  itemComponent
    .setSize(100, 50)
    .addChild(
      document.createGTextField("inside")
        .setId("n0")
        .setText("Inside")
        .setXY(1, 2)
        .setSize(80, 20)
    );
  const component = document.createComponent("Main")
    .setId(componentId)
    .setSize(800, 600)
    .setOverflow(OverflowType.Scroll)
    .setScrollType(ScrollType.Vertical);
  pkg.addResource(imageResource);
  pkg.addResource(itemComponent);
  pkg.addResource(component);

  component.addChild(
    document.createGImage("hero")
      .setId("n0")
      .setSrc("img01")
      .setPackageId(packageId)
      .setXY(10, 20)
      .setSize(128, 128)
      .setAlpha(0.75)
      .addRelation({
        target: "n1",
        type: RelationType.Left_Left,
        usePercent: false
      })
  );
  component.addChild(
    document.createGGroup("row")
      .setId("n1")
      .setLayout(GroupLayoutType.Horizontal)
      .setColumnGap(8)
  );
  component.addChild(
    document.createGTextField("title")
      .setId("n2")
      .setGroup("n1")
      .setText("Hello")
      .setFontSize(24)
      .setXY(150, 20)
      .setSize(200, 40)
  );
  component.addChild(
    document.createGList("items")
      .setId("n3")
      .setLayout(ListLayoutType.FlowHorizontal)
      .setListItems([{
        title: "One",
        icon: `ui://${packageId}img01`,
        url: `ui://${packageId}card1`,
        name: null,
        selectedTitle: null,
        selectedIcon: null,
        level: 0,
        isFolder: null
      }])
  );
  component.addChild(
    document.createGComponent("card")
      .setId("n4")
      .setSrc("card1")
      .setPackageId(packageId)
      .setXY(400, 20)
      .setSize(100, 50)
  );
  component.addChild(
    document.createGTree("tree")
      .setId("n5")
      .setLayout(ListLayoutType.SingleColumn)
  );
  component.addChild(
    document.createGLoader3D("model")
      .setId("n6")
      .setUrl(`ui://${packageId}model1`)
  );

  return { document, packageId, componentId };
}

test("OpenFairyGUI adapter emits strict CSS-style DOM without runtime aliases", () => {
  const { document, packageId, componentId } = createDocument();
  const dom = toFairyDomDocument(document, packageId, componentId);

  assert.deepEqual(FairyDomDocumentSchema.parse(dom), dom);
  assert.deepEqual(dom.root.content, {
    overflow: "scroll",
    scrollAxis: "vertical",
    opaque: true
  });
  assert.deepEqual(dom.root.children[0], {
    type: "image",
    id: "n0",
    name: "hero",
    style: {
      left: 10,
      top: 20,
      width: 128,
      height: 128,
      opacity: 0.75,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
      pivotX: 0,
      pivotY: 0,
      pivotAsAnchor: false,
      visible: true,
      touchable: true,
      grayed: false
    },
    relations: [{
      targetId: "n1",
      type: "Left_Left",
      percent: false
    }],
    content: {
      resource: { packageId, resourceId: "img01" },
      flip: "none",
      fillMethod: "none",
      fillAmount: 1,
      color: "#FFFFFF"
    }
  });
  assert.equal("x" in dom.root.children[0]!.style, false);
  assert.equal("alpha" in dom.root.children[0]!.style, false);
});

test("empty enabled component background is normalized as unset", () => {
  const { document, packageId, componentId } = createDocument();
  const component = document.getRoot()
    .getPackageById(packageId)
    ?.listComponents()
    .find((candidate) => candidate.getId() === componentId);
  assert.ok(component);
  component.setBgColorEnabled(true).setBgColor("");

  const dom = toFairyDomDocument(document, packageId, componentId);

  assert.equal(dom.root.content.backgroundColor, undefined);
  assert.deepEqual(FairyDomDocumentSchema.parse(dom), dom);
});

test("Group members stay siblings and static List items are content", () => {
  const { document, packageId, componentId } = createDocument();
  const dom = toFairyDomDocument(document, packageId, componentId);
  const group = dom.root.children.find((node) => node.type === "group");
  const title = dom.root.children.find((node) => node.id === "n2");
  const list = dom.root.children.find((node) => node.type === "list");

  assert.equal(group?.type, "group");
  assert.equal(title?.groupId, "n1");
  assert.equal("children" in (group ?? {}), false);
  assert.equal(list?.type, "list");
  if (list?.type === "list") {
    assert.deepEqual(list.content.items, [{
      title: "One",
      icon: { packageId, resourceId: "img01" },
      resource: { packageId, resourceId: "card1" }
    }]);
  }
});

test("planned Tree and Loader3D remain explicit read-only nodes", () => {
  const { document, packageId, componentId } = createDocument();
  const dom = toFairyDomDocument(document, packageId, componentId);

  const tree = dom.root.children.find((node) => node.id === "n5");
  const loader3d = dom.root.children.find((node) => node.id === "n6");
  assert.equal(tree?.type, "tree");
  assert.equal(tree?.readOnly, true);
  assert.equal(loader3d?.type, "loader3d");
  assert.equal(loader3d?.readOnly, true);
});

test("resolved instance previews are separate read-only source projections", () => {
  const { document, packageId, componentId } = createDocument();
  const projections = projectComponentInstances(document, packageId, componentId);

  assert.equal(projections.length, 1);
  assert.equal(projections[0]?.instanceId, "n4");
  assert.equal(projections[0]?.readOnly, true);
  assert.equal(projections[0]?.source.componentId, "card1");
  assert.equal(projections[0]?.dom.root.children[0]?.name, "inside");
});
