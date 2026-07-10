import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { reportColumnMetadata } from './tally.mjs';

// The voucher-lookup report is the keystone for cancel/delete/dedupe: it resolves a voucher's
// immutable master_id from a type+number match. These tests guard its config↔template contract
// (the live TDL query itself must be validated against a real Tally — see the PR notes).

test('voucher-lookup is declared with master_id first + the identity fields', () => {
  const fields = reportColumnMetadata('voucher-lookup');
  assert.ok(fields, 'voucher-lookup must be a declared pull report');
  const names = fields!.map(f => f.name);
  assert.deepEqual(names, [
    'master_id', 'date', 'voucher_number', 'voucher_type', 'reference', 'party_ledger', 'amount', 'is_cancelled'
  ]);
  assert.equal(fields![0].identifier, 'F01'); // master_id must be F01 — the id every write path keys on
});

const xml = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'voucher-lookup.xml'), 'utf-8');

test('voucher-lookup TDL filters by voucher number AND type and fetches MasterID + Reference', () => {
  assert.match(xml, /<TYPE>Voucher<\/TYPE>/);
  assert.match(xml, /FilterNumber">\$VoucherNumber = "\{voucherNumber\}"/);
  assert.match(xml, /FilterType">\$VoucherTypeName = "\{voucherType\}"/);
  assert.match(xml, /<SET>\$MasterID<\/SET>/);
  assert.match(xml, /<SET>\$Reference<\/SET>/);
  assert.match(xml, /<SVFROMDATE>\{fromDate\}<\/SVFROMDATE>/);
  assert.match(xml, /<SVTODATE>\{toDate\}<\/SVTODATE>/);
});

test('voucher-lookup INCLUDES cancelled vouchers (so stray cancelled rows can be located to clean up)', () => {
  // It must NOT carry the ledger-account-style cancelled filter, or the junk cancelled vouchers a
  // mis-matched reverse-voucher created would be invisible to a cleanup/delete.
  assert.equal(/FilterCancelledVouchers/.test(xml), false);
  assert.equal(/NOT \$IsCancelled/.test(xml), false);
  // optional (un-posted) vouchers are still excluded — they aren't real rows.
  assert.match(xml, /FilterOptionalVouchers">NOT \$IsOptional/);
});
