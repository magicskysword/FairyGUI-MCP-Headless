import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAIRYGUI_RELATION_TYPES,
  FairyDomDocumentSchema,
  FairyDomNodeSchema,
  type FairyDomDocument
} from "../../src/contracts/dom.js";

function validDocument(): FairyDomDocument {
  return {
    schemaVersion: 1,
    packageId: "legacy-package-id",
    componentId: "legacy-component-id",
    root: {
      type: "component-root",
      id: "legacy-component-id",
      name: "Main",
      style: {
        width: 800,
        height: 600,
        opacity: 1,
        visible: true
      },
      content: {
        overflow: "scroll",
        scrollAxis: "vertical"
      },
      relations: [],
      children: [
        {
          type: "image",
          id: "n0",
          name: "hero",
          style: {
            left: 10,
            top: 20,
            width: 128,
            height: 128,
            opacity: 0.8
          },
          content: {
            resource: {
              packageId: "target01",
              resourceId: "img01"
            }
          },
          relations: [{
            targetId: "n1",
            type: "Left_Left",
            percent: false
          }]
        },
        {
          type: "group",
          id: "n1",
          name: "row",
          style: {},
          content: {
            layout: "horizontal",
            columnGap: 8,
            excludeInvisibles: true
          },
          relations: []
        },
        {
          type: "text",
          id: "legacy-child",
          name: "title",
          groupId: "n1",
          style: {
            left: 160,
            top: 20,
            width: 240,
            height: 40
          },
          content: {
            text: "Hello",
            fontSize: 24,
            color: "#ffffff",
            align: "center",
            verticalAlign: "middle"
          },
          relations: []
        },
        {
          type: "list",
          id: "n3",
          name: "items",
          style: {
            left: 10,
            top: 180,
            width: 300,
            height: 300
          },
          content: {
            layout: "flow-horizontal",
            lineGap: 4,
            columnGap: 4,
            items: [{
              title: "One",
              icon: {
                packageId: "target01",
                resourceId: "img01"
              }
            }]
          },
          relations: []
        },
        {
          type: "instance",
          id: "n4",
          name: "card",
          style: {
            left: 400,
            top: 20,
            width: 200,
            height: 100
          },
          content: {
            resource: {
              packageId: "target01",
              resourceId: "cmp01"
            }
          },
          relations: []
        }
      ]
    }
  };
}

test("typed DOM schema accepts canonical CSS-style fields and legacy ids", () => {
  const document = validDocument();
  assert.deepEqual(FairyDomDocumentSchema.parse(document), document);
});

test("DOM schema exposes exactly all 25 FairyGUI relation names", () => {
  assert.equal(FAIRYGUI_RELATION_TYPES.length, 25);
  assert.equal(new Set(FAIRYGUI_RELATION_TYPES).size, 25);
  assert.equal(FAIRYGUI_RELATION_TYPES[0], "Left_Left");
  assert.equal(FAIRYGUI_RELATION_TYPES[24], "Size");
});

test("DOM schema rejects runtime aliases and CSS unit strings", () => {
  const aliasNode = {
    type: "image",
    id: "n0",
    name: "hero",
    style: { x: 10, alpha: 0.5 },
    content: {},
    relations: []
  };
  const unitNode = {
    type: "image",
    id: "n0",
    name: "hero",
    style: { left: "10px", width: "calc(100% - 20px)" },
    content: {},
    relations: []
  };

  assert.equal(FairyDomNodeSchema.safeParse(aliasNode).success, false);
  assert.equal(FairyDomNodeSchema.safeParse(unitNode).success, false);
});

test("Group and List remain flat boundary nodes instead of generic containers", () => {
  const groupWithChildren = {
    type: "group",
    id: "n0",
    name: "group",
    style: {},
    content: { layout: "horizontal" },
    relations: [],
    children: []
  };
  const listWithChildren = {
    type: "list",
    id: "n1",
    name: "list",
    style: {},
    content: { layout: "single-column", items: [] },
    relations: [],
    children: []
  };

  assert.equal(FairyDomNodeSchema.safeParse(groupWithChildren).success, false);
  assert.equal(FairyDomNodeSchema.safeParse(listWithChildren).success, false);
});

test("DOM schema rejects unknown nodes, invalid relations and wrong schema versions", () => {
  const unknownNode = {
    type: "spine",
    id: "n0",
    name: "hero",
    style: {},
    content: {},
    relations: []
  };
  const badRelation = {
    type: "graph",
    id: "n0",
    name: "box",
    style: {},
    content: { shape: "rectangle" },
    relations: [{ targetId: "root", type: "Center" }]
  };
  const wrongVersion = { ...validDocument(), schemaVersion: 2 };

  assert.equal(FairyDomNodeSchema.safeParse(unknownNode).success, false);
  assert.equal(FairyDomNodeSchema.safeParse(badRelation).success, false);
  assert.equal(FairyDomDocumentSchema.safeParse(wrongVersion).success, false);
});

