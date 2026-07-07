import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { parseTallyRequestVerb, isPathWithinRoots, normalizeOpenCompanyStrategy } from './mcp.mjs';

// --- #24: open-company strategy renames (deprecated aliases) ---

test('normalizeOpenCompanyStrategy maps tdl-load to verify-svcurrentcompany', () => {
  assert.deepEqual(normalizeOpenCompanyStrategy('tdl-load'), { strategy: 'verify-svcurrentcompany', deprecatedAlias: 'tdl-load' });
});

test('normalizeOpenCompanyStrategy maps tdl-connect to verify-in-loaded-list', () => {
  assert.deepEqual(normalizeOpenCompanyStrategy('tdl-connect'), { strategy: 'verify-in-loaded-list', deprecatedAlias: 'tdl-connect' });
});

test('normalizeOpenCompanyStrategy passes new/other names through unchanged', () => {
  assert.deepEqual(normalizeOpenCompanyStrategy('verify-svcurrentcompany'), { strategy: 'verify-svcurrentcompany', deprecatedAlias: null });
  assert.deepEqual(normalizeOpenCompanyStrategy('gui-agent'), { strategy: 'gui-agent', deprecatedAlias: null });
  assert.deepEqual(normalizeOpenCompanyStrategy('auto'), { strategy: 'auto', deprecatedAlias: null });
});

// --- #52: raw-xml-probe verb classification ---

test('parseTallyRequestVerb extracts Export (lowercased)', () => {
  assert.equal(parseTallyRequestVerb('<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER></ENVELOPE>'), 'export');
});

test('parseTallyRequestVerb detects mutating verbs', () => {
  assert.equal(parseTallyRequestVerb('<TALLYREQUEST>Import Data</TALLYREQUEST>'.replace(' Data', '')), 'import');
  assert.equal(parseTallyRequestVerb('<TALLYREQUEST>Alter</TALLYREQUEST>'), 'alter');
  assert.equal(parseTallyRequestVerb('<TALLYREQUEST>Delete</TALLYREQUEST>'), 'delete');
});

test('parseTallyRequestVerb tolerates whitespace and attributes', () => {
  assert.equal(parseTallyRequestVerb('<TALLYREQUEST >  Export  </TALLYREQUEST>'), 'export');
  assert.equal(parseTallyRequestVerb('<TALLYREQUEST TYPE="Data">Import</TALLYREQUEST>'), 'import');
});

test('parseTallyRequestVerb returns null when absent', () => {
  assert.equal(parseTallyRequestVerb('<ENVELOPE><BODY/></ENVELOPE>'), null);
});

// --- #53: dataPath/configPath containment ---

test('isPathWithinRoots accepts a path inside the root (posix)', () => {
  assert.equal(isPathWithinRoots('/data/900', ['/data'], path.posix).ok, true);
});

test('isPathWithinRoots accepts the root itself', () => {
  assert.equal(isPathWithinRoots('/data', ['/data'], path.posix).ok, true);
});

test('isPathWithinRoots rejects a traversal escape', () => {
  assert.equal(isPathWithinRoots('/data/../etc/passwd', ['/data'], path.posix).ok, false);
});

test('isPathWithinRoots rejects a sibling that shares a name prefix', () => {
  // "/data-evil" must NOT be treated as inside "/data"
  assert.equal(isPathWithinRoots('/data-evil/x', ['/data'], path.posix).ok, false);
});

test('isPathWithinRoots honors multiple allowed roots', () => {
  assert.equal(isPathWithinRoots('/backup/co', ['/data', '/backup'], path.posix).ok, true);
});

test('isPathWithinRoots works with win32 semantics', () => {
  assert.equal(isPathWithinRoots('C:\\Tally\\data\\900', ['C:\\Tally\\data'], path.win32).ok, true);
  assert.equal(isPathWithinRoots('C:\\Windows\\System32', ['C:\\Tally\\data'], path.win32).ok, false);
});
