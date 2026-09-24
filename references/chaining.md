# Chaining records: how NetSuite documents link

For getting the right rows across several records. Join keys and fallbacks only;
how to allocate or roll up cost across a chain belongs to the solutioning step.

## The spine: `transactionline.createdfrom`

| From | `createdfrom` points to |
|---|---|
| Work order issue, completion, close lines | The work order |
| Item fulfillment lines | Sales order, transfer order, or vendor return |
| Item receipt lines | Purchase order, transfer order, or return authorization |
| Invoice lines | Sales order |
| Some revaluation (`InvReval`) lines | The work order (partial; measure it) |

- Select it from `transactionline`; `transaction.createdfrom` errors.
- `BUILTIN.DF(tl.createdfrom)` gives the source document name, whose prefix tells the type.
- **Measure the keyed share before trusting it:** count lines with and without
  `createdfrom` for the type you rely on. Inventory documents are usually fully keyed,
  journals never, revaluations partly.
- Fallback when blank: `nexttransactionlink` (`previousdoc` -> `nextdoc`, `linktype`
  such as `WOReval` for work order to revaluation). It is header level. Then
  matching on item + location + quantity + direction + date, which must be checked
  for ambiguity (two candidates with the same quantity).

## Common chains

**Invoice to COGS.** Invoice lines -> `createdfrom` sales order -> fulfillment lines
(`type = 'ItemShip'`, `createdfrom IN (sales orders)`, same item) -> COGS on the
fulfillment's `transactionaccountingline` rows (`accttype = 'COGS'`, primary book).
Map invoice line to fulfillment line; a sales order with several fulfillments must
not attach all of them to every invoice line. One logical fulfillment item can span
several `transactionline` ids (lot detail on one, COGS on others): match by item
within the transaction.

**Lot genealogy.** Shipped or consumed lots: `inventoryassignment` with `quantity < 0`
on the document. Who made a lot: `inventoryassignment` with `quantity > 0`, joined
to the completion's **mainline** line; its `createdfrom` is the work order. Put the
maker restrictions inside one subquery; chained LEFT JOINs keep receipts and
adjustments and duplicate the issue row. A lot can have several makers, later
receipts, or an opening adjustment as its origin: filter by date and location, and
treat adjustment-origin lots as terminal.

**Work order documents.** `t.id IN (SELECT x.transaction FROM transactionline x WHERE x.createdfrom = :wo)`
also pulls whole revaluations. Restrict `recordtype` to issue, completion, close,
unbuild. Completion lines with `transactionlinetype = 'ROUTINGITEM'` carry labor and
overhead.

**Revaluation lines.** Detail lines come in adjacent pairs with the same
`accountinglinetype` and account: the first reverses at the old cost, the second
reposts at the new one. The second line's sign is the original direction. Types:
`ASSET` (on hand at a location) and `WIP`. Take location from each line, never from
the first row of the document.

**Transfers.** Destination location is only on the transfer order header
(`transferlocation`); the source location is on the posting lines. On a transfer
receipt the `INTRANSIT` line gives the source location.

**BOM explosion.** `itemassemblyitembom` -> `bom` -> as-of `bomrevision` ->
`bomrevisioncomponentmember`, one query per level for the whole frontier. Pick one
BOM per assembly deterministically (location default, then master default, then
lowest id) and one revision per BOM (latest effective start, then highest id).
Routing is looked up by the assembly's own BOM id.

**GL line to source.** `transactionaccountingline` -> `transactionline` (both keys)
-> `LEFT JOIN transaction src ON src.id = tl.createdfrom`. Keep unkeyed lines as
their own bucket; never drop them.

## Efficient traversal

- **Walk by frontier:** one IN-list query per level for every id at that level, so
  round trips scale with depth, not node count.
- Keep a visited set keyed at the right grain (item for BOMs, lot + item for
  genealogy, work order for supply) and a per-branch path set to detect cycles.
- Dedupe and validate ids, chunk IN lists (about 500), skip the query on an empty list.
- **Fetch rows, then history for survivors:** a correlated "value as of this line's
  date" subquery times out on aggregates. Pull the aggregate, then fetch history only
  for the ids that remain, and pick the latest-before-date client side.
- When SuiteQL refuses a shape, export flat single-table results with raw ids and
  join locally.
- **A join that repeats a row per parent is a double count until proven otherwise.**
  Check row counts per key after every join that can fan out.
- State every cap (depth, rows, ids) in the output. A silent cap reads as complete.
