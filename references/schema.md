# Schema facts that change the answer

Always probe before trusting a name. These are facts verified in live accounts;
customizations can differ, so confirm in yours.

## Transactions

- `transaction` = header (`id`, `tranid`, `type`, `recordtype`, `trandate`, `postingperiod`,
  `posting`, `status`, `createddate`, `foreigntotal`, `approvalstatus`).
- `transactionline` = lines (`transaction`, `id`, `linesequencenumber`, `item`, `location`,
  `subsidiary`, `quantity`, `rate`, `netamount`, `foreignamount`, `mainline`, `taxline`,
  `iscogs`, `accountinglinetype`, `transactionlinetype`, `createdfrom`, `expenseaccount`,
  `units`, `linelastmodifieddate`, `uniquekey`, `landedcostcategory`).
- **Location, subsidiary and `createdfrom` are on the line**, not the header.
- `mainline = 'T'` is the header line. On a work order completion the finished-good
  receipt is the mainline row; `mainline = 'F'` filters hide it.
- `createddate`, not `datecreated`.
- `type` codes: `SalesOrd`, `CustInvc`, `CustCred`, `ItemShip`, `ItemRcpt`, `PurchOrd`,
  `VendBill`, `Journal`, `InvAdjst`, `InvWksht`, `TrnfrOrd`, `WorkOrd`, `WOIssue`, `WOCompl`,
  `WOClose`, `Build`, `Unbuild`, `InvReval`.
- `recordtype` values are lower case names: `itemfulfillment`, `itemreceipt`,
  `workorderissue`, `workordercompletion`, `workorderclose`, `inventorycostrevaluation`.
- Status: SuiteQL returns the short code (`'D'`). Filter with both forms,
  `IN ('D','WorkOrd:D')`, because `N/query` filters on the qualified form.
  Vendor bill `approvalstatus`: 1 pending, 2 approved, 3 rejected.

## Money: `transactionaccountingline`

- One row per posting line **per accounting book**. Always filter `tal.accountingbook`
  (primary book id) or multi-book accounts double.
- Join to lines on **both keys**: `tl.transaction = tal.transaction AND tl.id = tal.transactionline`.
  **Not `linesequencenumber`.** The two are usually equal, so the wrong key passes
  casual testing, but they differ on some lines (seen on about 11% of work order
  completion lines), where the wrong key lands on another item.
- Signed amount: `NVL(tal.debit,0) - NVL(tal.credit,0)` (or `tal.amount`).
- Filter `t.posting = 'T' AND tal.posting = 'T'`.
- Periods: join `accountingperiod ap ON ap.id = t.postingperiod`; filter on `ap.enddate`,
  not `trandate`. Balance-sheet balances take no start date. `ap.isadjust = 'F'`
  excludes adjustment periods; decide deliberately. Other columns: `periodname`,
  `startdate`, `isyear`, `closed`.
- Debit and credit are in the posting subsidiary's base currency. Never add across
  subsidiaries with different currencies.
- Revenue: sum Income accounting lines; invoice `netamount` can include allocations.
- `account`: use `accountsearchdisplayname` (not `name`), `accttype` (e.g. `COGS`).
  `accountsubsidiarymap` maps accounts to subsidiaries.

## Signs and currency

- Sales order and invoice line quantity and amount are negative; credit memo lines positive.
- `foreigntotal` is negative on purchase orders, positive on bills and invoices.
- COGS posts on the fulfillment (`ItemShip`, lines with `iscogs = 'T'`), not the invoice.
- Invoice mainline: `amount` is base currency; `netamount` and `foreignamount` are
  transaction currency. No base-currency unpaid column: `foreignamountunpaid * exchangerate`.
- Exchange rates are stamped at posting; never recalculate.

## Units

- `transactionline.quantity` and `rate` are in the item's **base unit**, whatever
  `units` says. `BUILTIN.DF(tl.units)` is a label only.
- BOM component quantity is in the line's unit. Convert with `unitstypeuom`
  (`internalid`, `unitstype`, `unitname`, `conversionrate`, `baseunit`); unit ids are
  per units type. Check the conversion table; a wrong rate in setup is possible.

## Inventory

- Per-location average: `aggregateitemlocation` (`item`, `location`, `quantityonhand`,
  `onhandvaluemli`, `averagecostmli`, `cost`, `lastpurchasepricemli`,
  `quantityavailable`, `quantityonorder`, `quantityintransit`). `item.averagecost` is a
  company-wide blend and will not match any location. Always filter `item IN (...)`.
- Standard-cost items: `averagecostmli` shows the standard, not an average.
- Lots, serials, bins: `inventoryassignment` (`transaction`, `transactionline`,
  `inventorynumber`, signed `quantity`: negative consumed, positive created). Join on
  both keys; `inventorynumber` table gives the lot name.
- Landed-cost lines have NULL quantity (not zero) and `landedcostcategory` set.
- On PO receipts `netamount` can still carry the PO amount; the GL posted quantity x rate.
- `item`: `itemid` (the item number), `itemtype`, `costingmethod`, `matrixtype`,
  `parent`, `custitem_*` fields as plain columns.

## Manufacturing

- `itemassemblyitembom` (`assembly`, `billofmaterials`, `masterdefault`,
  `defaultforlocation`) -> `bom` -> `bomrevision` (`effectivestartdate`,
  `effectiveenddate`) -> `bomrevisioncomponentmember` (`bomrevision`, `item`, `quantity`, `units`).
  `bomrevisioncomponent` also exists and is what `systemnote` refers to.
- An as-of date outside every revision window returns zero rows.
- A work order's actual recipe: `transaction.billofmaterialsrevision`.
- `manufacturingrouting` (`billofmaterials`, multi-select `location`, `isdefault`,
  `isinactive`) -> `manufacturingroutingroutingstep` (`operationsequence`, `setuptime`,
  `runrate`, `manufacturingworkcenter`, `manufacturingcosttemplate`) ->
  `manufacturingcosttemplatecostdetail` (`costcategory`, `runrate`, `fixedrate`).
  Confirm `runrate` units against the UI before using it in math.
- `manufacturingoperationtask` (`workorder`, `operationsequence`, `title`).

## Links and admin

- `nexttransactionlink` (`previousdoc`, `nextdoc`, `linktype`): header level, no amount.
  `nexttransactionlinelink` is the line-level version.
- `deletedrecord` (`recordid`, `recordtypeid`, `deleteddate`, `name`).
- `systemnote`: audit trail. Needs a narrow date window; no GROUP BY.
- `scriptnote` (`date`, `type`, `title`, `detail`; join `script` on `scripttype`) reads
  script execution logs. `script`, `scriptdeployment` (`status`, `isdeployed`, `allroles`).
- `loginaudit`: see `errors.md`.
- `location` has no address columns; join `locationmainaddress` on `nkey = location.mainaddress`.
