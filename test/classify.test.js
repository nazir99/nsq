import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCustomTable, isCustomColumn, suiteappOf, tableLayer, featureOf, isSuiteappColumnPublic } from '../lib/schema/classify.js';

const SA = { ncfar: 'Fixed Assets Management', fam: 'Fixed Assets Management' };

test('custom tables: records, lists, custom transactions, segments', () => {
  for (const id of ['customrecord_x', 'customlist_y', 'customlist1930', 'customtransaction_z', 'customrecordacme_q', 'cseg_a'])
    assert.equal(isCustomTable(id), true, id);
});

test('standard tables that start with custom stay standard', () => {
  for (const id of ['customer', 'customerpayment', 'customrecordtype', 'customtransactiontype', 'customsegment', 'customfield'])
    assert.equal(isCustomTable(id), false, id);
});

test('client prefix anywhere makes a table or column custom', () => {
  assert.equal(isCustomTable('someacmething', ['acme']), true);
  assert.equal(isCustomColumn('ACME_flag', ['acme']), true);
});

test('custom columns, including matrix option aliases', () => {
  for (const id of ['custbody_a', 'custcol_b', 'custitem_c', 'custentity_d', 'custevent_e', 'custrecord_f', 'cseg_g', 'matrixoptioncustitem_h', 'custbodynounderscore'])
    assert.equal(isCustomColumn(id), true, id);
  for (const id of ['customer', 'createdfrom', 'item', 'custom', 'customform'])
    assert.equal(isCustomColumn(id), false, id);
});

test('suiteapp allowlist', () => {
  assert.equal(suiteappOf('customrecord_ncfar_asset', SA), 'Fixed Assets Management');
  assert.equal(suiteappOf('customlist_fam_x', SA), 'Fixed Assets Management');
  assert.equal(suiteappOf('customrecord_other_asset', SA), null);
  assert.equal(suiteappOf('customrecord_ncfar_acme', SA, ['acme']), null);
  assert.equal(tableLayer('customrecord_ncfar_asset', { suiteapps: SA }), 'suiteapp');
  assert.equal(tableLayer('customrecord_other', { suiteapps: SA }), 'custom');
  assert.equal(tableLayer('transaction', { suiteapps: SA }), 'standard');
});

test('suiteapp columns keep their own custrecord fields but drop client additions', () => {
  assert.equal(isSuiteappColumnPublic('custrecord_assetcost'), true);
  assert.equal(isSuiteappColumnPublic('name'), true);
  assert.equal(isSuiteappColumnPublic('cseg_acme_x'), false);
  assert.equal(isSuiteappColumnPublic('custrecord_acme_x', ['acme']), false);
  assert.equal(isSuiteappColumnPublic('custbody_x'), false);
});

test('feature tagging', () => {
  const F = [['^(revenue|revrec)', 'ARM'], ['^bom', 'Manufacturing']];
  assert.equal(featureOf('revenuearrangement', F), 'ARM');
  assert.equal(featureOf('bomrevision', F), 'Manufacturing');
  assert.equal(featureOf('transaction', F), null);
});
