import assert from "node:assert/strict";
import { test } from "node:test";
import { Document, GearType } from "@magicskysword/openfairygui-core";
import { queryAuthoringDocument } from "../../src/query/native-query-service.js";

function fixture() {
  const document = new Document();
  const pkg = document.createPackage('UI').setId('package1');
  const component = document.createComponent('Panel').setId('panel').setSize(200, 80);
  pkg.addResource(component);
  for (let i = 0; i < 100; i++) component.addChild(document.createGTextField(`title${i}`).setId(`n${i}`).setText(`Text ${i}`).setXY(i, 2));
  const controller = document.createController('state');
  controller.addPage(document.createControllerPage('up').setId('0')); controller.addPage(document.createControllerPage('down').setId('1'));
  component.addController(controller);
  component.getChildById('n0')!.addGear(document.createGear().setGearType(GearType.XY).setController(controller).setPages('0,1').setValues('0,2|40,2'));
  component.setExtras({ _sourceComponentXml: '<component><displayList><text id="n0" name="title0" text="Text 0" custom="keep"/></displayList></component>' });
  return document;
}

test('single-node native queries scale with matches and expose native values and gear scopes', () => {
  const result = queryAuthoringDocument(fixture(), { projectId: 'p', queries: { title: { kind: 'nodes', packageId: 'package1', componentId: 'panel', selector: '#n0', detail: 'full' } } });
  const title = result.results.title!;
  assert.equal(title.ok, true); if (!title.ok) return;
  assert.equal(title.data.items.length, 1);
  const item = title.data.items[0] as Record<string, any>;
  assert.equal(item.type, 'GTextField');
  assert.equal(item.props.x, 0);
  assert.equal(item.gears[0].controller, 'state');
  assert.ok(item.writable.scopedProperties.includes('x'));
  assert.ok(item.definition.file.endsWith('GTextField.schema.json'));
  assert.ok(JSON.stringify(title).length < 8000);
  assert.equal('children' in item, false);
});

test('native batches paginate by 50 and retain successful queries alongside failures', () => {
  const document = fixture();
  const first = queryAuthoringDocument(document, { projectId: 'p', queries: { nodes: { kind: 'nodes', packageId: 'package1', componentId: 'panel' }, bad: { kind: 'nodes', packageId: 'package1', componentId: 'missing' } } });
  assert.equal(first.failed, 1);
  const nodes = first.results.nodes!; assert.equal(nodes.ok, true); if (!nodes.ok) return;
  assert.equal(nodes.data.items.length, 50);
  const next = queryAuthoringDocument(document, { projectId: 'p', queries: { nodes: { kind: 'nodes', packageId: 'package1', componentId: 'panel', cursor: nodes.data.nextCursor! } } });
  const remaining = next.results.nodes!; assert.equal(remaining.ok, true); if (!remaining.ok) return;
  assert.equal(remaining.data.items.length, 50);
  assert.equal((remaining.data.items[0] as any).target.nodeId, 'n50');
});

test('XML fragments, controller pages and local references share stable target locations', () => {
  const result = queryAuthoringDocument(fixture(), { projectId: 'p', queries: {
    xml: { kind: 'xml', target: { kind: 'node', packageId: 'package1', componentId: 'panel', nodeId: 'n0' } },
    controllers: { kind: 'controllers', packageId: 'package1', componentId: 'panel', detail: 'full' },
    refs: { kind: 'references', target: { kind: 'controller', packageId: 'package1', componentId: 'panel', controllerName: 'state' } }
  } });
  assert.equal(result.failed, 0);
  const xml = result.results.xml!; assert.equal(xml.ok, true); if (xml.ok) assert.match(String((xml.data.items[0] as any).xml), /custom="keep"/);
  const controllers = result.results.controllers!; assert.equal(controllers.ok, true); if (controllers.ok) assert.equal((controllers.data.items[0] as any).pages.length, 2);
  const refs = result.results.refs!; assert.equal(refs.ok, true); if (refs.ok) assert.equal(refs.data.items.length, 1);
});
