import assert from 'node:assert/strict';
import test from 'node:test';
import { pickLoadedCompany } from './mcp.mjs';

const loaded = ['ROSS COMPUTERS PVT. LTD.'];

// The exact bug: registry/alias name differs from the loaded name; the write must be stamped with
// the EXACT loaded name, not the mismatched registry displayName.
test('reconciles a mismatched registry name to the exact loaded name', () => {
  const r = pickLoadedCompany('Ross Computer Pvt Ltd', loaded); // no plural "s", no dots
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.name, 'ROSS COMPUTERS PVT. LTD.'); // exact loaded casing/punctuation
});

test('blank intended + exactly one loaded → that one', () => {
  const r = pickLoadedCompany(null, loaded);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.name, 'ROSS COMPUTERS PVT. LTD.');
});

test('fails closed when nothing is loaded (would write into the void)', () => {
  const r = pickLoadedCompany('Ross Computer Pvt Ltd', []);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /No company is loaded/);
});

test('fails closed when the intended company is not among the loaded ones', () => {
  const r = pickLoadedCompany('Acme Corp', loaded);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /not currently loaded/);
});

test('blank intended + multiple loaded → ambiguous, fail closed', () => {
  const r = pickLoadedCompany('', ['Company A', 'Company B']);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /No active company set/);
});

test('exact match passes through unchanged', () => {
  const r = pickLoadedCompany('ROSS COMPUTERS PVT. LTD.', loaded);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.name, 'ROSS COMPUTERS PVT. LTD.');
});
