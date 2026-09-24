# A query proven in nsq is not yet proven in SuiteScript

nsq uses the REST SuiteQL endpoint. `N/query` inside a script runs the same
language with different rules. Re-test in the script before relying on it.

| Topic | REST (nsq) | `N/query` in SuiteScript |
|---|---|---|
| Status filter | Short code: `status = 'D'` | Qualified: `status = 'WorkOrd:D'`. Wrong form returns zero rows, no error. Write `IN ('D','WorkOrd:D')`. |
| Field exposure | Some fields readable (e.g. `account.acctname`) | Same field can raise `NOT_EXPOSED` |
| Row shape | Keyed objects, keys lower case, null keys omitted, a `links` field per row | `asMappedResults()` keyed; paged results positional (`row.values`) |
| Dates | Strings like `M/D/YYYY` | Strings in the user's date format |
| Checkboxes | `'T'` / `'F'` strings | Same strings; passing them straight to `record.setValue` on a checkbox silently stores false. Convert to a boolean. |
| Paging | `limit` up to 1000 per call, `offset`, header `Prefer: transient`, loop while `hasMore` | `runSuiteQLPaged` pageSize up to 1000, stops at 1000 pages; `paged.count` is the capped total |
| Row cap | nsq fails loudly past `--max` | `runSuiteQL().asMappedResults()` silently stops at 5000 rows |
| Accepted shapes | Correlated subqueries and more complex joins accepted | `runSuiteQLPaged` refuses some shapes `runSuiteQL` accepts |
| Parameters | Literal values in the text | Positional `?` binds with a `params` array |
| Time | Request timeout | Script governance (Suitelet about 1,000 units, RESTlet 5,000) and wall-clock limits; `runSuiteQLPaged` re-runs the query per page |

Also:

- Some fields are readable only through SuiteQL (`record.getValue` returns undefined).
- Paging needs a unique `ORDER BY` or rows duplicate and drop across pages.
- Pass a stable `customScriptId` to `runSuiteQL` for performance tracking.
- Saved searches apply role and subsidiary restrictions that SuiteQL does not; when
  porting a saved search, rebuild its logic rather than transcribing it.
