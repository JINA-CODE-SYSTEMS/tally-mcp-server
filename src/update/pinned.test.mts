import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateVerificationError } from './errors.mjs';
import { INITIAL_STATE, loadRootOfTrust } from './verify.mjs';
import { KEYS_URL, MANIFEST_URL, PINNED_ROOT, UPDATE_CHANNEL, keySetVersionUrl, refreshPinnedKeySet, verifyPinnedManifest } from './pinned.mjs';
import { keysDoc, manifestDoc, newKey, signKeys, signManifest } from './testkit.mjs';

// update-manifest.md §9 and §11: "A no-bypass test asserting that the production entrypoint accepts no
// key, threshold, URL or skip input." Plus source checks that nothing in the verification modules
// reads the environment or the command line, and that no production module imports the test kit.

function rejects(fn: () => unknown, code: string): UpdateVerificationError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof UpdateVerificationError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

const R = newKey();
const A = newKey();
const KEYS = signKeys(keysDoc({ version: 1, root: [R], release: [A] }), [R]);
const MANIFEST = signManifest(manifestDoc({ sequence: 1 }), [A]);

test('no root key is pinned yet, and nothing verifies until one is', () => {
  assert.equal(PINNED_ROOT.keys.length, 0, 'a root key was added to PINNED_ROOT: remove this assertion only as part of the root ceremony, never for a test key');
  rejects(() => loadRootOfTrust(PINNED_ROOT), 'ROOT_NOT_CONFIGURED');
  rejects(() => refreshPinnedKeySet({ state: INITIAL_STATE, keySetEnvelopes: [KEYS] }), 'ROOT_NOT_CONFIGURED');
  rejects(() => verifyPinnedManifest({ state: INITIAL_STATE, manifestEnvelope: MANIFEST }), 'ROOT_NOT_CONFIGURED');
});

test('the pinned root cannot be changed at run time', () => {
  assert.ok(Object.isFrozen(PINNED_ROOT));
  assert.ok(Object.isFrozen(PINNED_ROOT.keys));
  assert.throws(() => { (PINNED_ROOT.keys as unknown as unknown[]).push({ keyid: R.keyid, public_key: R.b64 }); }, TypeError);
  assert.throws(() => { (PINNED_ROOT as { threshold: number }).threshold = 0; }, TypeError);
  assert.equal(PINNED_ROOT.keys.length, 0);
});

test('the production entry points take no key, threshold, channel, clock, URL or skip input', () => {
  assert.equal(refreshPinnedKeySet.length, 1);
  assert.equal(verifyPinnedManifest.length, 1);
  const smuggled: Record<string, unknown>[] = [
    { root: { threshold: 1, keys: [{ keyid: R.keyid, public_key: R.b64 }] } },
    { keys: [R.b64] },
    { threshold: 0 },
    { now: new Date('2020-01-01T00:00:00Z') },
    { channel: 'beta' },
    { url: 'https://evil.example/' },
    { skipVerification: true },
    { insecure: true },
    { [Symbol('bypass')]: true },
  ];
  for (const extra of smuggled) {
    rejects(() => refreshPinnedKeySet({ state: INITIAL_STATE, keySetEnvelopes: [KEYS], ...extra } as never), 'INPUT_INVALID');
    rejects(() => verifyPinnedManifest({ state: INITIAL_STATE, manifestEnvelope: MANIFEST, ...extra } as never), 'INPUT_INVALID');
  }
});

test('channel and URLs are constants on the owner-decided host', () => {
  assert.equal(UPDATE_CHANNEL, 'stable');
  assert.equal(KEYS_URL, 'https://claudally.jinacode.systems/update/v1/keys.json');
  assert.equal(MANIFEST_URL, 'https://claudally.jinacode.systems/update/v1/stable/manifest.json');
  assert.equal(keySetVersionUrl(3), 'https://claudally.jinacode.systems/update/v1/keys/3.json');
  rejects(() => keySetVersionUrl(0), 'INPUT_INVALID');
  rejects(() => keySetVersionUrl(1.5), 'INPUT_INVALID');
});

// dist/update/pinned.test.mjs at run time; the sources are in <repo>/src/update.
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'update');
const productionSources = fs.readdirSync(srcDir)
  .filter((f) => f.endsWith('.mts') && !f.endsWith('.test.mts') && f !== 'testkit.mts')
  .map((f) => ({ f, text: fs.readFileSync(path.join(srcDir, f), 'utf8') }));

test('verification modules read no environment, command line or registry', () => {
  assert.ok(productionSources.length >= 6, `found ${productionSources.map((s) => s.f).join(', ')}`);
  for (const { f, text } of productionSources) {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [/\bprocess\s*\./, /\bprocess\s*\[/, /globalThis/, /node:child_process/, /\bimport\s*\(/, /\beval\s*\(/, /\bnew Function\b/, /NODE_TLS_REJECT_UNAUTHORIZED/]) {
      assert.doesNotMatch(code, forbidden, `${f} must not use ${forbidden}`);
    }
  }
});

test('no production module imports the test kit', () => {
  for (const { f, text } of productionSources) {
    assert.doesNotMatch(text, /testkit/, `${f} imports the test kit`);
  }
});
