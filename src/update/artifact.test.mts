import assert from 'node:assert/strict';
import test, { describe, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateVerificationError } from './errors.mjs';
import { ArtifactDigest, checkAuthenticode, verifyArtifactFile, type AuthenticodeObservation } from './artifact.mjs';
import type { AuthenticodePolicy } from './verify.mjs';
import { ARTIFACT_BYTES, ARTIFACT_SHA256 } from './testkit.mjs';

// update-manifest.md §6 steps 7–9 and the artifact items of §11: exact size, exact SHA-256, short by
// one byte, long by one byte, and the Authenticode policy.

async function rejectsAsync(p: Promise<unknown>, code: string, surface?: string): Promise<UpdateVerificationError> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  assert.ok(caught instanceof UpdateVerificationError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (surface) assert.equal(caught.surface, surface);
  return caught;
}
function rejects(fn: () => unknown, code: string, surface?: string): UpdateVerificationError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof UpdateVerificationError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (surface) assert.equal(caught.surface, surface);
  return caught;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudally-artifact-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
function file(name: string, bytes: Uint8Array): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}
const PIN = { size: ARTIFACT_BYTES.length, sha256: ARTIFACT_SHA256 };

describe('artifact size and hash', () => {
  test('the exact file verifies', async () => {
    await verifyArtifactFile(file('good.exe', ARTIFACT_BYTES), PIN);
  });

  test('verifies through an open FileHandle and leaves it open (step 9: hash what will run)', async () => {
    const handle = await fsp.open(file('held.exe', ARTIFACT_BYTES), 'r');
    try {
      await verifyArtifactFile(handle, PIN);
      const { bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
      assert.equal(bytesRead, 2, 'handle still usable');
    } finally {
      await handle.close();
    }
  });

  test('hash mismatch: same size, one byte different', async () => {
    const bytes = Buffer.from(ARTIFACT_BYTES);
    bytes[bytes.length - 1] ^= 0xff;
    const err = await rejectsAsync(verifyArtifactFile(file('tampered.exe', bytes), PIN), 'ARTIFACT_HASH_MISMATCH', 'verification-failed');
    assert.equal(err.details.expected, ARTIFACT_SHA256);
  });

  test('truncated file: short by one byte', async () => {
    const err = await rejectsAsync(verifyArtifactFile(file('short.exe', ARTIFACT_BYTES.subarray(0, -1)), PIN), 'ARTIFACT_SIZE_MISMATCH', 'verification-failed');
    assert.equal(err.details.direction, 'short');
    assert.equal(err.details.actual, ARTIFACT_BYTES.length - 1);
  });

  test('empty file', async () => {
    await rejectsAsync(verifyArtifactFile(file('empty.exe', Buffer.alloc(0)), PIN), 'ARTIFACT_SIZE_MISMATCH');
  });

  test('long by one byte (even when the extra byte leaves the prefix hash intact)', async () => {
    const err = await rejectsAsync(verifyArtifactFile(file('long.exe', Buffer.concat([ARTIFACT_BYTES, Buffer.from([0])])), PIN), 'ARTIFACT_SIZE_MISMATCH');
    assert.equal(err.details.direction, 'long');
  });

  test('a far larger file is refused after reading at most size + 1 bytes (A9)', async () => {
    const big = file('big.exe', crypto.randomBytes(4 * 1024 * 1024));
    const err = await rejectsAsync(verifyArtifactFile(big, { size: 1000, sha256: '0'.repeat(64) }), 'ARTIFACT_SIZE_MISMATCH');
    assert.equal(err.details.atLeast, 1001);
  });

  test('size mismatch against a right-sized pin with the wrong size', async () => {
    await rejectsAsync(verifyArtifactFile(file('good2.exe', ARTIFACT_BYTES), { ...PIN, size: PIN.size + 1 }), 'ARTIFACT_SIZE_MISMATCH');
  });

  test('a missing file is our problem, not a verification pass', async () => {
    await rejectsAsync(verifyArtifactFile(path.join(dir, 'nope.exe'), PIN), 'ARTIFACT_UNREADABLE', 'internal');
  });

  test('a malformed pin is refused', async () => {
    await rejectsAsync(verifyArtifactFile(file('good3.exe', ARTIFACT_BYTES), { size: PIN.size, sha256: PIN.sha256.toUpperCase() }), 'INPUT_INVALID');
    await rejectsAsync(verifyArtifactFile(file('good4.exe', ARTIFACT_BYTES), { size: 0, sha256: PIN.sha256 }), 'INPUT_INVALID');
  });

  test('streaming digest (for hashing a download as it is written): chunked input, exact cap', () => {
    const d = new ArtifactDigest(PIN);
    for (let i = 0; i < ARTIFACT_BYTES.length; i += 7) d.update(ARTIFACT_BYTES.subarray(i, i + 7));
    d.finish();

    const over = new ArtifactDigest(PIN);
    over.update(ARTIFACT_BYTES);
    rejects(() => over.update(Buffer.from([1])), 'ARTIFACT_SIZE_MISMATCH');

    const twice = new ArtifactDigest(PIN);
    twice.update(ARTIFACT_BYTES);
    twice.finish();
    rejects(() => twice.finish(), 'INPUT_INVALID');
  });
});

describe('Authenticode policy (step 8; the WinVerifyTrust call itself lands with #175)', () => {
  const CA = 'c'.repeat(64);
  const signer = { subject: 'CN=JINA CODE SYSTEMS LLP', issuerCaSha256: [CA], requireTimestamp: true };
  const required: AuthenticodePolicy = { required: true, signers: [signer] };
  const phase0: AuthenticodePolicy = { required: false, signers: [] };
  const phase0pinned: AuthenticodePolicy = { required: false, signers: [signer] };
  const ok: AuthenticodeObservation = { status: 'valid', subject: signer.subject, issuerCaSha256: CA, timestamped: true };

  test('required: a valid signature by a pinned signer with a timestamp passes', () => {
    checkAuthenticode(required, ok);
    checkAuthenticode(required, { ...ok, issuerCaSha256: CA.toUpperCase() });
  });

  test('required but unsigned', () => {
    rejects(() => checkAuthenticode(required, { status: 'unsigned' }), 'AUTHENTICODE_UNSIGNED', 'verification-failed');
  });

  test('signed by the wrong subject, or through the wrong CA', () => {
    rejects(() => checkAuthenticode(required, { ...ok, subject: 'CN=Someone Else' }), 'AUTHENTICODE_SIGNER_MISMATCH');
    rejects(() => checkAuthenticode(required, { ...ok, subject: 'CN=JINA CODE SYSTEMS LLP ' }), 'AUTHENTICODE_SIGNER_MISMATCH');
    rejects(() => checkAuthenticode(required, { ...ok, issuerCaSha256: 'd'.repeat(64) }), 'AUTHENTICODE_SIGNER_MISMATCH');
  });

  test('timestamp required but absent', () => {
    rejects(() => checkAuthenticode(required, { ...ok, timestamped: false }), 'AUTHENTICODE_NO_TIMESTAMP');
    checkAuthenticode({ required: true, signers: [{ ...signer, requireTimestamp: false }] }, { ...ok, timestamped: false });
  });

  test('an invalid signature is refused whether or not Authenticode is required', () => {
    rejects(() => checkAuthenticode(required, { status: 'invalid', reason: 'hash mismatch' }), 'AUTHENTICODE_INVALID');
    rejects(() => checkAuthenticode(phase0, { status: 'invalid', reason: 'hash mismatch' }), 'AUTHENTICODE_INVALID');
  });

  test('revocation server unreachable defers quietly and is never a pass', () => {
    const err = rejects(() => checkAuthenticode(required, { status: 'revocation-unavailable' }), 'AUTHENTICODE_REVOCATION_UNAVAILABLE', 'deferred');
    assert.equal(err.loud, false);
    rejects(() => checkAuthenticode(phase0, { status: 'revocation-unavailable' }), 'AUTHENTICODE_REVOCATION_UNAVAILABLE');
  });

  test('phase 0: unsigned is fine; signed by someone else is refused once signers are pinned', () => {
    checkAuthenticode(phase0, { status: 'unsigned' });
    checkAuthenticode(phase0, { ...ok, subject: 'CN=Anyone' });
    checkAuthenticode(phase0pinned, { status: 'unsigned' });
    checkAuthenticode(phase0pinned, ok);
    rejects(() => checkAuthenticode(phase0pinned, { ...ok, subject: 'CN=Someone Else' }), 'AUTHENTICODE_SIGNER_MISMATCH');
  });

  test('an observation of unknown shape is refused', () => {
    rejects(() => checkAuthenticode(phase0, { status: 'skipped' } as unknown as AuthenticodeObservation), 'INPUT_INVALID');
  });
});
