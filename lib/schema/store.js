// File locations and serialization for the schema graph.
//   <repo>/schema/graph.json      standard NetSuite (generated, committed)
//   <repo>/schema/suiteapp.json   Oracle SuiteApp layer (generated, committed)
//   <repo>/schema/facts.json      verified facts (hand-maintained, committed)
//   <repo>/schema/probes.json     live probe results (generated, committed; no data values)
//   ~/.netsuite-query/schema/<alias>-records-catalog.json  Records Catalog exports (local)
//   ~/.netsuite-query/schema/<alias>-pull.json             API-only pulls (local)
//   ~/.netsuite-query/schema/<alias>.json                  custom layer per account (local)
//   ~/.netsuite-query/schema/exports.json                  alias -> opaque export key (local)
//   ~/.netsuite-query/schema/build.json                    { clientPrefixes: [...] } (local)
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SECRET_DIR } from '../config.js';

export const REPO_SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');
export const LOCAL_SCHEMA_DIR = join(SECRET_DIR, 'schema');

export const paths = {
  graph: join(REPO_SCHEMA_DIR, 'graph.json'),
  suiteapp: join(REPO_SCHEMA_DIR, 'suiteapp.json'),
  facts: join(REPO_SCHEMA_DIR, 'facts.json'),
  probes: join(REPO_SCHEMA_DIR, 'probes.json'),
  exportsMap: join(LOCAL_SCHEMA_DIR, 'exports.json'),
  buildConfig: join(LOCAL_SCHEMA_DIR, 'build.json'),
  local: (alias) => join(LOCAL_SCHEMA_DIR, `${alias}.json`),
  pull: (alias) => join(LOCAL_SCHEMA_DIR, `${alias}-pull.json`),
};

const RESERVED = new Set(['exports', 'build']);

export function readJson(p, fallback) {
  if (!existsSync(p)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${p}`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function ensureLocalDir() {
  if (!existsSync(LOCAL_SCHEMA_DIR)) mkdirSync(LOCAL_SCHEMA_DIR, { recursive: true, mode: 0o700 });
}

export function writeLocalJson(p, obj) {
  ensureLocalDir();
  writeFileSync(p, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

function localFiles() {
  return existsSync(LOCAL_SCHEMA_DIR) ? readdirSync(LOCAL_SCHEMA_DIR) : [];
}

export function listExports() {
  return localFiles()
    .map((f) => f.match(/^(.+)-records-catalog\.json$/))
    .filter(Boolean)
    .map((m) => ({ alias: m[1], path: join(LOCAL_SCHEMA_DIR, m[0]) }));
}

export function listPulls() {
  return localFiles()
    .map((f) => f.match(/^(.+)-pull\.json$/))
    .filter(Boolean)
    .map((m) => ({ alias: m[1], path: join(LOCAL_SCHEMA_DIR, m[0]) }));
}

export function listLocalCaches() {
  return localFiles()
    .map((f) => f.match(/^([A-Za-z0-9_.-]+)\.json$/))
    .filter((m) => m && !RESERVED.has(m[1]) && !/-(records-catalog|pull)$/.test(m[1]) && m[1] !== 'records-catalog')
    .map((m) => ({ alias: m[1], path: join(LOCAL_SCHEMA_DIR, m[0]) }));
}

// alias -> opaque key used in the public graph's seenIn, so no account alias is committed.
export function exportKeys(aliases) {
  const map = readJson(paths.exportsMap, {});
  let changed = false;
  for (const a of aliases)
    if (!map[a]) {
      map[a] = 'x' + randomBytes(3).toString('hex');
      changed = true;
    }
  if (changed) writeLocalJson(paths.exportsMap, map);
  return map;
}

export function keyToAlias() {
  const map = readJson(paths.exportsMap, {});
  return Object.fromEntries(Object.entries(map).map(([a, k]) => [k, a]));
}

// One table or edge per line: readable diffs, modest size.
export function serializeLayer(layer, header = {}) {
  const lines = ['{'];
  for (const [k, v] of Object.entries(header)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  if (layer.exports) lines.push(`  "exports": ${JSON.stringify(layer.exports)},`);
  if (layer.chains) lines.push(`  "chains": ${JSON.stringify(layer.chains, null, 1).replace(/\n\s*/g, ' ')},`);
  const tables = Object.keys(layer.tables).sort();
  lines.push('  "tables": {');
  tables.forEach((id, i) => lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(layer.tables[id])}${i < tables.length - 1 ? ',' : ''}`));
  lines.push('  },');
  const edges = [...layer.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.keys[0][0].localeCompare(b.keys[0][0]));
  lines.push('  "edges": [');
  edges.forEach((e, i) => lines.push(`    ${JSON.stringify(e)}${i < edges.length - 1 ? ',' : ''}`));
  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

// Terms that must never reach a committed file.
export function leakCheck(text, terms) {
  const low = text.toLowerCase();
  return terms.filter((t) => t && low.includes(String(t).toLowerCase()));
}
