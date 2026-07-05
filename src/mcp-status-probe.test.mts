import assert from 'node:assert/strict';
import test from 'node:test';
import { probeWithRetry } from './mcp.mjs';

const noSleep = async () => {};

test('returns true on first success without further attempts', async () => {
  let calls = 0;
  const ok = await probeWithRetry(async () => { calls++; return true; }, 3, 0, noSleep);
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test('absorbs a single transient miss then succeeds (no flap)', async () => {
  let calls = 0;
  const ok = await probeWithRetry(async () => { calls++; return calls >= 2; }, 3, 0, noSleep);
  assert.equal(ok, true);
  assert.equal(calls, 2);
});

test('reports false only after all attempts miss', async () => {
  let calls = 0;
  const ok = await probeWithRetry(async () => { calls++; return false; }, 3, 0, noSleep);
  assert.equal(ok, false);
  assert.equal(calls, 3);
});

test('a throwing probe counts as a miss, not a crash', async () => {
  let calls = 0;
  const ok = await probeWithRetry(async () => { calls++; if (calls < 3) throw new Error('blip'); return true; }, 3, 0, noSleep);
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('two consecutive probes over a transient blip agree (stable status)', async () => {
  // Simulate a source that misses once at the start of each call but is really up.
  const makeFlappy = () => { let n = 0; return async () => { n++; return n >= 2; }; };
  const a = await probeWithRetry(makeFlappy(), 3, 0, noSleep);
  const b = await probeWithRetry(makeFlappy(), 3, 0, noSleep);
  assert.equal(a, b);
  assert.equal(a, true);
});
