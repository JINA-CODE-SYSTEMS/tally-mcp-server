import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVoucherXml, voucherBalance, toTallyDate, type VoucherInput } from './voucher.mjs';

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
