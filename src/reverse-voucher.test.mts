import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretVoucherLookup, interpretCancelResponse } from './mcp.mjs';
import { buildCancelVoucherXml } from './voucher.mjs';

const resp = (o: Partial<{ success: boolean; created: number; altered: number; cancelled: number; deleted: number; lastVchId: number; error: string }>) =>
  ({ success: false, created: 0, altered: 0, cancelled: 0, deleted: 0, lastVchId: 0, ...o });

// ── interpretVoucherLookup: turn voucher-lookup rows into one deterministic outcome ──────────────
test('lookup: no rows → not_found', () => {
  assert.equal(interpretVoucherLookup([]).status, 'not_found');
});

test('lookup: >1 row → ambiguous with the candidate master_ids', () => {
  const o = interpretVoucherLookup([{ master_id: '101' }, { master_id: '102' }]);
  assert.equal(o.status, 'ambiguous');
  assert.deepEqual((o as any).masterIds, ['101', '102']);
});

test('lookup: single already-cancelled row → already_cancelled (no-op success, not a re-cancel)', () => {
  const o = interpretVoucherLookup([{ master_id: '55', is_cancelled: 'Yes' }]);
  assert.equal(o.status, 'already_cancelled');
});

test('lookup: single live row → ok, carrying the voucher', () => {
  const o = interpretVoucherLookup([{ master_id: '77', is_cancelled: 'No' }]);
  assert.equal(o.status, 'ok');
  assert.equal((o as any).voucher.master_id, '77');
});

// ── interpretCancelResponse: the load-bearing guard against the junk-duplicate bug ───────────────
test('cancel: CREATED>0 → duplicate_created (Tally made a new cancelled voucher — never a success)', () => {
  const o = interpretCancelResponse(resp({ success: true, created: 1, altered: 0 }), '77');
  assert.equal(o.status, 'duplicate_created');
  assert.equal((o as any).created, 1);
});

test('cancel: CANCELLED>0, created=0 → cancelled (the normal happy path on builds that count cancels)', () => {
  const o = interpretCancelResponse(resp({ success: true, cancelled: 1 }), '77');
  assert.equal(o.status, 'cancelled');
  assert.equal((o as any).cancelled, 1);
});

test('cancel: ALTERED>0, created=0 → cancelled (builds that count a mark-cancel under ALTERED)', () => {
  const o = interpretCancelResponse(resp({ success: true, altered: 1 }), '77');
  assert.equal(o.status, 'cancelled');
});

test('cancel: nothing changed (all zero, not success) → failed, fallback names the master_id', () => {
  const o = interpretCancelResponse(resp({ success: false }), '77');
  assert.equal(o.status, 'failed');
  assert.match((o as any).message, /master_id 77/);
});

test('cancel: Tally error string is surfaced verbatim when present', () => {
  const o = interpretCancelResponse(resp({ success: false, error: 'LINEERROR: bad ledger' }), '77');
  assert.equal(o.status, 'failed');
  assert.match((o as any).message, /LINEERROR: bad ledger/);
});

// ── buildCancelVoucherXml: MASTERID targeting ────────────────────────────────────────────────────
test('buildCancelVoucherXml with masterId keys the cancel to the exact voucher', () => {
  const xml = buildCancelVoucherXml({ voucherType: 'Payment', voucherNumber: '877', date: '2026-07-03', masterId: '4321' }, 'Ross');
  assert.match(xml, /<VOUCHER ACTION="Cancel" VCHTYPE="Payment">/);
  assert.match(xml, /<MASTERID>4321<\/MASTERID>/);
  assert.match(xml, /<ISCANCELLED>Yes<\/ISCANCELLED>/);
});

test('buildCancelVoucherXml without masterId still works (no MASTERID tag) — backward compatible', () => {
  const xml = buildCancelVoucherXml({ voucherType: 'Sales', voucherNumber: 'INV-42', date: '2026-10-10' }, 'Ross');
  assert.equal(/<MASTERID>/.test(xml), false);
  assert.match(xml, /<VOUCHERNUMBER>INV-42<\/VOUCHERNUMBER>/);
});
