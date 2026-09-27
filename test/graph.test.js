import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../lib/schema/build.js';
import { loadLayers, findPath, describeTable, search, resolveTable } from '../lib/schema/graph.js';
import { renderPath, renderTable, renderSearch } from '../lib/schema/render.js';
import { catalogFixture, factsFixture } from './fixtures.js';

function G(extraLocal = []) {
  const { graph, suiteapp, local } = buildGraph({ exports: [{ key: 'e1', data: catalogFixture() }], facts: factsFixture(), clientPrefixes: ['acme'] });
  return loadLayers({ graph, suiteapp, locals: [{ alias: 'sb', key: 'e1', data: local.e1 }, ...extraLocal], aliases: { e1: 'sb' } });
}

test('resolveTable is case-insensitive and suggests on a miss', () => {
  const g = G();
  assert.equal(resolveTable(g, 'TransactionLine').id, 'transactionline');
  assert.throws(() => resolveTable(g, 'transactionlin'), /transactionline/);
});

test('path GL line to source document uses both keys and createdfrom', () => {
  const g = G();
  const p = findPath(g, 'transactionaccountingline', 'transaction', { via: ['transactionline'] });
  assert.equal(p.hops.length, 2);
  assert.deepEqual(p.hops[0].edge.keys, [['transaction', 'transaction'], ['transactionline', 'id']]);
  const text = renderPath(g, p);
  assert.match(text, /transactionaccountingline\.transactionline = transactionline\.id/);
  assert.match(text, /Never linesequencenumber/);
  assert.match(text, /JOIN transactionline tl ON tl\.transaction = tal\.transaction AND tl\.id = tal\.transactionline/);
});

test('path prefers verified edges and avoids joins whose column is not a column', () => {
  const g = G();
  const p = findPath(g, 'transactionline', 'transaction');
  assert.equal(p.hops.length, 1);
  assert.deepEqual(p.hops[0].edge.keys, [['transaction', 'id']]);
});

test('path avoids up-then-down fan-out through a shared parent when a direct route exists', () => {
  const g = G();
  // transactionline -> item <- inventorynumber is 2 hops through a parent;
  // transactionline <- inventoryassignment -> inventorynumber is the real link.
  const p = findPath(g, 'transactionline', 'inventorynumber');
  assert.deepEqual(p.hops.map((h) => h.to), ['inventoryassignment', 'inventorynumber']);
});

test('fan-out hops are flagged when the only route goes up and back down', () => {
  const g = G();
  const p = findPath(g, 'inventorynumber', 'transactionline', { via: ['item'] });
  const text = renderPath(g, p);
  assert.match(text, /fan-out/i);
});

test('subtype tables start from their base with a filter note', () => {
  const g = G();
  const p = findPath(g, 'invoice', 'inventorynumber');
  assert.equal(p.hops[0].edge.kind, 'subtype');
  assert.match(renderPath(g, p), /recordtype = 'invoice'/);
});

test('no path returns null', () => {
  const g = G([{ alias: 'x', data: { tables: { customrecord_lonely: { label: 'Lonely', cols: [], seenIn: [] } }, edges: [] } }]);
  assert.equal(findPath(g, 'customrecord_lonely', 'transaction'), null);
});

test('describeTable lists columns, joins both ways, traps, layer and seenIn alias', () => {
  const g = G();
  const d = describeTable(g, 'transactionline');
  assert.equal(d.layer, 'standard');
  assert.deepEqual(d.seenIn, ['sb']);
  assert.ok(d.cols.some((c) => c.id === 'createdfrom'));
  assert.ok(d.cols.some((c) => c.id === 'custcol_x' && c.layer === 'custom'));
  assert.ok(d.out.some((e) => e.to === 'transaction' && e.keys[0][0] === 'createdfrom'));
  assert.ok(d.in.some((e) => e.from === 'transactionaccountingline'));
  const text = renderTable(g, d);
  assert.match(text, /createdfrom/);
  assert.match(text, /seen in: sb/);
});

test('describeTable shows suiteapp layer and app', () => {
  const g = G();
  const d = describeTable(g, 'customrecord_ncfar_asset');
  assert.equal(d.layer, 'suiteapp');
  assert.equal(d.app, 'Fixed Assets Management');
});

test('search finds tables and columns by id and label', () => {
  const g = G();
  const r = search(g, 'document number');
  assert.ok(r.some((x) => x.table === 'transaction' && x.column === 'tranid'));
  const r2 = search(g, 'inventorynum');
  assert.equal(r2[0].table, 'inventorynumber');
  assert.match(renderSearch(r2), /inventorynumber/);
});

test('chains match on from/to and render their SQL', async () => {
  const { renderChain, chainHint } = await import('../lib/schema/render.js');
  const { matchChains } = await import('../lib/schema/graph.js');
  const facts = factsFixture();
  facts.chains = [{ name: 'gl-line-to-source', from: ['transactionaccountingline'], to: ['transaction'], about: 'x', sql: 'FROM transactionaccountingline tal', traps: ['t1'], probe: 'SELECT 1' }];
  const { graph, suiteapp } = buildGraph({ exports: [{ key: 'e1', data: catalogFixture() }], facts, probes: { chains: { 'gl-line-to-source': { ok: true, date: 'd' } } }, clientPrefixes: [] });
  assert.equal(graph.chains[0].probe, undefined, 'probe SQL is not published');
  assert.equal(graph.chains[0].verified, true);
  const g = loadLayers({ graph, suiteapp });
  const m = matchChains(g, 'TransactionAccountingLine', 'transaction');
  assert.equal(m.length, 1);
  assert.match(chainHint(m), /gl-line-to-source/);
  assert.match(renderChain(m[0]), /FROM transactionaccountingline tal/);
  assert.equal(matchChains(g, 'item', 'transaction').length, 0);
});

test('path lists alternative routes and warns when the best one is a fan-out', () => {
  const g = G();
  const p = findPath(g, 'transactionline', 'inventorynumber', { alternatives: 2 });
  assert.ok(p.alternatives.length >= 1);
  const text = renderPath(g, p);
  assert.match(text, /^alt: transactionline/m);
  const f = findPath(g, 'inventorynumber', 'transactionline', { via: ['item'] });
  assert.match(renderPath(g, f), /No direct join/);
});

test('entity subtypes keep a direct polymorphic join as well as the base', () => {
  const { graph } = buildGraph({ exports: [{ key: 'e1', data: catalogFixture() }], facts: factsFixture(), clientPrefixes: [] });
  assert.ok(graph.edges.some((e) => e.from === 'transaction' && e.to === 'customer' && e.keys[0][0] === 'entity'));
  assert.ok(graph.edges.some((e) => e.from === 'transaction' && e.to === 'entity' && e.keys[0][0] === 'entity'));
});
