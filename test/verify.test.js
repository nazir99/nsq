import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSql, columnProbeSql, sampleEdges, probeEdges, probeColumns, errorCode, errorKind, summarize } from '../lib/schema/verify.js';
import { checkMetadataPath } from '../lib/rest.js';
import { checkSelectOnly } from '../lib/guard.js';

const E = (from, to, keys, sources = ['catalog']) => ({ from, to, keys, sources });

test('probe SQL joins through every key and stays a single bounded SELECT', () => {
  const sql = probeSql(E('transactionaccountingline', 'transactionline', [['transaction', 'transaction'], ['transactionline', 'id']]));
  assert.equal(sql, 'SELECT a.transaction FROM transactionaccountingline a JOIN transactionline b ON b.transaction = a.transaction AND b.id = a.transactionline WHERE ROWNUM <= 5');
  assert.doesNotThrow(() => checkSelectOnly(sql));
  assert.equal(columnProbeSql('bom', ['id', 'name']), 'SELECT id, name FROM bom WHERE ROWNUM <= 1');
});

test('sample is deterministic and deduplicated', () => {
  const edges = [];
  for (let i = 0; i < 50; i++) edges.push(E(`t${i}`, 'x', [['a', 'id']]));
  edges.push(E('t1', 'x', [['a', 'id']]));
  const a = sampleEdges(edges, 10, 7).map((e) => e.from);
  const b = sampleEdges(edges, 10, 7).map((e) => e.from);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 10);
  assert.equal(sampleEdges(edges, 100, 7).length, 50);
});

test('error code and kind', () => {
  assert.equal(errorCode('UNEXPECTED_ERROR: An unexpected error occurred.'), 'UNEXPECTED_ERROR');
  assert.equal(errorKind('UNEXPECTED_ERROR: x'), 'invalid');
  assert.equal(errorKind('INSUFFICIENT_PERMISSION: You do not have permission'), 'access');
});

test('probeEdges records ok, matched and failures; summarize counts catalog edges only', async () => {
  const edges = [E('a', 'b', [['x', 'id']]), E('c', 'd', [['y', 'id']]), E('e', 'f', [['z', 'id']], ['facts']), E('g', 'h', [['w', 'id']])];
  const run = async (sql) => {
    if (sql.includes('FROM c a JOIN')) throw new Error('UNEXPECTED_ERROR: nope');
    if (sql.includes('FROM g ')) throw new Error("INVALID_PARAMETER: Record 'g' was not found.");
    return { rows: sql.includes('FROM a ') ? [{}] : [] };
  };
  const r = await probeEdges(edges, run, { date: 'd' });
  assert.deepEqual(r['a(x)->b(id)'], { ok: true, date: 'd', matched: true });
  assert.equal(r['c(y)->d(id)'].ok, false);
  assert.equal(r['c(y)->d(id)'].kind, 'invalid');
  const s = summarize(r, edges);
  assert.equal(r['g(w)->h(id)'].kind, 'table');
  assert.equal(s.probed, 3);
  assert.equal(s.failed, 2);
  assert.equal(s.tableUnavailable, 1);
  assert.equal(s.invalidOfQueryablePct, 50);
});

test('probeColumns narrows a failure to the bad columns', async () => {
  const run = async (sql) => {
    if (sql.includes('bogus')) throw new Error('INVALID_PARAMETER: Invalid search');
    return { rows: [] };
  };
  const r = await probeColumns({ bom: ['id', 'bogus', 'name'] }, run, { date: 'd' });
  assert.deepEqual(r.bom.badColumns, ['bogus']);
});

test('REST helper only reaches the metadata catalog', () => {
  assert.doesNotThrow(() => checkMetadataPath('/services/rest/record/v1/metadata-catalog'));
  assert.doesNotThrow(() => checkMetadataPath('/services/rest/record/v1/metadata-catalog/invoice'));
  assert.throws(() => checkMetadataPath('/services/rest/record/v1/invoice/1'));
  assert.throws(() => checkMetadataPath('/services/rest/record/v1/metadata-catalog/../invoice'));
  assert.throws(() => checkMetadataPath('/app/site/hosting/restlet.nl'));
});
