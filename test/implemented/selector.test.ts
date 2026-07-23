import assert from "node:assert/strict";
import { test } from "node:test";
import type { FairyDomDocument } from "../../src/contracts/dom.js";
import {
  matchFairyDomSelector,
  parseFairyDomSelector,
  SelectorSyntaxError
} from "../../src/dom/selector.js";

function fixture(): FairyDomDocument {
  return {
    schemaVersion: 1,
    packageId: "pkg00001",
    componentId: "cmp01",
    root: {
      type: "component-root",
      id: "cmp01",
      name: "Main",
      style: { width: 800, height: 600 },
      content: { overflow: "visible" },
      relations: [],
      children: [
        {
          type: "image",
          id: "n0",
          name: "hero",
          style: {},
          content: {},
          relations: []
        },
        {
          type: "text",
          id: "n1",
          name: "title",
          style: {},
          content: { text: "Title" },
          relations: []
        },
        {
          type: "text",
          id: "legacy.child",
          name: "subtitle",
          style: {},
          content: { text: "Subtitle" },
          relations: []
        },
        {
          type: "instance",
          id: "n3",
          name: "card",
          style: {},
          content: {
            resource: { packageId: "pkg00002", resourceId: "card1" }
          },
          relations: []
        }
      ]
    }
  };
}

test("selector parser accepts the intentionally restricted grammar", () => {
  assert.deepEqual(
    parseFairyDomSelector('component-root > text#n1[name="title"]'),
    {
      source: 'component-root > text#n1[name="title"]',
      steps: [
        {
          combinator: null,
          compound: { type: "component-root" }
        },
        {
          combinator: "child",
          compound: { type: "text", id: "n1", name: "title" }
        }
      ]
    }
  );
  assert.deepEqual(
    parseFairyDomSelector('[name="sub\\"title"]'),
    {
      source: '[name="sub\\"title"]',
      steps: [{
        combinator: null,
        compound: { name: 'sub"title' }
      }]
    }
  );
});

test("selector matcher preserves document order across type, id and name queries", () => {
  const document = fixture();

  assert.deepEqual(
    matchFairyDomSelector(document.root, "text").map((node) => node.id),
    ["n1", "legacy.child"]
  );
  assert.deepEqual(
    matchFairyDomSelector(document.root, "#legacy.child").map((node) => node.id),
    ["legacy.child"]
  );
  assert.deepEqual(
    matchFairyDomSelector(document.root, '[name="hero"]').map((node) => node.id),
    ["n0"]
  );
  assert.deepEqual(
    matchFairyDomSelector(document.root, "component-root > text").map(
      (node) => node.id
    ),
    ["n1", "legacy.child"]
  );
  assert.deepEqual(
    matchFairyDomSelector(document.root, "component-root text#n1").map(
      (node) => node.id
    ),
    ["n1"]
  );
});

test("selector parser rejects unsupported CSS with stable positions", () => {
  const invalidSelectors = [
    "",
    "*",
    ".title",
    "text:first-child",
    "text, image",
    "text + image",
    "text ~ image",
    "[id=\"n1\"]",
    "[name='title']",
    "unknown-type"
  ];

  for (const selector of invalidSelectors) {
    assert.throws(
      () => parseFairyDomSelector(selector),
      (error: unknown) => {
        assert.ok(error instanceof SelectorSyntaxError, selector);
        assert.equal(error.code, "INVALID_SELECTOR", selector);
        assert.ok(Number.isInteger(error.index), selector);
        assert.ok(error.index >= 0, selector);
        return true;
      }
    );
  }
});

test("selector matcher does not traverse an instance boundary by default", () => {
  const document = fixture();
  const instance = document.root.children[3] as typeof document.root.children[3] & {
    children?: Array<{
      type: "text";
      id: string;
      name: string;
      children?: never[];
    }>;
  };
  instance.children = [{
    type: "text",
    id: "projected-n0",
    name: "inside",
    children: []
  }];

  assert.deepEqual(
    matchFairyDomSelector(document.root, "instance text").map((node) => node.id),
    []
  );
  assert.deepEqual(
    matchFairyDomSelector(document.root, "instance text", {
      crossInstanceBoundaries: true
    }).map((node) => node.id),
    ["projected-n0"]
  );
});

