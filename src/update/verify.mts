// Verification core of the signed update channel (#177).
//
// Implements docs/dev/update-manifest.md §6 steps 1, 2, 4 and 5 — trust anchors, key-set refresh,
// manifest verification and the install decision — as pure functions over bytes. Fetching,
// downloading, waiting and applying are not here; the artifact check (steps 7 and 9) and the
// Authenticode policy check (step 8) are in artifact.mts.
//
// NO BYPASS (§9). Every check below runs on every call. There is no option, flag, environment
// variable or "test mode" that skips, relaxes or reorders one: tests reach the failure paths by
// constructing inputs (their own throwaway key hierarchy, their own clock value), never by a switch.
// Root keys arrive as a function argument so tests can supply a test hierarchy; the production entry
// point (pinned.mts) binds them to compiled-in constants and accepts no key, threshold or URL input.
//
// Anything unexpected fails closed with a typed UpdateVerificationError (errors.mts): unknown or
// missing fields, duplicate JSON keys, duplicate key ids, non-canonical base64, a threshold not met,
// expired metadata, version or sequence rollback, a key id that does not match its key, a payload
// type that does not match the document.

import crypto, { type KeyObject } from 'node:crypto';
import { parseStrictJson, StrictJsonError, type JsonValue } from './strict-json.mjs';
import { UpdateVerificationError, type UpdateErrorCode } from './errors.mjs';
import {
  KEYS_PAYLOAD_TYPE,
  MANIFEST_PAYLOAD_TYPE,
  bytesEqual,
  decodeCanonicalBase64,
  digestEquals,
  ed25519PublicKeyFromRaw,
  keyIdOf,
  parseEnvelope,
  requireThreshold,
  type Envelope,
  type RoleKey,
} from './dsse.mjs';

export const KEYS_DOCUMENT_TYPE = 'claudally.update.keys';
export const MANIFEST_DOCUMENT_TYPE = 'claudally.update.manifest';
export const SPEC_VERSION = 1;

/** §4.3 `issued`: rejected if more than 1 hour in the future. */
export const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;
/** §4.3 `expires`: 45 days after `issued` (owner decision §13.7). A longer-lived manifest is refused. */
export const MAX_MANIFEST_LIFETIME_MS = 45 * 24 * 60 * 60 * 1000;

const KEYID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MAX_STRING = 1024;

// ─── Public types ──────────────────────────────────────────────────────────────────────────────

/** A root public key as pinned in the client: the same shape as a `keys.json` key entry. */
export interface PinnedKey {
  readonly keyid: string;
  /** base64 of the raw 32-byte Ed25519 public key. */
  readonly public_key: string;
}

/** The compiled-in trust anchor (§6 step 1). */
export interface RootOfTrust {
  readonly threshold: number;
  readonly keys: readonly PinnedKey[];
}

export interface AuthenticodeSigner {
  /** Exact subject DN. */
  readonly subject: string;
  /** SHA-256 (lowercase hex) of each acceptable issuing CA certificate. */
  readonly issuerCaSha256: readonly string[];
  readonly requireTimestamp: boolean;
}

export interface AuthenticodePolicy {
  readonly required: boolean;
  readonly signers: readonly AuthenticodeSigner[];
}

export interface TrustedKey extends RoleKey {
  readonly holder: string;
}

export interface ReleaseKey extends TrustedKey {
  readonly expires: Date;
}

/** A verified `keys.json` (§4.2). */
export interface KeySet {
  readonly version: number;
  readonly issued: Date;
  readonly expires: Date;
  readonly root: { readonly threshold: number; readonly keys: readonly TrustedKey[] };
  readonly release: { readonly threshold: number; readonly keys: readonly ReleaseKey[] };
  readonly revokedKeyIds: ReadonlySet<string>;
  readonly channels: readonly string[];
  readonly authenticode: AuthenticodePolicy;
}

/** A verified `manifest.json` (§4.3). */
export interface Manifest {
  readonly channel: string;
  readonly sequence: number;
  readonly issued: Date;
  readonly expires: Date;
  readonly minKeysVersion: number;
  readonly release: {
    readonly version: string;
    readonly upgradeFromMin: string;
    readonly artifact: { readonly url: string; readonly size: number; readonly sha256: string };
    readonly provenance: { readonly tag: string; readonly commit: string; readonly workflow: string; readonly buildSha256: string };
    readonly notesUrl: string;
  };
  readonly securityFloor: string;
  readonly blockedVersions: readonly string[];
  readonly advisory: { readonly id: string; readonly summary: string; readonly url: string } | null;
}

/**
 * The verification-relevant part of `%ProgramData%\Claudally\update\state.json` (§6). Plain JSON, so
 * the updater can persist exactly what it gets back. It is trusted only because of where it lives
 * (SYSTEM + Administrators write); it is still re-checked for consistency on every load.
 */
export interface UpdateState {
  /** The trusted key set: base64 of the exact `keys.json` envelope bytes that were verified. */
  readonly keySet: { readonly envelope: string } | null;
  /** The highest manifest accepted on this channel. */
  readonly manifest: {
    readonly channel: string;
    readonly sequence: number;
    /** SHA-256 of the manifest payload bytes, for "equal sequence only if byte-identical". */
    readonly payloadSha256: string;
    /** When that manifest expires: the tray turns red once it has (§8, "Stale"). */
    readonly expires: string;
  } | null;
  /** §9.6: once set by a key set with `authenticode.required = true`, never cleared. */
  readonly authenticodeLatched: boolean;
}

export const INITIAL_STATE: UpdateState = Object.freeze({ keySet: null, manifest: null, authenticodeLatched: false });

// ─── Small validators ──────────────────────────────────────────────────────────────────────────

class Doc {
  constructor(readonly code: UpdateErrorCode, readonly name: string) {}

  fail(path: string, why: string, code: UpdateErrorCode = this.code): never {
    throw new UpdateVerificationError(code, `${this.name}: ${path} ${why}`, { path });
  }

  object(v: unknown, path: string, fields: readonly string[]): Record<string, JsonValue> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail(path, 'must be an object');
    const o = v as Record<string, JsonValue>;
    const keys = Object.keys(o);
    const unknown = keys.filter((k) => !fields.includes(k));
    if (unknown.length) this.fail(path, `has unknown field(s): ${unknown.join(', ')}`);
    const missing = fields.filter((f) => !keys.includes(f));
    if (missing.length) this.fail(path, `is missing field(s): ${missing.join(', ')}`);
    return o;
  }

  array(v: unknown, path: string, opts: { min?: number; max?: number } = {}): JsonValue[] {
    if (!Array.isArray(v)) this.fail(path, 'must be an array');
    if (opts.min !== undefined && v.length < opts.min) this.fail(path, `must have at least ${opts.min} entr${opts.min === 1 ? 'y' : 'ies'}`);
    if (opts.max !== undefined && v.length > opts.max) this.fail(path, `must have at most ${opts.max} entries`);
    return v;
  }

  string(v: unknown, path: string, re?: RegExp): string {
    if (typeof v !== 'string') this.fail(path, 'must be a string');
    if (v.length === 0 || v.length > MAX_STRING) this.fail(path, `must be 1 to ${MAX_STRING} characters`);
    // Nothing in these documents needs a control character, and they are shown to people.
    if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(path, 'contains a control character');
    if (re && !re.test(v)) this.fail(path, `has the wrong format`);
    return v;
  }

  int(v: unknown, path: string, min: number): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) this.fail(path, 'must be an integer');
    if (v < min) this.fail(path, `must be at least ${min}`);
    return v;
  }

  bool(v: unknown, path: string): boolean {
    if (typeof v !== 'boolean') this.fail(path, 'must be true or false');
    return v;
  }

  timestamp(v: unknown, path: string): Date {
    const s = this.string(v, path);
    const d = parseTimestamp(s);
    if (!d) this.fail(path, 'must be an RFC 3339 UTC timestamp of the form YYYY-MM-DDTHH:MM:SSZ');
    return d;
  }

  semver(v: unknown, path: string, code: UpdateErrorCode = this.code): string {
    const s = this.string(v, path);
    if (!parseSemver(s)) this.fail(path, 'must be a strict MAJOR.MINOR.PATCH version with no prerelease or build suffix', code);
    return s;
  }

  httpsUrl(v: unknown, path: string, host?: string, code: UpdateErrorCode = this.code): string {
    const s = this.string(v, path);
    let u: URL;
    try { u = new URL(s); } catch { this.fail(path, 'is not a URL', code); }
    if (u.protocol !== 'https:') this.fail(path, 'must be https', code);
    if (u.username || u.password || u.port) this.fail(path, 'must not carry credentials or a port', code);
    if (host !== undefined && u.hostname !== host) this.fail(path, `must be on ${host}`, code);
    // One spelling per URL: what is signed is what is fetched.
    if (u.href !== s) this.fail(path, 'is not in canonical form', code);
    return s;
  }

  uniqueStrings(values: readonly string[], path: string, code: UpdateErrorCode = this.code): void {
    if (new Set(values).size !== values.length) this.fail(path, 'contains a duplicate', code);
  }
}

export function parseTimestamp(s: string): Date | null {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Rejects dates that do not exist (2026-02-30) rather than letting them roll over.
  if (d.toISOString() !== `${s.slice(0, 19)}.000Z`) return null;
  return d;
}

export function parseSemver(s: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(s);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Compares two strict versions; throws INPUT_INVALID if either is not one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new UpdateVerificationError('INPUT_INVALID', `not a strict version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function assertNow(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new UpdateVerificationError('INPUT_INVALID', 'now must be a valid Date');
  }
  return now;
}

function parsePayload(payload: Buffer, name: string): JsonValue {
  try {
    return parseStrictJson(payload);
  } catch (e) {
    throw new UpdateVerificationError('PAYLOAD_INVALID', `${name}: ${e instanceof StrictJsonError ? e.message : String(e)}`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ─── Keys (shared by the pinned root and keys.json) ─────────────────────────────────────────────

/** Decodes a key entry and recomputes its key id from the key itself (§4.2: mismatch rejects). */
function decodeKey(d: Doc, keyid: string, publicKeyB64: string, path: string): KeyObject {
  const raw = decodeCanonicalBase64(publicKeyB64);
  const publicKey = raw ? ed25519PublicKeyFromRaw(raw) : null;
  if (!raw || !publicKey) d.fail(`${path}.public_key`, 'is not a canonical base64 32-byte Ed25519 public key');
  const expected = Buffer.from(keyIdOf(raw), 'utf8');
  const given = Buffer.from(keyid, 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    d.fail(`${path}.keyid`, 'does not match its public_key', 'KEYID_MISMATCH');
  }
  return publicKey;
}

function checkThreshold(d: Doc, threshold: number, keyCount: number, path: string): void {
  if (threshold > keyCount) d.fail(`${path}.threshold`, `is ${threshold} but only ${keyCount} key(s) are listed`, 'KEYSET_INVALID');
}

/** Validates the compiled-in root. An empty or malformed anchor means nothing can ever verify. */
export function loadRootOfTrust(root: RootOfTrust): { threshold: number; keys: TrustedKey[] } {
  const d: Doc = new Doc('ROOT_NOT_CONFIGURED', 'pinned root');
  if (typeof root !== 'object' || root === null || !Array.isArray(root.keys) || root.keys.length === 0) {
    d.fail('keys', 'is empty: no root key has been pinned in this build, so no update can be verified');
  }
  const threshold = d.int(root.threshold, 'threshold', 1);
  if (threshold > root.keys.length) d.fail('threshold', `is ${threshold} but only ${root.keys.length} key(s) are pinned`);
  const keys = root.keys.map((k, i) => {
    const keyid = d.string(k?.keyid, `keys[${i}].keyid`, KEYID_RE);
    const b64 = d.string(k?.public_key, `keys[${i}].public_key`);
    let publicKey: KeyObject;
    try {
      publicKey = decodeKey(d, keyid, b64, `keys[${i}]`);
    } catch (e) {
      // decodeKey raises KEYID_MISMATCH for documents; for the pinned anchor it is a build fault.
      throw new UpdateVerificationError('ROOT_NOT_CONFIGURED', (e as Error).message);
    }
    return { keyid, publicKey, holder: `pinned-${i + 1}` };
  });
  d.uniqueStrings(keys.map((k) => k.keyid), 'keys');
  return { threshold, keys };
}

// ─── keys.json ─────────────────────────────────────────────────────────────────────────────────

/** Parses and structurally validates a keys.json payload whose signatures have already been checked. */
export function parseKeySetPayload(payload: Buffer): KeySet {
  const d: Doc = new Doc('PAYLOAD_INVALID', 'keys.json');
  const v = parsePayload(payload, 'keys.json');
  if (typeof v !== 'object' || v === null || Array.isArray(v)) d.fail('(root)', 'must be an object');
  const top = v as Record<string, JsonValue>;
  if (top.type !== KEYS_DOCUMENT_TYPE) {
    d.fail('type', `must be "${KEYS_DOCUMENT_TYPE}" to match its payloadType (got ${JSON.stringify(top.type)})`, 'DOCUMENT_TYPE_MISMATCH');
  }
  if (top.spec_version !== SPEC_VERSION) d.fail('spec_version', `must be ${SPEC_VERSION}`, 'SPEC_VERSION_UNSUPPORTED');

  const o = d.object(top, '(root)', ['type', 'spec_version', 'version', 'issued', 'expires', 'root', 'release', 'revoked_keyids', 'channels', 'authenticode']);
  const version = d.int(o.version, 'version', 1);
  const issued = d.timestamp(o.issued, 'issued');
  const expires = d.timestamp(o.expires, 'expires');
  if (expires.getTime() <= issued.getTime()) d.fail('expires', 'must be after issued');

  const rootO = d.object(o.root, 'root', ['threshold', 'keys']);
  const rootThreshold = d.int(rootO.threshold, 'root.threshold', 1);
  const rootKeys: TrustedKey[] = d.array(rootO.keys, 'root.keys', { min: 1, max: 32 }).map((k, i) => {
    const path = `root.keys[${i}]`;
    const ko = d.object(k, path, ['keyid', 'public_key', 'holder']);
    const keyid = d.string(ko.keyid, `${path}.keyid`, KEYID_RE);
    const publicKey = decodeKey(d, keyid, d.string(ko.public_key, `${path}.public_key`), path);
    return { keyid, publicKey, holder: d.string(ko.holder, `${path}.holder`) };
  });

  const relO = d.object(o.release, 'release', ['threshold', 'keys']);
  const releaseThreshold = d.int(relO.threshold, 'release.threshold', 1);
  const releaseKeys: ReleaseKey[] = d.array(relO.keys, 'release.keys', { min: 1, max: 32 }).map((k, i) => {
    const path = `release.keys[${i}]`;
    const ko = d.object(k, path, ['keyid', 'public_key', 'holder', 'expires']);
    const keyid = d.string(ko.keyid, `${path}.keyid`, KEYID_RE);
    const publicKey = decodeKey(d, keyid, d.string(ko.public_key, `${path}.public_key`), path);
    return { keyid, publicKey, holder: d.string(ko.holder, `${path}.holder`), expires: d.timestamp(ko.expires, `${path}.expires`) };
  });

  const revoked = d.array(o.revoked_keyids, 'revoked_keyids', { max: 1024 }).map((k, i) => d.string(k, `revoked_keyids[${i}]`, KEYID_RE));
  const channels = d.array(o.channels, 'channels', { min: 1, max: 16 }).map((c, i) => d.string(c, `channels[${i}]`, CHANNEL_RE));

  const acO = d.object(o.authenticode, 'authenticode', ['required', 'signers']);
  const required = d.bool(acO.required, 'authenticode.required');
  const signers: AuthenticodeSigner[] = d.array(acO.signers, 'authenticode.signers', { max: 16 }).map((s, i) => {
    const path = `authenticode.signers[${i}]`;
    const so = d.object(s, path, ['subject', 'issuer_ca_sha256', 'require_timestamp']);
    const issuers = d.array(so.issuer_ca_sha256, `${path}.issuer_ca_sha256`, { min: 1, max: 16 }).map((h, j) => d.string(h, `${path}.issuer_ca_sha256[${j}]`, SHA256_RE));
    d.uniqueStrings(issuers, `${path}.issuer_ca_sha256`);
    return { subject: d.string(so.subject, `${path}.subject`), issuerCaSha256: issuers, requireTimestamp: d.bool(so.require_timestamp, `${path}.require_timestamp`) };
  });
  if (required && signers.length === 0) d.fail('authenticode.signers', 'must name at least one signer when required is true');

  // Structure. Fail closed on anything that would make the set ambiguous or unusable.
  d.uniqueStrings(rootKeys.map((k) => k.keyid), 'root.keys', 'KEYSET_INVALID');
  d.uniqueStrings(releaseKeys.map((k) => k.keyid), 'release.keys', 'KEYSET_INVALID');
  d.uniqueStrings(revoked, 'revoked_keyids', 'KEYSET_INVALID');
  d.uniqueStrings(channels, 'channels', 'KEYSET_INVALID');
  const rootIds = new Set(rootKeys.map((k) => k.keyid));
  if (releaseKeys.some((k) => rootIds.has(k.keyid))) {
    d.fail('release.keys', 'shares a key with root.keys; the roles must use different keys', 'KEYSET_INVALID');
  }
  checkThreshold(d, rootThreshold, rootKeys.filter((k) => !revoked.includes(k.keyid)).length, 'root');
  checkThreshold(d, releaseThreshold, releaseKeys.length, 'release');

  return Object.freeze({
    version,
    issued,
    expires,
    root: { threshold: rootThreshold, keys: rootKeys },
    release: { threshold: releaseThreshold, keys: releaseKeys },
    revokedKeyIds: new Set(revoked),
    channels,
    authenticode: { required, signers },
  });
}

function sameRoot(a: { threshold: number; keys: readonly RoleKey[] }, b: { threshold: number; keys: readonly RoleKey[] }): boolean {
  if (a.threshold !== b.threshold || a.keys.length !== b.keys.length) return false;
  const ids = new Set(a.keys.map((k) => k.keyid));
  return b.keys.every((k) => ids.has(k.keyid));
}

// ─── State ─────────────────────────────────────────────────────────────────────────────────────

function loadState(state: unknown): UpdateState {
  const d: Doc = new Doc('STATE_INVALID', 'update state');
  const o = d.object(state, '(root)', ['keySet', 'manifest', 'authenticodeLatched']);
  const latched = d.bool(o.authenticodeLatched, 'authenticodeLatched');
  let keySet: UpdateState['keySet'] = null;
  if (o.keySet !== null) {
    const k = d.object(o.keySet, 'keySet', ['envelope']);
    if (typeof k.envelope !== 'string' || !decodeCanonicalBase64(k.envelope)) d.fail('keySet.envelope', 'must be canonical base64');
    keySet = { envelope: k.envelope };
  }
  let manifest: UpdateState['manifest'] = null;
  if (o.manifest !== null) {
    const m = d.object(o.manifest, 'manifest', ['channel', 'sequence', 'payloadSha256', 'expires']);
    manifest = {
      channel: d.string(m.channel, 'manifest.channel', CHANNEL_RE),
      sequence: d.int(m.sequence, 'manifest.sequence', 1),
      payloadSha256: d.string(m.payloadSha256, 'manifest.payloadSha256', SHA256_RE),
      expires: d.string(m.expires, 'manifest.expires'),
    };
    if (!parseTimestamp(manifest.expires)) d.fail('manifest.expires', 'must be an RFC 3339 UTC timestamp');
  }
  return { keySet, manifest, authenticodeLatched: latched };
}

interface LoadedKeySet {
  readonly keySet: KeySet;
  readonly envelopeBytes: Buffer;
  readonly payload: Buffer;
}

/**
 * Re-checks the key set held in state: it must still parse, and it must carry its own root's
 * threshold — true of every key set this module ever adopts (the first is signed by the pinned root
 * and, if different, by its own; every later one by its own root, after rotations by both). Damage
 * here is our fault, not an attack, so it surfaces as STATE_INVALID.
 */
function loadTrustedKeySet(state: UpdateState, now: Date): LoadedKeySet | null {
  if (!state.keySet) return null;
  try {
    const envelopeBytes = decodeCanonicalBase64(state.keySet.envelope)!;
    const env = parseEnvelope(envelopeBytes, KEYS_PAYLOAD_TYPE);
    const keySet = parseKeySetPayload(env.payload);
    requireThreshold(env, {
      role: 'root',
      threshold: keySet.root.threshold,
      keys: keySet.root.keys,
      revoked: keySet.revokedKeyIds,
      otherRoleKeyIds: new Set(keySet.release.keys.map((k) => k.keyid)),
      now,
    });
    if (state.authenticodeLatched && !keySet.authenticode.required) {
      throw new UpdateVerificationError('STATE_INVALID', 'the Authenticode latch is set but the stored key set does not require it');
    }
    return { keySet, envelopeBytes, payload: env.payload };
  } catch (e) {
    if (e instanceof UpdateVerificationError && e.code === 'STATE_INVALID') throw e;
    const why = e instanceof Error ? e.message : String(e);
    throw new UpdateVerificationError('STATE_INVALID', `the stored key set no longer verifies: ${why}`, { cause: e instanceof UpdateVerificationError ? e.code : undefined });
  }
}

// ─── Step 2: refresh the key set ───────────────────────────────────────────────────────────────

export interface RefreshKeySetInput {
  /** The compiled-in root (§6 step 1). */
  readonly root: RootOfTrust;
  /** The persisted state; INITIAL_STATE on first run. */
  readonly state: UpdateState;
  /**
   * The fetched key-set envelopes, oldest first: `keys/<trusted+1>.json` … `keys/<latest>.json`, or just
   * the fetched `keys.json` when it is not newer than the trusted one. Empty when the fetch failed
   * (§6 step 2: continue with the trusted set if it has not expired).
   */
  readonly keySetEnvelopes: readonly Uint8Array[];
  readonly now: Date;
}

export interface RefreshKeySetResult {
  readonly keySet: KeySet;
  /** Key-set versions adopted by this call, in order; empty if nothing changed. */
  readonly adoptedVersions: readonly number[];
  /** The state to persist. */
  readonly state: UpdateState;
}

/**
 * §6 step 2. Walks the offered key sets from the trusted one, requiring for each: the payloadType for
 * keys; `threshold` valid signatures from the currently trusted root keys (the pinned root on first
 * run); strict parse with matching `type` and `spec_version`; every keyid matching its key;
 * `version` = previous + 1 (a lower version, or an equal one with different bytes, is a rollback);
 * and, if the root set changed, `threshold` valid signatures from the new root too. Finally the newest
 * key set must not have expired. The Authenticode latch, once set, rejects any key set that clears it.
 */
export function refreshKeySet(input: RefreshKeySetInput): RefreshKeySetResult {
  const now = assertNow(input.now);
  const pinned = loadRootOfTrust(input.root);
  const state = loadState(input.state);
  if (!Array.isArray(input.keySetEnvelopes)) throw new UpdateVerificationError('INPUT_INVALID', 'keySetEnvelopes must be an array');

  const trusted = loadTrustedKeySet(state, now);
  let current: {
    version: number;
    root: { threshold: number; keys: readonly TrustedKey[] };
    releaseIds: ReadonlySet<string>;
    revoked: ReadonlySet<string>;
    requiresAuthenticode: boolean;
    payload: Buffer | null;
  } = trusted
    ? {
        version: trusted.keySet.version,
        root: trusted.keySet.root,
        releaseIds: new Set(trusted.keySet.release.keys.map((k) => k.keyid)),
        revoked: trusted.keySet.revokedKeyIds,
        requiresAuthenticode: trusted.keySet.authenticode.required,
        payload: trusted.payload,
      }
    : // First run: the pinned root is the only trust, standing in as "version 0" with no release keys.
      { version: 0, root: pinned, releaseIds: new Set(), revoked: new Set(), requiresAuthenticode: false, payload: null };

  let latched = state.authenticodeLatched || current.requiresAuthenticode;
  let adoptedKeySet: KeySet | null = trusted?.keySet ?? null;
  let adoptedBytes: Buffer | null = trusted?.envelopeBytes ?? null;
  const adoptedVersions: number[] = [];

  for (const [i, bytes] of input.keySetEnvelopes.entries()) {
    const env: Envelope = parseEnvelope(bytes, KEYS_PAYLOAD_TYPE);

    // Signatures by the currently trusted root, over the raw bytes, before the payload is parsed.
    requireThreshold(env, {
      role: 'root',
      threshold: current.root.threshold,
      keys: current.root.keys,
      revoked: current.revoked,
      otherRoleKeyIds: current.releaseIds,
      now,
    });

    const next = parseKeySetPayload(env.payload);

    if (next.version < current.version) {
      throw new UpdateVerificationError('KEYSET_ROLLBACK', `keys.json version ${next.version} is below the trusted version ${current.version}`, {
        offered: next.version, trusted: current.version,
      });
    }
    if (next.version === current.version) {
      if (current.payload && bytesEqual(env.payload, current.payload)) continue; // the same key set again
      throw new UpdateVerificationError('KEYSET_ROLLBACK', `keys.json version ${next.version} differs from the trusted key set with the same version`, {
        offered: next.version, trusted: current.version,
      });
    }
    // On first run there is no previous version to continue from: any key set the pinned root signed
    // may start the chain. From then on, versions must be consecutive.
    if (current.payload !== null && next.version !== current.version + 1) {
      throw new UpdateVerificationError('KEYSET_VERSION_GAP', `keys.json jumps from version ${current.version} to ${next.version}; intermediate key sets are required`, {
        offered: next.version, trusted: current.version, index: i,
      });
    }

    // Root rotation: the new root set must also have signed (the TUF rule, threat model §7.1).
    if (!sameRoot(current.root, next.root)) {
      requireThreshold(env, {
        role: 'new-root',
        threshold: next.root.threshold,
        keys: next.root.keys,
        revoked: next.revokedKeyIds,
        otherRoleKeyIds: new Set(next.release.keys.map((k) => k.keyid)),
        now,
      });
    }

    if (latched && !next.authenticode.required) {
      throw new UpdateVerificationError('AUTHENTICODE_LATCH_VIOLATION', `keys.json version ${next.version} sets authenticode.required = false after it has been required`, {
        offered: next.version,
      });
    }
    latched = latched || next.authenticode.required;

    current = {
      version: next.version,
      root: next.root,
      releaseIds: new Set(next.release.keys.map((k) => k.keyid)),
      revoked: next.revokedKeyIds,
      requiresAuthenticode: next.authenticode.required,
      payload: env.payload,
    };
    adoptedKeySet = next;
    adoptedBytes = Buffer.from(bytes);
    adoptedVersions.push(next.version);
  }

  if (!adoptedKeySet || !adoptedBytes) {
    throw new UpdateVerificationError('KEYSET_MISSING', 'no trusted key set yet and none was fetched');
  }
  if (adoptedKeySet.expires.getTime() <= now.getTime()) {
    throw new UpdateVerificationError('KEYSET_EXPIRED', `the key set (version ${adoptedKeySet.version}) expired at ${adoptedKeySet.expires.toISOString()}`, {
      version: adoptedKeySet.version, expires: adoptedKeySet.expires.toISOString(),
    });
  }

  return {
    keySet: adoptedKeySet,
    adoptedVersions,
    state: { keySet: { envelope: adoptedBytes.toString('base64') }, manifest: state.manifest, authenticodeLatched: latched },
  };
}

// ─── manifest.json ─────────────────────────────────────────────────────────────────────────────

/** Parses and validates a manifest payload whose signatures have already been checked (§4.3). */
export function parseManifestPayload(payload: Buffer): Manifest {
  const d: Doc = new Doc('PAYLOAD_INVALID', 'manifest.json');
  const v = parsePayload(payload, 'manifest.json');
  if (typeof v !== 'object' || v === null || Array.isArray(v)) d.fail('(root)', 'must be an object');
  const top = v as Record<string, JsonValue>;
  if (top.type !== MANIFEST_DOCUMENT_TYPE) {
    d.fail('type', `must be "${MANIFEST_DOCUMENT_TYPE}" to match its payloadType (got ${JSON.stringify(top.type)})`, 'DOCUMENT_TYPE_MISMATCH');
  }
  if (top.spec_version !== SPEC_VERSION) d.fail('spec_version', `must be ${SPEC_VERSION}`, 'SPEC_VERSION_UNSUPPORTED');

  const o = d.object(top, '(root)', ['type', 'spec_version', 'channel', 'sequence', 'issued', 'expires', 'min_keys_version', 'release', 'security_floor', 'blocked_versions', 'advisory']);
  const rel = d.object(o.release, 'release', ['version', 'upgrade_from_min', 'artifact', 'provenance', 'notes_url']);
  const art = d.object(rel.artifact, 'release.artifact', ['url', 'size', 'sha256']);
  const prov = d.object(rel.provenance, 'release.provenance', ['tag', 'commit', 'workflow', 'build_sha256']);

  const blocked = d.array(o.blocked_versions, 'blocked_versions', { max: 256 }).map((b, i) => d.semver(b, `blocked_versions[${i}]`));
  d.uniqueStrings(blocked, 'blocked_versions');

  let advisory: Manifest['advisory'] = null;
  if (o.advisory !== null) {
    const a = d.object(o.advisory, 'advisory', ['id', 'summary', 'url']);
    advisory = { id: d.string(a.id, 'advisory.id'), summary: d.string(a.summary, 'advisory.summary'), url: d.httpsUrl(a.url, 'advisory.url') };
  }

  return Object.freeze({
    channel: d.string(o.channel, 'channel', CHANNEL_RE),
    sequence: d.int(o.sequence, 'sequence', 1),
    issued: d.timestamp(o.issued, 'issued'),
    expires: d.timestamp(o.expires, 'expires'),
    minKeysVersion: d.int(o.min_keys_version, 'min_keys_version', 1),
    release: {
      version: d.semver(rel.version, 'release.version', 'RELEASE_VERSION_INVALID'),
      upgradeFromMin: d.semver(rel.upgrade_from_min, 'release.upgrade_from_min'),
      artifact: {
        url: d.httpsUrl(art.url, 'release.artifact.url', 'github.com', 'ARTIFACT_URL_INVALID'),
        size: d.int(art.size, 'release.artifact.size', 1),
        sha256: d.string(art.sha256, 'release.artifact.sha256', SHA256_RE),
      },
      provenance: {
        tag: d.string(prov.tag, 'release.provenance.tag'),
        commit: d.string(prov.commit, 'release.provenance.commit', COMMIT_RE),
        workflow: d.string(prov.workflow, 'release.provenance.workflow'),
        buildSha256: d.string(prov.build_sha256, 'release.provenance.build_sha256', SHA256_RE),
      },
      notesUrl: d.httpsUrl(rel.notes_url, 'release.notes_url'),
    },
    securityFloor: d.semver(o.security_floor, 'security_floor'),
    blockedVersions: blocked,
    advisory,
  });
}

// ─── Step 4: verify the manifest ───────────────────────────────────────────────────────────────

export interface VerifyManifestInput {
  /** State after refreshKeySet: it must hold a trusted, unexpired key set. */
  readonly state: UpdateState;
  readonly manifestEnvelope: Uint8Array;
  /** The channel this client follows. */
  readonly channel: string;
  readonly now: Date;
}

export interface VerifiedManifest {
  readonly manifest: Manifest;
  readonly keySet: KeySet;
  /** What step 8 must enforce: the latch or the key set's own policy. */
  readonly authenticode: AuthenticodePolicy;
  /** The state to persist (the manifest sequence is recorded, §6 step 4). */
  readonly state: UpdateState;
}

/**
 * §6 step 4. The envelope must carry the manifest payloadType and `release.threshold` valid
 * signatures from release keys in the trusted key set that are neither revoked nor expired. Then:
 * `type`/`spec_version`/`channel` match; `min_keys_version` ≤ the trusted key-set version;
 * `sequence` ≥ the stored one (equal only if byte-identical); `issued` ≤ now + 1 h; `expires` > now
 * and no more than 45 days after `issued`; `release.version` strict with no prerelease; the artifact
 * URL https on github.com.
 */
export function verifyManifest(input: VerifyManifestInput): VerifiedManifest {
  const now = assertNow(input.now);
  if (typeof input.channel !== 'string' || !CHANNEL_RE.test(input.channel)) {
    throw new UpdateVerificationError('INPUT_INVALID', 'channel must be a channel name');
  }
  const state = loadState(input.state);
  const trusted = loadTrustedKeySet(state, now);
  if (!trusted) throw new UpdateVerificationError('KEYSET_MISSING', 'no trusted key set; refresh the key set first');
  const keySet = trusted.keySet;
  if (keySet.expires.getTime() <= now.getTime()) {
    throw new UpdateVerificationError('KEYSET_EXPIRED', `the key set (version ${keySet.version}) expired at ${keySet.expires.toISOString()}`, {
      version: keySet.version, expires: keySet.expires.toISOString(),
    });
  }
  if (!keySet.channels.includes(input.channel)) {
    throw new UpdateVerificationError('CHANNEL_MISMATCH', `the key set does not authorise channel "${input.channel}"`);
  }
  if (state.manifest && state.manifest.channel !== input.channel) {
    throw new UpdateVerificationError('STATE_INVALID', `stored manifest is for channel "${state.manifest.channel}", not "${input.channel}"`);
  }

  const env = parseEnvelope(input.manifestEnvelope, MANIFEST_PAYLOAD_TYPE);
  requireThreshold(env, {
    role: 'release',
    threshold: keySet.release.threshold,
    keys: keySet.release.keys,
    revoked: keySet.revokedKeyIds,
    otherRoleKeyIds: new Set(keySet.root.keys.map((k) => k.keyid)),
    now,
  });

  const m = parseManifestPayload(env.payload);
  const payloadSha256 = sha256Hex(env.payload);

  if (m.channel !== input.channel) {
    throw new UpdateVerificationError('CHANNEL_MISMATCH', `manifest is for channel "${m.channel}", this client follows "${input.channel}"`);
  }
  if (m.minKeysVersion > keySet.version) {
    throw new UpdateVerificationError('MANIFEST_KEYS_TOO_OLD', `manifest needs key set version ${m.minKeysVersion}; the trusted one is ${keySet.version}`, {
      required: m.minKeysVersion, trusted: keySet.version,
    });
  }
  if (state.manifest) {
    if (m.sequence < state.manifest.sequence) {
      throw new UpdateVerificationError('MANIFEST_ROLLBACK', `manifest sequence ${m.sequence} is below the last accepted ${state.manifest.sequence}`, {
        offered: m.sequence, stored: state.manifest.sequence,
      });
    }
    if (m.sequence === state.manifest.sequence && !digestEquals(payloadSha256, state.manifest.payloadSha256)) {
      throw new UpdateVerificationError('MANIFEST_ROLLBACK', `manifest sequence ${m.sequence} was already accepted with different contents`, {
        offered: m.sequence, stored: state.manifest.sequence,
      });
    }
  }
  if (m.issued.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new UpdateVerificationError('MANIFEST_FROM_FUTURE', `manifest issued ${m.issued.toISOString()} is more than 1 hour ahead of this clock`, {
      issued: m.issued.toISOString(),
    });
  }
  if (m.expires.getTime() <= m.issued.getTime() || m.expires.getTime() - m.issued.getTime() > MAX_MANIFEST_LIFETIME_MS) {
    throw new UpdateVerificationError('MANIFEST_LIFETIME_TOO_LONG', 'manifest must expire after it is issued and no more than 45 days later', {
      issued: m.issued.toISOString(), expires: m.expires.toISOString(),
    });
  }
  if (m.expires.getTime() <= now.getTime()) {
    throw new UpdateVerificationError('MANIFEST_EXPIRED', `manifest expired at ${m.expires.toISOString()}`, { expires: m.expires.toISOString() });
  }

  const latched = state.authenticodeLatched || keySet.authenticode.required;
  return {
    manifest: m,
    keySet,
    authenticode: { required: latched, signers: keySet.authenticode.signers },
    state: {
      keySet: state.keySet,
      manifest: { channel: m.channel, sequence: m.sequence, payloadSha256, expires: m.expires.toISOString().replace('.000Z', 'Z') },
      authenticodeLatched: latched,
    },
  };
}

// ─── Step 5: decide ────────────────────────────────────────────────────────────────────────────

/** `UPDATE_POLICY` (§7.1). Neither value can stop a security update. */
export type UpdatePolicy = 'security-auto' | 'security-only';

/**
 * Resolves the policy from the .env values. `UPDATE_CHECK=false` means `security-only` — it stops
 * feature updates, never security updates. An unrecognised `UPDATE_POLICY` (including the dropped
 * `notify`, `off` and `all-auto`) resolves to `security-only`: the most conservative reading of a
 * setting someone changed on purpose, and still one that installs every security update.
 */
export function resolveUpdatePolicy(env: { readonly UPDATE_POLICY?: string; readonly UPDATE_CHECK?: string }): UpdatePolicy {
  const check = (env.UPDATE_CHECK ?? '').trim().toLowerCase();
  if (check === 'false') return 'security-only';
  const policy = (env.UPDATE_POLICY ?? '').trim().toLowerCase();
  if (policy === '' || policy === 'security-auto') return 'security-auto';
  return 'security-only';
}

/** §7.2: which path an install is on, given a verified manifest. */
export type UpdatePath = 'up-to-date' | 'too-old' | 'security' | 'feature';

export interface UpdateDecision {
  readonly path: UpdatePath;
  /**
   * - `none`       nothing to install (up to date; too old to update automatically; or a feature
   *                update under `security-only`)
   * - `automatic`  the security path: applied without consent, through the drain protocol (§7.3)
   * - `on-consent` the feature path: shown in the tray, applied on "Install now"
   */
  readonly install: 'none' | 'automatic' | 'on-consent';
  readonly installed: string;
  readonly target: string;
  readonly reason: string;
}

/**
 * §6 step 5 and §7.2. The channel never installs a version at or below the installed one. Security
 * urgency comes from the gap between what is installed and what is safe (`security_floor`,
 * `blocked_versions`), not from a flag on the latest release.
 */
export function decideUpdate(manifest: Manifest, installedVersion: string, policy: UpdatePolicy): UpdateDecision {
  if (policy !== 'security-auto' && policy !== 'security-only') {
    throw new UpdateVerificationError('INPUT_INVALID', `unknown policy ${JSON.stringify(policy)}`);
  }
  if (!parseSemver(installedVersion)) {
    throw new UpdateVerificationError('INPUT_INVALID', `installed version ${JSON.stringify(installedVersion)} is not a strict version`);
  }
  const target = manifest.release.version;
  const base = { installed: installedVersion, target };

  if (compareVersions(installedVersion, target) >= 0) {
    return { ...base, path: 'up-to-date', install: 'none', reason: `installed ${installedVersion} is not below the offered ${target}` };
  }
  if (compareVersions(installedVersion, manifest.release.upgradeFromMin) < 0) {
    return { ...base, path: 'too-old', install: 'none', reason: `installed ${installedVersion} is below ${manifest.release.upgradeFromMin}, the oldest version that may upgrade directly; install ${target} by hand` };
  }
  const blocked = manifest.blockedVersions.some((v) => compareVersions(v, installedVersion) === 0);
  if (compareVersions(installedVersion, manifest.securityFloor) < 0 || blocked) {
    return {
      ...base,
      path: 'security',
      install: 'automatic',
      reason: blocked ? `installed ${installedVersion} has been withdrawn` : `installed ${installedVersion} is below the security floor ${manifest.securityFloor}`,
    };
  }
  return policy === 'security-auto'
    ? { ...base, path: 'feature', install: 'on-consent', reason: `feature update ${target} is available` }
    : { ...base, path: 'feature', install: 'none', reason: `feature update ${target} is available, but feature updates are off (security fixes still install)` };
}
