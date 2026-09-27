// Live read-only probes that check a join (or a table's columns) actually works in SuiteQL.
import { edgeKey } from './build.js';

export function probeSql(e) {
  const on = e.keys.map(([fc, tc]) => `b.${tc} = a.${fc}`).join(' AND ');
  return `SELECT a.${e.keys[0][0]} FROM ${e.from} a JOIN ${e.to} b ON ${on} WHERE ROWNUM <= 5`;
}

export function columnProbeSql(table, cols) {
  return `SELECT ${cols.join(', ')} FROM ${table} WHERE ROWNUM <= 1`;
}

export function errorCode(message) {
  const m = String(message || '').match(/\b([A-Z][A-Z_]{5,})\b/);
  return m ? m[1] : 'ERROR';
}

// "access": the table or feature is not available to this role/account; says nothing about the join.
// "invalid": the join or column is wrong.
export function errorKind(message) {
  return /INSUFFICIENT_PERMISSION|permission|not enabled|feature|Record type .* (not found|does not exist)|Invalid search type/i.test(String(message || ''))
    ? 'access'
    : 'invalid';
}

// Deterministic sample (mulberry32) so a re-run probes the same edges.
export function sampleEdges(edges, n, seed = 1) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const seen = new Set();
  const pool = [];
  for (const e of edges) {
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push(e);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

// run(sql) resolves to { rows } or throws with NetSuite's message.
// A failed join probe is only a bad join if both tables can be read on their own;
// otherwise the table is not queryable by this role or account ("table").
export async function probeEdges(edges, run, { date, onResult } = {}) {
  const results = {};
  const tableOk = new Map();
  const readable = async (t) => {
    if (!tableOk.has(t)) {
      try {
        await run(`SELECT * FROM ${t} WHERE ROWNUM <= 1`);
        tableOk.set(t, true);
      } catch {
        tableOk.set(t, false);
      }
    }
    return tableOk.get(t);
  };
  for (const e of edges) {
    const sql = probeSql(e);
    let r;
    try {
      const out = await run(sql);
      r = { ok: true, date, matched: out.rows.length > 0 };
    } catch (err) {
      let kind = errorKind(err.message);
      if (kind === 'invalid' && !((await readable(e.from)) && (await readable(e.to)))) kind = 'table';
      r = { ok: false, date, code: errorCode(err.message), kind };
    }
    results[edgeKey(e)] = r;
    onResult?.(e, r);
  }
  return results;
}

export async function probeColumns(tables, run, { date } = {}) {
  const results = {};
  for (const [table, cols] of Object.entries(tables)) {
    try {
      await run(columnProbeSql(table, cols));
      results[table] = { ok: true, date, columns: cols.length };
    } catch (err) {
      // find the failing columns one at a time
      const bad = [];
      for (const c of cols) {
        try {
          await run(columnProbeSql(table, [c]));
        } catch {
          bad.push(c);
        }
      }
      results[table] = { ok: false, date, code: errorCode(err.message), badColumns: bad };
    }
  }
  return results;
}

export function summarize(results, edges) {
  const catalogOnly = edges.filter((e) => !e.sources.includes('facts'));
  const rs = catalogOnly.map((e) => results[edgeKey(e)]).filter(Boolean);
  const failed = rs.filter((r) => !r.ok);
  const invalid = failed.filter((r) => r.kind === 'invalid');
  const table = failed.filter((r) => r.kind === 'table');
  const joinable = rs.length - table.length - failed.filter((r) => r.kind === 'access').length;
  return {
    probed: rs.length,
    ok: rs.length - failed.length,
    failed: failed.length,
    invalid: invalid.length,
    tableUnavailable: table.length,
    access: failed.length - invalid.length - table.length,
    invalidOfQueryablePct: joinable ? +((100 * invalid.length) / joinable).toFixed(1) : 0,
    failedPct: rs.length ? +((100 * failed.length) / rs.length).toFixed(1) : 0,
    invalidPct: rs.length ? +((100 * invalid.length) / rs.length).toFixed(1) : 0,
  };
}
