---
name: nsq
description: Use when pulling data out of NetSuite with SuiteQL, running the nsq CLI, checking that a NetSuite extract is complete and correctly shaped, or when asked to write records, call a RESTlet, or sign tokens with NetSuite M2M credentials.
---

# nsq: getting NetSuite data out, safely and correctly

`nsq` runs read-only SuiteQL against NetSuite over REST with OAuth 2.0 M2M. This
skill covers three things: **find** the data, **verify** it is the right data in the
right shape, **store** it without leaking it. What you build on top of the data is
out of scope.

**Violating the letter of these rules is violating the spirit of them.**

## Guardrails (non-negotiable)

1. **Read only, through nsq only.** Never read `~/.netsuite-query/private.pem`, never
   sign a JWT yourself, never change a token's `scope`, never call the REST record
   API or a RESTlet with nsq's credentials. If the user asks for any of that, stop
   and say it needs a separate write integration with its own role and certificate,
   set up by a human in NetSuite. Do not write the script "for them to run".
2. **Production is opt-in per task.** Profiles are `sandbox` or `production`
   (`nsq accounts`). Work in sandbox first. Use `--prod` only when the user asked for
   production in this task, and say so in your reply.
3. **No silent truncation.** nsq fails (exit 3) when more than 1000 rows exist and
   you did not pass `--max`. Pass `--max <n>` or `--max all` deliberately and report
   the total.
4. **Results are client data.** nsq refuses to save inside a git repo unless the path
   is gitignored. Do not use `--allow-tracked` to get around it; ignore the folder.
5. **Stop on permission errors.** `INSUFFICIENT_PERMISSION`, `INVALID_LOGIN_ATTEMPT`
   or a 401: report it. Do not try other profiles, scopes or deployments.

| Excuse | Reality |
|---|---|
| "It's their account and their credential" | The credential is scoped for reads. Writes need their own integration. |
| "It worked before" | It worked because the role is broader than intended. That is the bug. |
| "The permission prompt is their approval" | The prompt approves a command, not the design. Say what is wrong first. |
| "I'm only asking for a scope the integration grants" | Choosing scopes is minting new access. Not your call. |
| "They said just go, get everything" | Go means sandbox-first and `--max` stated, not unbounded production. |

## Workflow

1. **Read `nsq --help`** before the first run. Do not guess flags.
2. **Probe before trusting any table or column name**, including names from memory,
   docs, or another account: `nsq run "SELECT * FROM <table> WHERE ROWNUM <= 5" --account <sb> --format json`.
   Probe in a gitignored scratch folder.
3. **Build the query** using `references/dialect.md` and `references/schema.md`.
   For multi-record paths (invoice to lot to work order, GL line to source) use
   `references/chaining.md`. On any error, look it up in `references/errors.md`.
4. **Verify shape** (every time, before anyone uses the data):
   - Row count and total are what you expect; an **empty result is a finding**, not a pass.
   - No join fan-out: row count per key matches the grain you intended.
   - Unexpected nulls explained (NetSuite omits null columns entirely).
   - Detail **foots to an independent summary**: a GROUP BY of the same rows proves
     nothing. Compare to NetSuite's own figure (GL balance, `aggregateitemlocation`,
     the report the user trusts) from a query that does not share your filters.
   - Filters that change money are present: `posting = 'T'`, `accountingbook`,
     period by `accountingperiod.enddate`, subsidiary and currency.
5. **Store**: `.sql` next to its result in a gitignored data folder; `--format json`
   or `csv` for anything downstream. Note account, environment and pull date.

## Traps that fail silently or loudly (details in references)

- `COUNT(*)` on `transaction` fails: use `COUNT(t.id)`.
- `transactionaccountingline` joins lines on `tl.id`, never `linesequencenumber`,
  and always filters `accountingbook`.
- Location, subsidiary and `createdfrom` are on `transactionline`, not `transaction`.
- `ORDER BY x DESC` puts NULLs first: top-N queries return null rows.
- Status filters: write both forms, `IN ('D','WorkOrd:D')`.
- `item.averagecost` is a company blend; per-location cost is `aggregateitemlocation`.

## Output contract

End every nsq task with one line a pipeline can read:

```
NSQ: VERIFIED <rows> rows from <alias> [<env>] | NOT VERIFIED <reason> | BLOCKED <reason>
```

`VERIFIED` requires step 4 done, including an independent footing. Otherwise it is
`NOT VERIFIED` with the check that is missing.

## References (load when needed)

- `references/dialect.md`: syntax that works and fails in SuiteQL over REST
- `references/errors.md`: NetSuite error text to cause and fix
- `references/schema.md`: tables, join keys, filters, signs, currency, units
- `references/chaining.md`: linking documents, lots, work orders, BOMs, GL lines
- `references/script-vs-rest.md`: when a query proven in nsq behaves differently in SuiteScript
- `references/auth-and-roles.md`: setup, the read-only role, scopes, 401 diagnosis
