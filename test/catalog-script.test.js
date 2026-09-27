import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseRecordDetail, buildCatalogScript } from '../lib/schema/catalog-script.js';
import { buildGraph } from '../lib/schema/build.js';

// Record detail in the shape getRecordTypeDetail (SS_ANAL) returns, rebuilt from the
// standard inventorynumber record of a real export (columns and join labels as exported).
const detail = {
  label: 'Serial/Lot Number',
  fields: [
    { id: 'id', label: 'Internal ID', dataType: 'INTEGER', isColumn: true },
    { id: 'inventoryNumber', label: 'Serial/Lot Number', dataType: 'STRING', isColumn: true },
    { id: 'item', label: 'Item', dataType: 'INTEGER', isColumn: true },
    { id: 'expirationDate', label: 'Expiration Date', dataType: 'DATE', isColumn: true },
    { id: 'quantityOnHand', label: 'On Hand', dataType: 'FLOAT', isColumn: true },
    { id: 'locations', label: 'Locations', isColumn: false },
  ],
  joins: [
    { cardinality: 'N:1', joinType: 'POLYMORPHIC', label: 'Item', fieldId: 'item', sourceTargetType: { id: 'item' },
      joinPairs: [{ label: 'inventorynumber.item = item.id' }] },
    { cardinality: 'N:1', joinType: 'POLYMORPHIC', label: 'Inventory Item', fieldId: 'item', sourceTargetType: { id: 'inventoryItem' },
      joinPairs: [{ label: 'inventorynumber.item = inventoryItem.id' }] },
    // multi-key join: the second pair must survive
    { cardinality: 'N:1', joinType: 'AUTOMATIC', label: 'Item Location', fieldId: 'itemLocation', sourceTargetType: { id: 'inventorynumberlocation' },
      joinPairs: [{ label: 'inventorynumber.id = inventorynumberlocation.inventorynumber' }, { label: 'inventorynumber.location = inventorynumberlocation.location' }] },
    // label that does not parse: falls back to the field id, raw label kept
    { cardinality: 'N:1', joinType: 'INVERSE', label: 'Transaction', fieldId: 'transactionLines', sourceTargetType: { id: 'transaction' },
      joinPairs: [{ label: 'Transaction Lines' }] },
    { cardinality: '1:N', joinType: 'AUTOMATIC', label: 'Children', fieldId: 'kids', sourceTargetType: { id: 'x' } },
  ],
};

test('parse keeps columns, every joinPair and raw labels', () => {
  const r = parseRecordDetail('inventorynumber', 'Serial/Lot Number', detail);
  assert.deepEqual(r.table.columns.map((c) => c.id), ['id', 'inventoryNumber', 'item', 'expirationDate', 'quantityOnHand']);
  assert.equal(r.relationships.length, 4, '1:N joins are skipped');
  const [item, inv, multi, inverse] = r.relationships;
  assert.equal(item.fromColumn, 'item');
  assert.equal(item.toColumn, 'id');
  assert.equal(inv.toTable, 'inventoryitem');
  assert.deepEqual(multi.joinPairs.map((p) => [p.fromColumn, p.toColumn]), [['id', 'inventorynumber'], ['location', 'location']]);
  assert.equal(multi.joinPairs[1].label, 'inventorynumber.location = inventorynumberlocation.location');
  assert.equal(inverse.fromColumn, 'transactionLines');
  assert.equal(inverse.joinPairs[0].label, 'Transaction Lines');
  assert.deepEqual(r.discovered, ['item', 'inventoryitem', 'inventorynumberlocation', 'transaction']);
});

test('parsed output builds into the graph with multi-key joins intact', () => {
  const r = parseRecordDetail('inventorynumber', 'Serial/Lot Number', detail);
  const data = { tables: [r.table, { id: 'inventorynumberlocation', label: 'x', columns: [{ id: 'inventorynumber' }, { id: 'location' }] }], relationships: r.relationships };
  const { graph } = buildGraph({ exports: [{ key: 'k', data }], facts: {}, clientPrefixes: [] });
  const e = graph.edges.find((x) => x.to === 'inventorynumberlocation');
  assert.deepEqual(e.keys, [['id', 'inventorynumber'], ['location', 'location']]);
});

test('snippet compiles, embeds the tested parser, and only issues GETs to the catalog', () => {
  const s = buildCatalogScript();
  assert.doesNotThrow(() => new vm.Script(s));
  assert.ok(s.includes(parseRecordDetail.toString()));
  assert.ok(s.includes("method: 'GET'"));
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(s));
  const urls = s.match(/'\/[a-z/]+[^']*'/g) || [];
  assert.ok(urls.every((u) => u.startsWith("'/app/recordscatalog/rcendpoint.nl")), urls.join(','));
});

test('snippet walks tables and discovery rounds against a fake endpoint', async () => {
  const s = buildCatalogScript({ delayMs: 0, batch: 1000 });
  const calls = [];
  let downloaded = null;
  const records = {
    inventorynumber: detail,
    item: { fields: [{ id: 'id', isColumn: true, dataType: 'INTEGER' }], joins: [] },
    inventoryitem: { fields: [], joins: [] },
    inventorynumberlocation: { fields: [], joins: [] },
    transaction: { fields: [], joins: [] },
  };
  const sandbox = {
    console: { log() {} },
    setTimeout: (f) => f(),
    encodeURIComponent,
    URL: { createObjectURL: (b) => b },
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    document: { body: { appendChild() {} }, createElement: () => ({ click() { downloaded = JSON.parse(this.href.text); }, remove() {} }) },
    fetch: async (url, opts) => {
      calls.push([url, opts.method]);
      const q = new URL(url, 'https://x');
      const data = JSON.parse(q.searchParams.get('data'));
      const body = q.searchParams.get('action') === 'getRecordTypes' ? [{ id: 'inventorynumber', label: 'Serial/Lot Number' }] : records[String(data.scriptId).toLowerCase()];
      return { ok: true, json: async () => ({ data: body }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.URL = Object.assign(function (u, b) { return new globalThis.URL(u, b); }, { createObjectURL: (b) => b });
  vm.createContext(sandbox);
  await vm.runInContext(s.replace('(async () => {', 'globalThis.__p = (async () => {'), sandbox);
  await sandbox.__p;
  assert.ok(calls.every(([, m]) => m === 'GET'));
  assert.equal(downloaded.tableCount, 5);
  assert.equal(downloaded.relationshipCount, 4);
  assert.deepEqual(downloaded.errors, []);
});
