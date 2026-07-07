<!--
  PER-CLIENT INSTRUCTION SHEET — template.
  The tally-feeding skill copies this to clients/<company-slug>.md on first contact
  with a client, fills it during Discovery + Confirmation (Phases 2–3), and updates it
  as feedback arrives (Phase 6). Replace every <angle-bracket> placeholder. Delete
  rows/sections that don't apply (e.g. drop the Inventory section for a service client).
  Keep entries in EXACT Tally names — character-for-character — because these values
  are used directly in tool calls.
-->

# Instruction sheet — <Company Name>

- **Company (exact Tally name):** <Company Name as shown in Tally>
- **Slug (filename):** <company-slug>
- **GSTIN(s):** <GSTIN or "none">
- **Financial year in use:** <e.g. 2025-26>
- **Tally edition:** <Silver / Gold / unknown>
- **First profiled:** <YYYY-MM-DD>  ·  **Last updated:** <YYYY-MM-DD>
- **Overall confirmation:** <not yet confirmed / confirmed as-is / confirmed with changes> on <YYYY-MM-DD>

> Status legend used below: `confirmed` = client-verified · `observed` = inferred from
> data, not yet confirmed · `rule` = a change the client asked for that overrides what's
> in the books.

## Conventions

### Group structure
- <how accounts are grouped; note anything non-standard>  — _status: <observed/confirmed>_

### Ledger naming
- Sales ledger(s): <exact name(s)>  — _<observed/confirmed>_
- Purchase ledger(s): <exact name(s)>  — _<observed/confirmed>_
- Bank / cash ledgers: <exact name(s)>  — _<observed/confirmed>_
- Round-off ledger: <exact name or "not used">  — _<observed/confirmed>_
- Common expense ledgers: <name → what it's for>  — _<observed/confirmed>_

### Party ledgers
- Naming pattern: <e.g. plain trade name / "<name> (Debtors)" suffix>  — _<observed/confirmed>_
- Default group for new customers: <exact group>  — _<observed/confirmed>_
- Default group for new suppliers: <exact group>  — _<observed/confirmed>_
- Default GST registration type for new parties: <Regular/Composition/Unregistered/Consumer/Unknown>  — _<observed/confirmed>_

### Tax ledgers (must match exactly — used by create-gst-voucher)
- CGST: <exact name>   ·  SGST: <exact name>   ·  IGST: <exact name>  — _<observed/confirmed>_
- Typical supply type: <mostly intra-state / mostly inter-state / mixed>  — _<observed/confirmed>_

### Voucher conventions
- Numbering: <automatic / manual + pattern>  — _<observed/confirmed>_
- Narration style: <describe or give a template>  — _<observed/confirmed>_
- Voucher types in regular use: <list>  — _<observed/confirmed>_

### Inventory (delete if service-only)
- Item naming pattern: <describe>  — _<observed/confirmed>_
- Default base unit(s): <exact unit names>  — _<observed/confirmed>_
- HSN handling: <where HSN lives — on item / on ledger>  — _<observed/confirmed>_
- GST rate handling: <on item / on ledger>  — _<observed/confirmed>_

## Standing approvals (consent memory)

Each line is an `allow-always` grant the user gave in a preview step. Scoped to an
action type for this client; delete a line to revoke it.

- <e.g. "auto-post Sales GST vouchers once mapped — allow-always, 2026-07-04"> 
- <e.g. "auto-create new customer ledgers under 'Sundry Debtors' — allow-always, 2026-07-04">

_(none yet)_

## Do-not / cautions

- <e.g. "Never post to 'Suspense A/c' — client reconciles that manually.">
- <e.g. "Two ledgers named 'ABC Traders' and 'ABC Traders ' (trailing space) exist — always use the first.">

_(none yet)_

## Feedback log / changelog

Dated, one line each — what changed and why. This is the audit trail of how the
client's conventions evolved.

- <YYYY-MM-DD> — <what was learned/changed> — <reason / who said so>
