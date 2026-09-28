# Benchmarks

How nsq, its skill and its schema map were tested, what the results were, and what
changed because of them. All runs used a NetSuite **sandbox** of a real
manufacturing company, read-only through nsq. Client names, item codes, account
numbers and amounts are left out; the raw run folders stay private because they
contain client data.

## Method

- Each question was given to a fresh agent with nothing but the task text, the CLI
  and (depending on the arm) the skill. Agents could not read the author's notes or
  project files.
- **Arms**: with the skill vs the bare CLI (no `SKILL.md`, no `references/`), and
  with the schema map vs with the map files physically removed.
- **Models**: a strong model (Opus class) and a small model (Haiku class).
- **Grading**: correctness was checked by a separate grader agent that established
  its own reference answers with independent queries, then graded each run as
  CORRECT, PARTIAL (right numbers, method that breaks elsewhere) or WRONG. It also
  flagged **false-verified** runs: the agent claimed the result tied or was
  validated when it was wrong or the check only compared the result with itself.
- **Tokens**: total tokens per agent run, including a fixed overhead of roughly
  40k per run, so differences are what matter, not absolute numbers.

## Round 1: does the schema map save tokens? (strong model, join questions)

Three join questions per round, each run once or twice with and without the map.

| Questions | Without map | With map | Correct |
|---|---|---|---|
| Joins already documented in `references/` | 32.1k task tokens | 36.1k | all |
| Joins not documented (ship-to address, consolidated FX rate, preferred vendor) | 55.9k | 69.0k (+23%) | 12/12, both arms |

Finding: for a strong model the map added tokens. Agents read the map's answer and
then probed anyway, and two catalog joins in the map were wrong at the time (both
fixed after this round). Change made: `SKILL.md` switched to "references first".

## Round 2: does the map help a small model? (small model, same kind of joins)

Six questions, each with and without the map (12 runs).

| Questions | Without map | With map | Notes |
|---|---|---|---|
| Documented joins (invoice to lots, GL line to source, BOM as of date) | 152.6k | 170.0k (+11%) | Same answers; the map arm filtered BOM revisions by end date as well |
| Undocumented joins | 200.3k | 180.9k (-10%) | Without the map, the ship-to question was answered by string-parsing an address text field (wrong); the consolidated-rate question took 22 queries |

Finding: the map pays off on obscure structures (address subrecords joined on
`nkey`, multi-key joins, SuiteApp records) and for smaller models, and costs tokens
on guessable tables because agents over-explore. Change made: `SKILL.md` now says
to use the map for unfamiliar tables, failed first probes and the known hard spots,
with one lookup then query.

## Round 3: hard queries (both models, with and without the skill)

Five questions, each run by both models with and without the skill (20 runs):

1. Latest cost revaluation per item and location as of a date (window functions, tie-breaks).
2. Multi-level BOM explosion as of a date (no recursion available, revision dates, units).
3. Running inventory quantity and value for one item and location, tied to NetSuite's on-hand.
4. GL rollforward by month for an inventory account (periods, opening without a start date, multiple subsidiaries and currencies).
5. AR aging by subsidiary in base currency (open amounts, exchange rates, buckets).

| Model, arm | Correct | Partial | Wrong | False-verified | Mean tokens |
|---|---|---|---|---|---|
| Strong, bare CLI | 5 | 0 | 0 | 0 | 70.4k |
| Strong, with skill | 5 | 0 | 0 | 0 | 86.9k |
| Small, bare CLI | 0 | 2 | 3 | 3 | 86.4k |
| Small, with skill | 0 | 3 | 2 | 3 | 85.9k |

Findings:

- **Hard queries need a strong model.** The strong model got all ten right with or
  without the skill. The skill added about 23% tokens and bought extra independent
  tie-outs and more honest `NOT VERIFIED` reports, not extra accuracy.
- **The skill did not stop a small model from reporting wrong results as
  verified** (3 with, 3 without). The rule was in the skill; it was not followed.
- **Small models invent limitations**: "SuiteQL has no joins / window functions /
  CTEs / date arithmetic". Believing that, they moved logic into Python or awk,
  which is where most of their errors came from.
- **The two currency failures** (a rollforward adding a USD and a BRL subsidiary
  together) came from a rule that lived only in `references/schema.md`, which the
  agent never opened.

Changes made after this round:

- `SKILL.md`: a "SuiteQL can do this" list, so agents keep logic in SQL; the
  currency rule, `TRUNC(SYSDATE)`, latest-per-group tie-breaks, inventory value from
  ASSET lines and inactive BOMs moved into the top traps; a "Model choice" section.
- `references/dialect.md`: recursive CTEs fail; `CONNECT BY` runs but returns wrong
  `LEVEL` values; `ROW_NUMBER()` directly over `inventorycostrevaluation` fails, with
  the working alternatives. Each was re-probed before it was written down; one
  reported failure (`FETCH FIRST` inside a subquery) did not reproduce and was not
  added.

## What this means for use

- Use a strong model for anything past a simple join, and an independent
  re-check (the `netsuite-data-solutioning` skill) before a number is trusted.
- A small model's `NSQ: VERIFIED` is not evidence on its own.
- The schema map is a fallback for unfamiliar tables, not the first step.

## Reproducing

The questions above run against any NetSuite sandbox with inventory, manufacturing
and AR activity. Give each agent only the task text and either the bare CLI or the
skill, collect the final queries and results, and grade them against reference
answers computed with independent queries that do not share the agent's filters.
