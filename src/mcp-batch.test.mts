import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVoucherBatch } from './mcp.mjs';

const good = (n: number) => ({
  voucherType: 'Journal', date: '2026-10-10',
  entries: [{ ledger: `Dr${n}`, drCr: 'dr' as const, amount: 100 }, { ledger: `Cr${n}`, drCr: 'cr' as const, amount: 100 }],
});
const unbalanced = {
  voucherType: 'Journal', date: '2026-10-10',
  entries: [{ ledger: 'A', drCr: 'dr' as const, amount: 100 }, { ledger: 'B', drCr: 'cr' as const, amount: 90 }],
};

test('atomic batch aborts and posts nothing when any row fails validation', async () => {
  const b = await executeVoucherBatch([good(1), unbalanced, good(2)], { atomic: true });
  assert.equal(b.atomic, true);
  assert.equal(b.aborted, true);
  assert.equal(b.posted, 0);
  assert.equal(b.results.length, 3);
  assert.equal(b.results[1].status, 'error');
  assert.equal(b.results[1].code, 'UNBALANCED');
});

test('atomic dryRun validates all rows and posts nothing', async () => {
  const b = await executeVoucherBatch([good(1), good(2)], { atomic: true, dryRun: true });
  assert.equal(b.aborted, false);
  assert.equal(b.posted, 0);
  assert.equal(b.results.every(r => r.status === 'success'), true);
});

test('best-effort dryRun reports each row independently (mixed)', async () => {
  const b = await executeVoucherBatch([good(1), unbalanced], { atomic: false, dryRun: true });
  assert.equal(b.atomic, false);
  assert.equal(b.aborted, false);
  assert.equal(b.results[0].status, 'success');
  assert.equal(b.results[1].status, 'error');
  assert.equal(b.results[1].code, 'UNBALANCED');
});
