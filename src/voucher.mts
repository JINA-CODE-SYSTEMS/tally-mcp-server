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
    xml += `<CATEGORYALLOCATIONS.LIST><CATEGORY>${escapeXml(category)}</CATEGORY>`;
    for (const a of allocs) {
      xml += `<COSTCENTREALLOCATIONS.LIST><NAME>${escapeXml(a.centre)}</NAME>` +
             `<AMOUNT>${sign < 0 ? '-' : ''}${a.amount}</AMOUNT></COSTCENTREALLOCATIONS.LIST>`;
    }
    xml += `</CATEGORYALLOCATIONS.LIST>`;
  }
  return xml;
}

function ledgerEntryXml(entry: VoucherEntry): string {
  return `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${escapeXml(entry.ledger)}</LEDGERNAME>` +
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
    `<STOCKITEMNAME>${escapeXml(line.stockItem)}</STOCKITEMNAME>` +
    `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    (rateUnit ? `<RATE>${escapeXml(rateUnit)}</RATE>` : '') +
    `<AMOUNT>${amount}</AMOUNT>` +
    `<ACTUALQTY>${escapeXml(qtyUnit)}</ACTUALQTY>` +
    `<BILLEDQTY>${escapeXml(qtyUnit)}</BILLEDQTY>`;
  if (line.godown || line.batch) {
    xml += `<BATCHALLOCATIONS.LIST>` +
      (line.godown ? `<GODOWNNAME>${escapeXml(line.godown)}</GODOWNNAME>` : '') +
      (line.batch ? `<BATCHNAME>${escapeXml(line.batch)}</BATCHNAME>` : '') +
      `<AMOUNT>${amount}</AMOUNT><ACTUALQTY>${escapeXml(qtyUnit)}</ACTUALQTY><BILLEDQTY>${escapeXml(qtyUnit)}</BILLEDQTY>` +
      `</BATCHALLOCATIONS.LIST>`;
  }
  if (line.accountingLedger) {
    xml += `<ACCOUNTINGALLOCATIONS.LIST>` +
      `<LEDGERNAME>${escapeXml(line.accountingLedger)}</LEDGERNAME>` +
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
  const svCompany = targetCompany ? `<SVCURRENTCOMPANY>${escapeXml(targetCompany)}</SVCURRENTCOMPANY>` : '';
  const body =
    `<VOUCHER VCHTYPE="${escapeXml(v.voucherType)}" ACTION="Create">` +
    `<DATE>${tallyDate}</DATE>` +
    `<EFFECTIVEDATE>${tallyDate}</EFFECTIVEDATE>` +
    `<VOUCHERTYPENAME>${escapeXml(v.voucherType)}</VOUCHERTYPENAME>` +
    (v.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(v.voucherNumber)}</VOUCHERNUMBER>` : '') +
    (v.partyLedger ? `<PARTYLEDGERNAME>${escapeXml(v.partyLedger)}</PARTYLEDGERNAME>` : '') +
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
