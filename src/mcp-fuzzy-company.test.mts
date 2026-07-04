import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatchingLoadedCompany } from './mcp.mjs';

const loaded = ['ROSS COMPUTERS PVT. LTD.', 'JINA-CODE', 'SURAJBHAN RAJKUMAR PVT. LTD. - (FY 20-21)'];

test('exact case-insensitive match returns the loaded name', () => {
  assert.equal(findMatchingLoadedCompany('ross computers pvt. ltd.', loaded), 'ROSS COMPUTERS PVT. LTD.');
});

test('normalized match ignores punctuation and case', () => {
  // singular "Computer" still matches plural "Computers" via substring tier
  assert.equal(findMatchingLoadedCompany('Ross Computer Pvt Ltd', loaded), 'ROSS COMPUTERS PVT. LTD.');
});

test('normalized match handles missing punctuation', () => {
  assert.equal(findMatchingLoadedCompany('Jina Code', loaded), 'JINA-CODE');
});

test('substring match works in both directions', () => {
  // target ⊂ loaded
  assert.equal(findMatchingLoadedCompany('surajbhan', loaded), 'SURAJBHAN RAJKUMAR PVT. LTD. - (FY 20-21)');
  // loaded ⊂ target
  assert.equal(findMatchingLoadedCompany('JINA-CODE Systems Private Limited', loaded), 'JINA-CODE');
});

test('returns null when nothing matches', () => {
  assert.equal(findMatchingLoadedCompany('Acme Industries', loaded), null);
});

test('returns null on empty loaded list', () => {
  assert.equal(findMatchingLoadedCompany('anything', []), null);
});

test('returns null on empty target', () => {
  assert.equal(findMatchingLoadedCompany('', loaded), null);
});

test('pathologically long target returns null without hanging (self-DoS guard)', () => {
  // A multi-MB input must not allocate an O(n*m) DP matrix per loaded company.
  // The length guard short-circuits it; the call should return quickly with no match.
  const huge = 'a'.repeat(2_000_000);
  const started = Date.now();
  assert.equal(findMatchingLoadedCompany(huge, loaded), null);
  // Comfortably fast — matrix allocation for a 2M-char string would take far longer.
  assert.ok(Date.now() - started < 1000, 'fuzzy match should short-circuit huge inputs');
});
