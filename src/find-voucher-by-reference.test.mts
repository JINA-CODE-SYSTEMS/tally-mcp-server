import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { reportColumnMetadata } from './tally.mjs';

// find-voucher-by-reference underpins reference-keyed dedupe: a non-empty result means the bank
// instrument reference is already booked. These guard the config↔template contract (the live TDL
// query must be validated against a real Tally).

test('find-voucher-by-reference is declared with master_id first + identity fields', () => {
  const fields = reportColumnMetadata('find-voucher-by-reference');
  assert.ok(fields, 'must be a declared pull report');
  assert.deepEqual(fields!.map(f => f.name), ['master_id', 'date', 'voucher_number', 'voucher_type', 'reference', 'party_ledger', 'amount']);
});

const xml = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'find-voucher-by-reference.xml'), 'utf-8');

test('filters on $Reference equality and fetches MasterID', () => {
  assert.match(xml, /FilterReference">\$Reference = "\{reference\}"/);
  assert.match(xml, /<SET>\$MasterID<\/SET>/);
  assert.match(xml, /<TYPE>Voucher<\/TYPE>/);
});

test('EXCLUDES cancelled + optional vouchers (only LIVE duplicates count for dedupe)', () => {
  assert.match(xml, /FilterCancelledVouchers">NOT \$IsCancelled/);
  assert.match(xml, /FilterOptionalVouchers">NOT \$IsOptional/);
});
