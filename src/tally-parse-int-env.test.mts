import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIntEnv } from './utility.mjs';

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

// Security-relevant consumers (#64): a malformed value must fall back to the
// documented default rather than NaN, which would disable auth rate limiting or
// corrupt token-expiry math (Date.now() + NaN === NaN).
test('AUTH_RATE_LIMIT_MAX falls back to 10 on a bad value (rate limiting stays on)', () => {
  assert.equal(parseIntEnv('nope', 10), 10);
});

test('ACCESS_TOKEN_EXPIRY_SEC falls back to 3600 on a bad value (no NaN expiry)', () => {
  const expiresIn = parseIntEnv('', 3600);
  assert.equal(expiresIn, 3600);
  assert.ok(Number.isFinite(Date.now() + expiresIn * 1000));
});
