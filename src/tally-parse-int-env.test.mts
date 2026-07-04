import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIntEnv } from './tally.mjs';

test('returns the parsed value for a valid positive integer', () => {
  assert.equal(parseIntEnv('5000', 3000), 5000);
});

test('falls back when the env var is undefined', () => {
  assert.equal(parseIntEnv(undefined, 3000), 3000);
});

test('falls back on a non-numeric value (NaN would defeat setTimeout)', () => {
  assert.equal(parseIntEnv('not-a-number', 30000), 30000);
});

test('falls back on an empty string', () => {
  assert.equal(parseIntEnv('', 9000), 9000);
});

test('falls back on zero', () => {
  assert.equal(parseIntEnv('0', 3000), 3000);
});

test('falls back on a negative value', () => {
  assert.equal(parseIntEnv('-100', 3000), 3000);
});

test('parses the leading integer of a trailing-garbage value (parseInt semantics)', () => {
  assert.equal(parseIntEnv('5000ms', 3000), 5000);
});
