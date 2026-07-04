---
name: tally-feeding
description: >-
  Understand a client's existing Tally Prime accounting conventions, confirm them
  with the client, then feed new data (ledgers, stock items, vouchers, GST invoices)
  into Tally consistently through the Tally Prime MCP server. Use this whenever the
  user wants to enter, post, feed, record, or book accounting data into Tally for a
  client — sales / purchase / payment / receipt / contra / journal vouchers, GST
  invoices, debit/credit notes, party or expense ledgers, stock items — or wants to
  review how a client's books are structured before entering anything. It keeps a
  per-client "instruction sheet" of that client's naming, grouping, GST and voucher
  conventions and updates it as the user gives feedback, so entries stay consistent
  across sessions. Trigger for phrases like "feed data for <client>", "enter these
  invoices in Tally", "post these vouchers", "do the books for <client>", "create a
  ledger / stock item", "book this purchase", or "record GST sales", even when the
  user does not name this skill.
---

# Tally Feeding — client-consistent data entry into Tally Prime

**Designed for Claude Opus / Sonnet.** This skill assumes a reasoning-capable model
that can match near-identical master names, infer posting patterns from examples, and
weigh a suggested correction against a client's stated preference. Lean on that
judgment — do **not** collapse this into rote steps.

## What "feeding" means and why it needs care

"Feeding" is bookkeeping data entry: creating masters (ledgers, stock items) and
posting vouchers into a client's **live** Tally company. Two things make or break it:

1. **Correctness** — new entries must match how *this* client's books are already
   kept. The same expense can be "Carriage Inward" in one company and "Freight &
   Cartage" in another; a voucher that points at a ledger name Tally doesn't have
   simply fails. So before feeding, you learn the client's conventions rather than
   assuming your own.
2. **Consent** — every write lands in real accounts that feed GST returns and
   financials. Nothing gets written without the user seeing exactly what will be
   posted and approving it.

The **per-client instruction sheet** is what carries the client's confirmed
conventions and standing approvals from one session to the next, so you don't
re-interrogate the books (or the user) every time.

## The per-client instruction sheet (the memory)

- **Where it lives:** `clients/<company-slug>.md`, next to this skill. The slug is the
  company name lowercased, spaces → hyphens, punctuation dropped
  (e.g. `Ross Industries Pvt Ltd` → `ross-industries-pvt-ltd`). If the user has told
  you a different location for client sheets, use that instead.
- **Start of every feeding session:** locate and read this file.
  - **Missing** → this is a first-time client. Run **Discovery** (Phase 2), then
    create the sheet from `assets/client-instruction-sheet.template.md`.
  - **Present** → load the confirmed conventions and standing approvals and use them.
    Do a quick sanity re-check if the books may have changed since (new ledgers, new
    financial year).
- **It is the source of truth** for this client's conventions and consent grants.
  Keep client specifics **in the sheet, never in SKILL.md** — that is what lets this
  skill stay generic and be handed to other users unchanged (see Distribution note).

## Workflow

Feeding runs in phases. Skip ahead when the sheet already answers a phase, but never
skip the preview-and-consent step in Phase 4.

### Phase 0 — Select the right client company

Writes hit the active (or explicitly named) company, so getting this wrong corrupts
the wrong books. Confirm the exact company first:

- `list-loaded-companies` to see what's active. If the client isn't loaded, find it
  with `list-companies` / `list-available-companies`, then `open-company` or
  `load-company`, and `set-active-company`.
- Once you know the exact name, **pass `targetCompany` explicitly on every read and
  write** for the rest of the session. Don't rely on the default staying put.

### Phase 1 — Load or start the client's instruction sheet

Read `clients/<company-slug>.md` (per above). Note which conventions are already
"client-confirmed" and which standing approvals exist, so you neither re-ask settled
questions nor silently act on unsettled ones.

### Phase 2 — Discover how the existing data is structured

This is the "read the Tally way of feeding" step, and it is **read-only** — safe to run
freely. Build a concrete picture of the client's conventions using the pull tools
(exact tool list and params in `references/tally-tools.md`):

- **Group tree:** `chart-of-accounts` and `list-master collection=group` — how accounts
  are organised.
- **Ledgers:** `list-master collection=ledger` — capture exact ledger names, their
  parent groups, and GST registration types. Pay special attention to: party-ledger
  naming (any suffix/prefix pattern), expense/income ledger names, bank & cash names,
  and the **exact spelling and case of the tax ledgers** (CGST / SGST / IGST) — these
  feed GST vouchers and must match character-for-character.
- **Inventory (only if used):** `list-master collection=stockitem` plus `stockgroup`
  and `unit` — item naming, base units, HSN codes, GST rates.
- **Voucher types & numbering:** `list-master collection=vouchertype` — custom types
  and whether numbering is automatic or manual.
- **GST setup:** `list-master collection=gstin` and `gstclassification` — the
  registration(s) and HSN/SAC classifications in use.
- **Posting patterns:** sample recent transactions to see how entries are actually
  made — `gst-voucher-details` for a recent month, `ledger-account` for a busy
  sales/purchase ledger, or `query-database` over the cached tables. Infer which
  ledgers pair for sales vs purchase, whether supplies are usually intra- or
  inter-state, the narration style, the numbering scheme, and whether a round-off
  ledger is used.

Summarise into a draft conventions profile using **exact names**, not paraphrases —
"Sales @ 18%", not "the eighteen-percent sales account".

### Phase 3 — Confirm, or change, the conventions with the client

The client is the authority on their own books. Present the draft profile back
compactly and ask the deciding question:

> "Here's how your books are currently kept and how I'd feed new data to match.
> Keep it as-is, or tell me what to change?"

- **Confirmed as-is** → mark each convention `confirmed (client-verified) YYYY-MM-DD`
  in the sheet and accept the existing format and nature. Do **not** propose
  restructuring the client has not asked for.
- **Changes requested, or real problems found** → if discovery surfaced genuine risks
  (duplicate ledgers, an expense filed under the wrong group, inconsistent party
  naming), raise them briefly *with the reason*, and let the user decide. Record each
  agreed decision as a rule you will follow going forward — this is the "learn those
  changes for yourself" part. Example entry:
  `New freight costs → "Freight & Cartage" (not "Carriage Inward") — per client, 2026-07-04.`

Either way, the resolution goes into the sheet so the next session starts from
settled ground.

### Phase 4 — Feed new data (preview → consent → write)

Writes happen here. **Create masters before vouchers** — a voucher that references a
ledger or stock item that doesn't yet exist will fail.

1. **Map** the incoming data onto the confirmed conventions. Resolve every ledger /
   stock / tax name to an **exact existing master** (validate against
   `list-master`). If a required master is missing, that becomes a `create-ledger` /
   `create-stock-item` step — flag it clearly, because creating a master is a larger
   commitment than posting one voucher.
2. **Build a preview batch** — a compact table of exactly what will be written. For
   each row show the tool, the target company, and every field value: for a GST
   invoice — voucher type, date, party ledger, sales/purchase ledger, taxable value,
   GST rate, inter-state flag, the resolved CGST/SGST/IGST ledgers, narration, number;
   for a plain voucher — type, date, debit ledger, credit ledger, amount; for a master
   — name, parent group (and unit/HSN/rate for stock).
3. **Ask for consent**, offering granular choices (and honour any standing approval
   already recorded for this action type — if it's `allow-always`, skip the prompt but
   still show what was posted):
   - **Allow once** — write just this batch.
   - **Allow always** — for *this action type, this client*: stop asking for the rest
     of the session and record a standing approval in the sheet, e.g.
     `auto-post Sales GST vouchers once mapped — allow-always, 2026-07-04`. Tell the
     user this is scoped and reversible — it's one line in their sheet they can delete
     to revoke.
   - **Edit** — adjust a mapping before writing.
   - **Skip** — don't write.
4. **Write** using the right tool (full params in `references/tally-tools.md`):
   - `create-gst-voucher` for GST Sales / Purchase / Debit Note / Credit Note — it
     splits CGST+SGST vs IGST from the `isInterState` flag and auto-resolves tax
     ledgers.
   - `create-voucher` for non-GST double entry — Payment, Receipt, Contra, Journal.
   - `create-ledger` / `create-stock-item` for masters.
   - Always pass `targetCompany`.
5. **Capture results** — voucher numbers and any errors. On an error, **stop the batch
   and report it**; do not blindly retry a write (a silent retry can double-post, which
   is painful to unwind).

> If the server runs with `READONLY_MODE=true`, the write tools are disabled. Detect
> the failure and fall back to handing the user the exact plan (and, if useful, the
> voucher XML) for manual entry.

### Phase 5 — Verify what you fed

Reconcile so silent mistakes surface while they're still cheap to fix:
`ledger-account` / `ledger-balance` for the affected ledgers, `trial-balance` for the
period, or `gst-voucher-details` to confirm GST postings. Compare against what you
intended and report the difference plainly.

### Phase 6 — Record feedback into the sheet

Whenever the user corrects anything — a mapping, a name, a grouping, or a preference
like "always phrase the narration this way" — write it back into the instruction sheet
**immediately**, dated, with a one-line reason, under the relevant convention plus a
short changelog line. Also log new standing approvals or revocations. Update the
convention **in place** rather than letting contradictions accumulate. This closing
loop is what makes the skill get better with use.

## Correctness & safety principles

- **Right company, every write.** Confirm it, then pass `targetCompany` explicitly.
- **Masters before vouchers**, and resolve every name to an exact existing master.
- **Preview before every write.** Honour `allow-once` / `allow-always` from the sheet;
  never invent a grant the user didn't give.
- **Never fabricate** GSTINs, HSN/SAC codes, or tax rates — read them from masters or
  ask. Wrong GST data flows straight into returns.
- **Dates in `YYYY-MM-DD`; amounts > 0; debit/credit direction correct.**
- **On any tool error, stop and report** — don't retry writes blindly.

## Distribution note

`SKILL.md`, `references/`, and `assets/` are generic and safe to share — this is the
seed skill other users install as-is. The `clients/` folder holds real client
conventions and consent grants and is **private**: it's git-ignored, and the skill
ships with `clients/` empty apart from `.gitkeep`. When handing this skill to another
user, they start with no client sheets and build their own through Phases 2–3.
