import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeVoucher } from './mcp.mjs';
import { isDateInOpenPeriod, findMissingMasters, referencedLedgers, type VoucherInput } from './voucher.mjs';
import { makeIdempotencyStore } from './idempotency.mjs';

// ── pure invariant helpers (#95 H-9) ───────────────────────────────────────
test('isDateInOpenPeriod: booksFrom is the lower bound; fyTo the upper', () => {
  const p = { fyFrom: '2026-04-01', fyTo: '2027-03-31', booksFrom: '2026-09-01' };
  assert.equal(isDateInOpenPeriod('2026-10-10', p), true);
  assert.equal(isDateInOpenPeriod('2026-08-31', p), false); // before booksFrom
  assert.equal(isDateInOpenPeriod('2027-04-01', p), false); // after fyTo
  // unknown period → never blocks
  assert.equal(isDateInOpenPeriod('1999-01-01', { fyFrom: null, fyTo: null }), true);
});

test('findMissingMasters: exact case-insensitive; empty known list = skip', () => {
  const known = ['Cash', 'Sales', 'Acme Corp'];
  assert.deepEqual(findMissingMasters(['cash', 'ACME CORP'], known), []);
  assert.deepEqual(findMissingMasters(['Cash', 'Ghost Ledger'], known), ['Ghost Ledger']);
  assert.deepEqual(findMissingMasters(['anything'], []), []); // unknown list → don't block
});

test('referencedLedgers collects entries + party + inventory accounting ledgers', () => {
  const v: VoucherInput = {
    voucherType: 'Sales', date: '2026-10-10', partyLedger: 'Acme Corp',
    entries: [{ ledger: 'Acme Corp', drCr: 'dr', amount: 118 }, { ledger: 'Sales', drCr: 'cr', amount: 118 }],
    inventory: [{ stockItem: 'Widget', quantity: 1, accountingLedger: 'Sales' }],
  };
  assert.deepEqual(referencedLedgers(v).sort(), ['Acme Corp', 'Acme Corp', 'Sales', 'Sales'].sort());
});

// ── executeVoucher rejection paths (return before touching Tally) ──────────
const balanced = [
  { ledger: 'Rent', drCr: 'dr' as const, amount: 100 },
  { ledger: 'Cash', drCr: 'cr' as const, amount: 100 },
];
const codeOf = (r: any) => r.structuredContent?.code;

test('UNBALANCED when debits != credits', async () => {
  const r = await executeVoucher({ voucherType: 'Journal', date: '2026-10-10', entries: [
    { ledger: 'Rent', drCr: 'dr', amount: 100 }, { ledger: 'Cash', drCr: 'cr', amount: 90 },
  ] });
  assert.equal(r.isError, true);
  assert.equal(codeOf(r), 'UNBALANCED');
});

test('OUT_OF_PERIOD when the date is outside the open period', async () => {
  const r = await executeVoucher(
    { voucherType: 'Journal', date: '2020-01-01', entries: balanced },
    { period: { fyFrom: '2026-04-01', fyTo: '2027-03-31', booksFrom: null } }
  );
  assert.equal(codeOf(r), 'OUT_OF_PERIOD');
});

test('MASTER_NOT_FOUND when a referenced ledger is not in the known list', async () => {
  const r = await executeVoucher(
    { voucherType: 'Journal', date: '2026-10-10', entries: balanced },
    { knownLedgers: ['Cash', 'Sales'] } // "Rent" missing
  );
  assert.equal(codeOf(r), 'MASTER_NOT_FOUND');
});

test('dryRun echoes the posting and posts nothing', async () => {
  const r = await executeVoucher({ voucherType: 'Journal', date: '2026-10-10', entries: balanced }, { dryRun: true });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.dryRun, true);
  assert.equal(out.balance.balanced, true);
  assert.match(out.xml, /<VOUCHER VCHTYPE="Journal"/);
});

test('idempotent replay returns the prior result without re-posting', async () => {
  const tmp = path.join(os.tmpdir(), `idem-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
  const store = makeIdempotencyStore(tmp);
  store.put('K1', { success: true, lastVchId: 42 }, '2026-10-10T00:00:00Z');
  const r = await executeVoucher(
    { voucherType: 'Journal', date: '2026-10-10', entries: balanced, idempotencyKey: 'K1' },
    { idempotency: { store, now: '2026-10-10T00:00:00Z' } }
  );
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.idempotentReplay, true);
  assert.equal((out.result as any).lastVchId, 42);
  try { fs.unlinkSync(tmp); } catch {}
});

// ── idempotency store persistence ──────────────────────────────────────────
test('idempotency store persists across instances', () => {
  const tmp = path.join(os.tmpdir(), `idem2-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
  makeIdempotencyStore(tmp).put('A', { ok: 1 }, 't');
  assert.equal(makeIdempotencyStore(tmp).get('A')?.result && (makeIdempotencyStore(tmp).get('A')!.result as any).ok, 1);
  assert.equal(makeIdempotencyStore(tmp).get('missing'), null);
  try { fs.unlinkSync(tmp); } catch {}
});
