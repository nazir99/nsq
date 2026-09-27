// Browser snippet that exports an account's Records Catalog without installing anything.
// The approach (walk getRecordTypes FLAT, then getRecordTypeDetail SS_ANAL per table,
// plus discovery rounds for tables found through joins) follows Tim Dietrich's SuiteQL
// Query Tool (MIT). Unlike that tool's export, every joinPair is kept, with its raw label.

// Must stay self-contained: its source is embedded in the snippet with toString().
export function parseRecordDetail(tableId, tableLabel, record) {
  const columns = (record.fields || [])
    .filter((f) => f.isColumn)
    .map((f) => ({ id: f.id, label: f.label, dataType: f.dataType || 'VARCHAR' }));
  const relationships = [];
  const discovered = [];
  const pairRe = /\.(\w+)\s*=\s*\w+\.(\w+)/i;
  for (const join of record.joins || []) {
    if (!(join.cardinality === 'N:1' || join.cardinality === '1:1')) continue;
    if (!join.sourceTargetType || !join.sourceTargetType.id || !join.fieldId) continue;
    const toTable = String(join.sourceTargetType.id).toLowerCase();
    const pairs = (join.joinPairs || []).map((p) => {
      const label = (p && p.label) || '';
      const m = label.match(pairRe);
      return m ? { label, fromColumn: m[1], toColumn: m[2] } : { label, fromColumn: null, toColumn: null };
    });
    const first = pairs[0] && pairs[0].fromColumn ? pairs[0] : { fromColumn: join.fieldId, toColumn: 'id' };
    const rel = {
      fromTable: tableId,
      fromColumn: first.fromColumn,
      toTable,
      toColumn: first.toColumn,
      cardinality: join.cardinality,
      joinType: join.joinType || 'AUTOMATIC',
      label: join.label || '',
      fieldId: join.fieldId,
    };
    if (pairs.length) rel.joinPairs = pairs;
    relationships.push(rel);
    discovered.push(toTable);
  }
  return { table: { id: tableId, label: tableLabel || record.label || tableId, columns }, relationships, discovered };
}

export function buildCatalogScript({ delayMs = 120, batch = 20 } = {}) {
  return `// nsq catalog-script: paste into the browser console on any page of the NetSuite
// account while logged in. Read-only GETs to the Records Catalog. Downloads
// records-catalog.json when done; save it as ~/.netsuite-query/schema/<alias>-records-catalog.json
// Stop early with: window.__nsqStop = true
(async () => {
  const parseRecordDetail = ${parseRecordDetail.toString()};
  const DELAY = ${delayMs}, BATCH = ${batch};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (action, data) => {
    const url = '/app/recordscatalog/rcendpoint.nl?action=' + action + '&data=' + encodeURIComponent(JSON.stringify(data));
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, { method: 'GET', credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return (await res.json()).data;
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(1000 * attempt);
      }
    }
  };
  window.__nsqStop = false;
  const out = { version: 'nsq-catalog-1', exportDate: new Date().toISOString(), source: 'nsq catalog-script (Records Catalog, SS_ANAL)', tableCount: 0, columnCount: 0, relationshipCount: 0, tables: [], relationships: [], errors: [] };
  const list = (await get('getRecordTypes', { structureType: 'FLAT' })) || [];
  console.log('[nsq] ' + list.length + ' record types');
  const done = new Set();
  let queue = list.map((t) => ({ id: t.id, label: t.label }));
  let round = 0, n = 0;
  while (queue.length && !window.__nsqStop) {
    const next = [];
    for (const t of queue) {
      if (window.__nsqStop) break;
      const key = String(t.id).toLowerCase();
      if (done.has(key)) continue;
      done.add(key);
      try {
        const record = await get('getRecordTypeDetail', { scriptId: t.id, detailType: 'SS_ANAL' });
        const r = parseRecordDetail(t.id, t.label, record || {});
        out.tables.push(r.table);
        out.relationships.push(...r.relationships);
        for (const d of r.discovered) if (!done.has(d)) next.push({ id: d, label: null });
      } catch (e) {
        out.errors.push({ table: t.id, error: String(e && e.message || e) });
      }
      n++;
      if (n % 25 === 0) console.log('[nsq] ' + n + ' tables, round ' + round + ', ' + out.relationships.length + ' joins');
      if (n % BATCH === 0) await sleep(DELAY * 5); else await sleep(DELAY);
    }
    queue = next;
    round++;
  }
  out.tableCount = out.tables.length;
  out.columnCount = out.tables.reduce((s, t) => s + t.columns.length, 0);
  out.relationshipCount = out.relationships.length;
  console.log('[nsq] done: ' + out.tableCount + ' tables, ' + out.columnCount + ' columns, ' + out.relationshipCount + ' joins, ' + out.errors.length + ' errors' + (window.__nsqStop ? ' (STOPPED EARLY: incomplete)' : ''));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = 'records-catalog.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
})();
`;
}
