import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveTallyExePath } from './mcp.mjs';

// --- #172 A1: TALLY_EXE_PATH is attacker-reachable config, not a trusted constant ---
//
// .env is rewritten by the tray unelevated and the agent user holds Full Control over it
// (firstrun-config.ps1), while the service runs as LocalSystem. The value used to be
// interpolated into `execSync('start "" "<path>"', { shell: 'cmd' })`, so anyone who could
// edit .env had code execution as SYSTEM. win32 semantics are injected explicitly so these
// assertions mean the same thing on a posix CI runner as on Windows.

const PF = 'C:\\Program Files';
const winEnv = (over = {}) => ({ 'ProgramFiles': PF, 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ...over });
// No exclusions by default here, so each test states its own; the production default is the
// MCP install tree (see MCP_INSTALL_ROOT in mcp.mts).
const call = (over = {}, extra = {}) =>
  resolveTallyExePath({ env: winEnv(over), p: path.win32, excludeRoots: [], ...extra });

test('accepts the standard install path under Program Files', () => {
  const r = call();
  assert.equal(r.ok, true);
  assert.match(r.exe, /tally\.exe$/i);
});

test('accepts an explicit exe inside a trusted root', () => {
  assert.equal(call({ TALLY_EXE_PATH: 'C:\\Program Files\\TallyPrime\\tally.exe' }).ok, true);
});

test('refuses an exe outside every trusted root', () => {
  const r = call({ TALLY_EXE_PATH: 'C:\\Users\\Public\\evil.exe' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /outside the trusted roots/);
});

test('refuses traversal that escapes a trusted root', () => {
  assert.equal(call({ TALLY_EXE_PATH: 'C:\\Program Files\\..\\Users\\Public\\evil.exe' }).ok, false);
});

test('refuses a sibling directory that merely shares the root prefix', () => {
  assert.equal(call({ TALLY_EXE_PATH: 'C:\\Program Files Evil\\tally.exe' }).ok, false);
});

test('refuses a path that does not name an .exe', () => {
  const r = call({ TALLY_EXE_PATH: 'C:\\Program Files\\TallyPrime\\payload.bat' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /\.exe/);
});

// Shell safety comes from spawn(..., { shell: false }) at the call site, NOT from this function.
// What this test pins is narrower and true: a value carrying an appended command no longer ends
// in .exe, so it is refused here as well.
test('a value with an appended command does not survive the suffix check', () => {
  const smuggled = 'C:\\Program Files\\TallyPrime\\tally.exe" & calc.exe & "';
  assert.equal(call({ TALLY_EXE_PATH: smuggled }).ok, false);
});

// --- the allowlist itself must not be attacker-settable ---

test('.env CANNOT widen the allowlist — TALLY_ALLOWED_EXE_ROOTS in env is ignored', () => {
  // The whole point: an attacker who can write .env would otherwise grant themselves a root in
  // the same edit that poisons the path. Only the pre-dotenv process environment counts.
  const r = call({ TALLY_EXE_PATH: 'D:\\Apps\\Tally\\tally.exe', TALLY_ALLOWED_EXE_ROOTS: 'D:\\Apps' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /outside the trusted roots/);
});

test('a root supplied by the real process environment IS honoured', () => {
  const r = call({ TALLY_EXE_PATH: 'D:\\Apps\\Tally\\tally.exe' }, { rootsOverride: 'D:\\Apps' });
  assert.equal(r.ok, true);
});

test('a startup roots override REPLACES the Program Files default rather than adding to it', () => {
  const r = call({ TALLY_EXE_PATH: 'C:\\Program Files\\TallyPrime\\tally.exe' }, { rootsOverride: 'D:\\Apps' });
  assert.equal(r.ok, false);
});

test('fails closed when no trusted root can be determined', () => {
  const r = resolveTallyExePath({
    env: { TALLY_EXE_PATH: 'C:\\Program Files\\TallyPrime\\tally.exe' },
    p: path.win32, excludeRoots: [], rootsOverride: undefined,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /no trusted root/);
});

// --- Program Files is not a privilege boundary on its own ---

test('refuses a payload inside the MCP install tree, which the installer makes user-writable', () => {
  // tally-mcp.iss grants Users modify on {app}/logs and {app}/data, both inside %ProgramFiles%.
  // Prefix containment alone would happily accept a payload dropped there.
  const install = 'C:\\Program Files\\TallyMCP';
  const r = resolveTallyExePath({
    env: winEnv({ TALLY_EXE_PATH: install + '\\data\\payload.exe' }),
    p: path.win32,
    excludeRoots: [install],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /install tree/);
});

test('the exclusion covers nested paths, not just the immediate directory', () => {
  const install = 'C:\\Program Files\\TallyMCP';
  const r = resolveTallyExePath({
    env: winEnv({ TALLY_EXE_PATH: install + '\\data\\deep\\nest\\payload.exe' }),
    p: path.win32,
    excludeRoots: [install],
  });
  assert.equal(r.ok, false);
});

// --- usability: valid spellings must not be refused ---

test('accepts a correctly-spelled path in a different case', () => {
  assert.equal(call({ TALLY_EXE_PATH: 'c:\\program files\\tallyprime\\tally.exe' }).ok, true);
});

test('accepts a value an operator pasted with surrounding quotes', () => {
  assert.equal(call({ TALLY_EXE_PATH: '"C:\\Program Files\\TallyPrime\\tally.exe"' }).ok, true);
});

test('finds Program Files even when the environment upper-cases variable names', () => {
  // A plain object captured through a shell can arrive as PROGRAMFILES. process.env is a proxy
  // that hides this, so an exact-case lookup passes in production and fails everywhere else —
  // and the failure mode is the guard silently using fewer roots and refusing the real binary.
  const r = resolveTallyExePath({
    env: { 'PROGRAMFILES': PF, 'TALLY_EXE_PATH': PF + '\\TallyPrime\\tally.exe' },
    p: path.win32,
    excludeRoots: [],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, [PF]);
});
