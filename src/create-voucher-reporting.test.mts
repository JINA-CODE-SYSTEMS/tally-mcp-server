import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImportResponse } from './tally.mjs';
import { rowResult } from './mcp.mjs';
import type { ToolResult } from './mcp.mjs';

// A create-voucher call can legitimately return CREATED=0, ALTERED=1.
//
// It happens on a RETRY of a voucher whose earlier attempt Tally rejected (e.g. "Ledger 'X' does not
// exist!"). deriveRemoteId is deterministic from (voucherType, reference), so the retry carries the same
// REMOTEID; Tally matches the binding the failed attempt left behind and completes the write as an alter
// of it, at the masterid that attempt reserved. Observed live: three vouchers reposted after their ledger
// names were repaired landed at masterids 14699/14700/14710 — 14699 + their index in the original batch —
// each reporting created:0. A fourth, whose ledger was still broken, never appeared at its predicted id.
//
// Reporting only `created` renders that as {success:true, created:0}: a write that reads as a no-op.
// A caller that retries on it duplicates a real accounting entry.
const R = (resp: Record<string, string>) => parseImportResponse({ RESPONSE: resp });

test('Tally reporting ALTERED with CREATED=0 is a success, not a failure', () => {
  const r = R({ CREATED: '0', ALTERED: '1', ERRORS: '0', LASTVCHID: '14710' });
  assert.equal(r.success, true);
  assert.equal(r.created, 0);
  assert.equal(r.altered, 1);
  assert.equal(r.lastVchId, 14710);
});

test('nothing touched at all is still a failure', () => {
  const r = R({ CREATED: '0', ALTERED: '0', ERRORS: '0', LASTVCHID: '0' });
  assert.equal(r.success, false);
});

test('a rejected post reports the exception and no id', () => {
  const r = R({ CREATED: '0', ALTERED: '0', ERRORS: '1', EXCEPTIONS: '1', LASTVCHID: '0' });
  assert.equal(r.success, false);
});

// ── the batch row is what a caller actually reads ──────────────────────────
const ok = (body: object): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] } as ToolResult);

test('a created:0 / altered:1 row reports written>0 so it cannot read as "not posted"', () => {
  const row = rowResult(0, ok({
    success: true, written: 1, created: 0, altered: 1, masterId: 14710, lastVchId: 14710,
    note: 'Tally ALTERED an existing binding rather than creating a new row',
  }));
  assert.equal(row.status, 'success');
  assert.equal(row.written, 1, 'the field a caller should branch on');
  assert.equal(row.created, 0);
  assert.equal(row.altered, 1, 'altered must survive into the row — dropping it caused the original confusion');
  assert.equal(row.masterId, 14710, 'identifies the voucher so it can be read back');
  assert.match(row.note ?? '', /ALTERED/);
});

test('written is derived when an older-shaped body omits it', () => {
  const row = rowResult(1, ok({ success: true, created: 1, altered: 0, lastVchId: 79454 }));
  assert.equal(row.written, 1);
  assert.equal(row.masterId, 79454);
});

test('an ordinary create still reports created:1', () => {
  const row = rowResult(2, ok({ success: true, written: 1, created: 1, altered: 0, masterId: 79482, lastVchId: 79482 }));
  assert.equal(row.written, 1);
  assert.equal(row.created, 1);
  assert.equal(row.note, undefined, 'no advisory note on the ordinary path');
});

test('a skipIfExists hit stays neither success nor failure', () => {
  const row = rowResult(3, ok({ skipped: true, reference: 'M05483' }));
  assert.equal(row.status, 'skipped');
  assert.equal(row.reference, 'M05483');
});
