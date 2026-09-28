import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INITIAL_STATE, refreshKeySet, verifyManifest } from './verify.mjs';
import { DAY, bytesOf, keysDoc, manifestDoc, newKey, rootOf, signKeys, type TestKey } from './testkit.mjs';

// The offline signing script (update-manifest.md §10 step 7), driven end to end with throwaway keys.
// It uses the real clock, so these documents are dated around the real "now".

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'update', 'sign-manifest.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudally-sign-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const PASS = 'correct horse battery staple';
const now = new Date();
const R = newKey();
const A = newKey();
const B = newKey();

function encryptedPem(k: TestKey, passphrase = PASS): string {
  return k.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }) as string;
}
function write(name: string, data: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}
function run(args: string[], stdin: string) {
  return spawnSync(process.execPath, [script, ...args], { input: stdin, encoding: 'utf8' });
}

const keysDocNow = (release: TestKey[], threshold = 1) =>
  keysDoc({ version: 1, root: [R], release, releaseThreshold: threshold, issued: new Date(now.getTime() - DAY), expires: new Date(now.getTime() + 300 * DAY), releaseExpires: new Date(now.getTime() + 300 * DAY) });
const keysPath = write('keys.json', signKeys(keysDocNow([A]), [R]));
const payload = bytesOf(manifestDoc({ sequence: 7, issued: new Date(Math.floor(now.getTime() / 1000) * 1000 - DAY) }));
const payloadPath = write('manifest.payload.json', payload);
const keyA = write('release-a.pem', encryptedPem(A));

test('signs a manifest that verifies with the client module, byte-for-byte the given payload', () => {
  const out = path.join(dir, 'signed.json');
  const r = run(['--payload', payloadPath, '--key', keyA, '--keys', keysPath, '--out', out], `0.8.0\n${PASS}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Release version \.\.\. 0\.8\.0/);
  assert.match(r.stderr, /Signed\. The envelope verifies/);
  const state = refreshKeySet({ root: rootOf([R]), state: INITIAL_STATE, keySetEnvelopes: [fs.readFileSync(keysPath)], now }).state;
  const v = verifyManifest({ state, manifestEnvelope: fs.readFileSync(out), channel: 'stable', now });
  assert.equal(v.manifest.sequence, 7);
  assert.equal(Buffer.from(JSON.parse(fs.readFileSync(out, 'utf8')).payload, 'base64').equals(payload), true);
  assert.doesNotMatch(r.stderr + r.stdout, new RegExp(PASS), 'the passphrase is never echoed');
});

test('refuses when the typed version does not match, and writes nothing', () => {
  const out = path.join(dir, 'mistyped.json');
  const r = run(['--payload', payloadPath, '--key', keyA, '--keys', keysPath, '--out', out], `0.8.1\n${PASS}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED: the version typed/);
  assert.equal(fs.existsSync(out), false);
});

test('refuses an unencrypted key file', () => {
  const plain = write('plain.pem', A.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const r = run(['--payload', payloadPath, '--key', plain, '--keys', keysPath, '--out', path.join(dir, 'x1.json')], `0.8.0\n${PASS}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an encrypted PKCS#8 key/);
});

test('refuses a wrong passphrase, and leaves no placeholder behind', () => {
  const out = path.join(dir, 'x2.json');
  const r = run(['--payload', payloadPath, '--key', keyA, '--keys', keysPath, '--out', out], `0.8.0\nwrong\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not decrypt/);
  assert.equal(fs.existsSync(out), false);
});

test('refuses a key keys.json does not list as a release key (e.g. the root key)', () => {
  const rootPem = write('root.pem', encryptedPem(R));
  const r = run(['--payload', payloadPath, '--key', rootPem, '--keys', keysPath, '--out', path.join(dir, 'x3.json')], `0.8.0\n${PASS}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a release key/);
});

test('refuses an invalid payload before asking for anything', () => {
  const bad = manifestDoc({ sequence: 7 });
  bad.release.version = '0.8.0-rc.1';
  const r = run(['--payload', write('bad.json', bytesOf(bad)), '--key', keyA, '--keys', keysPath, '--out', path.join(dir, 'x4.json')], '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RELEASE_VERSION_INVALID/);
});

test('refuses to overwrite, unknown arguments, and --out equal to an input', () => {
  const exists = write('exists.json', '{}');
  assert.match(run(['--payload', payloadPath, '--key', keyA, '--keys', keysPath, '--out', exists], '').stderr, /already exists/);
  assert.match(run(['--payload', payloadPath, '--key', keyA, '--keys', keysPath, '--out', path.join(dir, 'y.json'), '--skip-verify', 'yes'], '').stderr, /unknown argument/);
  assert.equal(fs.readFileSync(exists, 'utf8'), '{}');
});

test('two holders sign in turn for a release threshold of 2', () => {
  const keys2 = write('keys2.json', signKeys(keysDocNow([A, B], 2), [R]));
  const keyB = write('release-b.pem', encryptedPem(B));
  const first = path.join(dir, 'first.json');
  const r1 = run(['--payload', payloadPath, '--key', keyA, '--keys', keys2, '--out', first], `0.8.0\n${PASS}\n`);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /threshold \(2\) is not met yet/);
  const second = path.join(dir, 'second.json');
  const r2 = run(['--envelope', first, '--key', keyB, '--keys', keys2, '--out', second], `0.8.0\n${PASS}\n`);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stderr, /Signed\. The envelope verifies/);
  // The same holder cannot sign twice.
  const r3 = run(['--envelope', second, '--key', keyB, '--keys', keys2, '--out', path.join(dir, 'third.json')], `0.8.0\n${PASS}\n`);
  assert.equal(r3.status, 1);
});

test('the signing script touches no network and writes no key', () => {
  const src = fs.readFileSync(script, 'utf8');
  for (const forbidden of [/node:(http|https|http2|net|tls|dgram|dns)\b/, /\bfetch\s*\(/, /WebSocket/, /child_process/, /\.export\s*\(/]) {
    assert.doesNotMatch(src, forbidden, `sign-manifest.mjs must not use ${forbidden}`);
  }
  // Exactly one write, of the envelope, through the descriptor --out was created with (exclusively).
  assert.deepEqual(src.match(/fs\.\w*[wW]rite\w*\(/g), ['fs.writeSync(']);
  assert.match(src, /fs\.writeSync\(outFd, envelope, off\)/);
  assert.deepEqual(src.match(/fs\.openSync\([^)]*\)/g), ["fs.openSync(out, 'wx')"]);
});
