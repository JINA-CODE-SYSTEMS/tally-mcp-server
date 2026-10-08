// Test-only key hierarchy and document builders for the update-verification tests (#177).
//
// Imported only by *.test.mts files; no production module imports it (pinned.test.mts checks). Every
// key here is generated fresh, in memory, each time the tests run — no private key is committed, and
// none of these keys can ever match the pinned root. Tests reach failure paths by building different
// inputs with these helpers, never by switching a check off.

import crypto, { type KeyObject } from 'node:crypto';
import { KEYS_PAYLOAD_TYPE, MANIFEST_PAYLOAD_TYPE, keyIdOf, rawEd25519PublicKey, signEnvelope, type PayloadType } from './dsse.mjs';
import type { RootOfTrust } from './verify.mjs';

export interface TestKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly raw: Buffer;
  readonly keyid: string;
  readonly b64: string;
}

export function newKey(): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = rawEd25519PublicKey(publicKey);
  return { privateKey, publicKey, raw, keyid: keyIdOf(raw), b64: raw.toString('base64') };
}

export const T0 = new Date('2026-10-15T00:00:00Z');
export const DAY = 24 * 60 * 60 * 1000;
/** The one timestamp spelling the documents allow: whole seconds, UTC, with a Z. */
export function iso(d: Date): string {
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}
export function at(offsetMs: number, from: Date = T0): Date {
  return new Date(from.getTime() + offsetMs);
}

export function rootOf(keys: readonly TestKey[], threshold = 1): RootOfTrust {
  return { threshold, keys: keys.map((k) => ({ keyid: k.keyid, public_key: k.b64 })) };
}

/** A plain, mutable keys.json payload object — tests edit it to build bad documents. */
export function keysDoc(opts: {
  version: number;
  root: readonly TestKey[];
  rootThreshold?: number;
  release: readonly TestKey[];
  releaseThreshold?: number;
  releaseExpires?: Date;
  revoked?: readonly string[];
  issued?: Date;
  expires?: Date;
  authenticode?: { required: boolean; signers: unknown[] };
}): Record<string, any> {
  return {
    type: 'claudally.update.keys',
    spec_version: 1,
    version: opts.version,
    issued: iso(opts.issued ?? at(-14 * DAY)),
    expires: iso(opts.expires ?? at(351 * DAY)),
    root: {
      threshold: opts.rootThreshold ?? 1,
      keys: opts.root.map((k, i) => ({ keyid: k.keyid, public_key: k.b64, holder: `root-${i + 1}` })),
    },
    release: {
      threshold: opts.releaseThreshold ?? 1,
      keys: opts.release.map((k, i) => ({
        keyid: k.keyid, public_key: k.b64, holder: `release-${String.fromCharCode(65 + i)}`, expires: iso(opts.releaseExpires ?? at(351 * DAY)),
      })),
    },
    revoked_keyids: [...(opts.revoked ?? [])],
    channels: ['stable'],
    authenticode: opts.authenticode ?? { required: false, signers: [] },
  };
}

export const ARTIFACT_BYTES = Buffer.from('MZ\u0090\u0000 not really an installer, but a fixed byte string for the tests\n', 'latin1');
export const ARTIFACT_SHA256 = crypto.createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

/** A plain, mutable manifest.json payload object. */
export function manifestDoc(opts: {
  sequence: number;
  version?: string;
  upgradeFromMin?: string;
  securityFloor?: string;
  blocked?: string[];
  issued?: Date;
  expires?: Date;
  minKeysVersion?: number;
  channel?: string;
} = { sequence: 1 }): Record<string, any> {
  const version = opts.version ?? '0.8.0';
  const issued = opts.issued ?? at(-5 * DAY);
  return {
    type: 'claudally.update.manifest',
    spec_version: 1,
    channel: opts.channel ?? 'stable',
    sequence: opts.sequence,
    issued: iso(issued),
    expires: iso(opts.expires ?? new Date(issued.getTime() + 45 * DAY)),
    min_keys_version: opts.minKeysVersion ?? 1,
    release: {
      version,
      upgrade_from_min: opts.upgradeFromMin ?? '0.7.0',
      artifact: {
        url: `https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/download/v${version}/Claudally-Setup-${version}.exe`,
        size: ARTIFACT_BYTES.length,
        sha256: ARTIFACT_SHA256,
      },
      provenance: {
        tag: `v${version}`,
        commit: 'a'.repeat(40),
        workflow: '.github/workflows/release.yml',
        build_sha256: ARTIFACT_SHA256,
      },
      notes_url: `https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/tag/v${version}`,
    },
    security_floor: opts.securityFloor ?? '0.7.0',
    blocked_versions: opts.blocked ?? [],
    advisory: null,
  };
}

export function bytesOf(doc: unknown): Buffer {
  return Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
}

function sign(type: PayloadType, doc: unknown, signers: readonly TestKey[]): Buffer {
  const payload = Buffer.isBuffer(doc) ? doc : bytesOf(doc);
  return signEnvelope(type, payload, signers.map((k) => k.privateKey));
}

export function signKeys(doc: unknown, signers: readonly TestKey[]): Buffer {
  return sign(KEYS_PAYLOAD_TYPE, doc, signers);
}

export function signManifest(doc: unknown, signers: readonly TestKey[]): Buffer {
  return sign(MANIFEST_PAYLOAD_TYPE, doc, signers);
}

/** Rewrites an envelope's JSON (to tamper with it after signing). */
export function editEnvelope(envelope: Buffer, edit: (env: any) => void): Buffer {
  const env = JSON.parse(envelope.toString('utf8'));
  edit(env);
  return Buffer.from(JSON.stringify(env), 'utf8');
}
