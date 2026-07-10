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
};

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
  const body =
    `<VOUCHER VCHTYPE="${xmlName(v.voucherType)}" ACTION="Create">` +
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
