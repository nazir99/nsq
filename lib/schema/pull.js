// API-only account scan for accounts where no browser export is possible:
// the REST metadata catalog record list, plus read-only presence probes over known
// feature tables. The metadata catalog lists records and their fields but not what a
// reference field points to, so it cannot supply joins; the graph supplies those.
import { lower } from './classify.js';

export async function pullAccount({ listRecords, run, presenceTables, date, onProgress }) {
  const out = { pulledAt: date, restRecords: [], presence: {}, features: {} };
  try {
    const list = await listRecords();
    out.restRecords = (list.items || []).map((i) => lower(i.name)).sort();
  } catch (e) {
    out.restError = e.message;
  }
  for (const [feature, tables] of Object.entries(presenceTables || {})) {
    let present = 0;
    for (const t of tables) {
      let r;
      try {
        const res = await run(`SELECT * FROM ${t} WHERE ROWNUM <= 1`);
        r = { ok: true, rows: res.rows.length };
        present++;
      } catch (e) {
        r = { ok: false, code: (String(e.message).match(/\b([A-Z][A-Z_]{5,})\b/) || [])[1] || 'ERROR' };
      }
      out.presence[t] = r;
      onProgress?.(t, r);
    }
    out.features[feature] = present === tables.length ? 'present' : present ? 'partial' : 'absent';
  }
  return out;
}

// What a pull contributes to the graph: tables confirmed to exist in that account.
export function presenceFromPull(pull) {
  const tables = {};
  for (const [t, r] of Object.entries(pull.presence || {})) tables[t] = !!r.ok;
  for (const t of pull.restRecords || []) if (!(t in tables)) tables[t] = true;
  return tables;
}
