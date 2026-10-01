# nsq schema graph: how NetSuite tables join

Maintainer detail for `nsq schema`. The short version is in the [README](../README.md#schema-graph).

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

## What is in it

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

## How much to trust the catalog

The Records Catalog lists joins in a human-readable form and exports parse it. Known
problems, all handled in the build: ids arrive in two casings (merged); some join
columns are sublist names rather than columns (`transactionline.transactionLines`
fails live; the real key is `transactionline.transaction`); list tables and units are
exported as joining on `id` when their key is `key` or `internalid` (repaired, the
original kept); polymorphic joins list every record subtype (collapsed to
`transaction`, `item`, `entity`); multi-key joins lose all but the first key in the
SuiteQL Query Tool export. Catalog joins stay `unprobed` until `nsq schema verify`
passes them; verified facts win on conflict.

How wrong the raw catalog is, before the build repairs it: **6.5% of joins were bad**
in a deterministic sample of 200 standard catalog joins (one sandbox export, 2,768
tables, 83,715 relationships, 2026-09). Each bad join used a key the table does not
have (`id` on a list, unit or address table) or a sublist name as a column. The build
repairs the `key`, `internalid` and `nkey` cases, and every repaired join in the
sample whose tables were queryable passed. A further 24% of the sample could not be
tested at all, because a read-only role cannot query those tables; that says nothing
about the join. (Total failing a live probe as exported: 31.5%, 37% on an earlier
sample.) `nsq schema verify` shows these numbers for your own account.

## Adding another account

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
