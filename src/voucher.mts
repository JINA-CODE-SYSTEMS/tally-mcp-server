// Full-fidelity voucher XML builder (#94, H-8). Pure + unit-testable: takes an already-resolved
// voucher (the SESSION does fuzzy matching / NL parsing / defaults; the HOST just posts exact inputs)
// and produces a Tally Import envelope. The flat push/ template+config system can only express a
// fixed two-line voucher, so the multi-line + optional-block executor lives here instead.
//
// Sign convention (matches push/voucher.xml): a debit line is ISDEEMEDPOSITIVE=Yes with a NEGATIVE
// AMOUNT; a credit line is ISDEEMEDPOSITIVE=No with a POSITIVE AMOUNT.

export type BillAllocation = { name: string; billType?: 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account'; amount: number };
export type CostAllocation = { category: string; centre: string; amount: number };
export type VoucherEntry = {
  ledger: string;
  drCr: 'dr' | 'cr';
  amount: number;                 // always positive; sign is derived from drCr
  billwise?: BillAllocation[];
  costCentres?: CostAllocation[];
};
export type InventoryLine = {
  stockItem: string;
  quantity: number;
  rate?: number;
  amount?: number;                // defaults to quantity*rate when omitted
  unit?: string;
  godown?: string;
  batch?: string;
  accountingLedger?: string;      // sales/purchase ledger this stock value posts to (ACCOUNTINGALLOCATIONS)
};
export type GstBlock = { placeOfSupply?: string; isReverseCharge?: boolean; registrationType?: string };
export type VoucherInput = {
  voucherType: string;
  date: string;                   // YYYY-MM-DD
  entries: VoucherEntry[];
  narration?: string;
  voucherNumber?: string;
  reference?: string;
  partyLedger?: string;           // for GST/invoice vouchers (PARTYLEDGERNAME)
  inventory?: InventoryLine[];
  gst?: GstBlock;
  remoteId?: string;              // durable external key (REMOTEID) — see deriveRemoteId
};

// Deterministic REMOTEID for a voucher we author. Tally's REMOTEID is a durable external key: a voucher
// imported WITH one can later be altered/deleted by re-sending that same REMOTEID (it is how Tally sync
// round-trips). We derive it from the business reference so the key is reproducible from the SAME inputs
// — no lookup needed — which makes two things work at once:
//   • idempotency/dedup: re-feeding the same reference re-keys the SAME voucher (Tally alters, not dupes)
//   • deletion: buildDeleteVoucherXml can match by this REMOTEID without first exporting the voucher
// A voucher with no reference gets no derived id (returns undefined) — Tally then auto-assigns identity
// and the voucher is only deletable via the GUI path, exactly like a hand-keyed one. The namespace
// prefix keeps our keys from colliding with Tally's own GUID-shaped remote ids.
export function deriveRemoteId(voucherType: string, reference?: string): string | undefined {
  const slug = (s: string) => String(s ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const r = slug(reference || '');
  if (!r) return undefined;
  const t = slug(voucherType) || 'Vch';
  return `TMCP-${t}-${r}`;
}

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters MUST leave as numeric character references, not literally. XML line-ending
    // normalization rewrites a literal CR (and CRLF) to a bare LF in parsed content — so a master name
    // genuinely containing CR would reach Tally altered and miss its exact-match lookup, sending the
    // posting to suspense. This is why Tally itself exports such names as "...LIMITED&#13;&#10;". LF and
    // TAB decode back identically either way and are escaped too, so a name round-trips byte-for-byte.
    // Must run AFTER the &-escape above, or the ampersands introduced here would be double-escaped.
    .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

// Inverse of escapeXml: decode the predefined + numeric XML entities back to literal characters.
// We CANONICALIZE every master name (ledger / stock item / party / voucher type / company) to this
// literal form so that (a) escaping is applied exactly once at XML-build time — a name arriving as
// "LEGAL &amp; PROFESSIONAL FEES" is not double-escaped into "&amp;amp;" (which Tally stores/looks up
// literally, so the ledger becomes unreferenceable), and (b) the master-exists check matches on one
// normalized form regardless of whether the caller passed "A & B" or "A &amp; B". `&amp;` is decoded
// LAST so "&amp;lt;" round-trips to the literal "&lt;" rather than collapsing to "<".
export function decodeXmlEntities(s: string): string {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// XML-encode a MASTER NAME safely: decode any entities the caller already applied, then escape exactly
// once. Idempotent w.r.t. caller escaping — xmlName("A & B") === xmlName("A &amp; B") === "A &amp; B".
export function xmlName(s: string): string {
  return escapeXml(decodeXmlEntities(s));
}

// Canonical comparison key for a master name: entity-decoded, trimmed, case-folded. So the
// master-exists check is insensitive to XML-escaping and to how Tally happened to encode the name it
// reported back.
export function masterKey(s: string): string {
  return decodeXmlEntities(String(s ?? '')).trim().toLowerCase();
}

// YYYY-MM-DD → YYYYMMDD (Tally's date format). Returns '' if not a valid ISO date.
export function toTallyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

// Deterministic balance fact (#94/#95): total debits vs total credits, rounded to 2dp to absorb
// floating-point noise. balanced === true only when they are equal.
export function voucherBalance(entries: VoucherEntry[]): { debit: number; credit: number; balanced: boolean } {
  const round = (n: number) => Math.round(n * 100) / 100;
  let debit = 0, credit = 0;
  for (const e of entries) {
    if (e.drCr === 'dr') debit += e.amount;
    else credit += e.amount;
  }
  debit = round(debit); credit = round(credit);
  return { debit, credit, balanced: debit === credit };
}

// Deterministic period-window check (#95 H-9 → OUT_OF_PERIOD). The lower bound is booksFrom (the
// real earliest valid date) when known, else fyFrom. Returns true (don't block) when the period is
// unknown. ISO YYYY-MM-DD compares correctly as strings.
export function isDateInOpenPeriod(
  dateIso: string,
  period: { fyFrom: string | null; fyTo: string | null; booksFrom?: string | null }
): boolean {
  const lower = period.booksFrom || period.fyFrom;
  const upper = period.fyTo;
  if (!lower && !upper) return true;
  if (lower && dateIso < lower) return false;
  if (upper && dateIso > upper) return false;
  return true;
}

// Deterministic exact-name master existence (#95 H-9 → MASTER_NOT_FOUND). Case-insensitive exact
// match — NO fuzzy matching (that's session-side). Returns the referenced names missing from `known`.
// An empty `known` list means "unknown" → returns [] (don't block on an unavailable master list).
export function findMissingMasters(referenced: string[], known: string[]): string[] {
  if (!known.length) return [];
  // Compare on the entity-decoded, case-folded key so "LEGAL & PROFESSIONAL FEES" and
  // "LEGAL &amp; PROFESSIONAL FEES" (either side) are treated as the same master (P0-1).
  const set = new Set(known.map(masterKey));
  const missing: string[] = [];
  for (const r of referenced) {
    const n = masterKey(r);
    if (n && !set.has(n) && !missing.includes(r)) missing.push(r);
  }
  return missing;
}

// Collects the ledger names a voucher references (entries + inventory accounting ledgers + party).
export function referencedLedgers(v: VoucherInput): string[] {
  const names = v.entries.map(e => e.ledger);
  if (v.partyLedger) names.push(v.partyLedger);
  for (const inv of v.inventory || []) if (inv.accountingLedger) names.push(inv.accountingLedger);
  return names;
}

// Maps a caller-supplied master name onto the EXACT name Tally stores, when the two differ only by the
// normalization masterKey() already tolerates: XML-entity form, case, and EDGE whitespace.
//
// This is load-bearing, not cosmetic. Tally's importer matches a master by exact string equality, so a
// name that is right to the eye but two characters short is rejected and the posting silently lands in
// suspense. Real books carry such names: a ledger created by pasting from a spreadsheet keeps the
// pasted line break, so Tally stores "BHARTI AIRTEL LIMITED\r\n" and exports it as
// "BHARTI AIRTEL LIMITED&#13;&#10;". Every read surface shows the trimmed form — that is what a caller
// reads back and types — findMissingMasters then ACCEPTS it (it compares on the edge-trimmed key) and
// the import is rejected anyway. Rewriting to the stored bytes here is what closes that gap; the
// existence check alone cannot, because passing its check is exactly the failure mode.
//
// INTERNAL whitespace is never touched. "MATRIX  SEAFOODS INDIA LIMITED" and "S D  Fine-Chem Limited"
// are real, distinct ledgers whose double spaces are part of the name — collapsing them would break
// masters that currently work in order to fix ones that don't.
//
// Ambiguity is reported, never guessed: when two stored masters share a key (one with and one without a
// trailing newline, say) there is no safe pick, so the caller disambiguates rather than have a posting
// land on whichever happened to come first. A caller who passed one of them byte-exact is not
// ambiguous — they already said which.
export type MasterResolution = {
  resolved: Map<string, string>;
  ambiguous: Array<{ name: string; candidates: string[] }>;
};

export function resolveMasterNames(referenced: string[], known: string[]): MasterResolution {
  const byKey = new Map<string, string[]>();
  for (const k of known) {
    const key = masterKey(k);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) { if (!list.includes(k)) list.push(k); }
    else byKey.set(key, [k]);
  }
  const resolved = new Map<string, string>();
  const ambiguous: Array<{ name: string; candidates: string[] }> = [];
  for (const r of referenced) {
    const key = masterKey(r);
    if (!key) continue;
    const cands = byKey.get(key);
    if (!cands?.length) continue;          // unknown master → left alone; findMissingMasters reports it
    const exact = cands.find(c => c === r);
    if (exact !== undefined) { resolved.set(r, exact); continue; }
    if (cands.length > 1) {
      if (!ambiguous.some(a => a.name === r)) ambiguous.push({ name: r, candidates: [...cands] });
      continue;
    }
    resolved.set(r, cands[0]!);
  }
  return { resolved, ambiguous };
}

// Rewrites every master name a voucher references to its exact stored spelling, returning the ambiguous
// ones so the caller can refuse the write instead of posting to a guessed master. An empty `known` list
// means "unknown" and leaves that class of name untouched, matching findMissingMasters' tolerance.
export function canonicalizeVoucherMasters(
  v: VoucherInput,
  knownLedgers: string[] = [],
  knownStockItems: string[] = [],
  knownVoucherTypes: string[] = []
): { voucher: VoucherInput; ambiguous: Array<{ name: string; candidates: string[] }> } {
  const ambiguous: Array<{ name: string; candidates: string[] }> = [];
  let out: VoucherInput = v;
  if (knownLedgers.length) {
    const { resolved, ambiguous: amb } = resolveMasterNames(referencedLedgers(out), knownLedgers);
    ambiguous.push(...amb);
    const fix = (n: string) => resolved.get(n) ?? n;
    out = {
      ...out,
      entries: out.entries.map(e => ({ ...e, ledger: fix(e.ledger) })),
      ...(out.partyLedger !== undefined ? { partyLedger: fix(out.partyLedger) } : {}),
      ...(out.inventory ? {
        inventory: out.inventory.map(i =>
          i.accountingLedger !== undefined ? { ...i, accountingLedger: fix(i.accountingLedger) } : i),
      } : {}),
    };
  }
  if (knownStockItems.length && out.inventory?.length) {
    const { resolved, ambiguous: amb } = resolveMasterNames(out.inventory.map(i => i.stockItem), knownStockItems);
    ambiguous.push(...amb);
    out = { ...out, inventory: out.inventory.map(i => ({ ...i, stockItem: resolved.get(i.stockItem) ?? i.stockItem })) };
  }
  if (knownVoucherTypes.length) {
    const { resolved, ambiguous: amb } = resolveMasterNames([out.voucherType], knownVoucherTypes);
    ambiguous.push(...amb);
    const t = resolved.get(out.voucherType);
    if (t !== undefined) out = { ...out, voucherType: t };
  }
  return { voucher: out, ambiguous };
}

function signedAmount(entry: VoucherEntry): string {
  // debit → negative, credit → positive (Tally convention, see push/voucher.xml)
  return entry.drCr === 'dr' ? `-${entry.amount}` : `${entry.amount}`;
}

function billwiseXml(entry: VoucherEntry): string {
  if (!entry.billwise?.length) return '';
  const sign = entry.drCr === 'dr' ? -1 : 1;
  return entry.billwise.map(b =>
    `<BILLALLOCATIONS.LIST>` +
    `<NAME>${escapeXml(b.name)}</NAME>` +
    `<BILLTYPE>${escapeXml(b.billType || 'New Ref')}</BILLTYPE>` +
    `<AMOUNT>${sign < 0 ? '-' : ''}${b.amount}</AMOUNT>` +
    `</BILLALLOCATIONS.LIST>`
  ).join('');
}

function costCentreXml(entry: VoucherEntry): string {
  if (!entry.costCentres?.length) return '';
  const sign = entry.drCr === 'dr' ? -1 : 1;
  // group allocations by category
  const byCat = new Map<string, CostAllocation[]>();
  for (const c of entry.costCentres) {
    const list = byCat.get(c.category) || [];
    list.push(c); byCat.set(c.category, list);
  }
  let xml = '';
  for (const [category, allocs] of byCat) {
    xml += `<CATEGORYALLOCATIONS.LIST><CATEGORY>${xmlName(category)}</CATEGORY>`;
    for (const a of allocs) {
      xml += `<COSTCENTREALLOCATIONS.LIST><NAME>${xmlName(a.centre)}</NAME>` +
             `<AMOUNT>${sign < 0 ? '-' : ''}${a.amount}</AMOUNT></COSTCENTREALLOCATIONS.LIST>`;
    }
    xml += `</CATEGORYALLOCATIONS.LIST>`;
  }
  return xml;
}

function ledgerEntryXml(entry: VoucherEntry): string {
  return `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${xmlName(entry.ledger)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>${entry.drCr === 'dr' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>${signedAmount(entry)}</AMOUNT>` +
    billwiseXml(entry) +
    costCentreXml(entry) +
    `</ALLLEDGERENTRIES.LIST>`;
}

function inventoryXml(line: InventoryLine): string {
  const amount = line.amount ?? (line.rate != null ? line.quantity * line.rate : 0);
  const qtyUnit = line.unit ? `${line.quantity} ${line.unit}` : `${line.quantity}`;
  const rateUnit = (line.rate != null && line.unit) ? `${line.rate}/${line.unit}` : (line.rate != null ? `${line.rate}` : '');
  let xml = `<ALLINVENTORYENTRIES.LIST>` +
    `<STOCKITEMNAME>${xmlName(line.stockItem)}</STOCKITEMNAME>` +
    `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    (rateUnit ? `<RATE>${escapeXml(rateUnit)}</RATE>` : '') +
    `<AMOUNT>${amount}</AMOUNT>` +
    `<ACTUALQTY>${escapeXml(qtyUnit)}</ACTUALQTY>` +
    `<BILLEDQTY>${escapeXml(qtyUnit)}</BILLEDQTY>`;
  if (line.godown || line.batch) {
    xml += `<BATCHALLOCATIONS.LIST>` +
      (line.godown ? `<GODOWNNAME>${xmlName(line.godown)}</GODOWNNAME>` : '') +
      (line.batch ? `<BATCHNAME>${xmlName(line.batch)}</BATCHNAME>` : '') +
      `<AMOUNT>${amount}</AMOUNT><ACTUALQTY>${escapeXml(qtyUnit)}</ACTUALQTY><BILLEDQTY>${escapeXml(qtyUnit)}</BILLEDQTY>` +
      `</BATCHALLOCATIONS.LIST>`;
  }
  if (line.accountingLedger) {
    xml += `<ACCOUNTINGALLOCATIONS.LIST>` +
      `<LEDGERNAME>${xmlName(line.accountingLedger)}</LEDGERNAME>` +
      `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
      `<AMOUNT>${amount}</AMOUNT>` +
      `</ACCOUNTINGALLOCATIONS.LIST>`;
  }
  xml += `</ALLINVENTORYENTRIES.LIST>`;
  return xml;
}

// Builds the full Import envelope. `targetCompany` is injected into STATICVARIABLES when supplied.
export function buildVoucherXml(v: VoucherInput, targetCompany?: string): string {
  const tallyDate = toTallyDate(v.date);
  const svCompany = targetCompany ? `<SVCURRENTCOMPANY>${xmlName(targetCompany)}</SVCURRENTCOMPANY>` : '';
  // REMOTEID (durable external key) goes as an ATTRIBUTE on the VOUCHER tag — the same shape Tally uses
  // when it EXPORTS a voucher, so it round-trips for a later alter/delete. Omitted when absent.
  const remoteIdAttr = v.remoteId ? ` REMOTEID="${escapeXml(v.remoteId)}"` : '';
  const body =
    `<VOUCHER${remoteIdAttr} VCHTYPE="${xmlName(v.voucherType)}" ACTION="Create">` +
    `<DATE>${tallyDate}</DATE>` +
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>` +
    `<VOUCHERTYPENAME>${xmlName(v.voucherType)}</VOUCHERTYPENAME>` +
    (v.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(v.voucherNumber)}</VOUCHERNUMBER>` : '') +
    (v.partyLedger ? `<PARTYLEDGERNAME>${xmlName(v.partyLedger)}</PARTYLEDGERNAME>` : '') +
    (v.reference ? `<REFERENCE>${escapeXml(v.reference)}</REFERENCE>` : '') +
    (v.narration ? `<NARRATION>${escapeXml(v.narration)}</NARRATION>` : '') +
    (v.gst?.placeOfSupply ? `<PLACEOFSUPPLY>${escapeXml(v.gst.placeOfSupply)}</PLACEOFSUPPLY>` : '') +
    (v.gst?.isReverseCharge ? `<ISREVERSECHARGEAPPLICABLE>Yes</ISREVERSECHARGEAPPLICABLE>` : '') +
    v.entries.map(ledgerEntryXml).join('') +
    (v.inventory?.length ? v.inventory.map(inventoryXml).join('') : '') +
    `</VOUCHER>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}

// ── ALTER ──────────────────────────────────────────────────────────────────────────────────────────
// Correcting a mis-booked voucher in place. On the Edit Log builds we hit, BOTH Cancel and Delete are
// refused ("Cannot delete unnamed object: VOUCHER") across every envelope form, which leaves a wrongly
// booked voucher uncorrectable. ACTION="Alter" keyed on the voucher's own REMOTEID / VCHKEY is the
// route that still works there.
//
// Alter REPLACES content — it is not a delta. So a patch that supplies entries must supply the COMPLETE
// new entry set; anything omitted from the patch is left exactly as Tally exported it.

export type VoucherPatch = {
  entries?: VoucherEntry[];
  inventory?: InventoryLine[];
  date?: string;                  // YYYY-MM-DD; rewrites DATE and EFFECTIVEDATE together
  narration?: string;
  voucherNumber?: string;
  reference?: string;
  partyLedger?: string;
};
export type VoucherIdentity = { remoteId?: string; vchKey?: string };

// Replace a scalar child in a voucher block, or insert it when absent. Only the FIRST occurrence is
// touched and only at the voucher's own level — the nested allocation lists carry no tags of these
// names, so a plain non-greedy match cannot stray into them.
function setChild(block: string, tag: string, value: string): string {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  const el = `<${tag}>${value}</${tag}>`;
  if (re.test(block)) return block.replace(re, el);
  return block.replace(/<\/VOUCHER>\s*$/, `${el}</VOUCHER>`);
}

// Drop every occurrence of a repeating list. Safe non-greedy: the closing tag name is unique to the
// list itself, so nested lists (BILLALLOCATIONS.LIST, ACCOUNTINGALLOCATIONS.LIST, …) are carried along
// with their parent rather than cutting the match short.
function dropLists(block: string, listTag: string): string {
  return block.replace(new RegExp(`<${listTag.replace('.', '\\.')}>[\\s\\S]*?</${listTag.replace('.', '\\.')}>`, 'g'), '');
}

const setAction = (block: string, action: string): string => {
  const openTag = (block.match(/<VOUCHER\b[^>]*>/) || ['<VOUCHER>'])[0];
  const newOpen = /\bACTION="[^"]*"/i.test(openTag)
    ? openTag.replace(/\bACTION="[^"]*"/i, `ACTION="${action}"`)
    : openTag.replace(/^<VOUCHER\b/, `<VOUCHER ACTION="${action}"`);
  return block.replace(openTag, newOpen);
};

// Rewrite a voucher's OWN exported block into an alter-import. Keeping Tally's exported block as the
// base (rather than synthesising a fresh body) preserves the fields we never modelled — GST
// registration details, voucher-class flags, UDFs — which a synthesised body would silently drop.
export function applyPatchToBlock(block: string, patch: VoucherPatch): string {
  let out = setAction(block, 'Alter');
  if (patch.entries?.length) {
    out = dropLists(out, 'ALLLEDGERENTRIES.LIST');
    out = dropLists(out, 'LEDGERENTRIES.LIST');
    out = out.replace(/<\/VOUCHER>\s*$/, `${patch.entries.map(ledgerEntryXml).join('')}</VOUCHER>`);
  }
  if (patch.inventory?.length) {
    out = dropLists(out, 'ALLINVENTORYENTRIES.LIST');
    out = out.replace(/<\/VOUCHER>\s*$/, `${patch.inventory.map(inventoryXml).join('')}</VOUCHER>`);
  }
  if (patch.date) {
    const d = toTallyDate(patch.date);
    out = setChild(out, 'DATE', d);
    out = setChild(out, 'EFFECTIVEDATE', d);
  }
  if (patch.narration !== undefined) out = setChild(out, 'NARRATION', escapeXml(patch.narration));
  if (patch.voucherNumber !== undefined) out = setChild(out, 'VOUCHERNUMBER', escapeXml(patch.voucherNumber));
  if (patch.reference !== undefined) out = setChild(out, 'REFERENCE', escapeXml(patch.reference));
  if (patch.partyLedger !== undefined) out = setChild(out, 'PARTYLEDGERNAME', xmlName(patch.partyLedger));
  return out;
}

// A minimal alter envelope built from scratch, keyed only on the identity attributes. Used as a
// fallback for builds that reject a full re-imported block.
export function buildAlterVoucherXml(
  v: { voucherType: string; date?: string; voucherNumber?: string } & VoucherPatch & VoucherIdentity,
  targetCompany?: string
): string {
  const tallyDate = v.date ? toTallyDate(v.date) : '';
  const svCompany = targetCompany ? `<SVCURRENTCOMPANY>${xmlName(targetCompany)}</SVCURRENTCOMPANY>` : '';
  const attrs =
    (v.remoteId ? ` REMOTEID="${escapeXml(v.remoteId)}"` : '') +
    (v.vchKey ? ` VCHKEY="${escapeXml(v.vchKey)}"` : '');
  const body =
    `<VOUCHER${attrs} VCHTYPE="${xmlName(v.voucherType)}" ACTION="Alter">` +
    (tallyDate ? `<DATE>${tallyDate}</DATE><EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>` : '') +
    `<VOUCHERTYPENAME>${xmlName(v.voucherType)}</VOUCHERTYPENAME>` +
    (v.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(v.voucherNumber)}</VOUCHERNUMBER>` : '') +
    (v.partyLedger ? `<PARTYLEDGERNAME>${xmlName(v.partyLedger)}</PARTYLEDGERNAME>` : '') +
    (v.reference ? `<REFERENCE>${escapeXml(v.reference)}</REFERENCE>` : '') +
    (v.narration ? `<NARRATION>${escapeXml(v.narration)}</NARRATION>` : '') +
    (v.entries?.length ? v.entries.map(ledgerEntryXml).join('') : '') +
    (v.inventory?.length ? v.inventory.map(inventoryXml).join('') : '') +
    `</VOUCHER>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}

// Builds a cancel envelope for reverse-voucher (#98 H-12), mark-cancelled semantics (Edit-Log-safe):
// ACTION="Cancel" + ISCANCELLED on the target voucher. When masterId is supplied, Tally keys the
// cancel to that exact immutable id — this is what stops the classic gotcha where a Cancel that can't
// match by number+date instead CREATES a brand-new cancelled voucher. voucherNumber/date remain as
// secondary identifiers. A reversing-entry (contra) reversal is just a normal create-voucher with
// swapped dr/cr, so it is not duplicated here.
export function buildCancelVoucherXml(
  v: { voucherType: string; voucherNumber?: string; date?: string; masterId?: string | number },
  targetCompany?: string
): string {
  const tallyDate = v.date ? toTallyDate(v.date) : '';
  const svCompany = targetCompany ? `<SVCURRENTCOMPANY>${xmlName(targetCompany)}</SVCURRENTCOMPANY>` : '';
  const body =
    `<VOUCHER ACTION="Cancel" VCHTYPE="${xmlName(v.voucherType)}">` +
    (v.masterId ? `<MASTERID>${escapeXml(String(v.masterId))}</MASTERID>` : '') +
    (tallyDate ? `<DATE>${tallyDate}</DATE>` : '') +
    `<VOUCHERTYPENAME>${xmlName(v.voucherType)}</VOUCHERTYPENAME>` +
    (v.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(v.voucherNumber)}</VOUCHERNUMBER>` : '') +
    `<ISCANCELLED>Yes</ISCANCELLED>` +
    `</VOUCHER>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}

// Builds a HARD-DELETE envelope (ACTION="Delete"). Unlike buildCancelVoucherXml (mark-cancelled, keeps
// the row), this removes the voucher outright — no row remains.
//
// Identity attributes go on the VOUCHER tag (never as child elements), with type/date/number repeated
// as children. Two live probes proved a voucher cannot be deleted by MASTERID alone — Tally's importer
// rejects it with "Cannot delete unnamed object: VOUCHER!", because a voucher has no name and MASTERID
// is not sufficient identity for an ACTION="Delete". The importer matches an existing voucher by its
// REMOTEID (the GUID) / VCHKEY, which must be read from the voucher first (locate-voucher fetches $Guid
// and $VoucherKey). So we emit REMOTEID + VCHKEY when available (MASTERID kept as a further handle);
// empty ones are omitted. On a TallyPrime Edit Log company the deletion is auto-recorded in the Edit
// Log; no delete-reason tag is emitted (version-specific, unverified).
export function buildDeleteVoucherXml(
  v: { voucherType: string; date?: string; guid?: string; remoteId?: string },
  targetCompany?: string
): string {
  const tallyDate = v.date ? toTallyDate(v.date) : '';
  const svCompany = targetCompany ? `<SVCURRENTCOMPANY>${xmlName(targetCompany)}</SVCURRENTCOMPANY>` : '';
  // Match precedence: REMOTEID (attribute) is the reliable key for a voucher WE authored with a stamped
  // remote id — Tally stored it at create-time, so re-sending it targets that exact voucher. This is the
  // only XML form that works for our own vouchers; legacy/hand-keyed vouchers have no stored REMOTEID and
  // must be deleted via the GUI (Alt+D). The GUID child is kept as a secondary attempt for the rare build
  // that exposes a real $Guid. MASTERID is deliberately NOT used — Tally rejects it ("unnamed object").
  const remoteIdAttr = v.remoteId ? ` REMOTEID="${escapeXml(v.remoteId)}"` : '';
  const body =
    `<VOUCHER${remoteIdAttr} ACTION="Delete">` +
    (v.guid ? `<GUID>${escapeXml(String(v.guid))}</GUID>` : '') +
    (tallyDate ? `<DATE>${tallyDate}</DATE>` : '') +
    `<VOUCHERTYPENAME>${xmlName(v.voucherType)}</VOUCHERTYPENAME>` +
    `</VOUCHER>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}
