import assert from 'node:assert/strict';
import test from 'node:test';
import { probeWithRetry, getTallyRequirements } from './mcp.mjs';

test('getTallyRequirements lists the hard external preconditions', () => {
  const reqs = getTallyRequirements();
  assert.ok(Array.isArray(reqs) && reqs.length >= 3);
  for (const r of reqs) {
    assert.equal(typeof r.requirement, 'string');
    assert.equal(typeof r.why, 'string');
    assert.ok(r.requirement.length > 0 && r.why.length > 0);
  }
  const blob = JSON.stringify(reqs).toLowerCase();
  // Was asserting on the word "xml". That let the requirement be phrased in a way only an engineer
  // could act on, which is exactly how a first-time user ended up stuck: Tally ships with this
  // connection OFF and nothing told them where the setting lives. Assert on the click-path instead —
  // it is the part that has to survive an edit.
  assert.ok(blob.includes('connectivity'), 'names the Tally menu where the connection is switched on');
  assert.ok(blob.includes('9000'), 'names the port to set');
  assert.ok(blob.includes('agent'), 'mentions the GUI agent requirement');
});

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
