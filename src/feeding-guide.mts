// Guidance for entering data into a client's books, served to ANY MCP client.
//
// The same method ships as a Claude plugin skill (plugin/skills/tally-feeding/SKILL.md). A plugin
// only reaches Claude, so other clients got the tools without the method: learn the client's
// conventions first, preview, ask for consent, verify. This module carries that method in the
// server itself, three ways, because clients differ in what they support:
//   - MCP prompts (`feed-tally-data`, `profile-client-books`) for clients that show prompts to the
//     user as commands;
//   - a read-only tool (`feeding-guide`) for clients that do not support prompts, and so the model
//     can fetch the method itself when the user just says "post these invoices";
//   - one line in the server instructions pointing at that tool.
//
// The text is model-neutral on purpose, and differs from the skill in one substantive way: the
// skill assumes a working folder for the per-client instruction sheet, while a client here may
// have no file access at all, so the guide gives a fallback order for where the sheet lives.
// When the method changes, change both this file and SKILL.md.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const FEEDING_GUIDE = `# Feeding data into Tally Prime: client-consistent data entry

This is the working method for entering accounting data into a client's Tally company through
this server's tools. It asks for judgment: matching near-identical master names, inferring how a
firm posts from examples, and weighing a suggested correction against what the client prefers.
Do not reduce it to rote steps.

## What "feeding" means and why it needs care

"Feeding" is bookkeeping data entry: creating masters (ledgers, stock items) and posting vouchers
into a client's **live** Tally company. Two things make or break it:

1. **Correctness.** New entries must match how *this* client's books are already kept. The same
   expense can be "Carriage Inward" in one company and "Freight & Cartage" in another, and a
   voucher that points at a ledger name Tally doesn't have simply fails. So before feeding, learn
   the client's conventions; do not assume your own.
2. **Consent.** Every write lands in real accounts that feed GST returns and financials. Nothing
   gets written without the user seeing exactly what will be posted and approving it.

The **per-client instruction sheet** carries the client's confirmed conventions and standing
approvals from one session to the next, so you don't re-interrogate the books (or the user) every
time.

## The per-client instruction sheet (the memory)

- **Where it lives:** wherever you can keep a document across sessions, in this order of preference:
  1. a file in the user's working folder, if you can read and write files there. Use
     \`tally-clients/<company-slug>.md\`, where the slug is the company name lowercased, spaces to
     hyphens, punctuation dropped (\`Ross Industries Pvt Ltd\` becomes \`ross-industries-pvt-ltd\`).
     If the user has told you a different location, use that.
  2. your own persistent memory, notes or project-knowledge feature, if you have one.
  3. if you have neither, give the user the full sheet at the end of the session and ask them to
     keep it and paste it back at the start of the next one. Say this plainly; do not pretend you
     will remember.
- **Start of every feeding session:** find and read the sheet for this company.
  - **Missing:** this is a first-time client. Run Discovery (Phase 2), then create the sheet from
    the template at the end of this guide.
  - **Present:** load the confirmed conventions and standing approvals and use them. Do a quick
    sanity re-check if the books may have changed since (new ledgers, a new financial year).
- **It is the source of truth** for this client's conventions and consent grants. It is private
  to the client: do not share one client's sheet with another.

## Workflow

Feeding runs in phases. Skip ahead when the sheet already answers a phase, but never skip the
preview-and-consent step in Phase 4.

### Phase 0: select the right client company

Writes hit the active (or explicitly named) company, so getting this wrong corrupts the wrong
books. Confirm the exact company first:

- Call \`status\`, then \`list-loaded-companies\` to see what is active. If the client isn't loaded,
  find it with \`list-companies\` / \`list-available-companies\`, then \`open-company\` or
  \`load-company\`, and \`set-active-company\`.
- Once you know the exact name, **pass \`targetCompany\` explicitly on every read and write** for
  the rest of the session. Don't rely on the default staying put.

### Phase 1: load or start the client's instruction sheet

Read the sheet (see above). Note which conventions are already client-confirmed and which
standing approvals exist, so you neither re-ask settled questions nor silently act on unsettled
ones.

### Phase 2: discover how the existing data is structured

This step is **read-only** and safe to run freely. Build a concrete picture of the client's
conventions with the read tools (each tool's description gives its exact parameters):

- **Group tree:** \`chart-of-accounts\` and \`list-master\` with collection \`group\`.
- **Ledgers:** \`list-master\` with collection \`ledger\`. Capture exact ledger names, their parent
  groups and GST registration types. Pay special attention to party-ledger naming (any
  suffix or prefix pattern), expense and income ledger names, bank and cash names, and the
  **exact spelling and case of the tax ledgers** (CGST / SGST / IGST). These feed GST vouchers
  and must match character for character.
- **Inventory (only if used):** \`list-master\` with collection \`stockitem\`, plus \`stockgroup\` and
  \`unit\`: item naming, base units, HSN codes, GST rates.
- **Voucher types and numbering:** \`list-master\` with collection \`vouchertype\`: custom types, and
  whether numbering is automatic or manual.
- **GST setup:** \`list-master\` with collection \`gstin\` and \`gstclassification\`.
- **Posting patterns, recorded as the Entry Format Profile (required for a fresh client; do not
  skip):** the master list tells you *what* exists; only real vouchers tell you *how this firm
  posts*, and that is what makes new entries match. Sample recent real vouchers and derive the
  profile with evidence: \`ledger-account\` for a busy money ledger (bank or cash) and for a
  representative income or expense ledger, \`gst-voucher-details\` for a recent month (GST
  clients), sliced with \`query-database\` / \`search-master\` over the cached tables. For **each
  voucher type in use**, capture the numbering scheme (auto or manual, and whether it differs by
  type, such as receipts numbered and payments blank), the narration house style (give concrete
  templates, matching case), which ledgers pair (for example receipts and payments hit the party
  ledger; interest booked by a year-end journal), and whether round-off, bill-wise references and
  GST are used. Note the sample size and period.

Summarise into a draft conventions profile using **exact names**, not paraphrases: "Sales @ 18%",
not "the eighteen-percent sales account".

### Phase 3: confirm, or change, the conventions with the client

The client is the authority on their own books. Present the draft profile back compactly and ask
the deciding question:

> "Here's how your books are currently kept and how I'd feed new data to match. Keep it as-is, or
> tell me what to change?"

- **Confirmed as-is:** mark each convention \`confirmed (client-verified) YYYY-MM-DD\` in the sheet
  and accept the existing format. Do **not** propose restructuring the client has not asked for.
- **Changes requested, or real problems found:** if discovery surfaced genuine risks (duplicate
  ledgers, an expense filed under the wrong group, inconsistent party naming), raise them briefly
  *with the reason* and let the user decide. Record each agreed decision as a rule you will
  follow from then on. Example entry:
  \`New freight costs go to "Freight & Cartage" (not "Carriage Inward"), per client, 2026-07-04.\`

Either way, the resolution goes into the sheet so the next session starts from settled ground.

### Phase 4: feed new data (preview, consent, write)

Writes happen here. **Create masters before vouchers**: a voucher that references a ledger or
stock item that doesn't yet exist will fail.

1. **Map** the incoming data onto the confirmed conventions **and the Entry Format Profile**.
   Resolve every ledger, stock and tax name to an **exact existing master** (validate against
   \`list-master\` / \`search-master\`). Conform each entry to the firm's profile: correct voucher
   type, debit and credit direction, per-type numbering, narration in the firm's house style and
   the usual ledger pairing. **Flag anything that deviates** from the profile before posting. If
   a required master is missing, that becomes a \`create-ledger\` / \`create-stock-item\` step. Flag
   it clearly, because creating a master is a larger commitment than posting one voucher.
2. **Build a preview batch:** a compact table of exactly what will be written. For each row show
   the tool, the target company and every field value. For a GST invoice: voucher type, date,
   party ledger, sales or purchase ledger, taxable value, GST rate, inter-state flag, the
   resolved CGST/SGST/IGST ledgers, narration, number. For a plain voucher: type, date, debit
   ledger, credit ledger, amount. For a master: name, parent group (and unit, HSN and rate for
   stock).
3. **Ask for consent**, offering these choices. Honour any standing approval already recorded for
   this action type: if it is \`allow-always\`, skip the question but still show what was posted.
   - **Allow once:** write just this batch.
   - **Allow always:** for *this action type, this client*: stop asking for the rest of the
     session and record a standing approval in the sheet, such as
     \`auto-post Sales GST vouchers once mapped: allow-always, 2026-07-04\`. Tell the user this is
     scoped and reversible: it is one line in their sheet that they can delete to revoke.
   - **Edit:** adjust a mapping before writing.
   - **Skip:** don't write.
4. **Write** with the right tool:
   - \`create-gst-voucher\` for GST Sales, Purchase, Debit Note and Credit Note. It splits
     CGST+SGST versus IGST from the inter-state flag and resolves the tax ledgers.
   - \`create-voucher\` for non-GST double entry: Payment, Receipt, Contra, Journal.
   - \`create-ledger\` / \`create-stock-item\` for masters.
   - Always pass \`targetCompany\`.
   - If a write result carries an entry-order note, relay it to the user.
5. **Capture results:** voucher numbers and any errors. On an error, **stop the batch and report
   it**. Do not blindly retry a write: a silent retry can double-post, which is painful to
   unwind.

> If the server is in read-only mode (\`status\` reports it), the write tools are refused. Hand the
> user the exact plan for manual entry instead.

### Phase 5: verify what you fed

Reconcile so silent mistakes surface while they are still cheap to fix: \`ledger-account\` /
\`ledger-balance\` for the affected ledgers, \`trial-balance\` for the period, or
\`gst-voucher-details\` to confirm GST postings. Compare against what you intended and report any
difference plainly.

### Phase 6: record feedback into the sheet

Whenever the user corrects anything (a mapping, a name, a grouping, or a preference such as
"always phrase the narration this way"), write it back into the instruction sheet
**immediately**, dated, with a one-line reason, under the relevant convention plus a short
changelog line. Also log new standing approvals or revocations. Update the convention **in
place** so contradictions do not accumulate.

## Correctness and safety principles

- **Right company, every write.** Confirm it, then pass \`targetCompany\` explicitly.
- **Masters before vouchers**, and resolve every name to an exact existing master.
- **Preview before every write.** Honour \`allow-once\` / \`allow-always\` from the sheet; never
  invent a grant the user didn't give.
- **Never fabricate** GSTINs, HSN/SAC codes or tax rates. Read them from masters or ask. Wrong
  GST data flows straight into returns.
- **Dates in \`YYYY-MM-DD\`; amounts greater than zero; debit and credit direction correct.**
- **On any tool error, stop and report.** Don't retry writes blindly.
- **Never enter data through the Tally window.** Keystrokes are for login and company selection
  only; all masters and vouchers go through the write tools.`;

export const INSTRUCTION_SHEET_TEMPLATE = `Replace every <angle-bracket> placeholder. Delete rows and sections that don't apply (for example the Inventory section for a service client). Keep entries in EXACT Tally names, character for character, because these values are used directly in tool calls.

# Instruction sheet — <Company Name>

- **Company (exact Tally name):** <Company Name as shown in Tally>
- **Slug (filename):** <company-slug>
- **GSTIN(s):** <GSTIN or "none">
- **Financial year in use:** <e.g. 2025-26>
- **Tally edition:** <Silver / Gold / unknown>
- **First profiled:** <YYYY-MM-DD>  ·  **Last updated:** <YYYY-MM-DD>
- **Overall confirmation:** <not yet confirmed / confirmed as-is / confirmed with changes> on <YYYY-MM-DD>

> Status legend used below: \`confirmed\` = client-verified · \`observed\` = inferred from
> data, not yet confirmed · \`rule\` = a change the client asked for that overrides what's
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

### Entry Format Profile (how this firm actually posts — sample from real vouchers)
Fill one row per voucher type in regular use, based on sampled vouchers.

| Voucher type | Numbering | Typical Dr / Cr pairing | Narration template (match case) |
|---|---|---|---|
| <e.g. Receipt> | <e.g. sequential, auto> | <Dr Bank / Cr party> | <e.g. "CH NO. <no> <BANK, BRANCH>" / "NEFT"> |
| <e.g. Payment> | <e.g. blank / auto> | <Dr expense-or-party / Cr Bank> | <e.g. "<PURPOSE> FOR <PERIOD>"> |
| <e.g. Journal> | <e.g. none> | <Dr … / Cr …> | <e.g. "BEING INTEREST … @X% AFTER TDS @Y%."> |

- Sampled from: <e.g. 244 bank vouchers, 2023-04 → 2026-10>  — _<observed/confirmed>_
- Round-off: <ledger name / not used>  ·  Bill-wise refs: <used / not used>  ·  GST on invoices: <yes / no>  — _<observed/confirmed>_
- House-style notes: <e.g. narration UPPERCASE, terse, reference-first>  — _<observed/confirmed>_

### Inventory (delete if service-only)
- Item naming pattern: <describe>  — _<observed/confirmed>_
- Default base unit(s): <exact unit names>  — _<observed/confirmed>_
- HSN handling: <where HSN lives — on item / on ledger>  — _<observed/confirmed>_
- GST rate handling: <on item / on ledger>  — _<observed/confirmed>_

## Standing approvals (consent memory)

Each line is an \`allow-always\` grant the user gave in a preview step. Scoped to an
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

- <YYYY-MM-DD> — <what was learned/changed> — <reason / who said so>`;

/** The guide followed by the sheet template: everything a session needs, in one text. */
export function feedingGuideText(): string {
  return `${FEEDING_GUIDE}\n\n## Instruction sheet template\n\n${INSTRUCTION_SHEET_TEMPLATE}\n`;
}

/** Prompt arguments arrive as free text from a person; keep them to one bounded line. */
function oneLine(value: string | undefined, max: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function feedPromptText(args: { company?: string; data?: string }): string {
  const company = oneLine(args.company, 200);
  const data = (args.data ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, 20000);
  const task = [
    '# Your task',
    '',
    company
      ? `Feed data into Tally for the company "${company}". Confirm that exact company in Phase 0 before anything else.`
      : 'Feed data into Tally. Ask which client company this is for, then confirm it in Phase 0 before anything else.',
    data ? `\nWhat to enter:\n\n${data}` : '\nAsk the user what they want entered if they have not said.',
    '',
    'Follow the guide above from Phase 0. Do not write anything to Tally before the preview and consent step in Phase 4.',
  ].join('\n');
  return `${feedingGuideText()}\n${task}\n`;
}

export function profilePromptText(args: { company?: string }): string {
  const company = oneLine(args.company, 200);
  const task = [
    '# Your task',
    '',
    company
      ? `Profile how the books of "${company}" are kept.`
      : 'Profile how a client\'s books are kept. Ask which client company first.',
    'Do Phases 0 to 3 of the guide above only: select the company, look for an existing instruction sheet, discover the conventions (including the Entry Format Profile from real vouchers), and confirm them with the user.',
    'This is read-only. Do not create masters or post vouchers.',
    'Finish by producing the filled instruction sheet from the template, and save it where the guide says.',
  ].join('\n');
  return `${feedingGuideText()}\n${task}\n`;
}

export const FEEDING_INSTRUCTIONS_LINE =
  'Entering data for a client (ledgers, stock items, vouchers, GST invoices): call `feeding-guide` once per session BEFORE the first write and follow it. '
  + 'It covers learning the client\'s existing conventions, the per-client instruction sheet, previewing every write and asking for consent. '
  + 'Clients that support MCP prompts also offer it as the `feed-tally-data` and `profile-client-books` prompts.';

/** `audit` records a call in the server's audit log, like every other tool; mcp.mts supplies it. */
export function registerFeedingGuide(server: McpServer, audit: (toolName: string, durationMs: number) => void = () => {}): void {
  server.registerPrompt(
    'feed-tally-data',
    {
      title: 'Feed data into Tally',
      description: 'Enter ledgers, stock items, vouchers or GST invoices into a client\'s Tally company the way that client\'s books are already kept: learn the conventions, preview every write, ask for consent, verify.',
      argsSchema: {
        company: z.string().optional().describe('The client company, as named in Tally (optional; you will be asked if omitted)'),
        data: z.string().optional().describe('What to enter: paste the invoices, payments or other entries, or describe them (optional)'),
      },
    },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: feedPromptText(args) } }] })
  );

  server.registerPrompt(
    'profile-client-books',
    {
      title: 'Profile a client\'s books',
      description: 'Read-only. Study how a client\'s Tally company is kept (groups, ledger and party naming, tax ledgers, numbering, narration style) and produce the per-client instruction sheet used for consistent data entry.',
      argsSchema: {
        company: z.string().optional().describe('The client company, as named in Tally (optional; you will be asked if omitted)'),
      },
    },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: profilePromptText(args) } }] })
  );

  server.registerTool(
    'feeding-guide',
    {
      title: 'Data entry guide',
      description: 'Returns the working method for entering data into a client\'s Tally company, plus the per-client instruction sheet template. Read-only; contacts nothing. Call it once per session before creating ledgers, stock items or vouchers for a client, and follow it: it covers learning the client\'s existing conventions, previewing every write, asking for consent, and verifying afterwards.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const start = Date.now();
      const text = feedingGuideText();
      audit('feeding-guide', Date.now() - start);
      return { content: [{ type: 'text', text }] };
    }
  );
}
