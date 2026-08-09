import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRemoteId, findRemoteIdCollisions } from './voucher.mjs';

// Two suppliers legitimately share printed invoice numbers. The reference-only key collapsed them:
// in one GST batch, invoice "09" (Shree Swami Samarth) was silently replaced by invoice "09"
// (Nagesh Gani) — created:0, altered:1, first bill gone with no error.

test('two parties sharing an invoice number derive DIFFERENT remote ids', () => {
  const a = deriveRemoteId('Expenses (No GST)', '09', 'SHREE SWAMI SAMARTH');
  const b = deriveRemoteId('Expenses (No GST)', '09', 'NAGESH CHANNAPPA GANI');
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('the party-aware id is deterministic — same inputs, same id', () => {
  assert.equal(
    deriveRemoteId('Payment', 'UTR123', 'ACME LTD'),
    deriveRemoteId('Payment', 'UTR123', 'ACME LTD'),
  );
});

test('a voucher with no party keeps the legacy id shape, so old stamps still round-trip', () => {
  assert.equal(deriveRemoteId('Journal', 'ADJ-7'), 'TMCP-Journal-ADJ-7');
  assert.equal(deriveRemoteId('Journal', 'ADJ-7', ''), 'TMCP-Journal-ADJ-7');
});

test('no reference still means no derived id at all', () => {
  assert.equal(deriveRemoteId('Payment', undefined, 'ACME LTD'), undefined);
  assert.equal(deriveRemoteId('Payment', '', 'ACME LTD'), undefined);
});

test('findRemoteIdCollisions flags rows that would silently replace each other', () => {
  const rows = [
    { voucherType: 'Expenses GST', reference: '09', partyLedger: 'SHREE SWAMI SAMARTH' },
    { voucherType: 'Expenses GST', reference: '09', partyLedger: 'SHREE SWAMI SAMARTH' }, // true duplicate
    { voucherType: 'Expenses GST', reference: '09', partyLedger: 'NAGESH CHANNAPPA GANI' }, // distinct party — fine now
  ];
  const collisions = findRemoteIdCollisions(rows);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].rows, [0, 1]);
});

test('the pre-fix collapse scenario is exactly what the detector would have refused', () => {
  // Simulate the OLD derivation (no party) by omitting partyLedger: both rows share the id.
  const rows = [
    { voucherType: 'Expenses (No GST)', reference: '076' },
    { voucherType: 'Expenses (No GST)', reference: '076' },
  ];
  const collisions = findRemoteIdCollisions(rows);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].remoteId, 'TMCP-Expenses-No-GST-076');
});

test('an explicit remoteId overrides derivation and still participates in collision detection', () => {
  const rows = [
    { voucherType: 'Payment', reference: 'R1', partyLedger: 'A', remoteId: 'CUSTOM-1' },
    { voucherType: 'Payment', reference: 'R2', partyLedger: 'B', remoteId: 'CUSTOM-1' },
  ];
  assert.equal(findRemoteIdCollisions(rows).length, 1);
});

test('rows without any id never collide', () => {
  const rows = [
    { voucherType: 'Payment' },
    { voucherType: 'Payment' },
  ];
  assert.equal(findRemoteIdCollisions(rows).length, 0);
});
