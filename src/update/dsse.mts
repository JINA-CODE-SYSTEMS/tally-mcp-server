// DSSE envelopes and Ed25519 signatures for the update channel (#177, update-manifest.md §5).
//
// Nothing in here is hand-written cryptography: the signature primitive is `crypto.verify` /
// `crypto.sign` from node:crypto (OpenSSL), and the only encoding built here is DSSE's
// pre-authentication encoding (PAE), which is a length-prefixed concatenation.
//
// The envelope is parsed strictly: exactly the three DSSE fields, each signature exactly
// `{ keyid, sig }`, base64 in its one canonical form. Bytes that are not a DSSE envelope at all (a
// captive portal, a proxy's error page) are a *transport* failure; an envelope-shaped document that
// fails any rule is a *verification* failure (§8).

import crypto, { type KeyObject } from 'node:crypto';
import { parseStrictJson, StrictJsonError, type JsonValue } from './strict-json.mjs';
import { UpdateVerificationError, type SignatureRejection } from './errors.mjs';

export const KEYS_PAYLOAD_TYPE = 'application/vnd.claudally.update.keys+json; version=1';
export const MANIFEST_PAYLOAD_TYPE = 'application/vnd.claudally.update.manifest+json; version=1';
export type PayloadType = typeof KEYS_PAYLOAD_TYPE | typeof MANIFEST_PAYLOAD_TYPE;

/** §6 steps 2 and 3: metadata is capped at 64 KiB before anything else looks at it (A9). */
export const MAX_METADATA_BYTES = 64 * 1024;
/** More signatures than any threshold this channel will ever use; bounds verification work. */
export const MAX_SIGNATURES = 32;

const KEYID_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface EnvelopeSignature {
  readonly keyid: string;
  readonly sig: Buffer;
}

export interface Envelope {
  readonly payloadType: string;
  /** The exact signed payload bytes. Not parsed here. */
  readonly payload: Buffer;
  readonly signatures: readonly EnvelopeSignature[];
}

/** DSSE v1 pre-authentication encoding: "DSSEv1" SP len(type) SP type SP len(body) SP body. */
export function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'),
    type,
    Buffer.from(` ${payload.length} `, 'utf8'),
    payload,
  ]);
}

/**
 * Decodes base64 only in its canonical form: standard alphabet, padded, no whitespace, and zero
 * trailing bits (so exactly one string maps to each byte sequence). `Buffer.from(s, 'base64')` on its
 * own ignores characters it does not recognise, which would let two different strings carry one key.
 */
export function decodeCanonicalBase64(s: string): Buffer | null {
  if (!BASE64_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? buf : null;
}

/** keyid = lowercase hex SHA-256 of the raw 32-byte Ed25519 public key (§4.2). */
export function keyIdOf(rawPublicKey: Uint8Array): string {
  return crypto.createHash('sha256').update(rawPublicKey).digest('hex');
}

/** Imports a raw 32-byte Ed25519 public key, or returns null if it is not one. */
export function ed25519PublicKeyFromRaw(raw: Uint8Array): KeyObject | null {
  if (raw.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The raw 32-byte public key of an Ed25519 key (public or private). */
export function rawEd25519PublicKey(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new TypeError('not an Ed25519 key');
  const der = pub.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(ED25519_SPKI_PREFIX.length));
}

/** Constant-time equality of two lowercase hex digests of equal, public length. */
export function digestEquals(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Constant-time equality of two byte strings, compared through their SHA-256 digests. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db) && a.length === b.length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeDsse(v: unknown): boolean {
  return isPlainObject(v) && 'payloadType' in v && 'payload' in v && 'signatures' in v;
}

/**
 * Parses a DSSE envelope and checks its payloadType. Does not verify signatures and does not parse
 * the payload: nothing inside is trusted until a threshold has been verified over it.
 */
export function parseEnvelope(bytes: Uint8Array, expectedPayloadType: PayloadType): Envelope {
  if (!(bytes instanceof Uint8Array)) {
    throw new UpdateVerificationError('INPUT_INVALID', 'envelope must be raw bytes');
  }
  if (bytes.length > MAX_METADATA_BYTES) {
    throw new UpdateVerificationError('METADATA_TOO_LARGE', `metadata is ${bytes.length} bytes; the cap is ${MAX_METADATA_BYTES}`, { size: bytes.length });
  }

  let doc: JsonValue;
  try {
    doc = parseStrictJson(bytes);
  } catch (e) {
    // Tell "not an envelope at all" (transport) from "an envelope, malformed" (verification) with
    // a lenient look at the same bytes. Only the classification uses the lenient parse.
    let lenient: unknown;
    try { lenient = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { lenient = undefined; }
    const why = e instanceof StrictJsonError ? e.message : String(e);
    if (looksLikeDsse(lenient)) {
      throw new UpdateVerificationError('ENVELOPE_INVALID', `envelope is not strict JSON: ${why}`);
    }
    throw new UpdateVerificationError('ENVELOPE_NOT_DSSE', `response is not a DSSE envelope: ${why}`);
  }
  if (!looksLikeDsse(doc)) {
    throw new UpdateVerificationError('ENVELOPE_NOT_DSSE', 'response is not a DSSE envelope');
  }
  const env = doc as Record<string, JsonValue>;
  const extra = Object.keys(env).filter((k) => k !== 'payloadType' && k !== 'payload' && k !== 'signatures');
  if (extra.length) {
    throw new UpdateVerificationError('ENVELOPE_INVALID', `unexpected envelope field(s): ${extra.join(', ')}`);
  }
  if (typeof env.payloadType !== 'string') {
    throw new UpdateVerificationError('ENVELOPE_INVALID', 'payloadType must be a string');
  }
  if (typeof env.payload !== 'string') {
    throw new UpdateVerificationError('ENVELOPE_INVALID', 'payload must be a string');
  }
  const payload = decodeCanonicalBase64(env.payload);
  if (!payload || payload.length === 0) {
    throw new UpdateVerificationError('ENVELOPE_INVALID', 'payload is not canonical base64');
  }
  if (!Array.isArray(env.signatures) || env.signatures.length === 0 || env.signatures.length > MAX_SIGNATURES) {
    throw new UpdateVerificationError('ENVELOPE_INVALID', `signatures must be an array of 1 to ${MAX_SIGNATURES} entries`);
  }
  const signatures: EnvelopeSignature[] = env.signatures.map((s, i) => {
    if (!isPlainObject(s)) throw new UpdateVerificationError('ENVELOPE_INVALID', `signatures[${i}] is not an object`);
    const keys = Object.keys(s);
    if (keys.length !== 2 || typeof s.keyid !== 'string' || typeof s.sig !== 'string') {
      throw new UpdateVerificationError('ENVELOPE_INVALID', `signatures[${i}] must be exactly { keyid, sig }`);
    }
    if (!KEYID_RE.test(s.keyid)) {
      throw new UpdateVerificationError('ENVELOPE_INVALID', `signatures[${i}].keyid is not 64 lowercase hex characters`);
    }
    const sig = decodeCanonicalBase64(s.sig);
    if (!sig || sig.length !== 64) {
      throw new UpdateVerificationError('ENVELOPE_INVALID', `signatures[${i}].sig is not a canonical base64 64-byte signature`);
    }
    return { keyid: s.keyid, sig };
  });

  if (env.payloadType !== expectedPayloadType) {
    throw new UpdateVerificationError('PAYLOAD_TYPE_MISMATCH', `expected payloadType "${expectedPayloadType}", got "${env.payloadType}"`, {
      expected: expectedPayloadType,
      actual: env.payloadType,
    });
  }
  return { payloadType: env.payloadType, payload, signatures };
}

/** A key trusted for one role, as the threshold check needs it. */
export interface RoleKey {
  readonly keyid: string;
  readonly publicKey: KeyObject;
  /** Release keys only: the key stops counting at this instant. */
  readonly expires?: Date;
}

export interface ThresholdContext {
  /** Name used in errors and details: 'root', 'new-root' or 'release'. */
  readonly role: string;
  readonly threshold: number;
  readonly keys: readonly RoleKey[];
  /** Key ids that never count, whatever list they appear in (§4.2 revoked_keyids). */
  readonly revoked: ReadonlySet<string>;
  /** Key ids trusted for the *other* role, reported as 'wrong-role' rather than 'unknown-key' (A8). */
  readonly otherRoleKeyIds: ReadonlySet<string>;
  readonly now: Date;
}

/**
 * Requires `threshold` distinct keys of this role to have validly signed the envelope. Each key counts
 * once however many times it appears; unknown key ids are ignored, not errors (§5). Throws
 * SIGNATURE_THRESHOLD_NOT_MET, with why each signature did not count, if the threshold is not met.
 */
export function requireThreshold(envelope: Envelope, ctx: ThresholdContext): ReadonlySet<string> {
  const message = pae(envelope.payloadType, envelope.payload);
  const byId = new Map(ctx.keys.map((k) => [k.keyid, k]));
  const counted = new Set<string>();
  const rejected: { keyid: string; reason: SignatureRejection }[] = [];

  for (const { keyid, sig } of envelope.signatures) {
    const key = byId.get(keyid);
    let reason: SignatureRejection | null = null;
    if (!key) reason = ctx.otherRoleKeyIds.has(keyid) ? 'wrong-role' : 'unknown-key';
    else if (ctx.revoked.has(keyid)) reason = 'revoked';
    else if (key.expires && key.expires.getTime() <= ctx.now.getTime()) reason = 'expired';
    else if (counted.has(keyid)) reason = 'duplicate';
    else if (!crypto.verify(null, message, key.publicKey, sig)) reason = 'bad-signature';

    if (reason) rejected.push({ keyid, reason });
    else counted.add(keyid);
  }

  if (counted.size < ctx.threshold) {
    const reasons = rejected.map((r) => `${r.keyid.slice(0, 12)}…: ${r.reason}`).join('; ') || 'no signatures';
    throw new UpdateVerificationError(
      'SIGNATURE_THRESHOLD_NOT_MET',
      `${ctx.role} threshold ${ctx.threshold} not met: ${counted.size} valid (${reasons})`,
      { role: ctx.role, threshold: ctx.threshold, valid: counted.size, rejected },
    );
  }
  return counted;
}

/**
 * Builds a DSSE envelope over `payload`, signed by each key given. Used by the offline signing
 * ceremony and by the tests; the updater itself never signs anything.
 */
export function signEnvelope(payloadType: PayloadType, payload: Uint8Array, privateKeys: readonly KeyObject[]): Buffer {
  const message = pae(payloadType, payload);
  const signatures = privateKeys.map((key) => ({
    keyid: keyIdOf(rawEd25519PublicKey(key)),
    sig: crypto.sign(null, message, key).toString('base64'),
  }));
  return Buffer.from(JSON.stringify({ payloadType, payload: Buffer.from(payload).toString('base64'), signatures }, null, 2) + '\n', 'utf8');
}

/** Adds signatures to an existing envelope (a second holder signing in turn); the payload is unchanged. */
export function addSignatures(envelope: Envelope, privateKeys: readonly KeyObject[]): Buffer {
  const message = pae(envelope.payloadType, envelope.payload);
  const signatures = [
    ...envelope.signatures.map((s) => ({ keyid: s.keyid, sig: s.sig.toString('base64') })),
    ...privateKeys.map((key) => ({
      keyid: keyIdOf(rawEd25519PublicKey(key)),
      sig: crypto.sign(null, message, key).toString('base64'),
    })),
  ];
  return Buffer.from(JSON.stringify({ payloadType: envelope.payloadType, payload: envelope.payload.toString('base64'), signatures }, null, 2) + '\n', 'utf8');
}
