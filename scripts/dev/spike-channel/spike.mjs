// THROWAWAY SPIKE (#219, ADR 0001 P1). Not product code, not built, not shipped. See README.md.
// Run:  npm ci --ignore-scripts  &&  node spike.mjs      (Node 22, Windows x64 is the target)

import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import {
  prependLen, lvCat, transcriptIr, calculateGenerator, scalarMult, scalarMultVfy, computeIsk, CPaceParty, G_I,
} from './cpace.mjs';
import { stringVectors as sv, b5 } from './vectors.mjs';
import { Host, Device, FrameError, parseBody, encodeFrame, PROTO } from './channel.mjs';

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`;
  results.push(line);
  console.log(line);
  if (!ok) failures++;
}
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 1. published test vectors
check('A.1.2 prepend_len("")', eq(prependLen(sv.prependLen[0].in), sv.prependLen[0].out));
check('A.1.2 prepend_len("1234")', eq(prependLen(sv.prependLen[1].in), sv.prependLen[1].out));
for (const v of sv.prependLen.slice(2)) {
  const o = prependLen(v.in);
  check(`A.1.2 prepend_len(range(${v.in.length}))`, o.length === v.outLen && eq(o.subarray(0, v.outPrefix.length), v.outPrefix));
}
check('A.1.4 lv_cat', eq(lvCat(...sv.lvCat.in), sv.lvCat.out));
for (const v of sv.transcriptIr) check(`A.3.5 transcript_ir(${v.in[0]})`, eq(transcriptIr(...v.in.map((s) => Buffer.from(s))), v.out));

const gen = calculateGenerator(b5.PRS, b5.CI, b5.sid);
check('B.5.1 generator_string', eq(gen.genStr, b5.genStr));
check('B.5.1 generator g', eq(gen.g, b5.g));
check('B.5.2 Ya = scalar_mult(ya, g)', eq(scalarMult(b5.ya, gen.g), b5.Ya));
check('B.5.3 Yb = scalar_mult(yb, g)', eq(scalarMult(b5.yb, gen.g), b5.Yb));
check('B.5.4 K = scalar_mult_vfy(ya, Yb)', eq(scalarMultVfy(b5.ya, b5.Yb), b5.K));
check('B.5.4 K = scalar_mult_vfy(yb, Ya)', eq(scalarMultVfy(b5.yb, b5.Ya), b5.K));
check('B.5.5 ISK (initiator/responder)', eq(computeIsk(b5.sid, b5.K, b5.Ya, b5.ADa, b5.Yb, b5.ADb), b5.ISK_IR));
check('B.5.10 scalar_mult(s, X)', eq(scalarMult(b5.s, b5.X), b5.sX));
check('B.5.10 scalar_mult_vfy(s, X)', eq(scalarMultVfy(b5.s, b5.X), b5.sXvfy));
check('B.5.11 invalid point Y_i1 -> G.I', scalarMultVfy(b5.s, b5.Y_i1) === G_I);
check('B.5.11 neutral encoding Y_i2 -> G.I', scalarMultVfy(b5.s, b5.Y_i2) === G_I);
// Full protocol objects with the vector scalars must reproduce the vector ISK on both sides.
{
  const A = new CPaceParty({ prs: b5.PRS, ci: b5.CI, sid: b5.sid, ad: b5.ADa, scalar: Buffer.from(b5.ya) });
  const B = new CPaceParty({ prs: b5.PRS, ci: b5.CI, sid: b5.sid, ad: b5.ADb, scalar: Buffer.from(b5.yb) });
  check('B.5 CPaceParty A/B reproduce ISK_IR', eq(A.finish(B.Y, b5.ADb, true), b5.ISK_IR) && eq(B.finish(A.Y, b5.ADa, false), b5.ISK_IR));
  let aborted = false;
  try { new CPaceParty({ prs: b5.PRS, ci: b5.CI, sid: b5.sid, ad: b5.ADa }).finish(b5.Y_i1, b5.ADb, true); } catch { aborted = true; }
  check('draft 7.2 MUST-abort on invalid peer element', aborted);
}

// ------------------------------------------------------------------ 2. frame parser (negative + fuzz)
{
  const good = encodeFrame([PROTO, randomBytes(16)]).subarray(2);
  const rejects = (buf) => { try { parseBody(buf, [64, 16]); return false; } catch (e) { return e instanceof FrameError; } };
  check('frame: valid body parses', parseBody(good, [64, 16]).length === 2);
  check('frame: truncated body rejected', rejects(good.subarray(0, good.length - 1)));
  check('frame: trailing byte rejected', rejects(Buffer.concat([good, Buffer.from([0])])));
  check('frame: missing field rejected', rejects(lvCat(PROTO)));
  check('frame: oversized field rejected', rejects(lvCat(Buffer.alloc(65), randomBytes(16))));
  check('frame: non-minimal LEB128 rejected', rejects(Buffer.concat([Buffer.from([0x80, 0x00]), lvCat(randomBytes(16))])));
  let bad = 0;
  for (let i = 0; i < 20000; i++) {
    const m = Buffer.from(good);
    const n = 1 + (i % 4);
    for (let k = 0; k < n; k++) m[Math.floor(Math.random() * m.length)] = Math.floor(Math.random() * 256);
    const cut = i % 3 === 0 ? m.subarray(0, Math.floor(Math.random() * m.length)) : m;
    try {
      const f = parseBody(cut, [64, 16]);
      if (f.length !== 2 || f[0].length > 64 || f[1].length > 16) bad++;
    } catch (e) {
      if (!(e instanceof FrameError)) bad++;
    }
  }
  check('frame: 20,000 random mutations -> only FrameError or a well-formed result', bad === 0, `${bad} bad`);
}

// ------------------------------------------------------------------ 3. transports
// LAN: the host listens (loopback here; the product binds the LAN interface only).
function lanListener(handler) {
  return new Promise((resolve) => {
    const srv = net.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const dial = (port) => new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => resolve(s)); s.once('error', reject); });

// Relay: both sides dial out; the relay pairs the first two connections and forwards bytes.
// It records everything it forwards, and can tamper, to play the malicious relay.
function relay({ tamper } = {}) {
  const seen = [];
  const c2h = [];
  let waiting = null;
  const srv = net.createServer((sock) => {
    if (!waiting) { waiting = sock; return; }
    const host = waiting, dev = sock;
    waiting = null;
    dev.on('data', (d) => { seen.push(Buffer.from(d)); c2h.push(Buffer.from(d)); host.write(d); });
    host.on('data', (d) => { seen.push(Buffer.from(d)); dev.write(tamper ? tamper(d) : d); });
    dev.on('close', () => host.destroy());
    host.on('close', () => dev.destroy());
    dev.on('error', () => {});
    host.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, c2h, port: srv.address().port })));
}

const CODE = 'K7Q2-M9XD'.replace('-', ''); // display form XXXX-XXXX; PRS is the normalised 8 characters

// A hung step is a failure, not a wait.
setTimeout(() => { check('spike finished within 60 s', false); console.log(`${failures} FAILED`); process.exit(1); }, 60000).unref();

async function main() {
  // ---- LAN pairing
  const host = new Host();
  const dev = new Device('Priya laptop');
  let pairTarget = 'pair';
  const lan = await lanListener((s) => {
    s.on('error', () => {});
    if (pairTarget === 'pair') host.servePairing(s, 'lan');
    else host.serveSession(s, 'lan', (d, t, id) => t.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echo: d.toString().trim(), device: id } }) + '\n'));
  });
  const lanPort = lan.address().port;

  host.issueCode(CODE);
  const id1 = await dev.pair(await dial(lanPort), CODE, 'lan');
  check('LAN: pairing with the right code succeeds', !!id1 && host.devices.has(id1));
  check('LAN: host and device hold the same device key', eq(host.devices.get(id1).psk, dev.record.psk));

  // ---- single use
  let err = null;
  try { await dev.pair(await dial(lanPort), CODE, 'lan'); } catch (e) { err = e; }
  check('code is single-use (second redemption fails)', !!err);

  // ---- session over the relay: encrypted exchange, relay sees only ciphertext
  const r = await relay();
  const hostOut = await dial(r.port); // host dials out
  hostOut.on('error', () => {});
  await sleep(50);
  host.serveSession(hostOut, 'relay', (d, t, id) => t.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { voucher: 'SECRET-VOUCHER-4711', device: id } }) + '\n'));
  const sess = dev.openSession(await dial(r.port));
  let ticket = null;
  sess.on('session', (t) => { ticket = t; }); // keep any TLS 1.3 ticket to try resuming after revocation
  const reply = await new Promise((resolve, reject) => {
    sess.once('secureConnect', () => sess.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ledger', q: 'PLAINTEXT-QUERY-0815' } }) + '\n'));
    sess.once('data', (d) => resolve(JSON.parse(d.toString())));
    sess.once('error', reject);
    sess.once('close', () => reject(new Error('session closed by host')));
  });
  await sleep(100);
  check('relay: encrypted MCP round trip works', reply.result.voucher === 'SECRET-VOUCHER-4711' && reply.result.device === id1);
  const wire = Buffer.concat(r.seen);
  const leaks = ['SECRET-VOUCHER-4711', 'PLAINTEXT-QUERY-0815', CODE, 'ledger'].filter((m) => wire.includes(Buffer.from(m)));
  check('relay: no plaintext, code or tool name in forwarded bytes', leaks.length === 0 && !wire.includes(dev.record.psk), leaks.join(','));
  check('relay: device identity is visible in the ClientHello (documented residual)', wire.includes(Buffer.from(id1)));
  {
    // Forward secrecy: the client must offer only psk_dhe_ke (1), never psk_ke (0), and send a key share.
    const ch = r.c2h[0];
    let p = 5 + 4 + 2 + 32;
    p += 1 + ch[p];
    p += 2 + ch.readUInt16BE(p);
    p += 1 + ch[p];
    const end = p + 2 + ch.readUInt16BE(p);
    p += 2;
    const ext = new Map();
    while (p < end) { ext.set(ch.readUInt16BE(p), ch.subarray(p + 4, p + 4 + ch.readUInt16BE(p + 2))); p += 4 + ch.readUInt16BE(p + 2); }
    const modes = ext.get(0x002d);
    check('ClientHello offers psk_dhe_ke only, with a key share (forward secrecy)', !!modes && modes.toString('hex') === '0101' && ext.has(0x0033), modes?.toString('hex'));
  }
  sess.destroy();
  r.srv.close();

  // ---- unknown device: rejected in the handshake, zero MCP bytes processed
  pairTarget = 'session';
  const before = host.mcpBytesSeen;
  const stranger = new Device('stranger');
  stranger.record = { deviceId: randomBytes(16).toString('hex'), psk: randomBytes(32) };
  const sx = stranger.openSession(await dial(lanPort));
  const strangerOk = await new Promise((resolve) => {
    sx.once('secureConnect', () => { sx.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'); resolve(true); });
    sx.once('error', () => resolve(false));
  });
  await sleep(100);
  check('unpaired device rejected in the handshake, no MCP byte reaches the server', !strangerOk && host.mcpBytesSeen === before);

  // ---- a device that knows the id but not the key
  const forger = new Device('forger');
  forger.record = { deviceId: id1, psk: randomBytes(32) };
  const fx = forger.openSession(await dial(lanPort));
  const forgerOk = await new Promise((resolve) => { fx.once('secureConnect', () => resolve(true)); fx.once('error', () => resolve(false)); });
  check('right device id with wrong key is rejected', !forgerOk);

  // ---- downgrade: TLS 1.2 attempt
  const t12 = tls.connect({ socket: await dial(lanPort), maxVersion: 'TLSv1.2', pskCallback: () => ({ psk: dev.record.psk, identity: id1 }), ciphers: 'PSK-AES128-GCM-SHA256' });
  const t12ok = await new Promise((resolve) => { t12.once('secureConnect', () => resolve(true)); t12.once('error', () => resolve(false)); });
  check('TLS 1.2 (downgrade) refused', !t12ok);

  // ---- revocation: live session cut, next session refused
  const live = dev.openSession(await dial(lanPort));
  await new Promise((resolve) => live.once('secureConnect', resolve));
  live.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  await new Promise((resolve) => live.once('data', resolve));
  const closed = new Promise((resolve) => live.once('close', () => resolve(true)));
  live.on('error', () => {});
  host.revoke(id1);
  check('revocation ends the live session', await Promise.race([closed, sleep(1000).then(() => false)]));
  const after = dev.openSession(await dial(lanPort));
  const afterOk = await new Promise((resolve) => { after.once('secureConnect', () => resolve(true)); after.once('error', () => resolve(false)); });
  check('revoked device: next session refused', !afterOk);

  // ---- resumption must not bypass revocation: the revoked device presents its saved ticket
  check(`TLS session ticket issued to the client: ${ticket ? 'yes' : 'no'} (informational)`, true);
  if (ticket) {
    const resumed = dev.openSession(await dial(lanPort), { session: ticket });
    const ok = await new Promise((resolve) => {
      resumed.once('data', () => resolve(true));
      resumed.once('error', () => resolve(false));
      resumed.once('close', () => resolve(false));
      resumed.once('secureConnect', () => resumed.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n'));
      setTimeout(() => resolve(false), 1500);
    });
    await sleep(100);
    const why = host.audit.filter((a) => a.event === 'session-rejected').at(-1)?.reason;
    check('revoked device cannot get back in by resuming a saved TLS session', !ok, `host: ${why}`);
  }

  // ---- wrong code: 3 attempts then locked; the right code no longer works
  pairTarget = 'pair';
  const h2 = new Host();
  const lan2 = await lanListener((s) => { s.on('error', () => {}); h2.servePairing(s, 'lan'); });
  const p2 = lan2.address().port;
  h2.issueCode(CODE);
  let wrongFails = 0;
  for (const guess of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']) {
    try { await new Device('attacker').pair(await dial(p2), guess, 'lan'); } catch { wrongFails++; }
  }
  await sleep(100);
  check('wrong code fails (x3)', wrongFails === 3, `attempts=${h2.code.attempts}`);
  let lockedOut = false;
  try { await new Device('user').pair(await dial(p2), CODE, 'lan'); } catch { lockedOut = true; }
  check('after 3 failed attempts the code is dead, even the right one fails', lockedOut && h2.audit.some((a) => a.event === 'code-locked'));

  // ---- expiry
  let clock = 0;
  const h3 = new Host({ now: () => clock });
  const lan3 = await lanListener((s) => { s.on('error', () => {}); h3.servePairing(s, 'lan'); });
  h3.issueCode(CODE);
  clock += 10 * 60 * 1000 + 1;
  let expired = false;
  try { await new Device('late').pair(await dial(lan3.address().port), CODE, 'lan'); } catch { expired = true; }
  check('expired code refused', expired);

  // ---- downgrade of our own protocol version
  const h4 = new Host();
  const lan4 = await lanListener((s) => { s.on('error', () => {}); h4.servePairing(s, 'lan'); });
  h4.issueCode(CODE);
  let vfail = false;
  try { await new Device('old').pair(await dial(lan4.address().port), CODE, 'lan', { proto: Buffer.from('claudally-spike-remote/0') }); } catch { vfail = true; }
  check('unknown/old protocol version refused before any CPace share is sent', vfail && h4.code.attempts === 0);

  // ---- cross-transport binding: a device that thinks it is on the relay cannot pair with a LAN host
  let xfail = false;
  try { await new Device('confused').pair(await dial(lan4.address().port), CODE, 'relay'); } catch { xfail = true; }
  check('transport is bound into CI (lan vs relay views differ -> fail)', xfail);

  // ---- replay: record a successful pairing via a relay, replay the device's bytes to a fresh code
  const h5 = new Host();
  const r5 = await relay();
  const h5out = await dial(r5.port);
  h5out.on('error', () => {});
  await sleep(50);
  h5.issueCode(CODE);
  const p5 = h5.servePairing(h5out, 'relay');
  await new Device('victim').pair(await dial(r5.port), CODE, 'relay');
  await p5;
  const recorded = Buffer.concat(r5.c2h);
  r5.srv.close();
  const h6 = new Host();
  const lan6 = await lanListener((s) => { s.on('error', () => {}); h6.servePairing(s, 'relay'); });
  h6.issueCode(CODE); // worst case: the same code value is issued again
  const rs = await dial(lan6.address().port);
  rs.on('error', () => {});
  rs.write(recorded);
  await sleep(400);
  check('replayed pairing transcript does not enrol a device', h6.devices.size === 0 && h6.audit.some((a) => a.event === 'pair-failed'));

  // ---- malicious relay flips one bit of ciphertext mid-session
  const h7 = new Host();
  const d7 = new Device('d7');
  const lan7 = await lanListener((s) => { s.on('error', () => {}); h7.servePairing(s, 'lan'); });
  h7.issueCode(CODE);
  await d7.pair(await dial(lan7.address().port), CODE, 'lan');
  // Armed once the session is up: the relay flips one bit in the next host->device chunk.
  let armed = false;
  const r7 = await relay({ tamper: (d) => { if (!armed) return d; armed = false; const x = Buffer.from(d); x[x.length - 5] ^= 1; return x; } });
  const h7out = await dial(r7.port);
  h7out.on('error', () => {});
  await sleep(50);
  h7.serveSession(h7out, 'relay', (d, t) => t.write('{"ok":1}\n'));
  const s7 = d7.openSession(await dial(r7.port));
  const tamperErr = await new Promise((resolve) => {
    s7.once('secureConnect', () => setTimeout(() => { armed = true; s7.write('{"x":1}\n'); }, 200));
    s7.on('data', () => resolve(null)); // plaintext delivered after the flip would be a failure
    s7.once('error', (e) => resolve(e.code || e.message));
    setTimeout(() => resolve(null), 1500);
  });
  check('tampered ciphertext is detected and the session dies', !!tamperErr, tamperErr ?? 'no error');
  r7.srv.close();

  // ---- audit log never carries secrets
  const auditText = JSON.stringify([host.audit, h2.audit, h5.audit, h6.audit]);
  check('audit log carries device ids, never the code or a key', !auditText.includes(CODE) && !auditText.includes(dev.record.psk.toString('hex')) && auditText.includes(id1));

  for (const s of [lan, lan2, lan3, lan4, lan6, lan7]) s.close();
}

main()
  .catch((e) => { check('spike ran to completion', false, e.stack); })
  .finally(() => {
    console.log(`\nnode ${process.version}, OpenSSL ${process.versions.openssl}, ${process.platform}-${process.arch}`);
    console.log(failures === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failures} of ${results.length} CHECKS FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
