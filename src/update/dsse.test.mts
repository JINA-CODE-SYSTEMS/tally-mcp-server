import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  KEYS_PAYLOAD_TYPE,
  MANIFEST_PAYLOAD_TYPE,
  MAX_METADATA_BYTES,
  decodeCanonicalBase64,
  keyIdOf,
  pae,
  parseEnvelope,
  rawEd25519PublicKey,
  requireThreshold,
} from './dsse.mjs';
import { UpdateVerificationError } from './errors.mjs';

// Known-answer tests (update-manifest.md §11: "Known-answer tests for the DSSE pre-authentication
// encoding and Ed25519 verification, using fixed vectors").

function rejects(fn: () => unknown, code: string, surface?: string): UpdateVerificationError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof UpdateVerificationError, `expected UpdateVerificationError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (surface) assert.equal(caught.surface, surface);
  return caught;
}

// RFC 8032 §7.1, TEST 1 and TEST 2. These private keys are published test vectors, not ours.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RFC8032 = [
  {
    secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    public: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    public: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
];
function rfcKey(secretHex: string) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(secretHex, 'hex')]), format: 'der', type: 'pkcs8' });
}

test('KAT: DSSE PAE matches the DSSE specification example', () => {
  // From the DSSE protocol document: PAE("http://example.com/HelloWorld", "hello world").
  assert.equal(pae('http://example.com/HelloWorld', Buffer.from('hello world')).toString('utf8'), 'DSSEv1 29 http://example.com/HelloWorld 11 hello world');
});

test('KAT: PAE lengths are byte counts, not character counts', () => {
  assert.equal(pae('t', Buffer.from('é', 'utf8')).toString('utf8'), 'DSSEv1 1 t 2 é');
  assert.equal(pae(MANIFEST_PAYLOAD_TYPE, Buffer.from('{"type":"claudally.update.manifest"}')).toString('utf8'),
    'DSSEv1 57 application/vnd.claudally.update.manifest+json; version=1 36 {"type":"claudally.update.manifest"}');
  assert.equal(pae(KEYS_PAYLOAD_TYPE, Buffer.alloc(0)).toString('utf8'), 'DSSEv1 53 application/vnd.claudally.update.keys+json; version=1 0 ');
});

for (const [i, v] of RFC8032.entries()) {
  test(`KAT: Ed25519 RFC 8032 test ${i + 1} — public key, signature, verify, key id`, () => {
    const priv = rfcKey(v.secret);
    const raw = rawEd25519PublicKey(priv);
    assert.equal(raw.toString('hex'), v.public);
    const sig = crypto.sign(null, Buffer.from(v.message, 'hex'), priv);
    assert.equal(sig.toString('hex'), v.signature);
    assert.ok(crypto.verify(null, Buffer.from(v.message, 'hex'), crypto.createPublicKey(priv), Buffer.from(v.signature, 'hex')));
    assert.equal(keyIdOf(raw), crypto.createHash('sha256').update(Buffer.from(v.public, 'hex')).digest('hex'));
  });
}

test('KAT: a fixed DSSE envelope signed by RFC 8032 key 1 verifies, and one flipped bit does not', () => {
  const payload = Buffer.from('{"type":"claudally.update.manifest"}');
  const keyid = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9';
  const sig = 'ncuGVUeUsx7YE5SHHn3Ilnv/mDGwTbOdsoWzOyjWrdcaCPQfsp92LcRs+CVVX6uFf8fccmBnrPCM+XSxPhkiDA==';
  const envelope = Buffer.from(JSON.stringify({ payloadType: MANIFEST_PAYLOAD_TYPE, payload: payload.toString('base64'), signatures: [{ keyid, sig }] }));
  const env = parseEnvelope(envelope, MANIFEST_PAYLOAD_TYPE);
  const publicKey = crypto.createPublicKey(rfcKey(RFC8032[0].secret));
  assert.equal(keyIdOf(rawEd25519PublicKey(publicKey)), keyid);
  const ctx = { role: 'release', threshold: 1, keys: [{ keyid, publicKey }], revoked: new Set<string>(), otherRoleKeyIds: new Set<string>(), now: new Date() };
  assert.deepEqual([...requireThreshold(env, ctx)], [keyid]);

  const flipped = Buffer.from(payload);
  flipped[10] ^= 1;
  const bad = parseEnvelope(Buffer.from(JSON.stringify({ payloadType: MANIFEST_PAYLOAD_TYPE, payload: flipped.toString('base64'), signatures: [{ keyid, sig }] })), MANIFEST_PAYLOAD_TYPE);
  const err = rejects(() => requireThreshold(bad, ctx), 'SIGNATURE_THRESHOLD_NOT_MET', 'verification-failed');
  assert.deepEqual(err.details.rejected, [{ keyid, reason: 'bad-signature' }]);
});

test('canonical base64: exactly one encoding per byte string', () => {
  assert.deepEqual(decodeCanonicalBase64('AAE='), Buffer.from([0, 1]));
  assert.equal(decodeCanonicalBase64('AAF='), null, 'non-zero trailing bits');
  assert.equal(decodeCanonicalBase64('AAE'), null, 'missing padding');
  assert.equal(decodeCanonicalBase64('AA E='), null, 'whitespace');
  assert.equal(decodeCanonicalBase64('AA\nE='), null, 'newline');
  assert.equal(decodeCanonicalBase64('AA-_'), null, 'URL-safe alphabet');
  assert.equal(decodeCanonicalBase64('AAE=AAE='), null, 'padding in the middle');
});

const goodEnvelope = () => ({
  payloadType: MANIFEST_PAYLOAD_TYPE,
  payload: Buffer.from('{}').toString('base64'),
  signatures: [{ keyid: 'a'.repeat(64), sig: Buffer.alloc(64).toString('base64') }],
});
const enc = (o: unknown) => Buffer.from(JSON.stringify(o));

test('envelope: something that is not a DSSE envelope at all is a transport failure, not an attack', () => {
  rejects(() => parseEnvelope(Buffer.from('<html><body>Please log in to the Wi-Fi</body></html>'), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_NOT_DSSE', 'transport');
  rejects(() => parseEnvelope(Buffer.from('{"error":"bad gateway"}'), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_NOT_DSSE', 'transport');
  rejects(() => parseEnvelope(Buffer.from(''), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_NOT_DSSE', 'transport');
});

test('envelope: oversized metadata is refused before it is parsed (A9)', () => {
  const big = Buffer.alloc(MAX_METADATA_BYTES + 1, 0x20);
  rejects(() => parseEnvelope(big, MANIFEST_PAYLOAD_TYPE), 'METADATA_TOO_LARGE', 'transport');
  // At the cap exactly it is parsed (and here fails as not-DSSE, which proves it got that far).
  rejects(() => parseEnvelope(Buffer.alloc(MAX_METADATA_BYTES, 0x20), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_NOT_DSSE');
});

test('envelope: malformed DSSE envelopes are verification failures', () => {
  const dup = '{"payloadType":"x","payload":"e30=","payload":"e30=","signatures":[]}';
  rejects(() => parseEnvelope(Buffer.from(dup), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID', 'verification-failed');
  rejects(() => parseEnvelope(enc({ ...goodEnvelope(), extra: 1 }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(enc({ ...goodEnvelope(), signatures: [] }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(enc({ ...goodEnvelope(), payload: 'e30' }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(enc({ ...goodEnvelope(), payload: '' }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  const sig = (s: unknown) => enc({ ...goodEnvelope(), signatures: [s] });
  rejects(() => parseEnvelope(sig({ keyid: 'A'.repeat(64), sig: Buffer.alloc(64).toString('base64') }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(sig({ keyid: 'a'.repeat(64), sig: Buffer.alloc(63).toString('base64') }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(sig({ keyid: 'a'.repeat(64), sig: Buffer.alloc(64).toString('base64'), extra: true }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(sig({ sig: Buffer.alloc(64).toString('base64') }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
  rejects(() => parseEnvelope(enc({ ...goodEnvelope(), signatures: Array(33).fill(goodEnvelope().signatures[0]) }), MANIFEST_PAYLOAD_TYPE), 'ENVELOPE_INVALID');
});

test('envelope: wrong payloadType — a key set where a manifest is expected, and vice versa', () => {
  const env = goodEnvelope();
  rejects(() => parseEnvelope(enc(env), KEYS_PAYLOAD_TYPE), 'PAYLOAD_TYPE_MISMATCH', 'verification-failed');
  rejects(() => parseEnvelope(enc({ ...env, payloadType: KEYS_PAYLOAD_TYPE }), MANIFEST_PAYLOAD_TYPE), 'PAYLOAD_TYPE_MISMATCH');
  rejects(() => parseEnvelope(enc({ ...env, payloadType: 'application/vnd.claudally.update.manifest+json' }), MANIFEST_PAYLOAD_TYPE), 'PAYLOAD_TYPE_MISMATCH');
  rejects(() => parseEnvelope(enc({ ...env, payloadType: 'application/vnd.claudally.update.manifest+json; version=2' }), MANIFEST_PAYLOAD_TYPE), 'PAYLOAD_TYPE_MISMATCH');
});
