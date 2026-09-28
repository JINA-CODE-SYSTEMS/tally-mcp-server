// The artifact half of verification (#177, update-manifest.md §6 steps 7–9): the downloaded
// installer must be exactly the manifest's `size` bytes with exactly its SHA-256, and — when the
// root-signed policy or the latch says so — carry an Authenticode signature by a pinned signer.
//
// Hashing is streaming: at most `size` + 1 bytes are ever read, so an over-long file (or an endless
// download, A9) is refused as soon as it passes the pinned size, and the file is never held in memory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { UpdateVerificationError } from './errors.mjs';
import type { AuthenticodePolicy } from './verify.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** What the manifest pins about the artifact. */
export interface ArtifactPin {
  readonly size: number;
  readonly sha256: string;
}

function checkPin(pin: ArtifactPin): void {
  if (typeof pin !== 'object' || pin === null || !Number.isSafeInteger(pin.size) || pin.size < 1 || typeof pin.sha256 !== 'string' || !SHA256_RE.test(pin.sha256)) {
    throw new UpdateVerificationError('INPUT_INVALID', 'artifact pin must be { size: positive integer, sha256: 64 lowercase hex }');
  }
}

/**
 * Hashes an artifact as its bytes arrive — for the downloader, over the bytes as they are written
 * (§6 step 7), and for verifyArtifactFile. `update` throws as soon as more than `size` bytes have
 * been seen; `finish` requires exactly `size` bytes and the pinned digest.
 */
export class ArtifactDigest {
  private readonly hash = crypto.createHash('sha256');
  private seen = 0;
  private done = false;

  constructor(private readonly pin: ArtifactPin) {
    checkPin(pin);
  }

  get bytesSeen(): number {
    return this.seen;
  }

  update(chunk: Uint8Array): void {
    if (this.done) throw new UpdateVerificationError('INPUT_INVALID', 'artifact digest already finished');
    this.seen += chunk.length;
    if (this.seen > this.pin.size) {
      this.done = true;
      throw new UpdateVerificationError('ARTIFACT_SIZE_MISMATCH', `artifact is longer than the pinned ${this.pin.size} bytes`, {
        expected: this.pin.size, atLeast: this.seen, direction: 'long',
      });
    }
    this.hash.update(chunk);
  }

  finish(): void {
    if (this.done) throw new UpdateVerificationError('INPUT_INVALID', 'artifact digest already finished');
    this.done = true;
    if (this.seen !== this.pin.size) {
      throw new UpdateVerificationError('ARTIFACT_SIZE_MISMATCH', `artifact is ${this.seen} bytes; the manifest pins ${this.pin.size}`, {
        expected: this.pin.size, actual: this.seen, direction: 'short',
      });
    }
    const actual = this.hash.digest();
    const expected = Buffer.from(this.pin.sha256, 'hex');
    if (!crypto.timingSafeEqual(actual, expected)) {
      throw new UpdateVerificationError('ARTIFACT_HASH_MISMATCH', 'artifact SHA-256 does not match the manifest', {
        expected: this.pin.sha256, actual: actual.toString('hex'),
      });
    }
  }
}

/**
 * Verifies a file on disk against the manifest's pin, streaming. Pass the FileHandle the updater is
 * holding open (§6 step 9: re-hash immediately before execution, with write sharing denied) to hash
 * exactly the file that will run; the handle is left open. A path is opened and closed here.
 */
export async function verifyArtifactFile(file: string | FileHandle, pin: ArtifactPin): Promise<void> {
  const digest = new ArtifactDigest(pin);
  // `end` is inclusive: reading bytes 0..size gives at most size + 1, enough to see "one too many".
  const range = { start: 0, end: pin.size };
  let stream: fs.ReadStream;
  try {
    stream = typeof file === 'string'
      ? fs.createReadStream(file, range)
      : (file.createReadStream({ ...range, autoClose: false }) as unknown as fs.ReadStream);
  } catch (e) {
    throw new UpdateVerificationError('ARTIFACT_UNREADABLE', `cannot read the artifact: ${(e as Error).message}`);
  }
  try {
    for await (const chunk of stream) digest.update(chunk as Buffer);
  } catch (e) {
    stream.destroy();
    if (e instanceof UpdateVerificationError) throw e;
    throw new UpdateVerificationError('ARTIFACT_UNREADABLE', `cannot read the artifact: ${(e as Error).message}`);
  }
  digest.finish();
}

/**
 * What `WinVerifyTrust` (with revocation checking on) reported for the staged file. Produced by the
 * Windows side once #175 lands; this module only applies the policy to it.
 */
export type AuthenticodeObservation =
  | { readonly status: 'unsigned' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'revocation-unavailable' }
  | { readonly status: 'valid'; readonly subject: string; readonly issuerCaSha256: string; readonly timestamped: boolean };

/**
 * §6 step 8. `policy` is the effective one from verifyManifest (latch or key-set requirement).
 *
 * - Required: the signature must be valid, by a pinned signer (subject and issuing CA), with a
 *   timestamp countersignature where that signer requires one.
 * - Not required, but signed: the signature must still be valid and, if signers are pinned, match
 *   one — a file signed by someone else is rejected even before #175.
 * - Revocation status unavailable: defer, quietly. Never a pass.
 */
export function checkAuthenticode(policy: AuthenticodePolicy, observed: AuthenticodeObservation): void {
  switch (observed.status) {
    case 'revocation-unavailable':
      throw new UpdateVerificationError('AUTHENTICODE_REVOCATION_UNAVAILABLE', 'could not confirm the signing certificate has not been revoked');
    case 'invalid':
      throw new UpdateVerificationError('AUTHENTICODE_INVALID', `Authenticode signature is not valid: ${observed.reason}`);
    case 'unsigned':
      if (policy.required) throw new UpdateVerificationError('AUTHENTICODE_UNSIGNED', 'the installer is not Authenticode-signed and policy requires it');
      return;
    case 'valid': {
      if (!policy.required && policy.signers.length === 0) return;
      const signer = policy.signers.find((s) => s.subject === observed.subject && s.issuerCaSha256.includes(observed.issuerCaSha256.toLowerCase()));
      if (!signer) {
        throw new UpdateVerificationError('AUTHENTICODE_SIGNER_MISMATCH', `signed by "${observed.subject}", which is not a pinned signer`, {
          subject: observed.subject, issuerCaSha256: observed.issuerCaSha256,
        });
      }
      if (signer.requireTimestamp && !observed.timestamped) {
        throw new UpdateVerificationError('AUTHENTICODE_NO_TIMESTAMP', 'the signature has no timestamp countersignature and the policy requires one');
      }
      return;
    }
    default:
      throw new UpdateVerificationError('INPUT_INVALID', 'unknown Authenticode observation');
  }
}
