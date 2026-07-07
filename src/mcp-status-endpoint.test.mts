import assert from 'node:assert/strict';
import test from 'node:test';
import { isStatusEndpointEnabled, getServerVersion } from './mcp.mjs';

test('status endpoint is disabled by default (undefined/empty)', () => {
  assert.equal(isStatusEndpointEnabled(undefined), false);
  assert.equal(isStatusEndpointEnabled(''), false);
});

test('status endpoint enabled by "1" or "true" (case-insensitive)', () => {
  assert.equal(isStatusEndpointEnabled('1'), true);
  assert.equal(isStatusEndpointEnabled('true'), true);
  assert.equal(isStatusEndpointEnabled('TRUE'), true);
  assert.equal(isStatusEndpointEnabled('  1 '), true);
});

test('status endpoint stays disabled for other values', () => {
  assert.equal(isStatusEndpointEnabled('0'), false);
  assert.equal(isStatusEndpointEnabled('yes'), false);
  assert.equal(isStatusEndpointEnabled('public'), false);
});

test('getServerVersion returns the package.json version (semver-ish)', () => {
  const v = getServerVersion();
  assert.equal(typeof v, 'string');
  assert.match(v, /^\d+\.\d+\.\d+/);
});
