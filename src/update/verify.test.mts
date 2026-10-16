import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { UpdateVerificationError } from './errors.mjs';
import { MAX_METADATA_BYTES } from './dsse.mjs';
import {
  INITIAL_STATE,
  decideUpdate,
  refreshKeySet,
  resolveUpdatePolicy,
  verifyManifest,
  type UpdateState,
} from './verify.mjs';
import {
  DAY,
  T0,
  at,
  bytesOf,
  editEnvelope,
  iso,
  keysDoc,
  manifestDoc,
  newKey,
  rootOf,
  signKeys,
  signManifest,
  type TestKey,
} from './testkit.mjs';

// Every rejection path of update-manifest.md §6 (steps 1, 2, 4, 5) and the negative-test list in §11.
// Keys are throwaway Ed25519 keys generated for this run; failures are reached by building different
// inputs, never by switching a check off.

function rejects(fn: () => unknown, code: string, surface?: string): UpdateVerificationError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof UpdateVerificationError, `expected UpdateVerificationError ${code}, got ${caught instanceof Error ? caught.stack : String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (surface) assert.equal(caught.surface, surface, `surface of ${code}`);
  return caught;
}

function reasons(err: UpdateVerificationError): string[] {
  return (err.details.rejected as { reason: string }[]).map((r) => r.reason);
}

// One hierarchy for the file: root R1 (pinned), release keys A and B; spares for rotation tests.
const R1 = newKey();
const R2 = newKey();
const R3 = newKey();
const A = newKey();
const B = newKey();
const C = newKey();
const STRANGER = newKey();
const PINNED = rootOf([R1]);

const keysV1 = () => keysDoc({ version: 1, root: [R1], release: [A] });
const KEYS_V1 = signKeys(keysV1(), [R1]);

function refresh(state: UpdateState, envelopes: Buffer[], now = T0, root = PINNED) {
  return refreshKeySet({ root, state, keySetEnvelopes: envelopes, now });
}

/** State that trusts the given chain of key-set envelopes (first-run walk from the pinned root). */
function trusting(...envelopes: Buffer[]): UpdateState {
  return refresh(INITIAL_STATE, envelopes).state;
}

function manifest(state: UpdateState, envelope: Buffer, now = T0, channel = 'stable') {
  return verifyManifest({ state, manifestEnvelope: envelope, channel, now });
}

const V1_STATE = trusting(KEYS_V1);
const MANIFEST_1 = signManifest(manifestDoc({ sequence: 1 }), [A]);

// ─── Happy path ─────────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  test('first run: a key set signed by the pinned root is adopted, then a manifest signed by its release key verifies', () => {
    const r = refresh(INITIAL_STATE, [KEYS_V1]);
    assert.deepEqual(r.adoptedVersions, [1]);
    assert.equal(r.keySet.version, 1);
    assert.equal(r.state.authenticodeLatched, false);
    assert.equal(Buffer.from(r.state.keySet!.envelope, 'base64').equals(KEYS_V1), true, 'state holds the exact verified bytes');

    const v = manifest(r.state, MANIFEST_1);
    assert.equal(v.manifest.release.version, '0.8.0');
    assert.equal(v.manifest.sequence, 1);
    assert.equal(v.manifest.release.artifact.url, 'https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/download/v0.8.0/Claudally-Setup-0.8.0.exe');
    assert.deepEqual(v.authenticode, { required: false, signers: [] });
    assert.equal(v.state.manifest!.sequence, 1);
    assert.equal(v.state.manifest!.channel, 'stable');
    assert.match(v.state.manifest!.payloadSha256, /^[0-9a-f]{64}$/);
    assert.equal(v.state.manifest!.expires, manifestDoc({ sequence: 1 }).expires);

    const d = decideUpdate(v.manifest, '0.7.0', 'security-auto');
    assert.equal(d.path, 'feature');
    assert.equal(d.install, 'on-consent');
  });

  test('state round-trips through JSON (what the updater persists is what it loads)', () => {
    const s1 = JSON.parse(JSON.stringify(manifest(V1_STATE, MANIFEST_1).state));
    const again = manifest(s1, MANIFEST_1);
    assert.equal(again.manifest.sequence, 1);
    const r = refresh(JSON.parse(JSON.stringify(V1_STATE)), [KEYS_V1]);
    assert.deepEqual(r.adoptedVersions, [], 'the same key set again changes nothing');
  });

  test('a higher sequence is accepted and recorded', () => {
    const s = manifest(V1_STATE, MANIFEST_1).state;
    const v = manifest(s, signManifest(manifestDoc({ sequence: 2, version: '0.8.1' }), [A]));
    assert.equal(v.state.manifest!.sequence, 2);
  });
});

// ─── Step 1: trust anchors ─────────────────────────────────────────────────────────────────────

describe('step 1: pinned root', () => {
  test('an empty pinned root verifies nothing', () => {
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], T0, { threshold: 1, keys: [] }), 'ROOT_NOT_CONFIGURED', 'internal');
  });
  test('a pinned threshold above the pinned key count is refused', () => {
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], T0, rootOf([R1], 2)), 'ROOT_NOT_CONFIGURED');
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], T0, rootOf([R1], 0)), 'ROOT_NOT_CONFIGURED');
  });
  test('a pinned key whose keyid does not match it is refused', () => {
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], T0, { threshold: 1, keys: [{ keyid: R2.keyid, public_key: R1.b64 }] }), 'ROOT_NOT_CONFIGURED');
  });
  test('a pinned key listed twice is refused (it would count twice toward nothing, but is a build fault)', () => {
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], T0, rootOf([R1, R1], 2)), 'ROOT_NOT_CONFIGURED');
  });
  test('first run needs a key set signed by the pinned root; one signed by another root is refused', () => {
    const other = signKeys(keysDoc({ version: 1, root: [R2], release: [A] }), [R2]);
    const err = rejects(() => refresh(INITIAL_STATE, [other]), 'SIGNATURE_THRESHOLD_NOT_MET', 'verification-failed');
    assert.deepEqual(reasons(err), ['unknown-key']);
  });
});

// ─── Step 2: key-set refresh ───────────────────────────────────────────────────────────────────

describe('step 2: key-set refresh', () => {
  test('nothing trusted and nothing fetched: a transport problem, not an attack', () => {
    rejects(() => refresh(INITIAL_STATE, []), 'KEYSET_MISSING', 'transport');
  });

  test('fetch failed but the trusted key set is unexpired: continue with it', () => {
    const r = refresh(V1_STATE, []);
    assert.equal(r.keySet.version, 1);
    assert.deepEqual(r.adoptedVersions, []);
  });

  test('fetch failed and the trusted key set has expired: stop, "update keys expired"', () => {
    const expires = new Date(keysV1().expires);
    rejects(() => refresh(V1_STATE, [], expires), 'KEYSET_EXPIRED', 'update-keys-expired');
  });

  test('expiry boundary: valid until the instant before `expires`, rejected at `expires`', () => {
    const expires = new Date(keysV1().expires);
    assert.equal(refresh(V1_STATE, [], at(-1, expires)).keySet.version, 1);
    rejects(() => refresh(V1_STATE, [], expires), 'KEYSET_EXPIRED');
    rejects(() => refresh(INITIAL_STATE, [KEYS_V1], expires), 'KEYSET_EXPIRED');
  });

  test('the newest key set in a walk must be unexpired', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A], issued: at(-10 * DAY), expires: at(-1 * DAY) }), [R1]);
    rejects(() => refresh(V1_STATE, [v2]), 'KEYSET_EXPIRED');
  });

  test('bad signature: payload altered after signing', () => {
    const doc = keysV1();
    const env = editEnvelope(KEYS_V1, (e) => {
      doc.release.threshold = 1;
      doc.channels = ['stable', 'beta'];
      e.payload = bytesOf(doc).toString('base64');
    });
    const err = rejects(() => refresh(INITIAL_STATE, [env]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['bad-signature']);
    assert.equal(err.details.role, 'root');
  });

  test('valid signature by an unknown key', () => {
    const err = rejects(() => refresh(INITIAL_STATE, [signKeys(keysV1(), [STRANGER])]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['unknown-key']);
  });

  test('mix-and-match: a key set signed by a release key is refused as wrong-role', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A] }), [A]);
    const err = rejects(() => refresh(V1_STATE, [v2]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['wrong-role']);
  });

  test('wrong payloadType: a manifest envelope where a key set is expected', () => {
    rejects(() => refresh(V1_STATE, [MANIFEST_1]), 'PAYLOAD_TYPE_MISMATCH', 'verification-failed');
  });

  test('payloadType and `type` disagreeing', () => {
    const doc = keysV1();
    doc.type = 'claudally.update.manifest';
    rejects(() => refresh(INITIAL_STATE, [signKeys(doc, [R1])]), 'DOCUMENT_TYPE_MISMATCH');
  });

  test('unsupported spec_version', () => {
    const doc = keysV1();
    doc.spec_version = 2;
    rejects(() => refresh(INITIAL_STATE, [signKeys(doc, [R1])]), 'SPEC_VERSION_UNSUPPORTED');
  });

  test('unknown or missing fields anywhere in keys.json', () => {
    const cases: ((d: Record<string, any>) => void)[] = [
      (d) => { d.extra = true; },
      (d) => { delete d.revoked_keyids; },
      (d) => { d.root.extra = 1; },
      (d) => { d.release.keys[0].extra = 1; },
      (d) => { delete d.release.keys[0].expires; },
      (d) => { d.root.keys[0].expires = d.expires; },
      (d) => { d.authenticode.bypass = true; },
      (d) => { d.version = '2'; },
      (d) => { d.issued = '2026-10-01T09:00:00.000Z'; },
      (d) => { d.issued = '2026-10-01T09:00:00+00:00'; },
      (d) => { d.expires = '2027-02-30T00:00:00Z'; },
      (d) => { d.expires = d.issued; },
      (d) => { d.channels = []; },
      (d) => { d.channels = ['Stable']; },
      (d) => { d.root.keys = []; },
      (d) => { d.root.keys[0].holder = 'root\u0000'; },
      (d) => { d.authenticode = { required: true, signers: [] }; },
      (d) => { d.authenticode.signers = [{ subject: 'CN=x', issuer_ca_sha256: ['A'.repeat(64)], require_timestamp: true }]; },
    ];
    for (const [i, edit] of cases.entries()) {
      const doc = keysV1();
      edit(doc);
      rejects(() => refresh(INITIAL_STATE, [signKeys(doc, [R1])]), 'PAYLOAD_INVALID', 'verification-failed');
      assert.ok(true, `case ${i}`);
    }
  });

  test('duplicate JSON keys in the signed payload', () => {
    const text = bytesOf(keysV1()).toString('utf8').replace('"version": 1,', '"version": 1,\n  "version": 1,');
    rejects(() => refresh(INITIAL_STATE, [signKeys(Buffer.from(text), [R1])]), 'PAYLOAD_INVALID');
  });

  test('a non-integer version (1.0) is refused, not read as 1', () => {
    const text = bytesOf(keysV1()).toString('utf8').replace('"version": 1,', '"version": 1.0,');
    rejects(() => refresh(INITIAL_STATE, [signKeys(Buffer.from(text), [R1])]), 'PAYLOAD_INVALID');
  });

  test('keyid not matching public_key', () => {
    for (const role of ['root', 'release'] as const) {
      const doc = keysV1();
      doc[role].keys[0].keyid = STRANGER.keyid;
      rejects(() => refresh(INITIAL_STATE, [signKeys(doc, [R1])]), 'KEYID_MISMATCH', 'verification-failed');
    }
  });

  test('a public key in non-canonical base64, or not 32 bytes', () => {
    const doc = keysV1();
    doc.release.keys[0].public_key = A.b64.replace('=', '');
    rejects(() => refresh(INITIAL_STATE, [signKeys(doc, [R1])]), 'PAYLOAD_INVALID');
    const doc2 = keysV1();
    doc2.release.keys[0].public_key = Buffer.concat([A.raw, Buffer.from([0])]).toString('base64');
    rejects(() => refresh(INITIAL_STATE, [signKeys(doc2, [R1])]), 'PAYLOAD_INVALID');
  });

  test('duplicate key ids in a role, a key in both roles, and thresholds that cannot be met', () => {
    rejects(() => refresh(INITIAL_STATE, [signKeys(keysDoc({ version: 1, root: [R1], release: [A, A] }), [R1])]), 'KEYSET_INVALID');
    rejects(() => refresh(INITIAL_STATE, [signKeys(keysDoc({ version: 1, root: [R1, R1], release: [A] }), [R1])]), 'KEYSET_INVALID');
    rejects(() => refresh(INITIAL_STATE, [signKeys(keysDoc({ version: 1, root: [R1], release: [A, R1] }), [R1])]), 'KEYSET_INVALID');
    rejects(() => refresh(INITIAL_STATE, [signKeys(keysDoc({ version: 1, root: [R1], release: [A], releaseThreshold: 2 }), [R1])]), 'KEYSET_INVALID');
    rejects(() => refresh(INITIAL_STATE, [signKeys(keysDoc({ version: 1, root: [R1], rootThreshold: 2, release: [A] }), [R1])]), 'KEYSET_INVALID');
    const dupRevoked = keysV1();
    dupRevoked.revoked_keyids = [C.keyid, C.keyid];
    rejects(() => refresh(INITIAL_STATE, [signKeys(dupRevoked, [R1])]), 'KEYSET_INVALID');
  });

  test('key-set version rollback: a lower version is an attack signal', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A, B] }), [R1]);
    const s2 = trusting(KEYS_V1, v2);
    const err = rejects(() => refresh(s2, [KEYS_V1]), 'KEYSET_ROLLBACK', 'verification-failed');
    assert.equal(err.loud, true);
  });

  test('the same key-set version with different bytes is a rollback too', () => {
    const other = keysV1();
    other.release.keys.push({ keyid: B.keyid, public_key: B.b64, holder: 'release-B', expires: other.release.keys[0].expires });
    rejects(() => refresh(V1_STATE, [signKeys(other, [R1])]), 'KEYSET_ROLLBACK');
  });

  test('the same key-set version with the same bytes is accepted (no change)', () => {
    const r = refresh(V1_STATE, [KEYS_V1]);
    assert.deepEqual(r.adoptedVersions, []);
    assert.equal(r.keySet.version, 1);
  });

  test('key-set version gap: v1 → v3 without v2 is refused', () => {
    const v3 = signKeys(keysDoc({ version: 3, root: [R1], release: [A] }), [R1]);
    rejects(() => refresh(V1_STATE, [v3]), 'KEYSET_VERSION_GAP');
  });

  test('a chain v1 → v2 → v3 is walked in order', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A, B] }), [R1]);
    const v3 = signKeys(keysDoc({ version: 3, root: [R1], release: [B] }), [R1]);
    const r = refresh(V1_STATE, [v2, v3]);
    assert.deepEqual(r.adoptedVersions, [2, 3]);
    assert.deepEqual(r.keySet.release.keys.map((k) => k.keyid), [B.keyid]);
    rejects(() => refresh(V1_STATE, [v3, v2]), 'KEYSET_VERSION_GAP');
  });

  test('a failure part-way through a walk adopts nothing', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A] }), [R1]);
    const v3bad = signKeys(keysDoc({ version: 3, root: [R1], release: [A] }), [STRANGER]);
    rejects(() => refresh(V1_STATE, [v2, v3bad]), 'SIGNATURE_THRESHOLD_NOT_MET');
    // The caller persists only a returned state; V1_STATE is unchanged.
    assert.equal(refresh(V1_STATE, []).keySet.version, 1);
  });

  test('first run may start the chain at any key set the pinned root signed', () => {
    const v5 = signKeys(keysDoc({ version: 5, root: [R1], release: [A] }), [R1]);
    assert.equal(refresh(INITIAL_STATE, [v5]).keySet.version, 5);
  });
});

describe('step 2: root rotation and thresholds', () => {
  const rotated = keysDoc({ version: 2, root: [R2], release: [A] });

  test('rotation signed by both the old and the new root is adopted', () => {
    const r = refresh(V1_STATE, [signKeys(rotated, [R1, R2])]);
    assert.deepEqual(r.keySet.root.keys.map((k) => k.keyid), [R2.keyid]);
  });

  test('rotation signed only by the old root is refused (new root has not signed)', () => {
    const err = rejects(() => refresh(V1_STATE, [signKeys(rotated, [R1])]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.equal(err.details.role, 'new-root');
  });

  test('rotation signed only by the new root is refused (old root has not signed)', () => {
    const err = rejects(() => refresh(V1_STATE, [signKeys(rotated, [R2])]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.equal(err.details.role, 'root');
  });

  test('after a rotation, the next key set must be signed by the new root; the old one no longer counts', () => {
    const s2 = refresh(V1_STATE, [signKeys(rotated, [R1, R2])]).state;
    const v3 = keysDoc({ version: 3, root: [R2], release: [B] });
    assert.equal(refresh(s2, [signKeys(v3, [R2])]).keySet.version, 3);
    const err = rejects(() => refresh(s2, [signKeys(v3, [R1])]), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['unknown-key']);
  });

  test('a client offline across a rotation follows the chain from the old pinned root', () => {
    const v2 = signKeys(rotated, [R1, R2]);
    const v3 = signKeys(keysDoc({ version: 3, root: [R2], release: [B] }), [R2]);
    const r = refresh(INITIAL_STATE, [KEYS_V1, v2, v3]);
    assert.deepEqual(r.adoptedVersions, [1, 2, 3]);
  });

  describe('2-of-3 root (a data change, not a code change)', () => {
    const to2of3 = keysDoc({ version: 2, root: [R1, R2, R3], rootThreshold: 2, release: [A] });
    const s2 = refresh(V1_STATE, [signKeys(to2of3, [R1, R2])]).state;
    const v3 = keysDoc({ version: 3, root: [R1, R2, R3], rootThreshold: 2, release: [B] });

    test('moving 1-of-1 → 2-of-3 needs the old root and 2 of the new', () => {
      const err = rejects(() => refresh(V1_STATE, [signKeys(to2of3, [R1])]), 'SIGNATURE_THRESHOLD_NOT_MET');
      assert.equal(err.details.role, 'new-root');
      assert.equal(err.details.valid, 1);
      assert.equal(refresh(V1_STATE, [signKeys(to2of3, [R2, R3, R1])]).keySet.root.threshold, 2);
    });

    test('1 valid signature of 3 keys is rejected', () => {
      const err = rejects(() => refresh(s2, [signKeys(v3, [R3])]), 'SIGNATURE_THRESHOLD_NOT_MET');
      assert.equal(err.details.threshold, 2);
      assert.equal(err.details.valid, 1);
    });

    test('2 valid signatures are accepted', () => {
      assert.equal(refresh(s2, [signKeys(v3, [R1, R3])]).keySet.version, 3);
    });

    test('1 valid signature plus 1 bad one is rejected', () => {
      const bad = editEnvelope(signKeys(v3, [R1, R2]), (e) => {
        const sig = Buffer.from(e.signatures[1].sig, 'base64');
        sig[0] ^= 1;
        e.signatures[1].sig = sig.toString('base64');
      });
      const err = rejects(() => refresh(s2, [bad]), 'SIGNATURE_THRESHOLD_NOT_MET');
      assert.deepEqual(reasons(err), ['bad-signature']);
    });

    test('the same key\'s signature duplicated does not fake a threshold', () => {
      const dup = editEnvelope(signKeys(v3, [R1]), (e) => { e.signatures.push({ ...e.signatures[0] }); });
      const err = rejects(() => refresh(s2, [dup]), 'SIGNATURE_THRESHOLD_NOT_MET');
      assert.deepEqual(reasons(err), ['duplicate']);
    });

    test('unknown key ids alongside a met threshold are ignored, not errors', () => {
      assert.equal(refresh(s2, [signKeys(v3, [STRANGER, R2, R3])]).keySet.version, 3);
    });
  });
});

describe('step 2: Authenticode policy and latch', () => {
  const signer = { subject: 'CN=JINA CODE SYSTEMS LLP, O=JINA CODE SYSTEMS LLP, C=IN', issuer_ca_sha256: ['c'.repeat(64)], require_timestamp: true };
  const v2required = signKeys(keysDoc({ version: 2, root: [R1], release: [A], authenticode: { required: true, signers: [signer] } }), [R1]);

  test('a key set requiring Authenticode sets the latch, and the manifest reports the policy', () => {
    const r = refresh(V1_STATE, [v2required]);
    assert.equal(r.state.authenticodeLatched, true);
    assert.deepEqual(r.keySet.authenticode.signers, [{ subject: signer.subject, issuerCaSha256: signer.issuer_ca_sha256, requireTimestamp: true }]);
    const v = manifest(r.state, MANIFEST_1);
    assert.equal(v.authenticode.required, true);
  });

  test('latch cleared by a later, validly root-signed key set is refused', () => {
    const s2 = refresh(V1_STATE, [v2required]).state;
    const v3 = signKeys(keysDoc({ version: 3, root: [R1], release: [A] }), [R1]);
    rejects(() => refresh(s2, [v3]), 'AUTHENTICODE_LATCH_VIOLATION', 'verification-failed');
    rejects(() => refresh(V1_STATE, [v2required, v3]), 'AUTHENTICODE_LATCH_VIOLATION');
  });

  test('state claiming the latch while its key set does not require it is damaged state', () => {
    rejects(() => refresh({ ...V1_STATE, authenticodeLatched: true }, []), 'STATE_INVALID', 'internal');
  });
});

describe('persisted state', () => {
  test('unknown fields or wrong types in state are refused', () => {
    rejects(() => refresh({ ...V1_STATE, skipVerification: true } as unknown as UpdateState, []), 'STATE_INVALID');
    rejects(() => refresh({ ...V1_STATE, authenticodeLatched: 'no' } as unknown as UpdateState, []), 'STATE_INVALID');
    rejects(() => refresh(null as unknown as UpdateState, []), 'STATE_INVALID');
  });

  test('a stored key set that no longer verifies is refused as damaged state', () => {
    const tampered = editEnvelope(KEYS_V1, (e) => {
      const d = keysV1();
      d.release.keys.push({ keyid: STRANGER.keyid, public_key: STRANGER.b64, holder: 'x', expires: d.expires });
      e.payload = bytesOf(d).toString('base64');
    });
    const state = { ...V1_STATE, keySet: { envelope: tampered.toString('base64') } };
    const err = rejects(() => manifest(state, signManifest(manifestDoc({ sequence: 1 }), [STRANGER])), 'STATE_INVALID', 'internal');
    assert.equal(err.details.cause, 'SIGNATURE_THRESHOLD_NOT_MET');
  });
});

// ─── Step 4: manifest ──────────────────────────────────────────────────────────────────────────

describe('step 4: manifest verification', () => {
  test('no trusted key set yet', () => {
    rejects(() => manifest(INITIAL_STATE, MANIFEST_1), 'KEYSET_MISSING', 'transport');
  });

  test('the trusted key set has expired', () => {
    rejects(() => manifest(V1_STATE, MANIFEST_1, new Date(keysV1().expires)), 'KEYSET_EXPIRED', 'update-keys-expired');
  });

  test('bad signature: manifest altered after signing (e.g. a different artifact hash)', () => {
    const doc = manifestDoc({ sequence: 1 });
    const env = editEnvelope(MANIFEST_1, (e) => {
      doc.release.artifact.sha256 = 'f'.repeat(64);
      e.payload = bytesOf(doc).toString('base64');
    });
    const err = rejects(() => manifest(V1_STATE, env), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['bad-signature']);
  });

  test('valid signature by an unknown key', () => {
    const err = rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1 }), [STRANGER])), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['unknown-key']);
  });

  test('mix-and-match: a manifest signed by the root key (not authorised for manifests) is refused', () => {
    const err = rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1 }), [R1])), 'SIGNATURE_THRESHOLD_NOT_MET', 'verification-failed');
    assert.deepEqual(reasons(err), ['wrong-role']);
    assert.equal(err.details.role, 'release');
  });

  test('wrong payloadType: a key-set envelope where a manifest is expected', () => {
    rejects(() => manifest(V1_STATE, KEYS_V1), 'PAYLOAD_TYPE_MISMATCH');
  });

  test('payloadType and `type` disagreeing', () => {
    const doc = manifestDoc({ sequence: 1 });
    doc.type = 'claudally.update.keys';
    rejects(() => manifest(V1_STATE, signManifest(doc, [A])), 'DOCUMENT_TYPE_MISMATCH');
  });

  test('unsupported spec_version', () => {
    const doc = manifestDoc({ sequence: 1 });
    doc.spec_version = 2;
    rejects(() => manifest(V1_STATE, signManifest(doc, [A])), 'SPEC_VERSION_UNSUPPORTED');
  });

  test('a revoked release key is refused even if it reappears in the release list', () => {
    const v2 = signKeys(keysDoc({ version: 2, root: [R1], release: [A, B], revoked: [A.keyid] }), [R1]);
    const s2 = refresh(V1_STATE, [v2]).state;
    const err = rejects(() => manifest(s2, signManifest(manifestDoc({ sequence: 1 }), [A])), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['revoked']);
    assert.equal(manifest(s2, signManifest(manifestDoc({ sequence: 1 }), [B])).manifest.sequence, 1);
  });

  test('a release key dropped from the key set no longer signs', () => {
    const s2 = refresh(V1_STATE, [signKeys(keysDoc({ version: 2, root: [R1], release: [B], revoked: [A.keyid] }), [R1])]).state;
    const err = rejects(() => manifest(s2, signManifest(manifestDoc({ sequence: 1 }), [A])), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['unknown-key']);
  });

  test('an expired release key is refused, from the instant of its expiry', () => {
    const keyExpires = at(10 * DAY);
    const s = trusting(signKeys(keysDoc({ version: 1, root: [R1], release: [A], releaseExpires: keyExpires }), [R1]));
    const env = signManifest(manifestDoc({ sequence: 1 }), [A]);
    assert.equal(manifest(s, env, at(-1, keyExpires)).manifest.sequence, 1);
    const err = rejects(() => manifest(s, env, keyExpires), 'SIGNATURE_THRESHOLD_NOT_MET');
    assert.deepEqual(reasons(err), ['expired']);
  });

  describe('release threshold 2', () => {
    const s = trusting(signKeys(keysDoc({ version: 1, root: [R1], release: [A, B, C], releaseThreshold: 2 }), [R1]));
    const doc = manifestDoc({ sequence: 1 });
    test('one signature is not enough', () => {
      rejects(() => manifest(s, signManifest(doc, [A])), 'SIGNATURE_THRESHOLD_NOT_MET');
    });
    test('the same key twice is not two signatures', () => {
      const err = rejects(() => manifest(s, signManifest(doc, [A, A])), 'SIGNATURE_THRESHOLD_NOT_MET');
      assert.deepEqual(reasons(err), ['duplicate']);
    });
    test('two distinct keys are', () => {
      assert.equal(manifest(s, signManifest(doc, [C, A])).manifest.sequence, 1);
    });
  });

  test('wrong channel in the manifest', () => {
    rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, channel: 'beta' }), [A])), 'CHANNEL_MISMATCH', 'verification-failed');
  });

  test('a channel the key set does not authorise', () => {
    rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, channel: 'beta' }), [A]), T0, 'beta'), 'CHANNEL_MISMATCH');
  });

  test('min_keys_version above the trusted key set (an old key set paired with a new manifest)', () => {
    const err = rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, minKeysVersion: 2 }), [A])), 'MANIFEST_KEYS_TOO_OLD');
    assert.deepEqual(err.details, { required: 2, trusted: 1 });
  });

  test('lower sequence is a rollback', () => {
    const s5 = manifest(V1_STATE, signManifest(manifestDoc({ sequence: 5 }), [A])).state;
    rejects(() => manifest(s5, signManifest(manifestDoc({ sequence: 4 }), [A])), 'MANIFEST_ROLLBACK', 'verification-failed');
  });

  test('equal sequence with different bytes is a rollback', () => {
    const s1 = manifest(V1_STATE, MANIFEST_1).state;
    rejects(() => manifest(s1, signManifest(manifestDoc({ sequence: 1, version: '0.9.0' }), [A])), 'MANIFEST_ROLLBACK');
  });

  test('equal sequence with identical payload bytes is accepted (even with a re-ordered signature list)', () => {
    const s = trusting(signKeys(keysDoc({ version: 1, root: [R1], release: [A, B] }), [R1]));
    const s1 = manifest(s, signManifest(manifestDoc({ sequence: 1 }), [A, B])).state;
    assert.equal(manifest(s1, signManifest(manifestDoc({ sequence: 1 }), [B, A])).manifest.sequence, 1);
  });

  test('freeze: the last manifest replayed is accepted until it expires, then refused as stale', () => {
    const doc = manifestDoc({ sequence: 1 });
    const s1 = manifest(V1_STATE, MANIFEST_1).state;
    const expires = new Date(doc.expires);
    assert.equal(manifest(s1, MANIFEST_1, at(-1, expires)).manifest.sequence, 1);
    const err = rejects(() => manifest(s1, MANIFEST_1, expires), 'MANIFEST_EXPIRED', 'stale');
    assert.equal(err.loud, false, 'a freeze is amber, not a verification failure');
    // An older (lower-sequence) manifest cannot stand in for a newer one to hold the client back.
    const s2 = manifest(s1, signManifest(manifestDoc({ sequence: 2, version: '0.8.1' }), [A])).state;
    rejects(() => manifest(s2, MANIFEST_1), 'MANIFEST_ROLLBACK');
  });

  test('expiry boundary: `expires` > now, exactly', () => {
    const expires = at(1 * DAY);
    const env = signManifest(manifestDoc({ sequence: 1, issued: at(-44 * DAY), expires }), [A]);
    assert.equal(manifest(V1_STATE, env, at(-1, expires)).manifest.sequence, 1);
    rejects(() => manifest(V1_STATE, env, expires), 'MANIFEST_EXPIRED');
    rejects(() => manifest(V1_STATE, env, at(1, expires)), 'MANIFEST_EXPIRED');
  });

  test('issued more than 1 hour in the future is refused; exactly 1 hour is allowed', () => {
    const hour = 60 * 60 * 1000;
    assert.equal(manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, issued: at(hour) }), [A])).manifest.sequence, 1);
    rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, issued: at(hour + 1000) }), [A])), 'MANIFEST_FROM_FUTURE');
  });

  test('a manifest valid for more than 45 days, or expiring before it is issued, is refused', () => {
    const issued = at(-1 * DAY);
    assert.equal(manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, issued, expires: at(45 * DAY, issued) }), [A])).manifest.sequence, 1);
    rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, issued, expires: at(45 * DAY + 1000, issued) }), [A])), 'MANIFEST_LIFETIME_TOO_LONG');
    rejects(() => manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, issued, expires: issued }), [A])), 'MANIFEST_LIFETIME_TOO_LONG');
  });

  test('release.version must be strict MAJOR.MINOR.PATCH (a prerelease on stable is refused)', () => {
    for (const version of ['0.8.0-rc.1', '0.8.0+build', 'v0.8.0', '0.8', '00.8.0', '0.8.0.1']) {
      const doc = manifestDoc({ sequence: 1 });
      doc.release.version = version;
      rejects(() => manifest(V1_STATE, signManifest(doc, [A])), 'RELEASE_VERSION_INVALID');
    }
  });

  test('artifact URL must be canonical https on github.com', () => {
    for (const url of [
      'http://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/download/v0.8.0/Claudally-Setup-0.8.0.exe',
      'https://evil.example/Claudally-Setup-0.8.0.exe',
      'https://github.com.evil.example/x.exe',
      'https://objects.githubusercontent.com/x.exe',
      'https://user@github.com/x.exe',
      'https://github.com:444/x.exe',
      'HTTPS://GITHUB.COM/x.exe',
      'https://github.com/a/../x.exe',
      'file:///C:/x.exe',
    ]) {
      const doc = manifestDoc({ sequence: 1 });
      doc.release.artifact.url = url;
      rejects(() => manifest(V1_STATE, signManifest(doc, [A])), 'ARTIFACT_URL_INVALID');
    }
  });

  test('unknown, missing or malformed fields anywhere in the manifest', () => {
    const cases: ((d: Record<string, any>) => void)[] = [
      (d) => { d.install_command = 'calc.exe'; },
      (d) => { delete d.advisory; },
      (d) => { d.release.extra = 1; },
      (d) => { d.release.artifact.second_url = d.release.artifact.url; },
      (d) => { delete d.release.artifact.size; },
      (d) => { d.release.artifact.size = 0; },
      (d) => { d.release.artifact.size = '98765432'; },
      (d) => { d.release.artifact.sha256 = d.release.artifact.sha256.toUpperCase(); },
      (d) => { d.release.artifact.sha256 = 'abc'; },
      (d) => { d.release.provenance.commit = 'xyz'; },
      (d) => { d.release.notes_url = 'http://github.com/notes'; },
      (d) => { d.security_floor = '0.8'; },
      (d) => { d.upgrade_from_min = '0.7.0'; },
      (d) => { d.release.upgrade_from_min = '0.7.0-beta'; },
      (d) => { d.blocked_versions = ['0.7.1', '0.7.1']; },
      (d) => { d.advisory = { id: 'GHSA-x', summary: 's' }; },
      (d) => { d.advisory = { id: 'GHSA-x', summary: 's', url: 'http://x.example/' }; },
      (d) => { d.sequence = 0; },
      (d) => { d.sequence = -1; },
      (d) => { d.min_keys_version = 0; },
      (d) => { d.issued = 'yesterday'; },
    ];
    for (const edit of cases) {
      const doc = manifestDoc({ sequence: 1 });
      edit(doc);
      rejects(() => manifest(V1_STATE, signManifest(doc, [A])), 'PAYLOAD_INVALID');
    }
  });

  test('duplicate JSON keys in the manifest payload (two artifact hashes)', () => {
    const doc = manifestDoc({ sequence: 1 });
    const text = bytesOf(doc).toString('utf8').replace(`"sha256": "${doc.release.artifact.sha256}"`, `"sha256": "${'0'.repeat(64)}",\n"sha256": "${doc.release.artifact.sha256}"`);
    rejects(() => manifest(V1_STATE, signManifest(Buffer.from(text), [A])), 'PAYLOAD_INVALID');
  });

  test('oversized metadata', () => {
    const doc = manifestDoc({ sequence: 1 });
    doc.advisory = { id: 'GHSA-x', summary: 'x'.repeat(1000), url: 'https://x.example/' };
    const big = editEnvelope(signManifest(doc, [A]), (e) => { e.payload = Buffer.alloc(MAX_METADATA_BYTES).toString('base64'); });
    rejects(() => manifest(V1_STATE, big), 'METADATA_TOO_LARGE', 'transport');
  });

  test('stored manifest state for another channel is damaged state', () => {
    const s1 = manifest(V1_STATE, MANIFEST_1).state;
    rejects(() => manifest({ ...s1, manifest: { ...s1.manifest!, channel: 'beta' } }, MANIFEST_1), 'STATE_INVALID');
  });
});

// ─── Step 5: decide ────────────────────────────────────────────────────────────────────────────

describe('step 5: decision and policy', () => {
  const m = manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, version: '0.9.0', upgradeFromMin: '0.6.0', securityFloor: '0.8.0', blocked: ['0.8.2'] }), [A])).manifest;

  test('installed at or above the release: nothing to do, never a downgrade', () => {
    for (const installed of ['0.9.0', '0.9.1', '1.0.0']) {
      const d = decideUpdate(m, installed, 'security-auto');
      assert.equal(d.path, 'up-to-date');
      assert.equal(d.install, 'none');
    }
  });

  test('installed below upgrade_from_min: no automatic update, even on the security path', () => {
    const d = decideUpdate(m, '0.5.9', 'security-auto');
    assert.equal(d.path, 'too-old');
    assert.equal(d.install, 'none');
  });

  test('installed below security_floor: security path, automatic under either policy', () => {
    for (const policy of ['security-auto', 'security-only'] as const) {
      const d = decideUpdate(m, '0.7.9', policy);
      assert.equal(d.path, 'security');
      assert.equal(d.install, 'automatic');
    }
  });

  test('installed version withdrawn (blocked_versions): security path', () => {
    const d = decideUpdate(m, '0.8.2', 'security-only');
    assert.equal(d.path, 'security');
    assert.equal(d.install, 'automatic');
  });

  test('otherwise a feature update: offered for consent, or not at all under security-only', () => {
    assert.equal(decideUpdate(m, '0.8.1', 'security-auto').install, 'on-consent');
    const off = decideUpdate(m, '0.8.1', 'security-only');
    assert.equal(off.path, 'feature');
    assert.equal(off.install, 'none');
  });

  test('versions compare numerically, not as strings', () => {
    const m10 = manifest(V1_STATE, signManifest(manifestDoc({ sequence: 1, version: '0.10.0', securityFloor: '0.9.0' }), [A])).manifest;
    assert.equal(decideUpdate(m10, '0.9.0', 'security-auto').path, 'feature');
    assert.equal(decideUpdate(m10, '0.8.10', 'security-auto').path, 'security');
  });

  test('an installed version that is not strict is an input error', () => {
    rejects(() => decideUpdate(m, '0.8', 'security-auto'), 'INPUT_INVALID', 'internal');
    rejects(() => decideUpdate(m, '0.8.0', 'all-auto' as never), 'INPUT_INVALID');
  });

  test('UPDATE_POLICY / UPDATE_CHECK: nothing turns security updates off', () => {
    assert.equal(resolveUpdatePolicy({}), 'security-auto');
    assert.equal(resolveUpdatePolicy({ UPDATE_POLICY: 'security-auto' }), 'security-auto');
    assert.equal(resolveUpdatePolicy({ UPDATE_POLICY: ' Security-Only ' }), 'security-only');
    assert.equal(resolveUpdatePolicy({ UPDATE_CHECK: 'false' }), 'security-only');
    assert.equal(resolveUpdatePolicy({ UPDATE_CHECK: 'FALSE', UPDATE_POLICY: 'security-auto' }), 'security-only');
    assert.equal(resolveUpdatePolicy({ UPDATE_CHECK: 'true' }), 'security-auto');
    for (const dropped of ['off', 'notify', 'all-auto', 'none']) {
      assert.equal(resolveUpdatePolicy({ UPDATE_POLICY: dropped }), 'security-only', dropped);
    }
    // Whatever the policy resolves to, a security-path install is automatic.
    for (const env of [{ UPDATE_CHECK: 'false' }, { UPDATE_POLICY: 'off' }]) {
      assert.equal(decideUpdate(m, '0.7.0', resolveUpdatePolicy(env)).install, 'automatic');
    }
  });
});

test('clock input must be a real date', () => {
  rejects(() => refresh(V1_STATE, [], new Date('nope')), 'INPUT_INVALID');
  rejects(() => manifest(V1_STATE, MANIFEST_1, 'now' as unknown as Date), 'INPUT_INVALID');
});

test('timestamps are UTC with a Z and no fractional seconds (the only spelling)', () => {
  assert.equal(iso(T0), '2026-10-15T00:00:00Z');
});
