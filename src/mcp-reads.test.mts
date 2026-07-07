import assert from 'node:assert/strict';
import test from 'node:test';
import { rowCount, filterMasterRows } from './mcp.mjs';

// ── rowCount (#92 H-6) ─────────────────────────────────────────────────────
test('rowCount: empty read yields 0, non-empty yields the length', () => {
  assert.equal(rowCount([]), 0);
  assert.equal(rowCount([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 3);
});

test('rowCount: non-arrays (null/undefined/object) yield 0', () => {
  assert.equal(rowCount(null), 0);
  assert.equal(rowCount(undefined), 0);
  assert.equal(rowCount({ name: 'A' } as unknown), 0);
});

// ── filterMasterRows (#93 H-7) ─────────────────────────────────────────────
const rows = [
  { name: 'Cash' },
  { name: 'Bank of Baroda' },
  { name: 'HDFC Bank' },
  { name: 'Sales' },
  { name: 'Bank Charges' }
];

test('substring match is case-insensitive and preserves source order (no ranking)', () => {
  const r = filterMasterRows(rows, 'bank');
  assert.deepEqual(r.map(x => x.name), ['Bank of Baroda', 'HDFC Bank', 'Bank Charges']);
});

test('prefix mode matches only the start of the name', () => {
  const r = filterMasterRows(rows, 'bank', 'prefix');
  assert.deepEqual(r.map(x => x.name), ['Bank of Baroda', 'Bank Charges']); // "HDFC Bank" excluded
});

test('blank/whitespace query returns all rows unchanged (like list-master)', () => {
  assert.equal(filterMasterRows(rows, '').length, rows.length);
  assert.equal(filterMasterRows(rows, '   ').length, rows.length);
});

test('no match yields an empty array (count 0), not a failure', () => {
  const r = filterMasterRows(rows, 'zzz');
  assert.equal(r.length, 0);
  assert.equal(rowCount(r), 0);
});

test('falls back to the first column when there is no name field', () => {
  const noName = [{ ledger: 'Cash' }, { ledger: 'Bank' }];
  const r = filterMasterRows(noName, 'bank');
  assert.deepEqual(r.map(x => x.ledger), ['Bank']);
});
