import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolError, errorResult } from './mcp.mjs';

test('buildToolError fills sensible defaults per code', () => {
  const e = buildToolError('AGENT_UNREACHABLE');
  assert.equal(e.code, 'AGENT_UNREACHABLE');
  assert.equal(e.retryable, true);
  assert.ok(e.message.length > 0);
  assert.ok(e.remedy && e.remedy.length > 0);
});

test('the key failure modes are distinguishable by code alone', () => {
  // Acceptance: password-required, agent-unreachable, and Tally-down differ by code.
  const codes = ['PASSWORD_REQUIRED', 'AGENT_UNREACHABLE', 'TALLY_DOWN', 'AGENT_TOO_OLD', 'READONLY'] as const;
  const built = codes.map(c => buildToolError(c).code);
  assert.deepEqual(built, [...codes]);
  assert.equal(new Set(built).size, codes.length);
});

test('caller overrides win; logs are demoted to a field', () => {
  const e = buildToolError('PASSWORD_REQUIRED', { message: 'custom', retryable: false, logs: 'line1\nline2' });
  assert.equal(e.message, 'custom');
  assert.equal(e.retryable, false);
  assert.equal(e.logs, 'line1\nline2');
});

test('READONLY is non-retryable', () => {
  assert.equal(buildToolError('READONLY').retryable, false);
});

test('remedy/logs omitted when not applicable', () => {
  const e = buildToolError('UNKNOWN');
  assert.equal('remedy' in e, false);
  assert.equal('logs' in e, false);
});

test('every ToolErrorCode has a usable default message + retryable', () => {
  const codes = [
    'PASSWORD_REQUIRED', 'AGENT_UNREACHABLE', 'TALLY_DOWN', 'AGENT_TOO_OLD',
    'COMPANY_NOT_FOUND', 'AMBIGUOUS', 'PRECONDITION_FAILED', 'READONLY', 'UNKNOWN',
    // host extensions: UNSAVED_ENTRY_OPEN was missing from this list, so its defaults were never
    // asserted. GUI_HANDOFF is new — it hands the Tally window to the caller instead of guessing
    // keystrokes, so its remedy IS the product behaviour and must not silently go missing.
    'UNSAVED_ENTRY_OPEN', 'GUI_HANDOFF',
    // spec-10 deterministic-invariant codes added in #99 (H-14)
    'OUT_OF_PERIOD', 'MASTER_NOT_FOUND', 'AMBIGUOUS_INPUT', 'UNBALANCED', 'DUPLICATE',
  ] as const;
  for (const c of codes) {
    const e = buildToolError(c);
    assert.equal(e.code, c);
    assert.ok(e.message.length > 0, `${c} has a default message`);
    assert.equal(typeof e.retryable, 'boolean');
  }
});

test('all 10 spec (H-14) codes exist', () => {
  const spec10 = [
    'AGENT_UNREACHABLE', 'TALLY_DOWN', 'PASSWORD_REQUIRED', 'OUT_OF_PERIOD', 'MASTER_NOT_FOUND',
    'AMBIGUOUS_INPUT', 'UNBALANCED', 'DUPLICATE', 'READONLY', 'PRECONDITION_FAILED',
  ] as const;
  for (const c of spec10) {
    const e = buildToolError(c);
    assert.equal(e.code, c);
    assert.ok(e.message.length > 0);
  }
});

test('the deterministic-invariant codes are non-retryable with a remedy', () => {
  for (const c of ['OUT_OF_PERIOD', 'MASTER_NOT_FOUND', 'AMBIGUOUS_INPUT', 'UNBALANCED', 'DUPLICATE'] as const) {
    const e = buildToolError(c);
    assert.equal(e.retryable, false, `${c} is a caller-fixable invariant, not transient`);
    assert.ok(e.remedy && e.remedy.length > 0, `${c} has a remedy`);
  }
});

test('errorResult emits isError + structuredContent + machine-parseable JSON text', () => {
  const r = errorResult('TALLY_DOWN', { logs: 'transcript' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'TALLY_DOWN');
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.code, 'TALLY_DOWN');
  assert.equal(parsed.retryable, true);
  assert.equal(parsed.logs, 'transcript');
});

test('GUI_HANDOFF tells the caller to look before every step', () => {
  // This remedy is the product behaviour, not decoration. open-company returns GUI_HANDOFF instead
  // of dispatching a keystroke sequence it guessed, so the instruction to screenshot -> send ONE
  // step -> screenshot again is the only thing standing between the caller and a blind sequence
  // fired into an unknown screen. Assert it names both halves of the loop.
  const e = buildToolError('GUI_HANDOFF');
  assert.equal(e.retryable, true);
  assert.ok(e.remedy, 'GUI_HANDOFF must carry a remedy');
  assert.match(e.remedy, /gui-screenshot/);
  assert.match(e.remedy, /gui-send-keys/);
  assert.match(e.remedy, /ONE step/);
});
