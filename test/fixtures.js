// Small Records Catalog export shaped like the real one (mixed-case duplicate ids,
// polymorphic joins, an INVERSE join whose fromColumn is not a column, custom fields).
export function catalogFixture() {
  const col = (id, dataType = 'INTEGER', label = id) => ({ id, label, dataType });
  const tables = [
    { id: 'transaction', label: 'Transaction', columns: [col('id'), col('tranid', 'STRING', 'Document Number'), col('type', 'STRING'), col('entity'), col('postingperiod'), col('custbody_acme_flag', 'BOOLEAN')] },
    { id: 'Transaction', label: 'Transaction', columns: [col('id'), col('tranId', 'STRING', 'Document Number')] },
    { id: 'transactionline', label: 'Transaction Line', columns: [col('id'), col('transaction'), col('item'), col('location'), col('createdfrom'), col('linesequencenumber'), col('custcol_x', 'STRING'), col('units')] },
    { id: 'invoice', label: 'Invoice', columns: [col('id'), col('entity')] },
    { id: 'salesorder', label: 'Sales Order', columns: [col('id')] },
    { id: 'item', label: 'Item', columns: [col('id'), col('itemid', 'STRING', 'Name')] },
    { id: 'inventoryitem', label: 'Inventory Item', columns: [col('id')] },
    { id: 'entity', label: 'Entity', columns: [col('id')] },
    { id: 'customer', label: 'Customer', columns: [col('id'), col('companyname', 'STRING', 'Company Name')] },
    { id: 'location', label: 'Site Location', columns: [col('id'), col('name', 'STRING')] },
    { id: 'accountingperiod', label: 'Accounting Period', columns: [col('id'), col('enddate', 'DATE')] },
    { id: 'unitstypeuom', label: 'Unit', columns: [col('internalid'), col('unitname', 'STRING')] },
    { id: 'inventorynumber', label: 'Inventory Number', columns: [col('id'), col('inventorynumber', 'STRING'), col('item')] },
    { id: 'customrecord_acme_thing', label: 'Acme Thing', columns: [col('id'), col('custrecord_acme_ref')] },
    { id: 'customrecord_ncfar_asset', label: 'FAM Asset', columns: [col('id'), col('custrecord_assetcost', 'CURRENCY'), col('cseg_acme_seg')] },
  ];
  const rel = (fromTable, fromColumn, toTable, joinType = 'AUTOMATIC', toColumn = 'id', cardinality = 'N:1') =>
    ({ fromTable, fromColumn, toTable, toColumn, cardinality, joinType, label: toTable });
  const relationships = [
    rel('transactionline', 'transactionLines', 'transaction', 'INVERSE'),
    rel('transactionline', 'location', 'location'),
    rel('transactionline', 'units', 'unitstypeuom'),
    rel('transactionline', 'item', 'item', 'POLYMORPHIC'),
    rel('transactionline', 'item', 'inventoryitem', 'POLYMORPHIC'),
    rel('transaction', 'entity', 'entity', 'POLYMORPHIC'),
    rel('transaction', 'entity', 'customer', 'POLYMORPHIC'),
    rel('Transaction', 'postingPeriod', 'accountingperiod'),
    rel('transaction', 'postingperiod', 'accountingperiod'),
    rel('activity', 'transaction', 'transaction', 'POLYMORPHIC'),
    rel('activity', 'transaction', 'invoice', 'POLYMORPHIC'),
    rel('activity', 'transaction', 'salesorder', 'POLYMORPHIC'),
    rel('transactionline', 'custcol_x', 'customrecord_acme_thing'),
    rel('customrecord_ncfar_asset', 'cseg_acme_seg', 'customrecord_acme_thing'),
    rel('customrecord_ncfar_asset', 'id', 'location', 'AUTOMATIC'),
  ];
  return { version: '2026.1', exportDate: '2026-09-01T00:00:00.000Z', tables, relationships };
}

export function factsFixture() {
  return {
    tables: {
      transactionaccountingline: {
        label: 'Transaction Accounting Line',
        columns: [['transaction', 'INTEGER'], ['transactionline', 'INTEGER'], ['accountingbook', 'INTEGER']],
        traps: ['Always filter accountingbook.'],
      },
      inventoryassignment: {
        label: 'Inventory Assignment',
        columns: [['transaction', 'INTEGER'], ['transactionline', 'INTEGER'], ['inventorynumber', 'INTEGER']],
      },
    },
    tableTraps: { transaction: ['COUNT(*) fails: use COUNT(t.id).'] },
    edges: [
      { from: 'transactionline', to: 'transaction', keys: [['transaction', 'id']], replaces: ['transactionlines'] },
      { from: 'transactionline', to: 'transaction', keys: [['createdfrom', 'id']], label: 'Created From', traps: ['createdfrom is on the line.'] },
      { from: 'transactionaccountingline', to: 'transactionline', keys: [['transaction', 'transaction'], ['transactionline', 'id']], traps: ['Never linesequencenumber.'] },
      { from: 'transactionaccountingline', to: 'transaction', keys: [['transaction', 'id']] },
      { from: 'transactionline', to: 'unitstypeuom', keys: [['units', 'internalid']] },
      { from: 'inventoryassignment', to: 'transactionline', keys: [['transaction', 'transaction'], ['transactionline', 'id']] },
      { from: 'inventoryassignment', to: 'inventorynumber', keys: [['inventorynumber', 'id']] },
      { from: 'inventorynumber', to: 'item', keys: [['item', 'id']] },
      { from: 'transactionline', to: 'item', keys: [['item', 'id']] },
    ],
    typeCodes: { invoice: 'CustInvc', salesorder: 'SalesOrd' },
    suiteapps: { ncfar: 'Fixed Assets Management' },
    features: [['^manufacturing', 'Manufacturing']],
  };
}
