import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullAccount, presenceFromPull } from '../lib/schema/pull.js';
import { checkSelectOnly } from '../lib/guard.js';

test('pull lists REST records and probes feature tables read-only', async () => {
  const sqls = [];
  const pull = await pullAccount({
    date: 'd',
    listRecords: async () => ({ items: [{ name: 'invoice' }, { name: 'Customer' }] }),
    run: async (sql) => {
      sqls.push(sql);
      checkSelectOnly(sql);
      if (sql.includes('revenueplan')) throw new Error('INVALID_PARAMETER: Invalid search type');
      return { rows: sql.includes('revenuearrangement') ? [] : [{ id: 1 }] };
    },
    presenceTables: { ARM: ['revenuearrangement', 'revenueplan'], Core: ['transaction'] },
  });
  assert.deepEqual(pull.restRecords, ['customer', 'invoice']);
  assert.deepEqual(pull.presence.revenuearrangement, { ok: true, rows: 0 });
  assert.equal(pull.presence.revenueplan.ok, false);
  assert.equal(pull.features.ARM, 'partial');
  assert.equal(pull.features.Core, 'present');
  assert.ok(sqls.every((s) => /WHERE ROWNUM <= 1$/.test(s)));
  assert.deepEqual(presenceFromPull(pull), { revenuearrangement: true, revenueplan: false, transaction: true, customer: true, invoice: true });
});

test('a failing metadata list is recorded, probes still run', async () => {
  const pull = await pullAccount({ date: 'd', listRecords: async () => { throw new Error('HTTP 403'); }, run: async () => ({ rows: [] }), presenceTables: { Core: ['transaction'] } });
  assert.match(pull.restError, /403/);
  assert.equal(pull.features.Core, 'present');
});
