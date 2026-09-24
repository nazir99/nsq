# NetSuite errors: cause and fix

nsq prints NetSuite's error verbatim and saves it as `<name>.error.txt` next to the
`.sql`. Read it before changing anything.

## Query errors

| Error text (contains) | Likely cause | Fix |
|---|---|---|
| `Invalid or unsupported search` | A shape SuiteQL refuses: `COUNT(*)` on transaction, GROUP BY not repeating an expression, ORDER BY alias, OR join, `JSON_VALUE`, comparing `location.subsidiary` | See `dialect.md` Fails table |
| `UNEXPECTED_ERROR` with no column named | A column that does not exist or is not selectable (`transaction.createdfrom`, `transactionline.transferlocation`, a non-stored custom field), a wide `systemnote` date window, a join from a link table to `transactionline` | Add columns one at a time; isolate custom fields; narrow the window |
| `Unknown identifier '<X>'` / `SSS_SEARCH_ERROR_OCCURRED` | Column name wrong or field not on that record (`item.class`, `file.content`, a custom field not yet created) | Probe `SELECT * ... WHERE ROWNUM <= 5` and read the real keys |
| `Field 'location' for record 'transaction' was not found. Reason: REMOVED` | Location, subsidiary and `createdfrom` live on `transactionline` | Join `transactionline` |
| `Invalid search type` | Custom record type does not exist in this account (an empty one is fine) | Check the scriptid and the account |
| `Failed to parse SQL ... syntax error` | Real syntax error, or placeholder text like `{id}` | Fix syntax; substitute literals |
| `NOT_EXPOSED` (in SuiteScript only) | Field readable over REST but not through `N/query` | See `script-vs-rest.md` |
| Zero rows, no error | Wrong status code form, as-of date outside every BOM revision, NULLs sorted first, filter on the wrong entity | Treat empty as a finding and check each filter |
| Query hangs or times out | Correlated subquery per row (cost as of date), unfiltered `aggregateitemlocation`, full history | Fetch rows first, then history for the surviving ids only; add item and date bounds |

## Auth errors

| Error text | Cause | Fix |
|---|---|---|
| `invalid bit length` when uploading the certificate | NetSuite needs a 4096-bit RSA key | Regenerate with 4096 bits |
| `Invalid Redirect URI` | Authorization Code grant is on for the integration | Turn it off; M2M uses Client Credentials only |
| `invalid_client` / `invalid_grant` at the token step | Wrong clientId, certId, or account; cert mapping expired or revoked | Check `accounts.json` against the M2M setup page |
| Token succeeds, then every call is 401 or `INSUFFICIENT_PERMISSION` | The mapped role lacks REST Web Services or OAuth 2.0 login permission, or is a web-services-only role | See `auth-and-roles.md` |
| `INVALID_LOGIN_ATTEMPT` on a RESTlet | Token scope is not `restlets` | Not an nsq task. Stop and report. |
| Short results, no error | Role restricted to selected subsidiaries | Use a role with all needed subsidiaries |

To see why NetSuite refused a login, query `loginaudit` (`date`, `status`, `detail`,
`oauthappname`, `requesturi`). `detail` values include `InsufficientPermissions`,
`ScopeMismatched`, `TokenRejected`.
