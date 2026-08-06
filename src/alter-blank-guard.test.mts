import assert from 'node:assert/strict';
import test from 'node:test';
import { blockHasLedgerEntries, alterWouldBlankVoucher, applyPatchToBlock } from './voucher.mjs';

// The skeletal block this Tally build actually returns from a $MasterID-filtered collection: identity
// attributes and scalars, but NO accounting lines.
const SKELETAL =
  '<VOUCHER REMOTEID="ca36e34b-00013289" VCHKEY="ca36e34b-0000b467:00000060" VCHTYPE="Payment" ACTION="Create">' +
  '<DATE>20260701</DATE><EFFECTIVEDATE>20260701</EFFECTIVEDATE>' +
  '<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>782</VOUCHERNUMBER>' +
  '<MASTERID>78900</MASTERID></VOUCHER>';

const FULL =
  SKELETAL.replace('</VOUCHER>',
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Omkar Pawar</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-20245</AMOUNT></ALLLEDGERENTRIES.LIST>' +
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>20245</AMOUNT></ALLLEDGERENTRIES.LIST>' +
    '</VOUCHER>');

test('detects whether a block carries accounting lines', () => {
  assert.equal(blockHasLedgerEntries(SKELETAL), false);
  assert.equal(blockHasLedgerEntries(FULL), true);
  // The older LEDGERENTRIES.LIST spelling counts too.
  assert.equal(blockHasLedgerEntries('<VOUCHER><LEDGERENTRIES.LIST/></VOUCHER>'.replace('/>', '></LEDGERENTRIES.LIST>')), true);
});

test('THE HAZARD: a date-only patch on a skeletal block produces a voucher with no entries', () => {
  // Demonstrates why the guard exists rather than asserting it abstractly. Alter REPLACES content, so
  // re-importing this would blank a real transaction while reporting success.
  const out = applyPatchToBlock(SKELETAL, { date: '2026-06-30' });
  assert.match(out, /ACTION="Alter"/);
  assert.match(out, /<DATE>20260630<\/DATE>/);
  assert.equal(blockHasLedgerEntries(out), false, 'the re-imported voucher would have NO accounting lines');
});

test('the guard fires exactly on that combination', () => {
  // skeletal + no entries in the patch → refuse
  assert.equal(alterWouldBlankVoucher(SKELETAL, { date: '2026-06-30' }), true);
  assert.equal(alterWouldBlankVoucher(SKELETAL, { narration: 'x' }), true);
});

test('the guard does NOT fire when the patch supplies the entries itself', () => {
  // A complete entries[] replaces the lines outright, so what the export omitted no longer matters.
  const entries = [
    { ledger: 'Omkar Pawar', drCr: 'dr' as const, amount: 20245 },
    { ledger: 'Cash', drCr: 'cr' as const, amount: 20245 },
  ];
  assert.equal(alterWouldBlankVoucher(SKELETAL, { date: '2026-06-30', entries }), false);
  const out = applyPatchToBlock(SKELETAL, { date: '2026-06-30', entries });
  assert.equal(blockHasLedgerEntries(out), true);
});

test('the guard does NOT fire on a full block — a date-only alter there is safe', () => {
  assert.equal(alterWouldBlankVoucher(FULL, { date: '2026-06-30' }), false);
  const out = applyPatchToBlock(FULL, { date: '2026-06-30' });
  assert.match(out, /<DATE>20260630<\/DATE>/);
  assert.match(out, /<EFFECTIVEDATE>20260630<\/EFFECTIVEDATE>/);
  assert.ok(out.includes('Omkar Pawar'), 'existing entries survive an untouched-entries patch');
  assert.equal((out.match(/<ALLLEDGERENTRIES\.LIST>/g) || []).length, 2);
});
