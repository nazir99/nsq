#!/usr/bin/env node
// nsq: send SuiteQL to NetSuite and read the result in your terminal / VS Code.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, dirname, join } from 'node:path';
import { loadAccounts, getProfile, saveAccounts, accountEnv } from '../lib/config.js';
import { checkSelectOnly, checkSavePath } from '../lib/guard.js';
import { getAccessToken } from '../lib/auth.js';
import { runSuiteQL } from '../lib/suiteql.js';
import { toMarkdown, toCsv, toJson } from '../lib/format.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function die(msg) {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

const HELP = `nsq: NetSuite SuiteQL runner

Usage:
  nsq run <file.sql|"SELECT ...">  --account <alias> [--prod] [--format md|csv|json] [--out <path>] [--max <n>|all]
  nsq test                          --account <alias>
  nsq accounts                      # list configured accounts
  nsq accounts add --account <alias> --accountId <id> --clientId <id> --certId <id> [--env production|sandbox]

Guardrails:
  --prod           required to run against a production account
  --max            defaults to 1000 rows; if more exist the run fails (exit 3) instead of
                   silently truncating. Pass --max <n> or --max all.
  single SELECT    only one SELECT / WITH statement per run
  --allow-tracked  results are not saved inside a git repo unless the path is gitignored

Results also save next to the .sql file as <name>.result.<ext> unless --out is given.
`;

async function cmdRun(args, { sqlOverride, silentSave } = {}) {
  const alias = args.account;
  if (!alias) die('missing --account <alias>');
  const profile = getProfile(alias);
  const env = accountEnv(profile);
  if (env === 'production' && !args.prod && !sqlOverride)
    die(`"${alias}" is a production account. Re-run with --prod once you mean to query production.`);

  let sql, srcPath;
  if (sqlOverride) {
    sql = sqlOverride;
  } else {
    const target = args._[0];
    if (!target) die('provide a .sql file path or an inline "SELECT ..." string');
    if (/\.sql$/i.test(target)) {
      srcPath = target;
      sql = readFileSync(target, 'utf8');
    } else {
      sql = target;
    }
  }
  sql = sql.trim().replace(/;\s*$/, '');
  if (!sql) die('empty query');
  try {
    checkSelectOnly(sql);
  } catch (e) {
    die(e.message);
  }

  const format = (args.format || 'md').toLowerCase();
  const DEFAULT_MAX = 1000;
  const maxRows = args.max === 'all' ? Infinity : args.max ? Number(args.max) : DEFAULT_MAX;
  if (!(maxRows > 0)) die('--max must be a positive number or "all"');

  const token = await getAccessToken(profile);
  let result;
  try {
    result = await runSuiteQL({ profile, token, sql, maxRows });
  } catch (e) {
    // Verbatim NetSuite error, readable in the terminal, and saved if we have a source file.
    const errText = `-- QUERY --\n${sql}\n\n-- ERROR (account: ${alias}) --\n${e.message}`;
    console.error(`\x1b[31mNetSuite error:\x1b[0m\n${e.message}`);
    if (srcPath && !silentSave) {
      const out = join(dirname(srcPath), `${basename(srcPath, extname(srcPath))}.error.txt`);
      writeFileSync(out, errText + '\n');
      console.error(`\nSaved error -> ${out}`);
    }
    process.exit(2);
  }

  const rendered =
    format === 'json' ? toJson(result) : format === 'csv' ? toCsv(result) : toMarkdown(result);
  console.log(rendered);
  const truncated = result.totalResults > result.rows.length;
  console.log(
    `\n\x1b[32m${result.rows.length} row(s)\x1b[0m from ${alias} [${env}] (total ${result.totalResults})` +
      (truncated ? `, TRUNCATED at --max ${maxRows}.` : '.')
  );
  if (truncated && !args.max && !silentSave) {
    console.error(
      `\x1b[31merror:\x1b[0m ${result.totalResults} rows exist but only the default ${DEFAULT_MAX} were fetched. ` +
        'Nothing was saved. Re-run with --max <n> or --max all.'
    );
    process.exit(3);
  }

  if (!silentSave) {
    const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'md';
    let out = args.out;
    if (!out && srcPath) out = join(dirname(srcPath), `${basename(srcPath, extname(srcPath))}.result.${ext}`);
    if (out) {
      if (!args['allow-tracked']) {
        try {
          checkSavePath(out);
        } catch (e) {
          die(e.message);
        }
      }
      writeFileSync(out, rendered + '\n');
      console.log(`Saved -> ${out}`);
    }
  }
  return result;
}

async function cmdTest(args) {
  args._ = [];
  console.log(`Testing auth for "${args.account}"...`);
  await cmdRun({ ...args, max: 1 }, { sqlOverride: 'SELECT id, name FROM subsidiary ORDER BY id', silentSave: true });
  console.log('\x1b[32mAuth OK.\x1b[0m');
}

function cmdAccountsList() {
  const accounts = loadAccounts();
  const names = Object.keys(accounts);
  if (!names.length) return console.log('No accounts configured. Add one with: nsq accounts add ...');
  for (const n of names) {
    const p = accounts[n];
    console.log(`  ${n.padEnd(14)} ${accountEnv(p).padEnd(10)} account ${p.accountId}  client ${String(p.clientId).slice(0, 10)}…`);
  }
}

function cmdAccountsAdd(args) {
  const { account, accountId, clientId, certId, env } = args;
  if (env && env !== 'production' && env !== 'sandbox') die('--env must be production or sandbox');
  if (!account || !accountId || !clientId || !certId)
    die('need --account <alias> --accountId <id> --clientId <id> --certId <id>');
  const accounts = loadAccounts();
  accounts[account] = { accountId, clientId, certId, ...(env ? { env } : {}) };
  saveAccounts(accounts);
  console.log(`Saved profile "${account}".`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'run':
        await cmdRun(args);
        break;
      case 'test':
        await cmdTest(args);
        break;
      case 'accounts':
        if (args._[0] === 'add') cmdAccountsAdd(args);
        else cmdAccountsList();
        break;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(HELP);
        break;
      default:
        die(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (e) {
    die(e.message);
  }
}

main();
