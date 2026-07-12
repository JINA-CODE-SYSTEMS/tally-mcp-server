import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVoucherXml, buildCancelVoucherXml, buildDeleteVoucherXml, deriveRemoteId, voucherBalance, toTallyDate, type VoucherInput } from './voucher.mjs';

test('buildCancelVoucherXml marks the located voucher cancelled (#98)', () => {
  const xml = buildCancelVoucherXml({ voucherType: 'Sales', voucherNumber: 'INV-42', date: '2026-10-10' }, 'Ross');
  assert.match(xml, /<VOUCHER ACTION="Cancel" VCHTYPE="Sales">/);
  assert.match(xml, /<VOUCHERNUMBER>INV-42<\/VOUCHERNUMBER>/);
  assert.match(xml, /<ISCANCELLED>Yes<\/ISCANCELLED>/);
  assert.match(xml, /<DATE>20261010<\/DATE>/);
  assert.match(xml, /<SVCURRENTCOMPANY>Ross<\/SVCURRENTCOMPANY>/);
});

test('toTallyDate: ISO → YYYYMMDD, invalid → empty', () => {
  assert.equal(toTallyDate('2026-10-10'), '20261010');
  assert.equal(toTallyDate('2026-04-01'), '20260401');
  assert.equal(toTallyDate('nope'), '');
});

test('voucherBalance: balanced vs unbalanced (2dp tolerance)', () => {
  assert.equal(voucherBalance([
    { ledger: 'A', drCr: 'dr', amount: 100 },
    { ledger: 'B', drCr: 'cr', amount: 100 },
  ]).balanced, true);
  const multi = voucherBalance([
    { ledger: 'Party', drCr: 'dr', amount: 118 },
    { ledger: 'Sales', drCr: 'cr', amount: 100 },
    { ledger: 'CGST', drCr: 'cr', amount: 9 },
    { ledger: 'SGST', drCr: 'cr', amount: 9 },
  ]);
  assert.deepEqual([multi.debit, multi.credit, multi.balanced], [118, 118, true]);
  assert.equal(voucherBalance([
    { ledger: 'A', drCr: 'dr', amount: 100 },
    { ledger: 'B', drCr: 'cr', amount: 90 },
  ]).balanced, false);
});

// Acceptance case (a): a plain journal.
test('builds a plain 2-line journal with correct signs', () => {
  const v: VoucherInput = {
    voucherType: 'Journal', date: '2026-10-10',
    entries: [
      { ledger: 'Rent', drCr: 'dr', amount: 5000 },
      { ledger: 'Cash', drCr: 'cr', amount: 5000 },
    ],
    narration: 'Office rent',
  };
  const xml = buildVoucherXml(v, 'Ross');
  assert.match(xml, /<VOUCHER VCHTYPE="Journal" ACTION="Create">/);
  assert.match(xml, /<DATE>20261010<\/DATE>/);
  assert.match(xml, /<SVCURRENTCOMPANY>Ross<\/SVCURRENTCOMPANY>/);
  // debit line: ISDEEMEDPOSITIVE Yes, negative amount
  assert.match(xml, /<LEDGERNAME>Rent<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-5000<\/AMOUNT>/);
  // credit line: No, positive
  assert.match(xml, /<LEDGERNAME>Cash<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>5000<\/AMOUNT>/);
  assert.match(xml, /<NARRATION>Office rent<\/NARRATION>/);
});

// Acceptance case (b): a multi-rate GST invoice with inventory.
test('builds a GST sales invoice with inventory + party + tax lines', () => {
  const v: VoucherInput = {
    voucherType: 'Sales', date: '2026-10-10',
    partyLedger: 'Acme Corp',
    gst: { placeOfSupply: 'Maharashtra' },
    entries: [
      { ledger: 'Acme Corp', drCr: 'dr', amount: 1180 },
      { ledger: 'Sales GST 18%', drCr: 'cr', amount: 1000 },
      { ledger: 'Output CGST', drCr: 'cr', amount: 90 },
      { ledger: 'Output SGST', drCr: 'cr', amount: 90 },
    ],
    inventory: [
      { stockItem: 'Widget', quantity: 10, rate: 100, unit: 'Nos', accountingLedger: 'Sales GST 18%' },
    ],
  };
  const xml = buildVoucherXml(v, 'Ross');
  assert.equal(voucherBalance(v.entries).balanced, true);
  assert.match(xml, /<PARTYLEDGERNAME>Acme Corp<\/PARTYLEDGERNAME>/);
  assert.match(xml, /<PLACEOFSUPPLY>Maharashtra<\/PLACEOFSUPPLY>/);
  assert.match(xml, /<ALLINVENTORYENTRIES\.LIST><STOCKITEMNAME>Widget<\/STOCKITEMNAME>/);
  assert.match(xml, /<ACTUALQTY>10 Nos<\/ACTUALQTY>/);
  assert.match(xml, /<ACCOUNTINGALLOCATIONS\.LIST><LEDGERNAME>Sales GST 18%<\/LEDGERNAME>/);
  // 4 ledger lines present
  assert.equal((xml.match(/<ALLLEDGERENTRIES\.LIST>/g) || []).length, 4);
});

// Acceptance case (c): a bill-wise receipt.
test('builds a bill-wise receipt with BILLALLOCATIONS on the party line', () => {
  const v: VoucherInput = {
    voucherType: 'Receipt', date: '2026-10-10',
    entries: [
      { ledger: 'Bank', drCr: 'dr', amount: 5000 },
      {
        ledger: 'Acme Corp', drCr: 'cr', amount: 5000,
        billwise: [{ name: 'INV-001', billType: 'Agst Ref', amount: 5000 }],
      },
    ],
  };
  const xml = buildVoucherXml(v, 'Ross');
  assert.match(xml, /<BILLALLOCATIONS\.LIST><NAME>INV-001<\/NAME><BILLTYPE>Agst Ref<\/BILLTYPE><AMOUNT>5000<\/AMOUNT><\/BILLALLOCATIONS\.LIST>/);
});

test('escapes XML metacharacters in ledger names', () => {
  const v: VoucherInput = {
    voucherType: 'Journal', date: '2026-10-10',
    entries: [
      { ledger: 'Smith & Co', drCr: 'dr', amount: 10 },
      { ledger: 'Cash', drCr: 'cr', amount: 10 },
    ],
  };
  const xml = buildVoucherXml(v);
  assert.match(xml, /<LEDGERNAME>Smith &amp; Co<\/LEDGERNAME>/);
});

// ── REMOTEID stamping (durable external key). deriveRemoteId is deterministic from type+reference, so
//    the SAME reference always yields the SAME key — that's what lets a later delete re-derive it and
//    match without a lookup, and what makes a re-feed idempotent (Tally alters the same voucher).
test('deriveRemoteId: deterministic, slugified, namespaced; undefined without a reference', () => {
  assert.equal(deriveRemoteId('Receipt', 'RCV00351'), 'TMCP-Receipt-RCV00351');
  assert.equal(deriveRemoteId('Receipt', 'RCV00351'), deriveRemoteId('Receipt', 'RCV00351')); // stable
  // messy references collapse to a safe slug; leading/trailing separators trimmed
  assert.equal(deriveRemoteId('Payment', 'IMPS/P2A 618817313928'), 'TMCP-Payment-IMPS-P2A-618817313928');
  assert.equal(deriveRemoteId('Receipt', undefined), undefined);
  assert.equal(deriveRemoteId('Receipt', '   '), undefined);
  assert.equal(deriveRemoteId('Receipt', '///'), undefined); // no alnum survives the slug
});

test('buildVoucherXml stamps REMOTEID as an attribute when present, omits it otherwise', () => {
  const base: VoucherInput = {
    voucherType: 'Receipt', date: '2026-07-07',
    entries: [{ ledger: 'Bank', drCr: 'dr', amount: 100 }, { ledger: 'Party', drCr: 'cr', amount: 100 }],
  };
  const withId = buildVoucherXml({ ...base, remoteId: 'TMCP-Receipt-RCV00351' }, 'ALG');
  assert.match(withId, /<VOUCHER REMOTEID="TMCP-Receipt-RCV00351" VCHTYPE="Receipt" ACTION="Create">/);
  const without = buildVoucherXml(base, 'ALG');
  assert.equal(/REMOTEID=/.test(without), false);
  assert.match(without, /<VOUCHER VCHTYPE="Receipt" ACTION="Create">/);
});

test('buildDeleteVoucherXml keys the delete on the REMOTEID attribute when supplied', () => {
  const xml = buildDeleteVoucherXml({ voucherType: 'Receipt', date: '2026-07-07', remoteId: 'TMCP-Receipt-RCV00351' }, 'ALG');
  assert.match(xml, /<VOUCHER REMOTEID="TMCP-Receipt-RCV00351" ACTION="Delete">/);
  assert.match(xml, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<SVCURRENTCOMPANY>ALG<\/SVCURRENTCOMPANY>/);
  assert.equal(/MASTERID/.test(xml), false); // never keyed on MASTERID (Tally → "unnamed object")
});
