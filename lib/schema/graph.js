// Query side of the schema graph: merge layers, find join paths, describe a table, search.
// Joins are stored child -> parent (N:1). Walking from -> to is "up", to -> from is "down".

export function loadLayers({ graph, suiteapp, locals = [], aliases = {} }) {
  const tables = {};
  const edges = [];
  const add = (layerName, layer, extra = {}) => {
    if (!layer) return;
    for (const [id, t] of Object.entries(layer.tables || {})) {
      if (!tables[id]) tables[id] = { id, ...t, layer: layerName === 'local' ? 'custom' : layerName, cols: (t.cols || []).map((c) => colObj(c, layerName)) };
      else {
        const have = new Set(tables[id].cols.map((c) => c.id));
        for (const c of t.cols || []) if (!have.has(c[0])) tables[id].cols.push(colObj(c, layerName === 'local' ? 'custom' : layerName));
        if (extra.alias) tables[id].localSeenIn = [...new Set([...(tables[id].localSeenIn || []), extra.alias])];
      }
      if (layerName === 'local' && extra.alias) tables[id].localSeenIn = [...new Set([...(tables[id].localSeenIn || []), extra.alias])];
    }
    for (const e of layer.edges || []) edges.push({ ...e, layer: layerName === 'local' ? 'custom' : layerName, ...(extra.alias ? { alias: extra.alias } : {}) });
  };
  add('standard', graph);
  add('suiteapp', suiteapp);
  for (const l of locals) add('local', l.data, { alias: l.alias });

  const adj = {};
  for (const e of edges) {
    (adj[e.from] ||= []).push({ e, next: e.to, dir: e.card === '1:1' || e.kind === 'subtype' ? 'same' : 'up' });
    (adj[e.to] ||= []).push({ e, next: e.from, dir: e.card === '1:1' || e.kind === 'subtype' ? 'same' : 'down' });
  }
  return { tables, edges, adj, aliases, exports: graph?.exports || {}, chains: graph?.chains || [] };
}

function colObj(c, layer) {
  return { id: c[0], type: c[1], label: c[2] || null, layer: layer === 'local' ? 'custom' : layer };
}

export function resolveTable(g, name) {
  const id = String(name || '').toLowerCase();
  if (g.tables[id]) return g.tables[id];
  const hits = search(g, id, { limit: 5, tablesOnly: true }).map((h) => h.table);
  throw new Error(`unknown table "${name}"` + (hits.length ? `. Did you mean: ${hits.join(', ')}?` : ''));
}

export function edgeCost(e) {
  if (e.verified === false) return Infinity;
  if (e.kind === 'subtype') return 0.5;
  let c = e.sources?.includes('facts') || e.verified === true ? 1 : 2;
  if (e.kind === 'polymorphic') c += 1;
  if (e.kind === 'inverse' || e.colCheck) c += 8;
  if (e.repaired && e.verified !== true) c += 1;
  if (e.layer === 'custom') c += 1;
  return c;
}

const VALLEY = 6; // going up to a parent and straight back down to another child multiplies rows

function segment(g, from, to, banned = null) {
  if (from === to) return { hops: [], cost: 0 };
  // Dijkstra over (table, direction of the last hop)
  const dist = new Map();
  const prev = new Map();
  const start = `${from}|none`;
  dist.set(start, 0);
  const heap = [[0, start]];
  const pop = () => {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
    return heap.splice(bi, 1)[0];
  };
  let goal = null;
  const done = new Set();
  while (heap.length) {
    const [d, state] = pop();
    if (done.has(state)) continue;
    done.add(state);
    const [node, lastDir] = state.split('|');
    if (node === to) {
      goal = state;
      break;
    }
    for (const { e, next, dir } of g.adj[node] || []) {
      if (banned?.has(e)) continue;
      // base -> subtype (transaction -> invoice) is only worth it when the subtype is the goal
      const base = e.kind === 'subtype' && next === e.from && next !== to ? 5 : edgeCost(e);
      if (!Number.isFinite(base)) continue;
      const cost = d + base + (lastDir === 'up' && dir === 'down' ? VALLEY : 0);
      const ns = `${next}|${dir === 'same' ? lastDir : dir}`;
      if (cost < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, cost);
        prev.set(ns, { state, e, dir, from: node, to: next });
        heap.push([cost, ns]);
      }
    }
  }
  if (!goal) return null;
  const hops = [];
  for (let s = goal; prev.has(s); s = prev.get(s).state) {
    const p = prev.get(s);
    hops.unshift({ edge: p.e, from: p.from, to: p.to, dir: p.dir });
  }
  return { hops, cost: dist.get(goal) };
}

export function findPath(g, from, to, { via = [], banned = null, alternatives = 0 } = {}) {
  const stops = [from, ...via, to].map((n) => resolveTable(g, n).id);
  const hops = [];
  let cost = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const s = segment(g, stops[i], stops[i + 1], banned);
    if (!s) return null;
    hops.push(...s.hops);
    cost += s.cost;
  }
  // flag fan-out: an "up" hop immediately followed by a "down" hop
  let last = 'none';
  for (const h of hops) {
    if (last === 'up' && h.dir === 'down') h.fanout = true;
    if (h.dir !== 'same') last = h.dir;
  }
  const result = { from: stops[0], to: stops[stops.length - 1], via: stops.slice(1, -1), hops, cost };
  if (alternatives > 0) {
    // next-best routes: drop one hop of the best path at a time
    const sig = (p) => p.hops.map((h) => `${h.to}:${h.edge.keys.map((k) => k.join('=')).join('&')}`).join('>');
    const seen = new Set([sig(result)]);
    const alts = [];
    for (const h of hops) {
      const p = findPath(g, from, to, { via, banned: new Set([...(banned || []), h.edge]) });
      if (p && !seen.has(sig(p))) {
        seen.add(sig(p));
        alts.push(p);
      }
    }
    result.alternatives = alts.sort((a, b) => a.cost - b.cost).slice(0, alternatives);
  }
  return result;
}

export function describeTable(g, name) {
  const t = resolveTable(g, name);
  const out = g.edges.filter((e) => e.from === t.id);
  const inc = g.edges.filter((e) => e.to === t.id);
  const rank = (e) => edgeCost(e) + (e.sources?.includes('facts') ? -0.5 : 0);
  out.sort((a, b) => rank(a) - rank(b));
  inc.sort((a, b) => rank(a) - rank(b));
  const alias = (k) => g.aliases[k] || k;
  // key columns first: id, then columns used by joins, then the rest
  const keyCols = new Set([...out.flatMap((e) => e.keys.map((k) => k[0])), ...inc.flatMap((e) => e.keys.map((k) => k[1]))]);
  const cols = [...t.cols].sort((a, b) => (a.id === 'id' ? -1 : b.id === 'id' ? 1 : (keyCols.has(b.id) ? 1 : 0) - (keyCols.has(a.id) ? 1 : 0) || a.id.localeCompare(b.id)));
  return {
    id: t.id,
    label: t.label,
    layer: t.layer,
    app: t.app || null,
    feature: t.feature || null,
    subtypeOf: t.subtypeOf || null,
    filter: t.filter || null,
    typeCode: t.typeCode || null,
    sources: t.sources || [],
    seenIn: [...new Set([...(t.seenIn || []).map(alias), ...(t.localSeenIn || [])])],
    exportCount: Object.keys(g.exports).length,
    traps: t.traps || [],
    cols,
    out,
    in: inc,
  };
}

export function search(g, text, { limit = 20, tablesOnly = false } = {}) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return [];
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const qs = squash(q);
  const score = (id, label) => {
    const i = id.toLowerCase();
    const l = String(label || '').toLowerCase();
    if (i === q || squash(l) === qs) return 100;
    if (i.startsWith(qs)) return 80 - Math.min(20, i.length - qs.length);
    if (i.includes(qs)) return 60 - Math.min(20, i.length - qs.length);
    if (l.includes(q)) return 50;
    if (q.split(/\s+/).every((w) => l.includes(w) || i.includes(w))) return 30;
    return 0;
  };
  const hits = [];
  for (const t of Object.values(g.tables)) {
    const s = score(t.id, t.label);
    if (s) hits.push({ kind: 'table', table: t.id, label: t.label, layer: t.layer, score: s + 5 });
    if (tablesOnly) continue;
    for (const c of t.cols) {
      const cs = score(c.id, c.label);
      if (cs) hits.push({ kind: 'column', table: t.id, column: c.id, type: c.type, label: c.label, layer: c.layer, score: cs });
    }
  }
  const core = (h) => (g.edges.some((e) => e.from === h.table && e.sources?.includes('facts')) ? 3 : 0);
  hits.sort((a, b) => b.score + core(b) - (a.score + core(a)) || a.table.length - b.table.length || a.table.localeCompare(b.table));
  return hits.slice(0, limit);
}

// Known multi-hop recipes whose from/to match the tables asked about.
export function matchChains(g, from, to) {
  const f = String(from).toLowerCase();
  const t = String(to).toLowerCase();
  return g.chains.filter((c) => c.from.includes(f) && c.to.includes(t));
}

export function getChain(g, name) {
  const c = g.chains.find((x) => x.name === name);
  if (!c) throw new Error(`unknown chain "${name}". Known: ${g.chains.map((x) => x.name).join(', ')}`);
  return c;
}
