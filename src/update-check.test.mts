import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, checkForUpdates, formatUpdateCheck, RELEASES_PAGE_URL } from './update-check.mjs';

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10 is newer than 0.9');
  assert.equal(compareVersions('v0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0, 'an rc never reads as newer than its release');
  assert.equal(compareVersions('0.9', '0.9.1'), -1);
});

test('a newer release is reported with how to update', async () => {
  const r = await checkForUpdates('0.9.0', { env: {}, fetchImpl: answer(200, { tag_name: 'v0.10.0' }) });
  assert.deepEqual(r, { status: 'update-available', installed: '0.9.0', latest: '0.10.0' });
  const text = formatUpdateCheck(r);
  assert.match(text, /0\.10\.0/);
  assert.match(text, /Connect your AI assistant to Tally/);
  assert.ok(text.includes(RELEASES_PAGE_URL));
});

test('same or older release is up to date', async () => {
  assert.equal((await checkForUpdates('0.10.0', { env: {}, fetchImpl: answer(200, { tag_name: 'v0.10.0' }) })).status, 'up-to-date');
  assert.equal((await checkForUpdates('0.11.0', { env: {}, fetchImpl: answer(200, { tag_name: 'v0.10.0' }) })).status, 'up-to-date');
});

test('UPDATE_CHECK=false makes no network call at all', async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
  const r = await checkForUpdates('0.10.0', { env: { UPDATE_CHECK: 'False ' }, fetchImpl: spy });
  assert.equal(r.status, 'disabled');
  assert.equal(called, false);
});

test('errors, odd answers and hostile tags become "could not check", never a link from the response', async () => {
  const thrower = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.equal((await checkForUpdates('0.10.0', { env: {}, fetchImpl: thrower })).status, 'unreachable');
  assert.equal((await checkForUpdates('0.10.0', { env: {}, fetchImpl: answer(403, {}) })).status, 'unreachable');
  const hostile = await checkForUpdates('0.10.0', { env: {}, fetchImpl: answer(200, { tag_name: 'v9.9.9 see https://evil.example' }) });
  assert.equal(hostile.status, 'unreachable');
  assert.ok(!formatUpdateCheck(hostile).includes('evil'));
});
