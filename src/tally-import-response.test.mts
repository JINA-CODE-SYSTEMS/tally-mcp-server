import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImportResponse } from './tally.mjs';

// parseImportResponse is the single decision point for every Tally import (create/alter/cancel/delete),
// shared by handlePush and pushXml. XMLParser is configured with parseTagValue:false, so every counter
// arrives as a STRING — these fixtures mirror that.
const R = (resp: Record<string, string>) => ({ RESPONSE: resp });

test('create success: CREATED>0 → success', () => {
  const r = parseImportResponse(R({ CREATED: '1', ALTERED: '0', LASTVCHID: '4321' }));
  assert.equal(r.success, true);
  assert.equal(r.created, 1);
  assert.equal(r.lastVchId, 4321);
  assert.equal(r.error, undefined);
});

test('alter success: ALTERED>0 → success', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '1' }));
  assert.equal(r.success, true);
  assert.equal(r.altered, 1);
});

// The core fix: a genuine cancel reports CANCELLED (not ALTERED). The old inline code never read
// CANCELLED, so it misclassified a real cancel as a no-op failure.
test('cancel-only success: CANCELLED>0 with created=altered=0 → success (was misread as failure)', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '0', CANCELLED: '1' }));
  assert.equal(r.success, true);
  assert.equal(r.cancelled, 1);
  assert.equal(r.error, undefined);
});

// The same fix for hard delete — a successful ACTION="Delete" returns DELETED=1, everything else 0.
test('delete-only success: DELETED>0 with created=altered=0 → success (unblocks delete-voucher)', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '0', DELETED: '1' }));
  assert.equal(r.success, true);
  assert.equal(r.deleted, 1);
});

test('true no-op: all four counters 0 → failure (voucher not located / nothing changed)', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '0', ERRORS: '0' }));
  assert.equal(r.success, false);
  assert.match(r.error!, /created=0, altered=0, cancelled=0, deleted=0/);
});

// The hard gate: errors>0 must fail EVEN IF a counter is non-zero, or the "errored op looks like
// success" inversion the fix must avoid would reappear.
test('errors>0 is a hard gate: fails even when cancelled>0', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '0', CANCELLED: '1', ERRORS: '2' }));
  assert.equal(r.success, false);
  assert.match(r.error!, /errors=2/);
});

test('missing RESPONSE element → failure with a clear message', () => {
  const r = parseImportResponse({});
  assert.equal(r.success, false);
  assert.match(r.error!, /Unexpected response format/);
});

// Fail loudly: the failure message must surface every raw counter, including the ones the old
// message dropped (cancelled/deleted/lastVchId).
test('failure message surfaces cancelled/deleted/lastVchId counters', () => {
  const r = parseImportResponse(R({ CREATED: '0', ALTERED: '0', EXCEPTIONS: '1', LASTVCHID: '9' }));
  assert.equal(r.success, false);
  assert.match(r.error!, /cancelled=0, deleted=0/);
  assert.match(r.error!, /lastVchId=9/);
});
