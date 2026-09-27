// Compact text output for agents (a few hundred tokens), plus JSON.

const ALIAS = {
  transaction: 't', transactionline: 'tl', transactionaccountingline: 'tal', inventoryassignment: 'ia',
  inventorynumber: 'inum', item: 'i', location: 'loc', account: 'acct', accountingperiod: 'ap',
  accountingbook: 'ab', bom: 'b', bomrevision: 'br', bomrevisioncomponentmember: 'bcm',
  itemassemblyitembom: 'iab', aggregateitemlocation: 'ail', unitstypeuom: 'uom', subsidiary: 'sub',
  nexttransactionlink: 'ntl', nexttransactionlinelink: 'ntll', manufacturingrouting: 'mr',
  manufacturingroutingroutingstep: 'mrs', entity: 'ent', customer: 'c', vendor: 'v', employee: 'emp',
};

function aliasFor(table, used) {
  let base = ALIAS[table] || table.replace(/[^a-z]/g, '').slice(0, 3);
  let a = base;
  for (let n = 2; used.has(a); n++) a = `${base}${n}`;
  used.add(a);
  return a;
}

function status(e) {
  const parts = [e.kind === 'subtype' ? 'subtype' : e.card || 'N:1'];
  parts.push(e.sources.join('+'));
  parts.push(e.verified === true ? 'probe ok' : e.verified === false ? `probe FAILED ${e.probe?.code || ''}`.trim() : e.probe?.kind === 'table' ? 'unprobed (table not queryable by the probing role)' : 'unprobed');
  if (e.kind === 'polymorphic') parts.push('polymorphic');
  if (e.colCheck) parts.push(`catalog column check: ${e.colCheck}`);
  if (e.repaired) parts.push(`repaired: ${e.repaired}`);
  if (e.layer && e.layer !== 'standard') parts.push(e.layer + (e.alias ? `:${e.alias}` : ''));
  return parts.join(', ');
}

function cond(e, fromAlias, toAlias) {
  return e.keys.map(([fc, tc]) => `${toAlias}.${tc} = ${fromAlias}.${fc}`).join(' AND ');
}

function hopText(e) {
  return e.keys.map(([fc, tc]) => `${e.from}.${fc} = ${e.to}.${tc}`).join(' AND ');
}

export function renderPath(g, p, { format = 'text' } = {}) {
  if (format === 'json') {
    return JSON.stringify({ from: p.from, to: p.to, via: p.via, alternatives: (p.alternatives || []).map((a) => a.hops.map((h) => ({ to: h.to, keys: h.edge.keys, edgeFrom: h.edge.from }))), hops: p.hops.map((h) => ({ from: h.from, to: h.to, dir: h.dir, fanout: !!h.fanout, join: h.edge.keys.map(([fc, tc]) => ({ [h.edge.from]: fc, [h.edge.to]: tc })), edge: slimEdge(h.edge) })), sql: sqlFor(p), tableTraps: tableTraps(g, p) }, null, 2);
  }
  const lines = [`path ${p.from} -> ${p.to}${p.via.length ? ` via ${p.via.join(', ')}` : ''}: ${p.hops.length} hop(s)`];
  if (p.hops.some((h) => h.fanout)) lines.push('! No direct join: this route only relates the tables through a shared parent (fan-out). Check the alternatives or pass --via.');
  p.hops.forEach((h, i) => {
    lines.push(`${i + 1}. ${hopText(h.edge)}  [${status(h.edge)}]`);
    if (h.fanout) lines.push(`   ! fan-out: goes up to ${h.from} then down to ${h.to}; rows multiply per ${h.from}. Restrict or aggregate before this hop.`);
    for (const t of h.edge.traps || []) lines.push(`   ! ${t}`);
    const tt = g.tables[h.to];
    if (h.edge.kind === 'subtype' && g.tables[h.from]?.filter) lines.push(`   = ${h.from} rows are ${g.tables[h.from].filter}${g.tables[h.from].typeCode ? ` (type '${g.tables[h.from].typeCode}')` : ''}`);
    if (h.edge.kind === 'subtype' && tt?.filter) lines.push(`   = ${h.to} rows are ${tt.filter}${tt.typeCode ? ` (type '${tt.typeCode}')` : ''}`);
  });
  const traps = tableTraps(g, p);
  if (Object.keys(traps).length) {
    lines.push('table notes:');
    for (const [t, list] of Object.entries(traps)) for (const x of list) lines.push(`  ${t}: ${x}`);
  }
  lines.push('SQL:', sqlFor(p));
  for (const a of p.alternatives || [])
    lines.push(`alt: ${a.from}` + a.hops.map((h) => ` -[${h.edge.keys.map(([fc, tc]) => (h.edge.from === h.from ? `${fc}=${tc}` : `${tc}=${fc}`)).join(',')}]-> ${h.to}`).join('') + (a.hops.some((h) => h.fanout) ? '  (fan-out)' : ''));
  return lines.join('\n');
}

function tableTraps(g, p) {
  const out = {};
  for (const id of [p.from, ...p.hops.map((h) => h.to)]) if (g.tables[id]?.traps?.length && !out[id]) out[id] = g.tables[id].traps;
  return out;
}

function sqlFor(p) {
  const used = new Set();
  const aliases = [aliasFor(p.from, used)];
  const lines = [`FROM ${p.from} ${aliases[0]}`];
  p.hops.forEach((h, i) => {
    const a = aliasFor(h.to, used);
    aliases.push(a);
    const prevAlias = aliases[i];
    // edge is stored from -> to; map the aliases onto its ends
    const [fromAlias, toAlias] = h.edge.from === h.from ? [prevAlias, a] : [a, prevAlias];
    const on = h.edge.from === h.from ? cond(h.edge, fromAlias, toAlias) : h.edge.keys.map(([fc, tc]) => `${fromAlias}.${fc} = ${toAlias}.${tc}`).join(' AND ');
    lines.push(`JOIN ${h.to} ${a} ON ${on}`);
  });
  return lines.join('\n');
}

function slimEdge(e) {
  const { from, to, keys, card, kind, label, sources, verified, probe, traps, colCheck, layer, alias, seenIn } = e;
  return { from, to, keys, card, kind, label, sources, verified, probe, traps, colCheck, layer, alias, seenIn };
}

function joinLine(e, side) {
  const other = side === 'out' ? e.to : e.from;
  const keys = e.keys.map(([fc, tc]) => (side === 'out' ? `${fc} -> ${other}.${tc}` : `${other}.${fc} -> ${tc}`)).join(' AND ');
  const flags = [];
  if (e.sources.includes('facts')) flags.push('facts');
  if (e.verified === true) flags.push('probe ok');
  if (e.verified === false) flags.push('probe FAILED');
  if (e.kind === 'polymorphic') flags.push('polymorphic');
  if (e.kind === 'subtype') flags.push('subtype');
  if (e.colCheck) flags.push(e.colCheck);
  if (e.repaired) flags.push('repaired');
  if (e.layer !== 'standard') flags.push(e.layer);
  return `  ${keys}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
}

export function renderTable(g, d, { format = 'text', columns = 40, joins = 12, live = null } = {}) {
  if (format === 'json') return JSON.stringify({ ...d, out: d.out.map(slimEdge), in: d.in.map(slimEdge), live }, null, 2);
  const L = [];
  const meta = [d.layer + (d.app ? `: ${d.app}` : ''), d.feature && `feature: ${d.feature}`, `sources: ${d.sources.join('+') || 'none'}`, `seen in: ${d.seenIn.join(', ') || 'none'} (${d.seenIn.length}/${d.exportCount} exports)`].filter(Boolean);
  L.push(`${d.id}  "${d.label}"  [${meta.join('; ')}]`);
  if (d.subtypeOf) L.push(`subtype of ${d.subtypeOf}${d.filter ? `: ${d.filter}` : ''}${d.typeCode ? ` (type '${d.typeCode}')` : ''}`);
  if (live) L.push(`live (${live.account}): ${live.ok ? `${live.rows} row(s)` : `ERROR ${live.error}`}`);
  for (const t of d.traps) L.push(`! ${t}`);
  const cap = (arr, n) => (n === 'all' ? arr : arr.slice(0, n));
  L.push(`joins out (${d.out.length}):`);
  for (const e of cap(d.out, joins)) L.push(joinLine(e, 'out'));
  if (joins !== 'all' && d.out.length > joins) L.push(`  ... ${d.out.length - joins} more (--joins all)`);
  L.push(`joins in (${d.in.length}):`);
  for (const e of cap(d.in, joins)) L.push(joinLine(e, 'in'));
  if (joins !== 'all' && d.in.length > joins) L.push(`  ... ${d.in.length - joins} more (--joins all)`);
  const cols = cap(d.cols, columns);
  L.push(`columns (${d.cols.length}): ` + cols.map((c) => `${c.id} ${c.type}${c.layer !== d.layer ? ` (${c.layer})` : ''}`).join(', ') + (columns !== 'all' && d.cols.length > columns ? `, ... ${d.cols.length - columns} more (--columns all)` : ''));
  return L.join('\n');
}

export function renderSearch(hits, { format = 'text' } = {}) {
  if (format === 'json') return JSON.stringify(hits, null, 2);
  if (!hits.length) return 'no match';
  return hits
    .map((h) => (h.kind === 'table' ? `table  ${h.table}  "${h.label}"${h.layer !== 'standard' ? ` [${h.layer}]` : ''}` : `column ${h.table}.${h.column} ${h.type}${h.label ? `  "${h.label}"` : ''}${h.layer !== 'standard' ? ` [${h.layer}]` : ''}`))
    .join('\n');
}

export function renderChain(c, { format = 'text' } = {}) {
  if (format === 'json') return JSON.stringify(c, null, 2);
  const L = [`chain ${c.name}  [facts, ${c.verified === true ? 'probe ok' : c.verified === false ? 'probe FAILED' : 'unprobed'}]`, c.about];
  for (const t of c.traps || []) L.push(`! ${t}`);
  L.push('SQL:', c.sql);
  return L.join('\n');
}

export function renderChainList(chains) {
  return chains.map((c) => `${c.name}: ${c.about}`).join('\n');
}

export function chainHint(chains) {
  return chains.length ? `known chain${chains.length > 1 ? 's' : ''} for this pair: ${chains.map((c) => c.name).join(', ')} (nsq schema chain <name>)` : '';
}
