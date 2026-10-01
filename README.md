# nsq

**Lets an AI assistant pull data out of NetSuite without changing anything, and
makes it prove the data is complete before anyone uses it.**

Two parts:

- **A command-line tool** that runs read-only queries against NetSuite and saves
  the results outside source control.
- **A skill** (`SKILL.md`): instructions for the AI on finding the right data,
  proving it is complete and correctly shaped, and keeping client data safe.
  `SKILL.md` is written for the AI, not for people.

Step 1 of [software-factory](https://github.com/nazir99/software-factory).

## Why it exists

AI assistants write decent NetSuite queries. They fail at everything around the
query:

- they run against production because someone said "just go"
- they reuse a read-only login to write records
- they trust a table name from memory
- they call a number "tied" when it only agrees with itself

nsq builds the hard rules into the tool and puts the judgment calls in the skill.

## What it guarantees

| Guarantee | How |
|---|---|
| It cannot change NetSuite data | Only a single `SELECT` runs. Its NetSuite login should be mapped to a read-only role (setup step 3). |
| Production only on request | A production account needs `--prod` on every run, so production is never the accidental choice. |
| No silently missing rows | It stops at 1,000 rows and fails if more exist, until you pass `--max <n>` or `--max all`. |
| Client data stays out of git | It refuses to save results inside a repository unless that folder is ignored. |
| You always know where it ran | Every run prints the account and `[production]` or `[sandbox]`. |
| Nothing is "verified" on faith | The skill requires a footing to an independent NetSuite figure before it reports `VERIFIED`. |

## What testing showed

53 runs in a NetSuite sandbox. Each was graded by a separate AI that worked out its
own answers. Full write-up: [`benchmarks/`](benchmarks/README.md).

- A strong model got every hard query right, with or without the skill.
- A small model got none fully right, and reported three wrong results as
  verified. **Use a strong model past simple joins, and never accept a small
  model's "verified" without an independent re-check.**
- The table map (below) saves effort only on unfamiliar joins and with smaller
  models. The skill says to use it only then.

## Install

Requires Node 18 or later. No dependencies.

```bash
git clone https://github.com/nazir99/nsq.git ~/.claude/skills/nsq
cd ~/.claude/skills/nsq && npm link        # puts `nsq` on your PATH
```

Then do the one-time [Setup](#setup-once-per-netsuite-account-admin-required) for
each NetSuite account. For agents other than Claude Code, clone the folder wherever
that agent loads skills from.

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

## Schema graph

A map of how standard NetSuite tables join, with known traps attached, so the AI
does not have to guess join keys.

```bash
nsq schema path transactionaccountingline transaction --via transactionline
nsq schema table inventoryassignment     # columns, joins, traps
nsq schema search "document number"
nsq schema chain                         # verified multi-hop recipes
```

How it is built, how far to trust it and how to add an account:
[docs/schema-graph.md](docs/schema-graph.md).

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

## Testing

- **Unit tests** for the CLI and the schema map: `node --test test/*.test.js`.
- **Agent benchmarks**: [`benchmarks/`](benchmarks/README.md), summarized in
  [What testing showed](#what-testing-showed).

## Layout

```
SKILL.md                    instructions for the AI
references/                 loaded by the AI on demand
  dialect.md                SuiteQL syntax that works and fails over REST
  errors.md                 NetSuite error text to cause and fix
  schema.md                 tables, join keys, filters, signs, currency, units
  chaining.md               how documents, lots, work orders and GL lines link
  script-vs-rest.md         where N/query in SuiteScript differs
  auth-and-roles.md         scopes, the read-only role, writes are not nsq
schema/                     the join map (graph, suiteapp, facts, probes)
docs/schema-graph.md        how the join map is built and verified
bin/ lib/                   the CLI (lib/schema: build, path search, verify, pull)
test/                       node --test test/*.test.js
benchmarks/                 how the skill was tested and what changed because of it
```

## License

MIT
