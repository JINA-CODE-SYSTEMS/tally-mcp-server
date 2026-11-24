// THROWAWAY SPIKE (#219). Not product code. See README.md.
//
// CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256, initiator-responder setting, written line by line from
// draft-irtf-cfrg-cpace-21 (sections 6, 7, 8.1, 8.4, A.1-A.3) and checked against its Appendix B.5
// test vectors (vectors.mjs). Nothing here is a new primitive: every curve operation is a documented
// public call into @noble/curves (audited), and every hash is node:crypto (OpenSSL).
//
//   H                       = SHA-256 (node:crypto), s_in_bytes = 64
//   G.calculate_generator   = p256_hasher.encodeToCurve(generator_string, { DST })   (RFC 9380 P256_XMD:SHA-256_SSWU_NU_)
//   G.sample_scalar         = p256.utils.randomSecretKey()                           (uniform in [1, n-1], draft 10.7)
//   G.scalar_mult(y, g)     = p256.getSharedSecret(y, g, false)                      (full SEC1 uncompressed encoding)
//   G.scalar_mult_vfy(y, X) = x-coordinate of p256.getSharedSecret(y, X), or G.I on any decode/validity error
//
// The glue we own is the string handling (prepend_len, lv_cat, generator_string, transcript_ir) and
// the order of calls. That glue is exactly what the draft's test vectors pin down.

import { createHash } from 'node:crypto';
import { p256, p256_hasher } from '@noble/curves/nist.js';

export const SUITE = 'CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256';
const DSI = Buffer.from('CPaceP256_XMD:SHA-256_SSWU_NU_', 'ascii');
const DST = Buffer.concat([DSI, Buffer.from('_DST', 'ascii')]);
const DSI_ISK = Buffer.concat([DSI, Buffer.from('_ISK', 'ascii')]);
const S_IN_BYTES = 64; // SHA-256 input block size
const POINT_LEN = 65; // SEC1 uncompressed

/** G.I - the "error"/neutral representation. We use null and treat it as MUST-abort. */
export const G_I = null;

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** draft A.1.1: LEB128 length prefix. */
export function prependLen(data) {
  const out = [];
  let length = data.length;
  for (;;) {
    out.push(length < 128 ? length : (length & 0x7f) + 0x80);
    length >>= 7;
    if (length === 0) break;
  }
  return Buffer.concat([Buffer.from(out), Buffer.from(data)]);
}

/** draft A.1.3 */
export const lvCat = (...args) => Buffer.concat(args.map(prependLen));

/** draft A.2 */
export function generatorString(dsi, prs, ci, sid, sInBytes) {
  const lenZpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, Buffer.alloc(lenZpad), ci, sid);
}

/** draft A.3.4 */
export const transcriptIr = (Ya, ADa, Yb, ADb) => Buffer.concat([lvCat(Ya, ADa), lvCat(Yb, ADb)]);

/** draft 8.4.3: G.calculate_generator -> SEC1 uncompressed encoding of the generator. */
export function calculateGenerator(prs, ci, sid) {
  const genStr = generatorString(DSI, prs, ci, sid, S_IN_BYTES);
  const g = p256_hasher.encodeToCurve(genStr, { DST });
  return { genStr, g: Buffer.from(g.toBytes(false)) };
}

export const sampleScalar = () => Buffer.from(p256.utils.randomSecretKey());

/** G.scalar_mult: full-coordinate encoding of y*g. */
export const scalarMult = (y, g) => Buffer.from(p256.getSharedSecret(y, g, false));

/**
 * G.scalar_mult_vfy: validate X (IEEE 1363 A.16.10 via noble's strict fromBytes), then ECSVDP-DH.
 * Returns the big-endian x-coordinate, or G_I (null) for any invalid input or neutral result.
 */
export function scalarMultVfy(y, X) {
  if (!(X instanceof Uint8Array) || X.length !== POINT_LEN || X[0] !== 0x04) return G_I; // uncompressed only (draft 8.4.1)
  try {
    const shared = p256.getSharedSecret(y, X, false); // throws on off-curve / infinity / bad encoding
    return Buffer.from(shared.subarray(1, 33));
  } catch {
    return G_I;
  }
}

/** draft 7.2: ISK = H.hash(lv_cat(DSI || "_ISK", sid, K) || transcript_ir(Ya, ADa, Yb, ADb)) */
export const computeIsk = (sid, K, Ya, ADa, Yb, ADb) =>
  sha256(lvCat(DSI_ISK, sid, K), transcriptIr(Ya, ADa, Yb, ADb));

/**
 * One party's CPace state. role 'A' (initiator: sends first) or 'B' (responder).
 * The scalar lives only inside this object and is dropped after finish().
 */
export class CPaceParty {
  constructor({ prs, ci, sid, ad, scalar }) {
    this.ci = ci;
    this.sid = sid;
    this.ad = ad;
    this.y = scalar ?? sampleScalar();
    const { g } = calculateGenerator(prs, ci, sid);
    this.Y = scalarMult(this.y, g);
  }
  /** Returns ISK, or throws on the MUST-abort condition. ownIsA selects transcript order. */
  finish(peerY, peerAd, ownIsA) {
    const K = scalarMultVfy(this.y, peerY);
    this.y.fill(0);
    this.y = null;
    if (K === G_I) throw new Error('CPace abort: peer element invalid or neutral (draft 7.2)');
    return ownIsA
      ? computeIsk(this.sid, K, this.Y, this.ad, peerY, peerAd)
      : computeIsk(this.sid, K, peerY, peerAd, this.Y, this.ad);
  }
}
