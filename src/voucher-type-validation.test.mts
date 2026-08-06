import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVoucher, resolveGstVoucherClass } from './mcp.mjs';

// The voucher type is a per-company master, not a fixed enum. These cover the runtime check that
// replaced the compile-time enum, using the real voucher-type list of a live company (ALG CHEMICALS)
// as the fixture — it carries custom types alongside the base ones, which is the normal case.
const COMPANY_TYPES = [
  'Attendance', 'Contra', 'Contra - Mahad', 'Credit Note', 'Debit Note', 'Delivery Note',
  'Excise Sales', 'Expenses GST', 'Expenses (No GST)', 'Export Sales', 'GST SALES', 'Import Purchase',
  'Journal', 'Journal - Mahad', 'Payment', 'Payment - Mahad', 'PERFORMA INVOICE', 'Purchase Order',
  'Receipt', 'Receipt - Mahad', 'RM Purchase', 'Sales', 'Service Purchase', 'Stock Journal',
];

const balanced = [
  { ledger: 'Rent', drCr: 'dr' as const, amount: 100 },
  { ledger: 'Cash', drCr: 'cr' as const, amount: 100 },
];
const codeOf = (r: any) => r.structuredContent?.code;
const bodyOf = (r: any) => JSON.parse(r.content[0].text);

test('a company-specific voucher type posts (the enum used to reject it)', async () => {
  const r = await executeVoucher(
    { voucherType: 'RM Purchase', date: '2026-10-10', entries: balanced },
    { knownVoucherTypes: COMPANY_TYPES, dryRun: true }
  );
  assert.notEqual(r.isError, true);
  assert.equal(bodyOf(r).voucher.voucherType, 'RM Purchase');
});

test('an unknown voucher type is refused, and the error carries the valid list', async () => {
  const r = await executeVoucher(
    { voucherType: 'Retail Sale', date: '2026-10-10', entries: balanced },
    { knownVoucherTypes: COMPANY_TYPES, dryRun: true }
  );
  assert.equal(r.isError, true);
  assert.equal(codeOf(r), 'MASTER_NOT_FOUND');
  const remedy = r.structuredContent?.remedy as string;
  // The caller must be able to recover from the message alone.
  assert.match(remedy, /RM Purchase/);
  assert.match(remedy, /Contra - Mahad/);
});

test('voucher-type matching is case- and entity-insensitive, like the other masters', async () => {
  const r = await executeVoucher(
    { voucherType: 'gst sales', date: '2026-10-10', entries: balanced },
    { knownVoucherTypes: COMPANY_TYPES, dryRun: true }
  );
  assert.notEqual(r.isError, true);
});

test('an unavailable voucher-type list skips the check rather than blocking the write', async () => {
  const r = await executeVoucher(
    { voucherType: 'Anything At All', date: '2026-10-10', entries: balanced },
    { knownVoucherTypes: [], dryRun: true }
  );
  assert.notEqual(r.isError, true);
});

// ── GST class resolution ───────────────────────────────────────────────────
// Existence is not enough for a GST voucher: the posting direction (output vs input tax) depends on
// which base type it behaves as, and a custom name carries no reliable signal.
test('resolveGstVoucherClass infers the class when the type IS a base type', () => {
  assert.deepEqual(resolveGstVoucherClass('Sales'), { class: 'Sales' });
  assert.deepEqual(resolveGstVoucherClass('credit note'), { class: 'Credit Note' });
});

test('resolveGstVoucherClass fails closed on a custom type with no stated class', () => {
  const r = resolveGstVoucherClass('RM Purchase');
  assert.ok('error' in r);
  assert.match(r.error, /voucherClass/);
});

test('resolveGstVoucherClass uses the stated class for a custom type', () => {
  assert.deepEqual(resolveGstVoucherClass('RM Purchase', 'Purchase'), { class: 'Purchase' });
  // "GST SALES" and "PERFORMA INVOICE" are both sales in this company; neither is guessable.
  assert.deepEqual(resolveGstVoucherClass('PERFORMA INVOICE', 'Sales'), { class: 'Sales' });
});

test('an explicit voucherClass overrides a base-type name', () => {
  // Deliberate: the caller knows the company's type behaviour better than the name does.
  assert.deepEqual(resolveGstVoucherClass('Sales', 'Credit Note'), { class: 'Credit Note' });
});
