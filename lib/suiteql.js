// Runs a SuiteQL statement against the REST SuiteQL endpoint, following pagination.
import { request } from 'node:https';
import { accountHost } from './config.js';

const PAGE_SIZE = 1000; // endpoint max per call

function postSuiteQL({ host, token, sql, limit, offset }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ q: sql });
    const req = request(
      {
        host,
        path: `/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'transient', // required by the SuiteQL endpoint
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Returns { rows, columns, totalResults }. Throws with the verbatim NetSuite error on failure.
export async function runSuiteQL({ profile, token, sql, maxRows = 100000 }) {
  const host = accountHost(profile.accountId);
  let offset = 0;
  const rows = [];
  let totalResults = null;

  while (true) {
    const limit = Math.min(PAGE_SIZE, maxRows - rows.length);
    const { status, body } = await postSuiteQL({ host, token, sql, limit, offset });
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`SuiteQL returned non-JSON (HTTP ${status}): ${body.slice(0, 600)}`);
    }
    if (status !== 200) {
      // NetSuite error envelope: { "o:errorDetails": [ { detail, "o:errorCode" } ], title, ... }
      const detail =
        parsed?.['o:errorDetails']?.map((d) => `${d['o:errorCode'] || ''}: ${d.detail}`).join('\n') ||
        parsed.title ||
        body.slice(0, 600);
      const err = new Error(detail);
      err.netsuiteStatus = status;
      err.raw = parsed;
      throw err;
    }
    if (Array.isArray(parsed.items)) rows.push(...parsed.items);
    if (typeof parsed.totalResults === 'number') totalResults = parsed.totalResults;
    if (!parsed.hasMore || rows.length >= maxRows) break;
    offset += PAGE_SIZE;
  }

  // Strip the per-row "links" metadata NetSuite adds.
  const clean = rows.map(({ links, ...rest }) => rest);
  // NetSuite omits null fields from a row, so take the union of keys across all
  // rows; the first row alone drops any column that happens to be null there.
  const columns = [...new Set(clean.flatMap((row) => Object.keys(row)))];
  return { rows: clean, columns, totalResults: totalResults ?? clean.length };
}
