// THROWAWAY SPIKE (#219). Not product code. See README.md.
//
// Pairing: CPace (cpace.mjs) -> HKDF-SHA256 -> TLS 1.3 external PSK (psk_dhe_ke) whose Finished
// messages are the key confirmation -> device credential derived with the TLS exporter (RFC 8446 7.5).
// Session: TLS 1.3 external PSK per device (node:tls / OpenSSL), no certificates.
//
// Everything cryptographic after CPace is node:crypto / node:tls. The only bytes this file frames
// itself are the three public pre-TLS pairing messages, encoded with the draft's own lv_cat.

import tls from 'node:tls';
import { hkdfSync, randomBytes } from 'node:crypto';
import { CPaceParty, SUITE, lvCat } from './cpace.mjs';

export const PROTO = Buffer.from('claudally-spike-remote/1');
const ALPN_PAIR = 'cl-spike-pair/1';
const ALPN_SESSION = 'cl-spike-session/1';
const PAIR_PSK_IDENTITY = 'pairing';
const EXPORTER_LABEL = 'EXPORTER-claudally-spike-device-psk-v1';
const TLS_OPTS = {
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
  // SHA-256 suites only: OpenSSL binds a callback-supplied external PSK to SHA-256.
  ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256',
};
const NONCE_LEN = 16;
const MAX_FRAME = 1024;

// Roles are fixed (draft 10.1.2): the host is always CPace initiator A and TLS server; the device is
// always CPace responder B and TLS client. Both roles, the protocol version and the transport go into
// CI, so a message cannot be reflected into the other role or replayed across transports.
const channelId = (transport) => lvCat(Buffer.from('A=host'), Buffer.from('B=device'), PROTO, Buffer.from(transport));
const AD_HOST = lvCat(PROTO, Buffer.from(SUITE), Buffer.from('role=host'));
const AD_DEVICE = lvCat(PROTO, Buffer.from(SUITE), Buffer.from('role=device'));

// ---------------------------------------------------------------------------------------------
// Pre-TLS frame layer: uint16be length || lv_cat(fields). Strict: exact field count, per-field
// maximum length, minimal LEB128, no trailing bytes. This is the parser the checklist says to fuzz.
// ---------------------------------------------------------------------------------------------
export class FrameError extends Error {}

export function encodeFrame(fields) {
  const body = lvCat(...fields);
  if (body.length > MAX_FRAME) throw new FrameError('frame too large');
  const hdr = Buffer.alloc(2);
  hdr.writeUInt16BE(body.length);
  return Buffer.concat([hdr, body]);
}

/** Parse an lv_cat body into exactly `maxLens.length` fields. Throws FrameError on anything else. */
export function parseBody(body, maxLens) {
  const out = [];
  let p = 0;
  for (const max of maxLens) {
    if (p >= body.length) throw new FrameError('truncated: missing field');
    let len = body[p++];
    if (len & 0x80) {
      if (p >= body.length) throw new FrameError('truncated length');
      const hi = body[p++];
      if (hi & 0x80 || hi === 0) throw new FrameError('non-minimal or oversized length');
      len = (len & 0x7f) | (hi << 7);
    }
    if (len > max) throw new FrameError('field too long');
    if (p + len > body.length) throw new FrameError('truncated field');
    out.push(body.subarray(p, p + len));
    p += len;
  }
  if (p !== body.length) throw new FrameError('trailing bytes');
  return out;
}

/** Read exactly n bytes without over-reading, so TLS can take over the same stream afterwards. */
function readExact(stream, n, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const done = (err, val) => {
      clearTimeout(t);
      stream.off('readable', tryRead);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onErr);
      err ? reject(err) : resolve(val);
    };
    const tryRead = () => {
      const chunk = stream.read(n);
      if (chunk !== null) done(null, chunk);
    };
    const onEnd = () => done(new FrameError('stream ended mid-frame'));
    const onErr = (e) => done(e);
    const t = setTimeout(() => done(new FrameError('timeout')), timeoutMs);
    stream.on('readable', tryRead);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onErr);
    tryRead();
  });
}

export async function readFrame(stream, maxLens) {
  const hdr = await readExact(stream, 2);
  const len = hdr.readUInt16BE(0);
  if (len === 0 || len > MAX_FRAME) throw new FrameError('bad frame length');
  return parseBody(await readExact(stream, len), maxLens);
}

const pairPsk = (isk, sid) => Buffer.from(hkdfSync('sha256', isk, sid, 'claudally-spike pairing psk v1', 32));

function waitSecure(sock, event) {
  return new Promise((resolve, reject) => {
    sock.once(event, () => resolve(sock));
    sock.once('error', reject);
    sock.once('close', () => reject(new Error('closed before handshake')));
  });
}

function readLine(sock, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const onData = (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(t);
        sock.off('data', onData);
        resolve(buf.slice(0, i));
      }
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------
// Host (Tally machine)
// ---------------------------------------------------------------------------------------------
export class Host {
  constructor({ now = () => Date.now(), maxAttempts = 3, codeTtlMs = 10 * 60 * 1000 } = {}) {
    this.devices = new Map(); // deviceId -> { psk, label, readOnly }. In product: DPAPI machine scope + locked ACL.
    this.sessions = new Map(); // deviceId -> Set<TLSSocket>
    this.code = null; // { value, expires, attempts, used }
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.codeTtlMs = codeTtlMs;
    this.audit = [];
    this.mcpBytesSeen = 0; // proves "no MCP byte before authentication"
  }

  log(event, fields = {}) {
    this.audit.push({ event, ...fields }); // never codes, keys, ISK or payloads
  }

  issueCode(value) {
    this.code = { value: Buffer.from(value, 'ascii'), expires: this.now() + this.codeTtlMs, attempts: 0, used: false };
    this.log('code-issued');
  }

  cancelCode() {
    this.code = null;
    this.log('code-cancelled');
  }

  codeUsable() {
    const c = this.code;
    return !!c && !c.used && c.attempts < this.maxAttempts && this.now() < c.expires;
  }

  failAttempt(reason) {
    // The attempt was already counted when the host committed its CPace share (servePairing).
    this.log('pair-failed', { reason, attempts: this.code?.attempts });
    if (this.code && this.code.attempts >= this.maxAttempts) this.log('code-locked');
  }

  /** Serve one pairing attempt on a raw byte stream (TCP socket or relay-forwarded stream). */
  async servePairing(stream, transport) {
    try {
      const [proto, nonceD] = await readFrame(stream, [64, NONCE_LEN]);
      if (!proto.equals(PROTO) || nonceD.length !== NONCE_LEN) throw new FrameError('unsupported protocol version');
      if (!this.codeUsable()) throw new FrameError('no usable pairing code');
      const nonceH = randomBytes(NONCE_LEN);
      const sid = Buffer.concat([nonceD, nonceH]);
      // An attempt is counted as soon as the host commits a CPace share for this code.
      this.code.attempts++;
      const a = new CPaceParty({ prs: this.code.value, ci: channelId(transport), sid, ad: AD_HOST });
      stream.write(encodeFrame([nonceH, a.Y, AD_HOST]));
      const [Yb, ADb] = await readFrame(stream, [65, 128]);
      const isk = a.finish(Yb, ADb, true);
      const psk = pairPsk(isk, sid);
      isk.fill(0);
      const t = new tls.TLSSocket(stream, {
        isServer: true,
        ...TLS_OPTS,
        ALPNProtocols: [ALPN_PAIR],
        pskCallback: (_s, identity) => (identity === PAIR_PSK_IDENTITY ? psk : null),
      });
      await waitSecure(t, 'secure');
      if (t.alpnProtocol !== ALPN_PAIR) throw new Error('ALPN mismatch');
      const deviceId = randomBytes(16).toString('hex');
      t.write(JSON.stringify({ deviceId }) + '\n');
      const devicePsk = t.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.from(deviceId));
      const ack = JSON.parse(await readLine(t));
      if (ack.stored !== true) throw new Error('device did not store');
      this.devices.set(deviceId, { psk: devicePsk, label: ack.label, readOnly: false });
      this.code.used = true;
      this.code.attempts--; // the successful attempt does not count against the limit
      this.log('device-paired', { deviceId, label: ack.label, transport });
      t.end(JSON.stringify({ committed: true }) + '\n');
      return deviceId;
    } catch (e) {
      this.failAttempt(e.code || e.message);
      stream.destroy();
      return null;
    }
  }

  /** Serve one session. `onMcp` stands in for spawning dist/index.mjs and piping stdio. */
  serveSession(stream, transport, onMcp) {
    let deviceId = null;
    const t = new tls.TLSSocket(stream, {
      isServer: true,
      ...TLS_OPTS,
      ALPNProtocols: [ALPN_SESSION],
      pskCallback: (_s, identity) => {
        const d = this.devices.get(identity);
        if (!d) {
          this.log('session-rejected', { reason: 'unknown-or-revoked', transport });
          return null;
        }
        deviceId = identity; // recorded ONLY here: a resumed handshake never sets it
        return d.psk;
      },
    });
    t.on('error', (e) => this.log('session-error', { deviceId, code: e.code }));
    t.on('secure', () => {
      // NOTE: t.isSessionReused() cannot be used to spot resumption here: OpenSSL reports every
      // external-PSK handshake as "reused". The guard is that deviceId is set only by pskCallback,
      // which a ticket-based resumption never calls.
      if (!deviceId || t.alpnProtocol !== ALPN_SESSION || !this.devices.has(deviceId)) {
        this.log('session-rejected', { reason: 'resumed-or-unauthenticated', transport });
        t.destroy();
        return;
      }
      const set = this.sessions.get(deviceId) ?? new Set();
      set.add(t);
      this.sessions.set(deviceId, set);
      t.on('close', () => set.delete(t));
      this.log('session-start', { deviceId, label: this.devices.get(deviceId).label, transport });
      t.on('data', (d) => {
        this.mcpBytesSeen += d.length;
        onMcp(d, t, deviceId);
      });
    });
    return t;
  }

  revoke(deviceId) {
    this.devices.delete(deviceId); // new sessions: pskCallback now returns null
    for (const s of this.sessions.get(deviceId) ?? []) s.destroy(); // live sessions: cut now
    this.sessions.delete(deviceId);
    this.log('device-revoked', { deviceId });
  }
}

// ---------------------------------------------------------------------------------------------
// Device (remote machine, the connector)
// ---------------------------------------------------------------------------------------------
export class Device {
  constructor(label) {
    this.label = label;
    this.record = null; // { deviceId, psk }. In product: DPAPI CurrentUser.
  }

  async pair(stream, code, transport, { proto = PROTO, recordFrames } = {}) {
    const nonceD = randomBytes(NONCE_LEN);
    const f1 = encodeFrame([proto, nonceD]);
    recordFrames?.push(f1);
    stream.write(f1);
    const [nonceH, Ya, ADa] = await readFrame(stream, [NONCE_LEN, 65, 128]);
    if (!ADa.equals(AD_HOST)) throw new Error('host AD mismatch (version/suite downgrade?)');
    const sid = Buffer.concat([nonceD, nonceH]);
    const b = new CPaceParty({ prs: Buffer.from(code, 'ascii'), ci: channelId(transport), sid, ad: AD_DEVICE });
    const f3 = encodeFrame([b.Y, AD_DEVICE]);
    recordFrames?.push(f3);
    stream.write(f3);
    const isk = b.finish(Ya, ADa, false);
    const psk = pairPsk(isk, sid);
    isk.fill(0);
    const t = tls.connect({
      socket: stream,
      ...TLS_OPTS,
      ALPNProtocols: [ALPN_PAIR],
      pskCallback: () => ({ psk, identity: PAIR_PSK_IDENTITY }),
    });
    await waitSecure(t, 'secureConnect');
    const { deviceId } = JSON.parse(await readLine(t));
    const devicePsk = t.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.from(deviceId));
    this.record = { deviceId, psk: devicePsk };
    t.write(JSON.stringify({ stored: true, label: this.label }) + '\n');
    const fin = JSON.parse(await readLine(t));
    t.destroy();
    if (fin.committed !== true) throw new Error('host did not commit');
    return deviceId;
  }

  openSession(stream, { session } = {}) {
    const t = tls.connect({
      socket: stream,
      ...TLS_OPTS,
      ALPNProtocols: [ALPN_SESSION],
      session,
      pskCallback: () => ({ psk: this.record.psk, identity: this.record.deviceId }),
    });
    return t;
  }
}
