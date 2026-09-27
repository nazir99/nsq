// `nsq schema ...` subcommands.
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from './build.js';
import { loadLayers, findPath, describeTable, search, matchChains, getChain } from './graph.js';
import { renderPath, renderTable, renderSearch, renderChain, renderChainList, chainHint } from './render.js';
import { sampleEdges, probeEdges, probeColumns, summarize } from './verify.js';
import { buildCatalogScript } from './catalog-script.js';
import { pullAccount, presenceFromPull } from './pull.js';
import {
  paths, readJson, writeLocalJson, listExports, listPulls, listLocalCaches, exportKeys, keyToAlias,
  serializeLayer, leakCheck, LOCAL_SCHEMA_DIR,
} from './store.js';
import { loadAccounts, getProfile, accountEnv } from '../config.js';
import { getAccessToken } from '../auth.js';
import { runSuiteQL } from '../suiteql.js';
import { getMetadata } from '../rest.js';
import { checkSelectOnly } from '../guard.js';

export const SCHEMA_HELP = `nsq schema: NetSuite join map (standard tables, join keys, traps)

  nsq schema path <from> <to> [--via a,b] [--format json]
      shortest join path, exact keys per hop, traps, and a FROM/JOIN skeleton
  nsq schema table <name> [--columns <n>|all] [--joins <n>|all] [--format json] [--account <alias>]
      columns, joins in and out, traps, which exports contain it; --account adds a live row count
  nsq schema search <text> [--limit <n>] [--format json]
      find tables and columns by id or label
  nsq schema chain [name]
      verified multi-hop recipes (invoice to lots, GL line to source, BOM as of a date, ...)

Maintenance:
  nsq schema build [--client-prefix a,b]     rebuild schema/graph.json from local exports + facts + probes
  nsq schema verify --account <sandbox> [--sample 200] [--seed 1]
                                              live-probe facts joins and a sample of catalog joins
  nsq schema pull --account <alias>           API-only scan: REST metadata record list + feature presence probes
  nsq schema catalog-script                   print a browser-console snippet that exports the Records Catalog

Local files: ${LOCAL_SCHEMA_DIR}
  <alias>-records-catalog.json  exports (browser snippet or SuiteQL Query Tool)
  <alias>-pull.json             API-only pulls
  <alias>.json                  that account's custom tables and fields (merged at query time, never committed)
`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadQueryGraph() {
  const graph = readJson(paths.graph);
  const suiteapp = readJson(paths.suiteapp, { tables: {}, edges: [] });
  const locals = listLocalCaches().map(({ alias, path }) => ({ alias, data: readJson(path) }));
  return loadLayers({ graph, suiteapp, locals, aliases: keyToAlias() });
}

function guardedProfile(args) {
  const alias = args.account;
  if (!alias) throw new Error('missing --account <alias>');
  const profile = getProfile(alias);
  const env = accountEnv(profile);
  if (env === 'production' && !args.prod) throw new Error(`"${alias}" is a production account. Use a sandbox, or pass --prod once you mean production.`);
  return { alias, profile, env };
}

async function runner(profile) {
  const token = await getAccessToken(profile);
  return async (sql) => {
    checkSelectOnly(sql);
    return runSuiteQL({ profile, token, sql, maxRows: 5 });
  };
}

async function liveCount(args, table) {
  const { alias, profile } = guardedProfile(args);
  const run = await runner(profile);
  for (const sql of [`SELECT COUNT(*) AS n FROM ${table}`, `SELECT COUNT(id) AS n FROM ${table}`]) {
    try {
      const r = await run(sql);
      return { account: alias, ok: true, rows: Number(r.rows[0]?.n ?? 0) };
    } catch {}
  }
  try {
    const r = await run(`SELECT * FROM ${table} WHERE ROWNUM <= 1`);
    return { account: alias, ok: true, rows: r.rows.length ? 'at least 1' : 0 };
  } catch (e) {
    return { account: alias, ok: false, error: e.message.split('\n')[0].slice(0, 160) };
  }
}

function cmdBuild(args, log = console.log) {
  const exps = listExports();
  if (!exps.length) {
    const bare = join(LOCAL_SCHEMA_DIR, 'records-catalog.json');
    throw new Error(
      `no exports in ${LOCAL_SCHEMA_DIR}. Save each as <alias>-records-catalog.json` +
        (existsSync(bare) ? ` (found records-catalog.json: rename or link it to <alias>-records-catalog.json)` : '')
    );
  }
  const pulls = listPulls();
  const keys = exportKeys([...exps.map((e) => e.alias), ...pulls.map((p) => p.alias)]);
  const cfg = readJson(paths.buildConfig, {});
  const clientPrefixes = args['client-prefix']
    ? String(args['client-prefix']).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none')
    : cfg.clientPrefixes;
  if (!Array.isArray(clientPrefixes))
    throw new Error(`set the client prefixes to strip (e.g. {"clientPrefixes":["acme"]}) in ${paths.buildConfig}, or pass --client-prefix a,b (or none)`);
  const exports = exps.map(({ alias, path }) => ({ key: keys[alias], alias, data: readJson(path) }));
  const presence = pulls.map(({ alias, path }) => ({ key: keys[alias], tables: presenceFromPull(readJson(path)) }));
  const facts = readJson(paths.facts);
  const probes = readJson(paths.probes, {});
  const { graph, suiteapp, local, stats } = buildGraph({ exports, facts, probes, presence, clientPrefixes, labelRenames: cfg.labelRenames || {}, generatedAt: today() });

  const header = { about: 'Generated by `nsq schema build`: standard NetSuite tables and joins. Do not edit; edit schema/facts.json.', generated: today() };
  const graphText = serializeLayer(graph, header);
  const saText = serializeLayer(suiteapp, { about: 'Generated by `nsq schema build`: Oracle SuiteApp tables on the allowlist in facts.json (suiteapps).', generated: today() });
  const accounts = loadAccounts();
  const terms = [
    ...clientPrefixes,
    ...Object.keys(cfg.labelRenames || {}),
    ...Object.keys(accounts),
    ...exports.map((e) => e.alias),
    ...Object.values(accounts).map((a) => String(a.accountId).split('_')[0]),
  ];
  const leaks = [...new Set([...leakCheck(graphText, terms), ...leakCheck(saText, terms)])];
  if (leaks.length) throw new Error(`refusing to write the public graph: it contains ${leaks.join(', ')}. Add the prefix to clientPrefixes.`);
  writeFileSync(paths.graph, graphText);
  writeFileSync(paths.suiteapp, saText);
  for (const { key, alias } of exports) if (local[key]) writeLocalJson(paths.local(alias), { alias, built: today(), ...local[key] });
  log(
    `graph: ${stats.tables} tables, ${stats.edges} joins (${stats.catalogEdges} catalog relationships read, ` +
      `${stats.replacedByFacts} replaced by facts, ${stats.colCheckFailed} fail the column check, ${stats.repaired || 0} of those repaired)\n` +
      `suiteapp: ${stats.suiteappTables} tables\nlocal: ${exports.map((e) => `${e.alias} ${stats.localTables[e.key] || 0} custom tables`).join(', ')}`
  );
  return stats;
}

async function cmdVerify(args, log = console.log) {
  const { alias, profile, env } = guardedProfile(args);
  const graph = readJson(paths.graph);
  const facts = graph.edges.filter((e) => e.sources.includes('facts') && e.kind !== 'subtype');
  const catalog = graph.edges.filter((e) => !e.sources.includes('facts') && e.kind !== 'subtype');
  const n = args.sample === undefined ? 200 : Number(args.sample);
  const sample = sampleEdges(catalog, n, Number(args.seed || 1));
  const run = await runner(profile);
  const date = today();
  let i = 0;
  const total = facts.length + sample.length + sample.filter((e) => e.catalogKeys).length;
  const onResult = (e, r) => {
    i++;
    if (!r.ok || i % 25 === 0) log(`${i}/${total} ${r.ok ? 'ok ' : 'FAIL'} ${e.from} -> ${e.to} (${e.keys.map((k) => k.join('=')).join(', ')})${r.ok ? '' : ` ${r.code}`}`);
  };
  // The failure share is measured on joins exactly as the catalog exported them;
  // repaired joins are probed a second time with the repaired key.
  const asExported = sample.map((e) => (e.catalogKeys ? { ...e, keys: e.catalogKeys } : e));
  const repaired = sample.filter((e) => e.catalogKeys);
  const edgeResults = await probeEdges([...facts, ...asExported, ...repaired], run, { date, onResult });
  const factCols = readJson(paths.facts).tables || {};
  const columnResults = await probeColumns(Object.fromEntries(Object.entries(factCols).map(([t, v]) => [t, v.columns.map((c) => c[0])])), run, { date });
  const chainResults = {};
  for (const c of readJson(paths.facts).chains || []) {
    try {
      await run(c.probe);
      chainResults[c.name] = { ok: true, date };
    } catch (e) {
      chainResults[c.name] = { ok: false, date, code: (e.message.match(/\b([A-Z][A-Z_]{5,})\b/) || [])[1] || 'ERROR' };
    }
    log(`chain ${c.name}: ${chainResults[c.name].ok ? 'ok' : 'FAILED ' + chainResults[c.name].code}`);
  }
  const summary = summarize(edgeResults, asExported);
  const repairedSummary = summarize(edgeResults, repaired);
  const factSummary = summarize(edgeResults, facts.map((e) => ({ ...e, sources: ['catalog'] })));
  const prev = readJson(paths.probes, {});
  const probes = {
    about: 'Live read-only probe results from `nsq schema verify` (sandbox). One bounded SELECT through each join; no data values are stored.',
    updated: date,
    env,
    catalogSample: { seed: Number(args.seed || 1), ...summary, repaired: repairedSummary },
    facts: factSummary,
    edges: { ...(prev.edges || {}), ...edgeResults },
    columns: { ...(prev.columns || {}), ...columnResults },
    chains: { ...(prev.chains || {}), ...chainResults },
  };
  writeFileSync(paths.probes, JSON.stringify(probes, null, 1) + '\n');
  log(`catalog sample: ${summary.probed} probed, ${summary.failed} failed (${summary.failedPct}%): ${summary.invalid} bad join, ${summary.tableUnavailable} table not queryable, ${summary.access} permission`);
  log(`  bad joins among probes whose tables are queryable: ${summary.invalidOfQueryablePct}%`);
  log(`repaired joins in the sample: ${repairedSummary.probed} probed with the repaired key, ${repairedSummary.failed} failed`);
  log(`facts joins: ${factSummary.probed} probed, ${factSummary.failed} failed`);
  const badCols = Object.entries(columnResults).filter(([, r]) => !r.ok);
  log(`facts columns: ${Object.keys(columnResults).length} tables, ${badCols.length} with bad columns${badCols.length ? ': ' + badCols.map(([t, r]) => `${t}(${r.badColumns.join(',')})`).join(' ') : ''}`);
  log(`account: ${alias} [${env}]`);
  if (listExports().length) cmdBuild(args, log);
  return { summary, factSummary };
}

async function cmdPull(args, log = console.log) {
  const { alias, profile, env } = guardedProfile(args);
  const token = await getAccessToken(profile);
  const run = async (sql) => {
    checkSelectOnly(sql);
    return runSuiteQL({ profile, token, sql, maxRows: 1 });
  };
  const facts = readJson(paths.facts);
  const pull = await pullAccount({
    date: today(),
    listRecords: () => getMetadata({ profile, token, path: '/services/rest/record/v1/metadata-catalog' }),
    run,
    presenceTables: facts.presenceTables,
    onProgress: (t, r) => log(`${r.ok ? 'present' : 'absent '} ${t}${r.ok ? (r.rows ? '' : ' (exists, empty)') : ` ${r.code}`}`),
  });
  writeLocalJson(paths.pull(alias), { alias, env, ...pull });
  log(`REST metadata: ${pull.restRecords.length} records${pull.restError ? ` (error: ${pull.restError})` : ''}`);
  for (const [f, s] of Object.entries(pull.features)) log(`  ${f}: ${s}`);
  log(`saved ${paths.pull(alias)}; run nsq schema build to merge it`);
}

export async function cmdSchema(args) {
  const [sub, ...rest] = args._;
  const format = (args.format || 'text').toLowerCase();
  switch (sub) {
    case 'path': {
      if (rest.length < 2) throw new Error('usage: nsq schema path <from> <to> [--via a,b]');
      const g = loadQueryGraph();
      const via = args.via ? String(args.via).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const p = findPath(g, rest[0], rest[1], { via, alternatives: 2 });
      const hint = chainHint(matchChains(g, rest[0], rest[1]));
      if (!p) {
        console.log(`no join path between ${rest[0]} and ${rest[1]} in the graph. Probe before assuming one exists.` + (hint ? `\n${hint}` : ''));
        process.exitCode = 4;
        return;
      }
      console.log(renderPath(g, p, { format }) + (hint && format !== 'json' ? `\n${hint}` : ''));
      return;
    }
    case 'chain': {
      const g = loadQueryGraph();
      console.log(rest[0] ? renderChain(getChain(g, rest[0]), { format }) : renderChainList(g.chains));
      return;
    }
    case 'table': {
      if (!rest[0]) throw new Error('usage: nsq schema table <name>');
      const g = loadQueryGraph();
      const d = describeTable(g, rest[0]);
      const live = args.account ? await liveCount(args, d.id) : null;
      const num = (v, dflt) => (v === 'all' ? 'all' : v ? Number(v) : dflt);
      console.log(renderTable(g, d, { format, columns: num(args.columns, 30), joins: num(args.joins, 10), live }));
      return;
    }
    case 'search': {
      if (!rest.length) throw new Error('usage: nsq schema search <text>');
      const g = loadQueryGraph();
      console.log(renderSearch(search(g, rest.join(' '), { limit: Number(args.limit || 20) }), { format }));
      return;
    }
    case 'build':
      cmdBuild(args);
      return;
    case 'verify':
      await cmdVerify(args);
      return;
    case 'pull':
      await cmdPull(args);
      return;
    case 'catalog-script':
      console.log(buildCatalogScript());
      return;
    case undefined:
    case 'help':
      console.log(SCHEMA_HELP);
      return;
    default:
      throw new Error(`unknown schema command "${sub}"\n\n${SCHEMA_HELP}`);
  }
}
