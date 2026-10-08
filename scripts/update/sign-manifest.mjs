#!/usr/bin/env node
/**
 * Signs an update manifest on the OFFLINE signing laptop (#177; docs/dev/update-manifest.md §10 step 7).
 *
 *   node scripts/update/sign-manifest.mjs --payload <unsigned manifest.json> --key <release-key.pem>
 *                                         --keys <current keys.json envelope> --out <manifest envelope>
 *
 *   --payload   the unsigned manifest payload produced on the workstation (step 6). Signed byte-for-byte.
 *   --envelope  instead of --payload: an envelope another release-key holder already signed; this adds
 *               a signature to it (for a release threshold above 1). The payload is not changed.
 *   --key       this holder's release key: an ENCRYPTED PKCS#8 PEM. An unencrypted key is refused.
 *   --keys      the current keys.json envelope, to check the key and the result against.
 *   --out       where to write the signed envelope. Must not exist yet.
 *
 * What it does, in order: validates the payload with the client's own parser; renders it in plain
 * language; requires the signer to type the release version; reads the passphrase (not echoed on a
 * terminal); refuses a key that keys.json does not list as a release key; signs; verifies the result
 * with the same verification module the client uses; writes the envelope to --out and nothing else.
 *
 * It never touches the network (it imports no network module, and a test checks that), never writes a
 * private key anywhere, and has no option that skips a check. --out is created exclusively up front and
 * removed again if the run is refused. Needs `npm run build` first, for dist/.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '..', 'dist', 'update');
if (!fs.existsSync(path.join(dist, 'verify.mjs'))) {
  console.error('dist/update/verify.mjs not found. Run `npm run build` first.');
  process.exit(2);
}
const { MANIFEST_PAYLOAD_TYPE, KEYS_PAYLOAD_TYPE, parseEnvelope, signEnvelope, addSignatures, keyIdOf, rawEd25519PublicKey } =
  await import(pathToFileURL(path.join(dist, 'dsse.mjs')).href);
const { parseManifestPayload, parseKeySetPayload, verifyManifest } = await import(pathToFileURL(path.join(dist, 'verify.mjs')).href);
const { UpdateVerificationError } = await import(pathToFileURL(path.join(dist, 'errors.mjs')).href);

// --out is created exclusively (O_EXCL) before anything else happens, so nothing can be put in its
// place between the check and the write; on any refusal the empty placeholder is removed again.
let outFd = null;
let outPath = null;
function releaseOut() {
  if (outFd === null) return;
  try { fs.closeSync(outFd); } catch { /* already closed */ }
  try { fs.unlinkSync(outPath); } catch { /* already gone */ }
  outFd = null;
}

function fail(msg) {
  releaseOut();
  console.error(`\nREFUSED: ${msg}\nNothing was written.`);
  process.exit(1);
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────
const ALLOWED = new Set(['--payload', '--envelope', '--key', '--keys', '--out']);
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i];
  if (!ALLOWED.has(flag)) fail(`unknown argument ${JSON.stringify(flag)}. Allowed: ${[...ALLOWED].join(', ')}`);
  if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
  if (args[flag] !== undefined) fail(`${flag} given twice`);
  args[flag] = argv[i + 1];
}
if (!!args['--payload'] === !!args['--envelope']) fail('give exactly one of --payload or --envelope');
for (const f of ['--key', '--keys', '--out']) if (!args[f]) fail(`${f} is required`);
const out = path.resolve(args['--out']);
for (const f of ['--payload', '--envelope', '--key', '--keys']) {
  if (args[f] && path.resolve(args[f]) === out) fail(`--out must not be the same file as ${f}`);
}
try {
  outFd = fs.openSync(out, 'wx');
  outPath = out;
} catch (e) {
  fail(e.code === 'EEXIST' ? `${out} already exists; choose a new path` : `cannot create ${out}: ${e.message}`);
}

// ── Input ───────────────────────────────────────────────────────────────────────────────────────
let stdinLines = null;
async function readLine(question, { hidden = false } = {}) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    if (stdinLines === null) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    }
    const line = stdinLines.shift();
    process.stderr.write('\n');
    if (line === undefined) fail('input ended');
    return line;
  }
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\u0003') { process.stdin.setRawMode(false); releaseOut(); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) { buf = buf.slice(0, -1); if (!hidden) process.stderr.write('\b \b'); }
          continue;
        }
        buf += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    process.stdin.on('data', onData);
  });
}

function readFile(flag) {
  try { return fs.readFileSync(args[flag]); } catch (e) { fail(`cannot read ${flag} ${args[flag]}: ${e.message}`); }
}

function explain(e) {
  return String(e?.message ?? e);
}

// ── The current key set ─────────────────────────────────────────────────────────────────────────
const keysBytes = readFile('--keys');
let keySet;
try {
  keySet = parseKeySetPayload(parseEnvelope(keysBytes, KEYS_PAYLOAD_TYPE).payload);
} catch (e) { fail(`--keys is not a valid keys.json envelope: ${explain(e)}`); }

// ── The payload ─────────────────────────────────────────────────────────────────────────────────
let payload;
let existing = null;
if (args['--payload']) {
  payload = readFile('--payload');
} else {
  try { existing = parseEnvelope(readFile('--envelope'), MANIFEST_PAYLOAD_TYPE); } catch (e) { fail(`--envelope is not a manifest envelope: ${explain(e)}`); }
  payload = existing.payload;
}
let m;
try { m = parseManifestPayload(payload); } catch (e) { fail(`the manifest payload is not valid: ${explain(e)}`); }

const day = (d) => d.toISOString().replace('.000Z', 'Z');
const lifetimeDays = ((m.expires - m.issued) / 86400000).toFixed(1);
console.error(`
================ MANIFEST TO SIGN ================
  Channel ........... ${m.channel}
  Sequence .......... ${m.sequence}
  Release version ... ${m.release.version}
  Installer URL ..... ${m.release.artifact.url}
  Installer size .... ${m.release.artifact.size.toLocaleString('en-US')} bytes
  Installer SHA-256 . ${m.release.artifact.sha256}
  Source commit ..... ${m.release.provenance.commit} (tag ${m.release.provenance.tag})
  Upgrades from ..... ${m.release.upgradeFromMin} and later
  Security floor .... ${m.securityFloor}   (installs below this get it automatically)
  Blocked versions .. ${m.blockedVersions.length ? m.blockedVersions.join(', ') : '(none)'}
  Advisory .......... ${m.advisory ? `${m.advisory.id}: ${m.advisory.summary}` : '(none)'}
  Issued ............ ${day(m.issued)}
  Expires ........... ${day(m.expires)}  (${lifetimeDays} days)
  Needs key set ..... version ${m.minKeysVersion} or later (current: ${keySet.version})
  Already signed by . ${existing ? existing.signatures.map((s) => s.keyid.slice(0, 16)).join(', ') : '(nobody)'}
==================================================
`);

const typed = await readLine(`Type the release version (${'x.y.z'}) to confirm you have checked all of the above: `);
if (typed.trim() !== m.release.version) fail('the version typed does not match the manifest');

// ── The key ─────────────────────────────────────────────────────────────────────────────────────
const pem = readFile('--key').toString('utf8');
if (!/^-----BEGIN ENCRYPTED PRIVATE KEY-----/m.test(pem)) {
  fail('the key file is not an encrypted PKCS#8 key. Release keys are stored passphrase-encrypted (threat model §5.4).');
}
const passphrase = await readLine('Passphrase for the release key: ', { hidden: true });
let privateKey;
try {
  privateKey = crypto.createPrivateKey({ key: pem, format: 'pem', passphrase });
} catch { fail('could not decrypt the key (wrong passphrase?)'); }
if (privateKey.asymmetricKeyType !== 'ed25519') fail('the key is not an Ed25519 key');
const keyid = keyIdOf(rawEd25519PublicKey(privateKey));
const listed = keySet.release.keys.find((k) => k.keyid === keyid);
if (!listed) fail(`this key (${keyid}) is not a release key in keys.json version ${keySet.version}`);
if (keySet.revokedKeyIds.has(keyid)) fail(`this key (${keyid}) is revoked in keys.json version ${keySet.version}`);
if (listed.expires <= new Date()) fail(`this key (${keyid}) expired at ${day(listed.expires)}`);
if (existing && existing.signatures.some((s) => s.keyid === keyid)) fail('this key has already signed this envelope');

// ── Sign, then verify exactly as a client would ────────────────────────────────────────────────
const envelope = existing ? addSignatures(existing, [privateKey]) : signEnvelope(MANIFEST_PAYLOAD_TYPE, payload, [privateKey]);
const state = { keySet: { envelope: keysBytes.toString('base64') }, manifest: null, authenticodeLatched: keySet.authenticode.required };
let complete = true;
try {
  verifyManifest({ state, manifestEnvelope: envelope, channel: m.channel, now: new Date() });
} catch (e) {
  if (e instanceof UpdateVerificationError && e.code === 'SIGNATURE_THRESHOLD_NOT_MET' && e.details.role === 'release'
      && e.details.rejected.length === 0 && e.details.valid >= 1) {
    complete = false; // every signature is good; more holders need to sign
  } else {
    fail(`the signed envelope does not verify against keys.json version ${keySet.version}: ${explain(e)}`);
  }
}

for (let off = 0; off < envelope.length;) off += fs.writeSync(outFd, envelope, off);
fs.closeSync(outFd);
outFd = null;
console.error(complete
  ? `\nSigned. The envelope verifies against keys.json version ${keySet.version}.\nWrote ${outPath}`
  : `\nSigned, but the release threshold (${keySet.release.threshold}) is not met yet. Pass ${outPath} to the next holder (--envelope).`);
console.error(`SHA-256 of the envelope: ${crypto.createHash('sha256').update(envelope).digest('hex')}`);
