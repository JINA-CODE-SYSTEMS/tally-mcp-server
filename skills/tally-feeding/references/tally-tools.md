# Tally Prime MCP — tool reference

Exact tool names, parameters, and usage notes, cross-checked against the server
source (`src/mcp.mts`). Read this when you need the precise signature for a call.
Every tool accepts an optional `targetCompany` (exact company name); pass it
explicitly during feeding so the write can't land in the wrong company.

## Table of contents
- [Discovery / read tools](#discovery--read-tools)
- [Write / feed tools](#write--feed-tools)
- [Company & session tools](#company--session-tools)
- [list-master collections](#list-master-collections)
- [Choosing the right write tool](#choosing-the-right-write-tool)
- [READONLY_MODE](#readonly_mode)

## Discovery / read tools

Read-only — safe to run during Phase 2 discovery and Phase 5 verification. Dates are
`YYYY-MM-DD`.

| Tool | Key params | Use for |
|------|-----------|---------|
| `list-master` | `collection` (enum, see below) | Enumerate masters — the backbone of discovery and name validation. Returns tab-separated rows. |
| `chart-of-accounts` | — | The group tree / account structure. |
| `trial-balance` | `fromDate`, `toDate` | Period trial balance; good for post-feed reconciliation. |
| `profit-loss` | `fromDate`, `toDate` | P&L. |
| `balance-sheet` | `toDate` | Balance sheet as at a date. |
| `ledger-balance` | `ledgerName`, `toDate` | Closing balance of one ledger. |
| `ledger-account` | `ledgerName`, `fromDate`, `toDate` | Full ledger statement — inspect real posting patterns. |
| `stock-summary` | `fromDate`, `toDate` | Stock summary. |
| `stock-item-balance` | `itemName`, `toDate` | One item's balance. |
| `stock-item-account` | `itemName`, `fromDate`, `toDate` | One item's movement. |
| `bills-outstanding` | `toDate` | Receivables/payables ageing. |
| `gst-voucher-details` | `fromDate`, `toDate` | GST voucher-level detail — sample to learn posting style. |
| `stock-item-gst` | — | Per-item GST (HSN, rate). |
| `gst-hsn-summary` | `fromDate`, `toDate` | HSN-wise summary. |
| `gstr1-summary` | `fromDate`, `toDate` | Outward supplies (GSTR-1). |
| `gstr2-summary` | `fromDate`, `toDate` | Inward supplies (GSTR-2). |
| `query-database` | `sql` | SQL over the cached DuckDB report tables — flexible cross-cuts. |

## Write / feed tools

These mutate the client's live books. Gate each behind Phase 4 (preview → consent).

### `create-ledger`
Creates a ledger master.

| Param | Type | Notes |
|-------|------|-------|
| `name` | string, required | Ledger name to create. |
| `parentGroup` | string, required | Exact parent group — validate with `list-master collection=group`. |
| `openingBalance` | number, optional | Negative = debit, positive = credit. |
| `mailingName` | string, optional | Display / mailing name. |
| `gstRegistrationType` | enum, optional | `Regular` \| `Composition` \| `Unregistered` \| `Consumer` \| `Unknown` (for party ledgers). |
| `gstin` | string, optional | GSTIN for party ledgers — never fabricate. |

### `create-stock-item`
Creates a stock item master.

| Param | Type | Notes |
|-------|------|-------|
| `name` | string, required | Item name. |
| `parentGroup` | string, optional | Stock group — validate with `list-master collection=stockgroup`. |
| `unit` | string, optional | Base unit — validate with `list-master collection=unit`. |
| `openingQuantity` | number, optional | |
| `openingRate` | number, optional | Rate per unit. |
| `hsnCode` | string, optional | HSN/SAC — read from existing items, don't invent. |
| `gstRate` | number, optional | GST rate %. |

### `create-voucher`
Non-GST double-entry voucher.

| Param | Type | Notes |
|-------|------|-------|
| `voucherType` | enum, required | `Sales` \| `Purchase` \| `Payment` \| `Receipt` \| `Contra` \| `Journal` \| `Debit Note` \| `Credit Note`. |
| `date` | string, required | `YYYY-MM-DD`. |
| `debitLedger` | string, required | Exact ledger name — validate first. |
| `creditLedger` | string, required | Exact ledger name — validate first. |
| `amount` | number, required | > 0. |
| `narration` | string, optional | |
| `voucherNumber` | string, optional | Blank = auto-number. |

### `create-gst-voucher`
GST invoice with automatic tax split. Prefer this for GST Sales/Purchase and
GST-bearing notes.

| Param | Type | Notes |
|-------|------|-------|
| `voucherType` | enum, required | `Sales` \| `Purchase` \| `Debit Note` \| `Credit Note`. |
| `date` | string, required | `YYYY-MM-DD`. |
| `partyLedger` | string, required | Exact party ledger — validate first. |
| `salePurchaseLedger` | string, required | Exact sales/purchase ledger — validate first. |
| `taxableValue` | number, required | Amount before GST, > 0. |
| `gstRate` | number, required | e.g. `18` for 18%. Split into CGST+SGST (intra) or IGST (inter). |
| `isInterState` | boolean, required | `true` = IGST; `false` = CGST + SGST. |
| `placeOfSupply` | string, optional | State name for GST determination. |
| `isReverseCharge` | boolean, optional | Default false. |
| `narration` | string, optional | |
| `voucherNumber` | string, optional | Blank = auto-number. |
| `originalInvoiceNumber` | string, optional | **Required** for Debit/Credit Note — links to the original invoice. |
| `originalInvoiceDate` | string, optional | `YYYY-MM-DD`, for Debit/Credit Note. |
| `cgstLedger` / `sgstLedger` / `igstLedger` | string, optional | Exact tax-ledger names. If omitted, auto-resolved from Tally — but if the client uses non-standard tax-ledger names, pass them explicitly from the confirmed conventions. |

## Company & session tools

| Tool | Key params | Use for |
|------|-----------|---------|
| `list-loaded-companies` | — | What's currently loaded/active. |
| `list-companies` | — | Companies known to Tally (names + folder IDs). |
| `list-available-companies` | `dataPath`, `configPath` (optional) | Scan a data path for companies (incl. backups). |
| `list-configured-companies` | — | Companies with saved credential hints. |
| `set-active-company` | `companyName` | Switch the default target. |
| `open-company` | `companyName`, `strategy` (`auto`\|`tdl-load`\|`tdl-connect`\|`gui-agent`) | Open/attach a company. |
| `load-company` / `load-company-by-alias` | `company`, `replace`, `dataPath`, `userName`, `password`, `waitTimeoutSec` | Cold-load via Tally restart (edition-aware). Credentials are filtered from audit logs. |
| `open-company-debug` | `includeRecentResult`, `watchDir` | Diagnose open/load issues. |
| `tally-raw-xml-probe` | `xml`, `label` | Debug-only raw XML probe. Not for routine feeding. |

## list-master collections

`list-master` `collection` enum:
`group`, `ledger`, `vouchertype`, `unit`, `godown`, `stockgroup`, `stockitem`,
`costcategory`, `costcentre`, `attendancetype`, `company`, `currency`, `gstin`,
`gstclassification`.

Most-used in discovery: `group`, `ledger`, `vouchertype`, `stockitem`, `stockgroup`,
`unit`, `gstin`, `gstclassification`.

## Choosing the right write tool

- **GST sales/purchase invoice, or GST debit/credit note** → `create-gst-voucher`
  (handles CGST/SGST vs IGST from `isInterState`; for notes, supply
  `originalInvoiceNumber`).
- **Payment, Receipt, Contra, Journal, or any plain two-ledger entry** →
  `create-voucher`.
- **A referenced ledger/party/expense account doesn't exist** → `create-ledger` first.
- **A referenced stock item doesn't exist** → `create-stock-item` first.

Order within a batch: masters (`create-ledger`, `create-stock-item`) before the
vouchers that reference them.

## READONLY_MODE

The server env var `READONLY_MODE=true` disables all write tools. If a write fails
because of this, don't keep retrying — tell the user, and fall back to producing the
exact voucher/master plan (and XML if helpful) for manual entry in Tally.
