# nsq

A read-only SuiteQL runner for NetSuite, and an agent skill that teaches AI coding
agents to use it safely.

The CLI sends SuiteQL to NetSuite's REST endpoint with OAuth 2.0 Machine-to-Machine
auth and prints the result, or saves it next to the `.sql` file. The skill
(`SKILL.md`) tells an agent how to find NetSuite data, prove it is complete and
correctly shaped, and store it without leaking client data.

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
bin/ lib/                   the CLI
```

## License

MIT
