import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVoucher, executeVoucherBatch } from './mcp.mjs';

// skipIfExists dedupe. checkExisting is injected, so the skip path is fully testable WITHOUT a live
// Tally (it returns before pushXml). We only exercise skip/dryRun paths (never the real post path).
const voucher = (over: object = {}) => ({
  voucherType: 'Payment', date: '2026-07-03', reference: 'AXODH18269919819', skipIfExists: true,
  entries: [{ ledger: 'A', drCr: 'dr' as const, amount: 100 }, { ledger: 'B', drCr: 'cr' as const, amount: 100 }],
  ...over,
});
const hit = async () => [{ master_id: '50', voucher_number: '877', date: '2026-07-03', amount: 100 }];
const miss = async () => [];

test('skipIfExists + reference already booked → skipped (does NOT post)', async () => {
  const r = await executeVoucher(voucher(), { checkExisting: hit });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.skipped, true);
  assert.equal(body.reason, 'ALREADY_EXISTS');
  assert.equal(body.reference, 'AXODH18269919819');
  assert.equal(body.existing[0].master_id, '50');
});

test('skipIfExists dryRun + already booked → wouldSkip (preview, no post)', async () => {
  const r = await executeVoucher(voucher(), { dryRun: true, checkExisting: hit });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.wouldSkip, true);
  assert.equal(body.skipped, undefined);
});

test('skipIfExists but reference NOT found → proceeds (dryRun echo, no skip)', async () => {
  const r = await executeVoucher(voucher({ reference: 'NEW-UTR' }), { dryRun: true, checkExisting: miss });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.wouldPost, true);
  assert.equal(body.wouldSkip, undefined);
});

test('skipIfExists=false → no dedupe check even if a match exists', async () => {
  const r = await executeVoucher(voucher({ skipIfExists: false }), { dryRun: true, checkExisting: hit });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.wouldPost, true); // flag off → never checked
});

test('no reference → skipIfExists is a no-op (nothing to dedupe on)', async () => {
  const r = await executeVoucher(voucher({ reference: undefined }), { dryRun: true, checkExisting: hit });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.wouldPost, true);
});

test('read failure (checkExisting → null) does NOT block the write', async () => {
  const r = await executeVoucher(voucher(), { dryRun: true, checkExisting: async () => null });
  const body = JSON.parse(r.content[0]!.text);
  assert.equal(body.wouldPost, true); // fail-open: a failed dedupe check never blocks a legit write
});

test('batch: an all-already-booked batch skips every row, posts none, and is not aborted', async () => {
  const b = await executeVoucherBatch([voucher(), voucher({ reference: 'X2' })], { checkExisting: hit });
  assert.equal(b.skipped, 2);
  assert.equal(b.posted, 0);
  assert.equal(b.aborted, false);
  assert.equal(b.results.every(r => r.status === 'skipped'), true);
});
