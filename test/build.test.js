import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, edgeKey } from '../lib/schema/build.js';
import { catalogFixture, factsFixture } from './fixtures.js';

function build(extra = {}) {
  return buildGraph({
    exports: [{ key: 'e1', data: catalogFixture() }],
    facts: factsFixture(),
    clientPrefixes: ['acme'],
    ...extra,
  });
}

const findEdge = (edges, from, to, fromCol) =>
  edges.find((e) => e.from === from && e.to === to && e.keys[0][0] === fromCol);

test('table ids are lower-cased and case variants merged', () => {
  const { graph } = build();
  assert.ok(graph.tables.transaction);
  assert.equal(graph.tables.Transaction, undefined);
  const cols = graph.tables.transaction.cols.map((c) => c[0]);
  assert.ok(cols.includes('tranid'));
  assert.equal(cols.filter((c) => c === 'tranid').length, 1);
});

test('custom tables, columns and joins leave the public graph and go to the local layer', () => {
  const { graph, local } = build();
  assert.equal(graph.tables.customrecord_acme_thing, undefined);
  assert.ok(!graph.tables.transaction.cols.some((c) => c[0].startsWith('custbody')));
  assert.ok(!graph.edges.some((e) => e.keys.some(([fc]) => fc.startsWith('custcol'))));
  assert.ok(local.e1.tables.customrecord_acme_thing);
  assert.ok(local.e1.tables.transaction.cols.some((c) => c[0] === 'custbody_acme_flag'));
  assert.ok(local.e1.edges.some((e) => e.keys[0][0] === 'custcol_x'));
  assert.ok(!JSON.stringify(graph).includes('acme'));
});

test('suiteapp tables go to their own layer without client columns', () => {
  const { graph, suiteapp, local } = build();
  assert.equal(graph.tables.customrecord_ncfar_asset, undefined);
  const t = suiteapp.tables.customrecord_ncfar_asset;
  assert.equal(t.app, 'Fixed Assets Management');
  assert.ok(t.cols.some((c) => c[0] === 'custrecord_assetcost'));
  assert.ok(!t.cols.some((c) => c[0] === 'cseg_acme_seg'));
  assert.ok(local.e1.tables.customrecord_ncfar_asset.cols.some((c) => c[0] === 'cseg_acme_seg'));
  assert.ok(!JSON.stringify(suiteapp).includes('acme'));
});

test('polymorphic joins collapse to the family base table', () => {
  const { graph } = build();
  const e = findEdge(graph.edges, 'activity', 'transaction', 'transaction');
  assert.ok(e, 'activity.transaction -> transaction');
  assert.equal(e.kind, 'polymorphic');
  assert.ok(!findEdge(graph.edges, 'activity', 'invoice', 'transaction'));
  assert.ok(findEdge(graph.edges, 'transaction', 'entity', 'entity'));

});

test('verified facts override catalog edges that disagree', () => {
  const { graph } = build();
  assert.ok(!findEdge(graph.edges, 'transactionline', 'transaction', 'transactionlines'));
  const e = findEdge(graph.edges, 'transactionline', 'transaction', 'transaction');
  assert.deepEqual(e.keys, [['transaction', 'id']]);
  assert.ok(e.sources.includes('facts'));
  const u = graph.edges.filter((x) => x.from === 'transactionline' && x.to === 'unitstypeuom');
  assert.equal(u.length, 1);
  assert.deepEqual(u[0].keys, [['units', 'internalid']]);
});

test('same join from catalog and facts merges sources', () => {
  const { graph } = build();
  const e = findEdge(graph.edges, 'transactionline', 'item', 'item');
  assert.deepEqual(e.sources.sort(), ['catalog', 'facts']);
  assert.equal(graph.edges.filter((x) => x.from === 'transactionline' && x.to === 'item').length, 1);
});

test('tables missing from the catalog come from facts, marked by source', () => {
  const { graph } = build();
  const t = graph.tables.transactionaccountingline;
  assert.deepEqual(t.sources, ['facts']);
  assert.deepEqual(t.traps, ['Always filter accountingbook.']);
  const e = graph.edges.find((x) => x.from === 'transactionaccountingline' && x.to === 'transactionline');
  assert.deepEqual(e.keys, [['transaction', 'transaction'], ['transactionline', 'id']]);
  assert.deepEqual(e.traps, ['Never linesequencenumber.']);
  assert.deepEqual(graph.tables.transaction.traps, ['COUNT(*) fails: use COUNT(t.id).']);
});

test('multi-key catalog joins keep every joinPair', () => {
  const data = catalogFixture();
  data.relationships.push({
    fromTable: 'inventorynumber', fromColumn: 'item', toTable: 'item', toColumn: 'id', cardinality: 'N:1', joinType: 'AUTOMATIC', label: 'x',
    joinPairs: [{ fromColumn: 'item', toColumn: 'id' }, { fromColumn: 'location', toColumn: 'loc' }],
  });
  const { graph } = buildGraph({ exports: [{ key: 'e1', data }], facts: { edges: [] }, clientPrefixes: [] });
  const e = graph.edges.find((x) => x.from === 'inventorynumber' && x.keys.length === 2);
  assert.deepEqual(e.keys, [['item', 'id'], ['location', 'loc']]);
});

test('subtype tables link to their base with a filter', () => {
  const { graph } = build();
  assert.equal(graph.tables.invoice.subtypeOf, 'transaction');
  assert.equal(graph.tables.invoice.filter, "transaction.recordtype = 'invoice'");
  const e = graph.edges.find((x) => x.from === 'invoice' && x.to === 'transaction' && x.kind === 'subtype');
  assert.deepEqual(e.keys, [['id', 'id']]);
  assert.equal(graph.tables.inventoryitem.subtypeOf, 'item');
});

test('static column check flags join columns that are not columns', () => {
  const data = catalogFixture();
  const { graph, stats } = buildGraph({ exports: [{ key: 'e1', data }], facts: { edges: [] }, clientPrefixes: [] });
  const inv = findEdge(graph.edges, 'transactionline', 'transaction', 'transactionlines');
  assert.equal(inv.colCheck, 'from-missing');
  assert.ok(stats.colCheckFailed >= 1);
});

test('seenIn records which exports contained each table and edge', () => {
  const a = catalogFixture();
  const b = { tables: [{ id: 'transaction', label: 'Transaction', columns: [{ id: 'id', dataType: 'INTEGER' }] }, { id: 'revenuearrangement', label: 'Revenue Arrangement', columns: [] }], relationships: [] };
  const { graph } = buildGraph({ exports: [{ key: 'e1', data: a }, { key: 'e2', data: b }], facts: factsFixture(), clientPrefixes: ['acme'] });
  assert.deepEqual(graph.tables.transaction.seenIn, ['e1', 'e2']);
  assert.deepEqual(graph.tables.revenuearrangement.seenIn, ['e2']);
  assert.deepEqual(graph.tables.item.seenIn, ['e1']);
  assert.ok(graph.exports.e1 && graph.exports.e2);
});

test('presence probes from an API-only pull add seenIn for tables that exist', () => {
  const { graph } = build({ presence: [{ key: 'p1', tables: { item: true, revenuearrangement: false } }] });
  assert.deepEqual(graph.tables.item.seenIn, ['e1', 'p1']);
});

test('probe results mark edges verified', () => {
  const probes = { edges: {} };
  probes.edges[edgeKey({ from: 'transactionline', to: 'location', keys: [['location', 'id']] })] = { ok: true, date: '2026-09-27' };
  probes.edges[edgeKey({ from: 'transaction', to: 'accountingperiod', keys: [['postingperiod', 'id']] })] = { ok: false, date: '2026-09-27', code: 'UNEXPECTED_ERROR' };
  const { graph } = build({ probes });
  assert.equal(findEdge(graph.edges, 'transactionline', 'location', 'location').verified, true);
  const bad = findEdge(graph.edges, 'transaction', 'accountingperiod', 'postingperiod');
  assert.equal(bad.verified, false);
  assert.equal(bad.probe.code, 'UNEXPECTED_ERROR');
  assert.equal(findEdge(graph.edges, 'transactionline', 'item', 'item').verified, null);
});

test('features are tagged on standard tables', () => {
  const data = catalogFixture();
  data.tables.push({ id: 'manufacturingrouting', label: 'Routing', columns: [] });
  const { graph } = buildGraph({ exports: [{ key: 'e1', data }], facts: factsFixture(), clientPrefixes: [] });
  assert.equal(graph.tables.manufacturingrouting.feature, 'Manufacturing');
});

test('catalog joins to a missing "id" are repaired to the key the target has, original kept', () => {
  const data = catalogFixture();
  data.tables.push({ id: 'eventtype', label: 'Event Type', columns: [{ id: 'key', dataType: 'STRING' }, { id: 'name', dataType: 'STRING' }] });
  data.tables.push({ id: 'activity', label: 'Activity', columns: [{ id: 'id' }, { id: 'type', dataType: 'STRING' }] });
  data.relationships.push({ fromTable: 'activity', fromColumn: 'type', toTable: 'eventtype', toColumn: 'id', cardinality: 'N:1', joinType: 'AUTOMATIC', label: 'Type' });
  const { graph, stats } = buildGraph({ exports: [{ key: 'e1', data }], facts: {}, clientPrefixes: [] });
  const e = graph.edges.find((x) => x.from === 'activity' && x.to === 'eventtype');
  assert.deepEqual(e.keys, [['type', 'key']]);
  assert.deepEqual(e.catalogKeys, [['type', 'id']]);
  assert.match(e.repaired, /key/);
  assert.equal(e.colCheck, undefined);
  assert.ok(stats.repaired >= 1);
});

test('account label renames are mapped back before publishing', () => {
  const { graph } = build({ labelRenames: { 'Site Location': 'Location' } });
  assert.equal(graph.tables.location.label, 'Location');
  assert.ok(!JSON.stringify(graph).includes('Site'));
});

test('a probe that failed on an unqueryable table leaves the join unverified, not failed', () => {
  const probes = { edges: {} };
  probes.edges[edgeKey({ from: 'transactionline', to: 'location', keys: [['location', 'id']] })] = { ok: false, kind: 'table', code: 'INVALID_PARAMETER' };
  const { graph } = build({ probes });
  assert.equal(findEdge(graph.edges, 'transactionline', 'location', 'location').verified, null);
});
