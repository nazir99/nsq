// Builds the schema graph from Records Catalog exports, the verified facts layer
// and live probe results. Pure: no file or network access (see store.js / cli.js).
//
// Output layers:
//   graph    standard NetSuite tables and joins (committed, public)
//   suiteapp Oracle SuiteApp tables on the allowlist (committed, public)
//   local    per-export custom tables, custom columns and their joins (never committed)
import { lower, tableLayer, isCustomColumn, isSuiteappColumnPublic, suiteappOf, featureOf } from './classify.js';

const FAMILY_BASES = ['transaction', 'item', 'entity'];

export function edgeKey(e) {
  return `${e.from}(${e.keys.map((k) => k[0]).join('+')})->${e.to}(${e.keys.map((k) => k[1]).join('+')})`;
}

function addUnique(arr, v) {
  if (v != null && !arr.includes(v)) arr.push(v);
  return arr;
}

function emptyLayer() {
  return { tables: {}, edges: [] };
}

function ensureTable(layer, id, init) {
  if (!layer.tables[id]) layer.tables[id] = { label: init.label || id, sources: [], seenIn: [], cols: [], traps: [], ...init.extra };
  return layer.tables[id];
}

function addCol(t, id, type, label) {
  if (t.cols.some((c) => c[0] === id)) return;
  const col = [id, type || 'UNKNOWN'];
  if (label && lower(label).replace(/[^a-z0-9]/g, '') !== id) col.push(label);
  t.cols.push(col);
}

// Parse a relationship's column pairs. New exports (nsq catalog-script) carry every
// joinPair; the SuiteQL Query Tool export carries only the first as from/toColumn.
function relKeys(r) {
  if (Array.isArray(r.joinPairs) && r.joinPairs.length && r.joinPairs.every((p) => p.fromColumn && p.toColumn))
    return r.joinPairs.map((p) => [lower(p.fromColumn), lower(p.toColumn)]);
  return [[lower(r.fromColumn), lower(r.toColumn || 'id')]];
}

export function buildGraph({ exports = [], facts = {}, probes = {}, presence = [], clientPrefixes = [], labelRenames = {}, generatedAt } = {}) {
  const suiteapps = facts.suiteapps || {};
  const features = facts.features || [];
  const opts = { clientPrefixes, suiteapps };
  const layerOf = (id) => tableLayer(id, opts);

  const graph = { ...emptyLayer(), exports: {} };
  const suiteapp = emptyLayer();
  const local = {};
  const stats = { exports: exports.length, catalogEdges: 0, colCheckFailed: 0, replacedByFacts: 0 };

  const pub = (id) => (layerOf(id) === 'suiteapp' ? suiteapp : graph);

  // ---- 1. tables and columns ----
  const colSets = {}; // table -> Set(all columns seen, any layer), for the static check
  for (const { key, data } of exports) {
    graph.exports[key] = {
      version: data.version || null,
      exportDate: data.exportDate || null,
      tables: (data.tables || []).length,
      relationships: (data.relationships || []).length,
    };
    const loc = (local[key] ||= emptyLayer());
    for (const t of data.tables || []) {
      const id = lower(t.id);
      const layer = layerOf(id);
      const cs = (colSets[id] ||= new Set());
      if (layer === 'custom') {
        const lt = ensureTable(loc, id, { label: t.label });
        addUnique(lt.seenIn, key);
        for (const c of t.columns || []) {
          addCol(lt, lower(c.id), c.dataType, c.label);
          cs.add(lower(c.id));
        }
        continue;
      }
      const target = layer === 'suiteapp' ? suiteapp : graph;
      const extra = layer === 'suiteapp' ? { app: suiteappOf(id, suiteapps, clientPrefixes) } : {};
      const pt = ensureTable(target, id, { label: t.label, extra });
      addUnique(pt.sources, 'catalog');
      addUnique(pt.seenIn, key);
      for (const c of t.columns || []) {
        const cid = lower(c.id);
        cs.add(cid);
        const isPublic = layer === 'suiteapp' ? isSuiteappColumnPublic(cid, clientPrefixes) : !isCustomColumn(cid, clientPrefixes);
        if (isPublic) addCol(pt, cid, c.dataType, c.label);
        else {
          const lt = ensureTable(loc, id, { label: t.label });
          addUnique(lt.seenIn, key);
          addCol(lt, cid, c.dataType, c.label);
        }
      }
    }
  }

  // ---- 2. polymorphic families (transaction, item, entity) ----
  const polyGroups = new Map(); // from|col -> {rels, targets:Set}
  for (const { data } of exports)
    for (const r of data.relationships || [])
      if (r.joinType === 'POLYMORPHIC') {
        const k = `${lower(r.fromTable)}|${lower(r.fromColumn)}`;
        const g = polyGroups.get(k) || { targets: new Set() };
        g.targets.add(lower(r.toTable));
        polyGroups.set(k, g);
      }
  const family = {}; // base -> Set(subtypes)
  for (const base of FAMILY_BASES) {
    let best = null;
    for (const g of polyGroups.values()) if (g.targets.has(base) && (!best || g.targets.size > best.size)) best = g.targets;
    if (best) family[base] = new Set([...best].filter((t) => t !== base && !FAMILY_BASES.includes(t)));
  }
  const baseOf = (t) => FAMILY_BASES.find((b) => family[b]?.has(t)) || null;

  // ---- 3. catalog relationships ----
  const edgeIndex = new Map(); // layer-qualified key -> edge
  function putEdge(layer, e, key) {
    const k = edgeKey(e);
    const existing = edgeIndex.get(layer === graph || layer === suiteapp ? `pub:${k}` : `${key}:${k}`);
    if (existing) {
      for (const s of e.sources || []) addUnique(existing.sources, s);
      for (const s of e.seenIn || []) addUnique(existing.seenIn, s);
      for (const t of e.traps || []) addUnique((existing.traps ||= []), t);
      if (e.label && !existing.label) existing.label = e.label;
      return existing;
    }
    const edge = { ...e, sources: [...(e.sources || [])], seenIn: [...(e.seenIn || [])] };
    layer.edges.push(edge);
    edgeIndex.set(layer === graph || layer === suiteapp ? `pub:${k}` : `${key}:${k}`, edge);
    return edge;
  }

  function placeEdge(e, key) {
    const fromLayer = layerOf(e.from);
    const toLayer = layerOf(e.to);
    const colsPublic = e.keys.every(([fc]) =>
      fromLayer === 'suiteapp' ? isSuiteappColumnPublic(fc, clientPrefixes) : !isCustomColumn(fc, clientPrefixes)
    ) && e.keys.every(([, tc]) => !isCustomColumn(tc, clientPrefixes));
    if (fromLayer !== 'custom' && toLayer !== 'custom' && colsPublic) {
      const layer = fromLayer === 'suiteapp' || toLayer === 'suiteapp' ? suiteapp : graph;
      for (const t of [e.from, e.to]) {
        const tt = ensureTable(pub(t), t, { label: t, extra: layerOf(t) === 'suiteapp' ? { app: suiteappOf(t, suiteapps, clientPrefixes) } : {} });
        addUnique(tt.seenIn, key);
        if (!tt.sources.length) tt.sources.push('catalog');
      }
      return putEdge(layer, e, key);
    }
    const loc = (local[key] ||= emptyLayer());
    return putEdge(loc, e, key);
  }

  for (const { key, data } of exports) {
    const polySeen = new Set();
    for (const r of data.relationships || []) {
      stats.catalogEdges++;
      const from = lower(r.fromTable);
      let to = lower(r.toTable);
      const keys = relKeys(r);
      let kind = r.joinType === 'INVERSE' ? 'inverse' : r.joinType === 'POLYMORPHIC' ? 'polymorphic' : 'fk';
      let label = r.label || '';
      if (kind === 'polymorphic') {
        const g = polyGroups.get(`${from}|${lower(r.fromColumn)}`);
        const base = baseOf(to) || (FAMILY_BASES.includes(to) ? to : null);
        if (base === 'entity' && to !== 'entity' && g) {
          // entity subtypes (customer, vendor, employee...) have their own columns: keep a direct join too
          placeEdge({ from, to, keys, card: r.cardinality || 'N:1', kind, label, sources: ['catalog'], seenIn: [key] }, key);
        }
        if (base && g) {
          const dedupe = `${from}|${keys[0][0]}|${base}`;
          if (polySeen.has(dedupe)) continue;
          polySeen.add(dedupe);
          to = base;
          label = `${base} (polymorphic: ${[...g.targets].filter((t) => t === base || family[base]?.has(t)).length} record types)`;
        }
      }
      const e = { from, to, keys, card: r.cardinality || 'N:1', kind, label, sources: ['catalog'], seenIn: [key] };
      if (r.joinPairs?.[0]?.label) e.joinPair = r.joinPairs.map((p) => p.label).join(' AND ');
      placeEdge(e, key);
    }
  }

  // ---- 4. verified facts ----
  for (const [id, ft] of Object.entries(facts.tables || {})) {
    const t = ensureTable(pub(id), id, { label: ft.label });
    if (ft.label && (t.label === id || !t.sources.includes('catalog'))) t.label = ft.label;
    addUnique(t.sources, 'facts');
    for (const [cid, type] of ft.columns || []) addCol(t, lower(cid), type);
    for (const trap of ft.traps || []) addUnique(t.traps, trap);
  }
  for (const [id, traps] of Object.entries(facts.tableTraps || {})) {
    const t = ensureTable(pub(id), id, { label: id });
    addUnique(t.sources, 'facts');
    for (const trap of traps) addUnique(t.traps, trap);
  }
  for (const fe of facts.edges || []) {
    const keys = fe.keys.map(([a, b]) => [lower(a), lower(b)]);
    const from = lower(fe.from);
    const to = lower(fe.to);
    const replaces = new Set((fe.replaces || []).map(lower));
    for (const layer of [graph, suiteapp]) {
      layer.edges = layer.edges.filter((e) => {
        if (e.from !== from || e.to !== to) return true;
        const conflict = replaces.has(e.keys[0][0]) || (e.keys[0][0] === keys[0][0] && edgeKey(e) !== edgeKey({ from, to, keys }));
        if (conflict) {
          stats.replacedByFacts++;
          edgeIndex.delete(`pub:${edgeKey(e)}`);
        }
        return !conflict;
      });
    }
    for (const t of [from, to]) {
      const tt = ensureTable(pub(t), t, { label: t });
      if (!tt.sources.length) tt.sources.push('facts');
    }
    putEdge(pub(from) === suiteapp || pub(to) === suiteapp ? suiteapp : graph, {
      from, to, keys, card: fe.card || 'N:1', kind: 'fk', label: fe.label || '', sources: ['facts'], seenIn: [], traps: fe.traps || [],
    });
  }

  // ---- 5. subtypes: invoice.id = transaction.id etc. ----
  const typeCodes = facts.typeCodes || {};
  for (const [base, subs] of Object.entries(family)) {
    for (const sub of subs) {
      const t = graph.tables[sub];
      if (!t || !graph.tables[base]) continue;
      t.subtypeOf = base;
      if (base === 'transaction') {
        t.filter = `transaction.recordtype = '${sub}'`;
        if (typeCodes[sub]) t.typeCode = typeCodes[sub];
      }
      putEdge(graph, { from: sub, to: base, keys: [['id', 'id']], card: '1:1', kind: 'subtype', label: `${sub} is a ${base}`, sources: ['derived'], seenIn: [...t.seenIn] });
    }
  }

  // ---- 6. presence (API-only pulls) ----
  for (const { key, tables } of presence) {
    for (const [id, ok] of Object.entries(tables || {})) {
      if (!ok) continue;
      const t = graph.tables[lower(id)] || suiteapp.tables[lower(id)];
      if (t) addUnique(t.seenIn, key);
    }
  }

  // ---- 7. features, probes, static column check ----
  for (const [id, t] of Object.entries(graph.tables)) {
    const f = featureOf(id, features);
    if (f) t.feature = f;
  }
  const probeEdges = probes.edges || {};
  for (const layer of [graph, suiteapp]) {
    for (const e of layer.edges) {
      const p = probeEdges[edgeKey(e)];
      // a probe that failed because a table is not queryable says nothing about the join
      e.verified = p && !(p.ok === false && p.kind === 'table') ? !!p.ok : null;
      if (p) e.probe = p;
      const fromCols = colSets[e.from];
      const toCols = colSets[e.to];
      const factCols = (id) => new Set((facts.tables?.[id]?.columns || []).map((c) => lower(c[0])));
      const has = (set, id, c) => (set && set.has(c)) || factCols(id).has(c);
      if (e.sources.includes('catalog') && !e.sources.includes('facts') && e.kind !== 'subtype') {
        const fromOk = !fromCols || e.keys.every(([fc]) => has(fromCols, e.from, fc));
        const toOk = !toCols || e.keys.every(([, tc]) => has(toCols, e.to, tc));
        if (!fromOk || !toOk) {
          e.colCheck = !fromOk ? 'from-missing' : 'to-missing';
          stats.colCheckFailed++;
          // The catalog assumes the target key is "id". List tables key on "key", units on "internalid", addresses on "nkey".
          if (fromOk && e.keys.length === 1 && e.keys[0][1] === 'id') {
            const alt = ['key', 'internalid', 'nkey'].find((c) => has(toCols, e.to, c));
            if (alt) {
              e.catalogKeys = e.keys;
              e.keys = [[e.keys[0][0], alt]];
              e.repaired = `target key id -> ${alt}`;
              delete e.colCheck;
              stats.repaired = (stats.repaired || 0) + 1;
              const p2 = probeEdges[edgeKey(e)];
              e.verified = p2 ? !!p2.ok : null;
              if (p2) e.probe = p2;
              else delete e.probe;
            }
          }
        }
      }
      if (!e.traps?.length) delete e.traps;
    }
  }
  // Account-level label renames (Location renamed to something else, say) are not
  // generic NetSuite: map them back before anything is published.
  const renames = Object.entries(labelRenames).sort((a, b) => b[0].length - a[0].length);
  const unrename = (l) => (typeof l === 'string' ? renames.reduce((s, [from, to]) => s.split(from).join(to), l) : l);
  if (renames.length)
    for (const layer of [graph, suiteapp]) {
      for (const t of Object.values(layer.tables)) {
        t.label = unrename(t.label);
        for (const c of t.cols) if (c[2]) c[2] = unrename(c[2]);
      }
      for (const e of layer.edges) e.label = unrename(e.label);
    }
  for (const layer of [graph, suiteapp, ...Object.values(local)])
    for (const t of Object.values(layer.tables)) {
      t.cols.sort((a, b) => (a[0] === 'id' ? -1 : b[0] === 'id' ? 1 : a[0].localeCompare(b[0])));
      if (!t.traps?.length) delete t.traps;
    }

  // ---- 8. known multi-hop chains (verified SQL skeletons) ----
  graph.chains = (facts.chains || []).map((c) => {
    const p = probes.chains?.[c.name];
    const { probe, ...rest } = c;
    return { ...rest, verified: p ? !!p.ok : null, ...(p ? { probed: p.date } : {}) };
  });

  stats.tables = Object.keys(graph.tables).length;
  stats.edges = graph.edges.length;
  stats.suiteappTables = Object.keys(suiteapp.tables).length;
  stats.localTables = Object.fromEntries(Object.entries(local).map(([k, l]) => [k, Object.keys(l.tables).length]));
  graph.generated = generatedAt || null;
  return { graph, suiteapp, local, stats };
}
