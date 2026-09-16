import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGuiDeleteOutcome } from './mcp.mjs';

// A GUI deletion is aimed by reading a screenshot — the same judgement that booked the wrong entry
// in the first place. These four cases are the entire safety argument for letting software press
// Alt+D at all: the keystroke is not trusted, the before/after difference is.

test('exactly the intended voucher disappearing is the only success', () => {
  const r = classifyGuiDeleteOutcome('14699', ['14699', '14700', '14701'], ['14700', '14701']);
  assert.equal(r.status, 'deleted');
  assert.deepEqual(r.removed, ['14699']);
  assert.deepEqual(r.unexpectedlyRemoved, []);
});

test('a voucher nobody asked about disappearing is WRONG-VOUCHER, never success', () => {
  // The misnavigation case: Alt+D landed on the row above. The target is still there, so a naive
  // "did the delete work?" check that only looked for the target would report failure and retry —
  // deleting a second innocent voucher. It has to be named as wrong, not as failed.
  const r = classifyGuiDeleteOutcome('14699', ['14699', '14700'], ['14699']);
  assert.equal(r.status, 'wrong-voucher');
  assert.equal(r.targetRemoved, false);
  assert.deepEqual(r.unexpectedlyRemoved, ['14700']);
});

test('the target AND something else going is COLLATERAL, not success', () => {
  // Easy to get wrong: the caller asked for 14699 and 14699 is gone, so a check for "target absent"
  // passes. Something else went too, and that must not be reported as a clean delete.
  const r = classifyGuiDeleteOutcome('14699', ['14699', '14700', '14701'], ['14701']);
  assert.equal(r.status, 'collateral');
  assert.equal(r.targetRemoved, true);
  assert.deepEqual(r.unexpectedlyRemoved, ['14700']);
});

test('nothing moving is reported as nothing, not as a delete', () => {
  // Alt+D never reached a voucher screen, or a confirmation is still sitting open.
  const r = classifyGuiDeleteOutcome('14699', ['14699', '14700'], ['14699', '14700']);
  assert.equal(r.status, 'nothing-happened');
  assert.deepEqual(r.removed, []);
});

test('ids are compared as strings, so a numeric id is not missed', () => {
  // Tally's master ids arrive as numbers from some paths and strings from others; a mismatch here
  // would read as "the target is still present" and report a correct deletion as wrong-voucher.
  const r = classifyGuiDeleteOutcome('14699', [14699 as any, 14700 as any], [14700 as any]);
  assert.equal(r.status, 'deleted');
});

test('a voucher APPEARING is not mistaken for a deletion', () => {
  // Another user posting on the same date mid-operation. Additions are irrelevant to the question
  // "what went away", and must not disturb the verdict.
  const r = classifyGuiDeleteOutcome('14699', ['14699', '14700'], ['14700', '14999']);
  assert.equal(r.status, 'deleted');
  assert.deepEqual(r.removed, ['14699']);
});
