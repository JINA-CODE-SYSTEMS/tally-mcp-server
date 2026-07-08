import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretSwitchResult, SWITCH_COMPANY_MIN_AGENT_VERSION, buildToolError } from './mcp.mjs';

const opts = { target: 'JINA CODE SYSTEMS LLP', isProtected: false, hadCreds: false };

test('success → ok, carries the agent message', () => {
  const r = interpretSwitchResult({ status: 'success', message: "Company 'JINA' loaded and verified (loaded: JINA CODE SYSTEMS LLP)." }, opts);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.message, /JINA/);
});

test('success with empty message → ok with a sensible default', () => {
  const r = interpretSwitchResult({ status: 'success', message: '' }, opts);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.message, /no Tally restart/i);
});

test('null response → AGENT_UNREACHABLE', () => {
  const r = interpretSwitchResult(null, opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'AGENT_UNREACHABLE');
});

test('old agent ("Unknown action") → AGENT_TOO_OLD, names the required version', () => {
  const r = interpretSwitchResult({ status: 'error', message: 'Unknown action: switch-company' }, opts);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'AGENT_TOO_OLD');
    assert.match(r.message, new RegExp(SWITCH_COMPANY_MIN_AGENT_VERSION.replace(/\./g, '\\.')));
  }
});

test('agent unsaved-entry fail-safe → UNSAVED_ENTRY_OPEN', () => {
  const r = interpretSwitchResult({ status: 'error', message: 'Refused: an unsaved data-entry screen is open' }, opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'UNSAVED_ENTRY_OPEN');
});

test('unverified status → PRECONDITION_FAILED (retryable, suggests screenshot)', () => {
  const r = interpretSwitchResult({ status: 'unverified', message: 'Tally XML server did not respond' }, opts);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'PRECONDITION_FAILED');
    assert.match(r.remedy ?? '', /gui-screenshot/);
  }
});

test('protected company + error, no creds supplied → PASSWORD_REQUIRED (missing)', () => {
  const r = interpretSwitchResult(
    { status: 'error', message: 'no company appears loaded' },
    { target: 'ACME', isProtected: true, hadCreds: false }
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'PASSWORD_REQUIRED');
    assert.match(r.message, /no stored credentials/i);
  }
});

test('protected company + error, creds WERE supplied → PASSWORD_REQUIRED (wrong)', () => {
  const r = interpretSwitchResult(
    { status: 'error', message: 'no company appears loaded' },
    { target: 'ACME', isProtected: true, hadCreds: true }
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'PASSWORD_REQUIRED');
    assert.match(r.message, /may be wrong/i);
  }
});

test('unprotected company + error → PRECONDITION_FAILED (keystrokes missed)', () => {
  const r = interpretSwitchResult({ status: 'error', message: 'no company appears loaded' }, opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PRECONDITION_FAILED');
});

// The new host error code must be wired into the defaults table (so errorResult can build it).
test('UNSAVED_ENTRY_OPEN is a known, retryable error code', () => {
  const env = buildToolError('UNSAVED_ENTRY_OPEN');
  assert.equal(env.code, 'UNSAVED_ENTRY_OPEN');
  assert.equal(env.retryable, true);
  assert.match(env.remedy ?? '', /Escape|Gateway|Save/i);
});
