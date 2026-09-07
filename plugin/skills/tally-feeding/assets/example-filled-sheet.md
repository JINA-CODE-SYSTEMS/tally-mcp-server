<!--
  WORKED EXAMPLE (fictional). Shows what a per-client sheet looks like once filled.
  This is a sample only — "Ross Industries Pvt Ltd" is not a real client. Real sheets
  live in clients/ and are private. Use this to see the shape, not as real data.
-->

# Instruction sheet — Ross Industries Pvt Ltd

- **Company (exact Tally name):** Ross Industries Pvt Ltd
- **Slug (filename):** ross-industries-pvt-ltd
- **GSTIN(s):** 27ABCDE1234F1Z5
- **Financial year in use:** 2025-26
- **Tally edition:** Gold
- **First profiled:** 2026-07-04  ·  **Last updated:** 2026-07-04
- **Overall confirmation:** confirmed with changes on 2026-07-04

> Status legend: `confirmed` = client-verified · `observed` = inferred · `rule` = client-requested override.

## Conventions

### Group structure
- Standard Tally groups; expenses split under "Direct Expenses" and "Indirect Expenses". — _confirmed_

### Ledger naming
- Sales ledger(s): "Sales @ 18%", "Sales @ 12%" — _confirmed_
- Purchase ledger(s): "Purchase @ 18%" — _confirmed_
- Bank / cash ledgers: "HDFC Bank 4021", "Cash" — _confirmed_
- Round-off ledger: "Round Off" — _confirmed_
- Common expense ledgers: "Freight & Cartage" → inward freight; "Bank Charges" → bank fees — _confirmed_

### Party ledgers
- Naming pattern: plain trade name, no suffix — _confirmed_
- Default group for new customers: "Sundry Debtors" — _confirmed_
- Default group for new suppliers: "Sundry Creditors" — _confirmed_
- Default GST registration type for new parties: Regular — _confirmed_

### Tax ledgers (must match exactly)
- CGST: "CGST" · SGST: "SGST" · IGST: "IGST" — _confirmed_
- Typical supply type: mostly intra-state (Maharashtra) — _confirmed_

### Voucher conventions
- Numbering: automatic — _confirmed_
- Narration style: "Being <goods> sold to <party> vide inv <no>" — _confirmed_
- Voucher types in regular use: Sales, Purchase, Payment, Receipt, Journal — _confirmed_

### Inventory
- Item naming pattern: "<Product> - <Grade>" — _confirmed_
- Default base unit(s): "Nos", "Kg" — _confirmed_
- HSN handling: on item — _confirmed_
- GST rate handling: on item — _confirmed_

## Standing approvals (consent memory)

- auto-post Sales GST vouchers once mapped — allow-always, 2026-07-04
- auto-create new customer ledgers under "Sundry Debtors" — allow-always, 2026-07-04

## Do-not / cautions

- Never post to "Suspense A/c" — client reconciles that manually.

## Feedback log / changelog

- 2026-07-04 — New inward freight goes to "Freight & Cartage", not "Carriage Inward" (which is legacy/unused) — per client (Mr. Ross).
- 2026-07-04 — Confirmed intra-state default; only tag inter-state when party GSTIN state ≠ 27 — per client.
