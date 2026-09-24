# SuiteQL dialect over REST (nsq)

SuiteQL is Oracle-flavoured SQL with NetSuite restrictions. What works differs by
endpoint: the rules below are for the REST SuiteQL endpoint that nsq uses. The AI
Service Connector endpoint is stricter (no CTEs, no `BUILTIN.DF`).

## Works

- `WHERE ROWNUM <= n`, and `FETCH FIRST n ROWS ONLY`.
- CTEs: `WITH x AS (SELECT ...) SELECT ... FROM x`.
- Window functions: `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)`, `COUNT(x) OVER ()`,
  `SUM(x) OVER (...)`. Latest-per-group: wrap and filter,
  `SELECT * FROM (SELECT ..., ROW_NUMBER() OVER (PARTITION BY item ORDER BY trandate DESC) rn FROM ...) WHERE rn = 1`.
- `KEEP (DENSE_RANK LAST ORDER BY ...)`, `LISTAGG ... WITHIN GROUP`, `ADD_MONTHS`,
  `TRUNC(d)`, `TRUNC(d, 'IW')` (ISO week Monday), `MOD`, `NULLIF`, `CASE`.
- Oracle functions: `NVL` (not `ISNULL`), `SUBSTR` (not `SUBSTRING`), `SYSDATE` (not `NOW()`),
  `TO_DATE('2026-01-31','YYYY-MM-DD')`, `TO_CHAR(d,'YYYY-MM-DD HH24:MI:SS')`.
- Date arithmetic is in days: `TRUNC(createddate) - TRUNC(trandate)`.
- `BUILTIN.DF(field)`: display text for a list or record field (status, location, item).
- `BUILTIN.MNFILTER(col,'MN_INCLUDE','','FALSE','<id>') = 'T'` to test a multi-select field.
- `CHR(38)` to put `&` in a built string (URLs), avoiding tool-side escaping.
- A `UNION ALL` inside a subquery with an outer `ORDER BY`.

## Fails or misleads

| Pattern | What happens | Do instead |
|---|---|---|
| `COUNT(*)` on `transaction` | "Invalid or unsupported search" | `COUNT(t.id)` |
| `GROUP BY col` when SELECT has `BUILTIN.DF(col)` or `TO_CHAR(col)` | Invalid search | Repeat the exact SELECT expression in GROUP BY |
| `ORDER BY <alias>` on an aggregate | Invalid search | Repeat the expression or use an ordinal (`ORDER BY 3`) |
| `ORDER BY BUILTIN.DF(x)` over a LEFT JOIN | Invalid search | Order on the raw column, e.g. `NVL(x.status,'~')` |
| Join condition with `OR` | Rejected | Two queries, combine client side |
| Nested derived tables | Rejected | One level, or flat exports joined client side |
| `UNION ALL` whose branches join the same CTE | Rejected | Inline the CTE per branch |
| Top-level `ORDER BY` over a `UNION` | Sometimes refused | Wrap the union, order outside |
| Grouping on a derived-table column | Rejected | Wrap it in `MAX()` |
| `JSON_VALUE` | Invalid search | Parse client side |
| `ORDER BY x DESC` for top-N | NULLs sort first, top-N returns null rows | `NVL(x,0)` or `NULLS LAST` |
| `NVL(x,'')` | `''` is NULL in Oracle, so still null | `NVL(x,'(none)')` |
| `BUILTIN.DF` on a column selected out of a CTE | Returns the raw id | Join the table, select its name |
| `BUILTIN.DF` on a grouped column | Returns null | Join the record, select its name |
| Constant in SELECT (`'x' AS m`) on `systemnote` | Fails | Add constants client side |
| Template placeholders `{param}` | Syntax error | Literal values in nsq; `?` binds in SuiteScript |

## Habits

- One statement per run. No trailing `;` (nsq strips one).
- Add columns one at a time when a query errors with no column named.
- Isolate fragile columns (non-stored custom fields, formula fields) in their own
  query so they fail alone.
- Unique `ORDER BY` (end with `t.id, tl.id`) whenever results page. A non-unique
  sort duplicates and drops rows across pages.
- Third-party query tools with a formatter can split identifiers containing a
  keyword (`createdfrom` becomes `created FROM`) and flatten `--` comments over real
  columns. nsq sends the text unchanged.
