import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { interpretDeleteResponse, decideDeleteGate } from './mcp.mjs';
import { buildDeleteVoucherXml } from './voucher.mjs';
import { reportColumnMetadata } from './tally.mjs';

const resp = (o: Partial<{ success: boolean; created: number; altered: number; cancelled: number; deleted: number; lastVchId: number; error: string }>) =>
  ({ success: false, created: 0, altered: 0, cancelled: 0, deleted: 0, lastVchId: 0, ...o });

test('buildDeleteVoucherXml keys a hard delete to the master_id (ACTION=Delete, no ISCANCELLED)', () => {
  const xml = buildDeleteVoucherXml({ masterId: '4321', voucherType: 'Payment', date: '2026-07-03' }, 'Ross');
  assert.match(xml, /<VOUCHER ACTION="Delete" VCHTYPE="Payment">/);
  assert.match(xml, /<MASTERID>4321<\/MASTERID>/);
  assert.match(xml, /<DATE>20260703<\/DATE>/);
  assert.match(xml, /<SVCURRENTCOMPANY>Ross<\/SVCURRENTCOMPANY>/);
  assert.equal(/ISCANCELLED/.test(xml), false); // a delete is not a cancel
});

test('buildDeleteVoucherXml omits DATE when not supplied (master_id is sufficient)', () => {
  const xml = buildDeleteVoucherXml({ masterId: '9', voucherType: 'Journal' });
  assert.match(xml, /<MASTERID>9<\/MASTERID>/);
  assert.equal(/<DATE>/.test(xml), false);
});

// The delete reason tag is deliberately NOT emitted (version-specific, unverified). Guard that so it
// isn't reintroduced without a live probe.
test('buildDeleteVoucherXml emits no delete-reason tag (pending live verification)', () => {
  const xml = buildDeleteVoucherXml({ masterId: '9', voucherType: 'Journal' });
  assert.equal(/AUDITDELETEDNARRATION|DELETEDREASON|REMOVALREASON/i.test(xml), false);
});

test('delete: DELETED>0 → deleted', () => {
  const o = interpretDeleteResponse(resp({ success: true, deleted: 1 }), '4321');
  assert.equal(o.status, 'deleted');
  assert.equal((o as any).deleted, 1);
});

test('delete: CREATED>0 → created_instead (never report a mis-keyed delete as success)', () => {
  const o = interpretDeleteResponse(resp({ success: true, created: 1 }), '4321');
  assert.equal(o.status, 'created_instead');
});

test('delete: nothing deleted → failed with a diagnostic (names master_id + hints at Edit Log)', () => {
  const o = interpretDeleteResponse(resp({ success: false }), '4321');
  assert.equal(o.status, 'failed');
  assert.match((o as any).message, /master_id 4321/);
});

// ── decideDeleteGate: the safety gate. 'proceed' (the only path that deletes) REQUIRES confirm:true
//    AND a master_id, so a destructive call can never be bound to a voucher number that Tally can renumber.
test('gate: dryRun always previews, even with confirm+masterId', () => {
  assert.equal(decideDeleteGate({ dryRun: true, confirm: true, hasMasterId: true }), 'dryRun');
});

test('gate: confirm:true + masterId → proceed (the ONLY delete path)', () => {
  assert.equal(decideDeleteGate({ confirm: true, hasMasterId: true }), 'proceed');
});

test('gate: confirm:true WITHOUT masterId → needs_confirm (number+confirm can never delete — the TOCTOU fix)', () => {
  assert.equal(decideDeleteGate({ confirm: true, hasMasterId: false }), 'needs_confirm');
});

test('gate: masterId WITHOUT confirm → needs_confirm', () => {
  assert.equal(decideDeleteGate({ confirm: false, hasMasterId: true }), 'needs_confirm');
});

test('gate: neither → needs_confirm', () => {
  assert.equal(decideDeleteGate({ hasMasterId: false }), 'needs_confirm');
});

// ── voucher-by-masterid report: verifies a master_id against Tally before an irreversible delete.
test('voucher-by-masterid report is declared with the identity fields and filters on $MasterID', () => {
  const fields = reportColumnMetadata('voucher-by-masterid');
  assert.ok(fields, 'voucher-by-masterid must be a declared pull report');
  assert.deepEqual(fields!.map(f => f.name), ['master_id', 'date', 'voucher_number', 'voucher_type', 'reference', 'party_ledger', 'amount', 'is_cancelled']);
  const xml = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'voucher-by-masterid.xml'), 'utf-8');
  assert.match(xml, /FilterMasterId">\$MasterID = \{masterId\}/); // numeric compare, unquoted
  assert.match(xml, /<TYPE>Voucher<\/TYPE>/);
});
