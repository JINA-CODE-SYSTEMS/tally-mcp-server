import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// --- #40: the Claude Desktop extension (mcpb/) and its build (scripts/build-mcpb.mjs) ---
//
// dist/ layout: this file runs as dist/mcpb.test.mjs, so the repo root is one level up.
const repoRoot = path.resolve(import.meta.dirname, '..');
const readJson = (...rel: string[]) => JSON.parse(fs.readFileSync(path.join(repoRoot, ...rel), 'utf-8'));
const BUILD = path.join(repoRoot, 'scripts', 'build-mcpb.mjs');
const LAUNCHER = path.join(repoRoot, 'mcpb', 'server', 'launcher.mjs');
const locate: any = await import(pathToFileURL(path.join(repoRoot, 'mcpb', 'server', 'locate.mjs')).href);

test('mcpb manifest version matches package.json (bump both together)', () => {
  assert.equal(readJson('mcpb', 'manifest.json').version, readJson('package.json').version);
});

test('mcpb manifest: a Windows-only node server whose entry point is the launcher', () => {
  const m = readJson('mcpb', 'manifest.json');
  for (const key of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) assert.ok(m[key], `manifest.${key}`);
  assert.equal(m.server.type, 'node');
  assert.equal(m.server.entry_point, 'server/launcher.mjs');
  assert.ok(fs.existsSync(path.join(repoRoot, 'mcpb', ...m.server.entry_point.split('/'))));
  assert.equal(m.server.mcp_config.command, 'node');
  assert.deepEqual(m.server.mcp_config.args, ['${__dirname}/server/launcher.mjs']);
  assert.deepEqual(m.compatibility.platforms, ['win32']);
  // The optional install-folder setting is what the launcher reads first.
  assert.equal(m.server.mcp_config.env.CLAUDALLY_INSTALL_DIR, '${user_config.install_dir}');
  assert.equal(m.user_config.install_dir.required, false);
});

// --- a tiny ZIP reader: the end-of-central-directory record, then each central entry ---

function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  assert.equal(at + buf.readUInt32LE(eocd + 12), eocd, 'central directory ends where the EOCD begins');
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'central directory signature');
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf-8');
    assert.equal(buf.readUInt32LE(localAt), 0x04034b50, `local header for ${name}`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, `size of ${name}`);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('build:mcpb writes claudally-<version>.mcpb holding the manifest, the launcher and the icon', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcpb-'));
  try {
    const r = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    const version = readJson('package.json').version;
    const file = path.join(out, `claudally-${version}.mcpb`);
    assert.equal(r.stdout.trim(), file);
    const bytes = fs.readFileSync(file);
    const entries = readZip(bytes);
    for (const name of ['manifest.json', 'server/launcher.mjs', 'server/locate.mjs', 'icon.png']) assert.ok(entries.has(name), name);
    assert.deepEqual(entries.get('manifest.json'), fs.readFileSync(path.join(repoRoot, 'mcpb', 'manifest.json')));
    assert.deepEqual(entries.get('server/launcher.mjs'), fs.readFileSync(LAUNCHER));
    assert.deepEqual(entries.get('icon.png')!.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // Reproducible: a second build gives the same bytes, so the published hash can be re-derived.
    const again = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf-8' });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('build:mcpb CRC-32 matches the standard check value', async () => {
  const { crc32 } = await import(pathToFileURL(BUILD).href);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('build:mcpb rejects an unknown argument instead of ignoring it', () => {
  const r = spawnSync(process.execPath, [BUILD, '--outt', 'x'], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument: --outt/);
});

// --- the launcher ---

test('launcher looks in the configured folder first, then TallyMCP and Claudally under each Program Files root', () => {
  const p = path.win32;
  assert.deepEqual(locate.candidateInstallDirs({ ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, p), [
    'C:\\Program Files\\TallyMCP', 'C:\\Program Files\\Claudally',
    'C:\\Program Files (x86)\\TallyMCP', 'C:\\Program Files (x86)\\Claudally'
  ]);
  assert.deepEqual(locate.candidateInstallDirs({ CLAUDALLY_INSTALL_DIR: ' D:\\Apps\\Claudally ', ProgramFiles: 'C:\\Program Files' }, p)[0], 'D:\\Apps\\Claudally');
  // An empty setting reaches the launcher as "" or as the unexpanded placeholder: both mean unset.
  for (const unset of ['', '${user_config.install_dir}']) {
    assert.deepEqual(locate.candidateInstallDirs({ CLAUDALLY_INSTALL_DIR: unset, ProgramFiles: 'C:\\Program Files' }, p), ['C:\\Program Files\\TallyMCP', 'C:\\Program Files\\Claudally']);
  }
  const found = locate.findInstalledServer({ ProgramFiles: 'C:\\Program Files' }, (f: string) => f === 'C:\\Program Files\\Claudally\\dist\\index.mjs', p);
  assert.equal(found.dir, 'C:\\Program Files\\Claudally');
});

function runLauncher(env: Record<string, string>) {
  // A clean environment: none of the real machine's Program Files variables leak in.
  const base: Record<string, string> = { PATH: process.env.PATH ?? '' };
  return spawnSync(process.execPath, [LAUNCHER], { encoding: 'utf-8', env: { ...base, ...env }, input: '' });
}

test('launcher: with no install it says to install Claudally first, on stderr, and exits 1', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcpb-pf-'));
  try {
    const r = runLauncher({ ProgramFiles: empty });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '', 'stdout is the protocol channel and stays clean');
    assert.match(r.stderr, /Install Claudally first/);
    assert.ok(r.stderr.includes(path.join(empty, 'TallyMCP')));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('launcher: runs the installed dist/index.mjs in its own process', () => {
  const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcpb-pf-'));
  try {
    const dist = path.join(pf, 'TallyMCP', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    // Stands in for the server: proves it was loaded in-process (same pid) and owns stdout.
    fs.writeFileSync(path.join(dist, 'index.mjs'), 'process.stdout.write(`server pid ${process.pid}\\n`);\n');
    const r = runLauncher({ ProgramFiles: pf });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^server pid \d+\n$/);
    assert.equal(r.stdout.trim(), `server pid ${r.pid}`);
    assert.match(r.stderr, /starting .*index\.mjs/);

    // The configured folder wins over Program Files.
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcpb-custom-'));
    fs.mkdirSync(path.join(custom, 'dist'));
    fs.writeFileSync(path.join(custom, 'dist', 'index.mjs'), 'process.stdout.write("custom\\n");\n');
    const c = runLauncher({ ProgramFiles: pf, CLAUDALLY_INSTALL_DIR: custom });
    assert.equal(c.stdout, 'custom\n');
    fs.rmSync(custom, { recursive: true, force: true });
  } finally {
    fs.rmSync(pf, { recursive: true, force: true });
  }
});

// --- upgrades: the installer must be able to find and stop the extension's server ---
//
// Claude Desktop runs the launcher with its own Node.js from its extensions folder, and the
// launcher loads the install's dist/index.mjs (and DuckDB's native module) into that process, so
// neither its executable nor its command line names the install. stop-install-processes.ps1 finds it
// by the module it has loaded from the install instead; without that test an upgrade with Claude
// Desktop open failed on the locked duckdb.dll. PowerShell does not run here, so this guards the
// contract by reading the script.
test('installer stop helper recognises a process by a module loaded from the install (the extension host)', () => {
  const ps = fs.readFileSync(path.join(repoRoot, 'scripts', 'installer', 'stop-install-processes.ps1'), 'utf-8');
  assert.match(ps, /\[System\.Diagnostics\.Process\]::GetProcessById\(\$ProcessId\)/);
  assert.match(ps, /foreach \(\$m in \$proc\.Modules\)/);
  // A module counts only from under the install root (with its separator), and never from update\.
  assert.match(ps, /\$f\.StartsWith\(\$rootWithSep,/);
  assert.match(ps, /\$f\.StartsWith\(\$updateDir \+ '\\',/);
  assert.match(ps, /\$why = 'loaded module ' \+ \$module/);
  // The launcher still loads the server in-process, which is why the module test is needed at all.
  assert.match(fs.readFileSync(LAUNCHER, 'utf-8'), /await import\(pathToFileURL\(found\.entry\)\.href\)/);
});
