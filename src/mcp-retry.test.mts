import assert from 'node:assert/strict';
import test from 'node:test';
import { retryForResult } from './mcp.mjs';

const noSleep = async () => {};

// #89 H-3: self-healing unlock retry.
test('succeeds on the Nth attempt and reports the count', async () => {
  let calls = 0;
  const { result, attempts } = await retryForResult<{ status: string }>(
    async () => { calls++; return { status: calls >= 3 ? 'success' : 'miss' }; },
    (r) => !!r && r.status === 'success',
    5, 1, noSleep
  );
  assert.equal(result?.status, 'success');
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
});

test('exhausts all attempts then returns the last (failed) value', async () => {
  let calls = 0;
  const { result, attempts } = await retryForResult<{ status: string }>(
    async () => { calls++; return { status: 'miss' }; },
    (r) => !!r && r.status === 'success',
    3, 1, noSleep
  );
  assert.equal(result?.status, 'miss'); // caller maps this to PASSWORD_REQUIRED
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
});

test('a thrown attempt is treated as a miss and retried', async () => {
  let calls = 0;
  const { result, attempts } = await retryForResult<{ status: string }>(
    async () => { calls++; if (calls < 2) throw new Error('agent blip'); return { status: 'success' }; },
    (r) => !!r && r.status === 'success',
    3, 1, noSleep
  );
  assert.equal(result?.status, 'success');
  assert.equal(attempts, 2);
});
