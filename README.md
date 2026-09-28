# nsq

A read-only SuiteQL runner for NetSuite, and an agent skill that teaches AI coding
agents to use it safely.

The CLI sends SuiteQL to NetSuite's REST endpoint with OAuth 2.0 Machine-to-Machine
auth and prints the result, or saves it next to the `.sql` file. The skill
(`SKILL.md`) tells an agent how to find NetSuite data, prove it is complete and
correctly shaped, and store it without leaking client data.

Part of [software-factory](https://github.com/nazir99/software-factory): the data link.

## Why it exists

Agents write decent SuiteQL. Where they fail is everything around the query: they
run against production because someone said "just go", they reuse a read
credential to write records, they trust a table name from memory, and they call a
number "tied" when it only agrees with itself. nsq puts the hard rules in the tool
and the judgment calls in the skill.

## Guardrails

Enforced by the CLI:

| Guardrail | Behavior |
|---|---|
| Production is opt-in | Production profiles need `--prod` on every run |
| No silent truncation | Default cap 1000 rows; if more exist the run fails (exit 3) until you pass `--max <n>` or `--max all` |
| One SELECT | Only a single `SELECT` or `WITH ... SELECT` statement |
| Results stay out of git | Refuses to save inside a git repository unless the path is gitignored |
| Visible environment | Every run prints the account alias and `[production]` or `[sandbox]` |

Enforced by NetSuite, if you set it up that way (recommended): map nsq's certificate
to a **read-only role**. See `references/auth-and-roles.md`.

Enforced by the skill: never touch the private key or sign tokens, never write or
call RESTlets with these credentials, probe before trusting names, verify against
an independent figure, stop on permission errors.

## Install

Requires Node 18 or later. No dependencies.

```bash
git clone https://github.com/nazir99/nsq.git ~/.claude/skills/nsq
cd ~/.claude/skills/nsq && npm link        # puts `nsq` on your PATH
```

The folder is a plain skill in the open Agent Skills format (`SKILL.md` plus
`references/`). For agents other than Claude Code, clone it wherever that agent
loads skills from.

## Usage

```bash
nsq run queries/open-orders.sql --account sb1 --format csv
nsq run "SELECT id, name FROM subsidiary" --account sb1 --max 50
nsq run queries/month-end.sql --account prod --prod --max all --format json
nsq test --account sb1          # verify auth with a one-row query
nsq accounts                    # list profiles and their environment
```

Results save next to the `.sql` file as `<name>.result.md` (or `.csv` / `.json`).
NetSuite errors print verbatim and save as `<name>.error.txt`. Keep query folders
gitignored, or pass `--out` to a path outside the repository.

## Schema graph: how NetSuite tables join

Agents burn tokens (and get joins wrong) working out how NetSuite tables connect.
`nsq schema` answers from a generated map of standard NetSuite tables, columns and
join keys, with known traps attached to the joins and tables they belong to.

```bash
nsq schema chain                                  # verified multi-hop recipes
nsq schema chain invoice-to-shipped-lots          # SQL skeleton + traps
nsq schema path transactionaccountingline transaction --via transactionline
nsq schema table inventoryassignment              # columns, joins in/out, traps, where seen
nsq schema table revenuearrangement --account sb1 # adds a live row count: "exists but empty"
nsq schema search "document number"
```

Output is compact text; add `--format json` for structure. `path` returns the exact
keys at every hop, the traps on each hop and table, and a `FROM ... JOIN ...`
skeleton. It prefers verified joins, avoids joins whose catalog column is not a real
column, and flags fan-out (a hop up to a parent and straight back down).

### What is in it

| Layer | File | Content |
|---|---|---|
| Standard | `schema/graph.json` | Standard tables, columns and joins (generated) |
| SuiteApp | `schema/suiteapp.json` | Oracle SuiteApp records on an allowlist: Fixed Assets Management (`ncfar_`, `fam_`), Electronic Bank Payments (`2663_`) |
| Facts | `schema/facts.json` | Hand-maintained, verified: tables missing from the catalog (`transactionaccountingline`, `aggregateitemlocation`, `inventoryassignment`, `nexttransactionlink`, `nexttransactionlinelink`, `bomrevisioncomponentmember`, ...), corrected joins, traps, chains |
| Probes | `schema/probes.json` | Live read-only probe results (pass/fail and error code only, no data) |
| Custom | `~/.netsuite-query/schema/<alias>.json` | That account's custom records, lists and fields. Merged at query time, never committed |

Every join records its `sources` (`catalog`, `facts`, `derived`), whether a live probe
passed (`verified`), and `seenIn`: which account exports contained it (opaque keys in
the public files; `~/.netsuite-query/schema/exports.json` maps them to your aliases).
Tables carry a `feature` tag where it applies (Advanced Revenue Management, SuiteBilling,
Manufacturing, Projects, Intercompany, Consolidation).

### How much to trust the catalog

The Records Catalog lists joins in a human-readable form and exports parse it. Known
problems, all handled in the build: ids arrive in two casings (merged); some join
columns are sublist names rather than columns (`transactionline.transactionLines`
fails live; the real key is `transactionline.transaction`); list tables and units are
exported as joining on `id` when their key is `key` or `internalid` (repaired, the
original kept); polymorphic joins list every record subtype (collapsed to
`transaction`, `item`, `entity`); multi-key joins lose all but the first key in the
SuiteQL Query Tool export. Catalog joins stay `unprobed` until `nsq schema verify`
passes them; verified facts win on conflict.

Measured on one sandbox export (2,768 tables, 83,715 relationships, 2026-09): of a
deterministic sample of 200 standard catalog joins, taken as exported, 31.5% failed a
live probe (37% on an earlier sample). Most of that (24%) is tables a read-only role
cannot query, which says nothing about the join; 6.5% were bad joins, each a target
key the table does not have (`id` on a list, unit or address table) or a sublist name
used as a column. The build repairs the `key`, `internalid` and `nkey` cases; every
repaired join in the sample whose tables were queryable passed. `nsq schema verify` shows these numbers for your own account.

### Adding another account

Each export only lists what is enabled in that account, so merging several widens the
map. Three ways to produce one:

1. **SuiteQL Query Tool** (if installed in the account): Build Schema, Export JSON.
2. **No install, browser:** `nsq schema catalog-script | pbcopy`, open any page of the
   account while logged in, paste into the browser console, wait for the download.
   Read-only GETs to the Records Catalog, throttled, progress in the console; stop
   early with `window.__nsqStop = true`. It keeps every join key pair, with its raw
   label. (Its parser and walk are unit tested against a fake endpoint.)
3. **No install, API only:** `nsq schema pull --account <alias>` lists the REST
   metadata catalog's records and runs `SELECT * FROM <table> WHERE ROWNUM <= 1`
   presence probes over known feature tables. It records which tables and features
   exist (`seenIn`), not columns or joins: the metadata catalog does not say what a
   reference field points to.

Save exports as `~/.netsuite-query/schema/<alias>-records-catalog.json`, then:

```bash
nsq schema build          # merge exports + pulls + facts + probes
```

`build` needs `~/.netsuite-query/schema/build.json`:
`{"clientPrefixes": ["acme"], "labelRenames": {"Site": "Location"}}`.
Custom records, lists, segments, `cust*` fields and anything containing a client
prefix go to the local custom layer; account-level label renames are mapped back.
The build refuses to write the public files if any client prefix, alias or account
id appears in them.

Maintainers: `nsq schema verify --account <sandbox> [--sample 200]` probes every facts
join, the facts tables' columns, the chains, and a deterministic sample of catalog
joins, then rebuilds.

Credit: the Records Catalog approach and export format come from Tim Dietrich's
[SuiteQL Query Tool](https://timdietrich.me/) (MIT license). nsq reads its exports
as-is; the browser snippet reimplements the same walk.

## Setup (once per NetSuite account, admin required)

Secrets live in `~/.netsuite-query/`, never in this repository:
`private.pem`, `public.pem`, and `accounts.json` (profiles).

1. **Generate a key pair once** (4096-bit; NetSuite rejects 2048):
   ```bash
   mkdir -p ~/.netsuite-query && cd ~/.netsuite-query
   openssl req -new -x509 -newkey rsa:4096 -keyout private.pem -out public.pem \
     -sha256 -days 730 -nodes -subj "/CN=nsq"
   chmod 600 private.pem
   ```
2. **Enable features** (Setup > Company > Enable Features > SuiteCloud): REST Web
   Services and OAuth 2.0.
3. **Create a read-only role** as described in `references/auth-and-roles.md`.
4. **Create an integration** (Setup > Integration > Manage Integrations > New):
   turn off Token-Based Authentication and Authorization Code grant; turn on OAuth 2.0
   and Client Credentials (Machine to Machine); scope REST Web Services. Save and copy
   the **Client ID**.
5. **Map the certificate** (Setup > Integration > OAuth 2.0 Client Credentials Setup >
   Create New): your user, the read-only role, the integration, and `public.pem`.
   Copy the **Certificate ID**.
6. **Find the Account ID** (Setup > Company > Company Information), e.g. `1234567` or
   `1234567_SB1`.
7. **Register the profile** and test:
   ```bash
   nsq accounts add --account sb1 --accountId 1234567_SB1 \
     --clientId <CLIENT_ID> --certId <CERT_ID>
   nsq test --account sb1
   ```

Account ids ending in `_SB<n>` or `_RP` are treated as sandbox; everything else is
production unless you pass `--env sandbox` or `--env production` when adding it.

The same key pair can be uploaded to every account you manage. Certificates last
at most two years.

## Layout

```
SKILL.md                    the agent skill
references/                 loaded by the agent on demand
  dialect.md                SuiteQL syntax that works and fails over REST
  errors.md                 NetSuite error text to cause and fix
  schema.md                 tables, join keys, filters, signs, currency, units
  chaining.md               how documents, lots, work orders and GL lines link
  script-vs-rest.md         where N/query in SuiteScript differs
  auth-and-roles.md         scopes, the read-only role, writes are not nsq
schema/                     the join map (graph, suiteapp, facts, probes)
bin/ lib/                   the CLI (lib/schema: build, path search, verify, pull)
test/                       node --test test/*.test.js
```

## License

MIT
