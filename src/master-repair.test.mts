import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeMasterName, describeNameIssues, planMasterNameRepairs, buildRenameMasterXml, verifyRename } from './master.mjs';

const CRLF = 'BHARTI AIRTEL LIMITED\r\n';
const CLEAN = 'BHARTI AIRTEL LIMITED';

test('sanitize strips control characters and edge whitespace', () => {
  assert.equal(sanitizeMasterName(CRLF), CLEAN);
  assert.equal(sanitizeMasterName('  KRISHNA ADDITIVES  '), 'KRISHNA ADDITIVES');
  assert.equal(sanitizeMasterName('A\tB'), 'AB');
});

test('sanitize leaves a clean name completely alone', () => {
  assert.equal(sanitizeMasterName('KRISHNA ADDITIVES'), 'KRISHNA ADDITIVES');
});

test('internal double spaces survive — they are part of real ledger names', () => {
  // Renaming these would break masters that post correctly today.
  for (const n of ['MATRIX  SEAFOODS INDIA LIMITED', 'S D  Fine-Chem Limited']) {
    assert.equal(sanitizeMasterName(n), n);
  }
  assert.deepEqual(planMasterNameRepairs(['MATRIX  SEAFOODS INDIA LIMITED']).repairs, []);
});

test('issues are described in terms the operator can act on', () => {
  const issues = describeNameIssues(CRLF);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /U\+000D/);
  assert.match(issues[0]!, /U\+000A/);
  assert.deepEqual(describeNameIssues(CLEAN), []);
  assert.deepEqual(describeNameIssues('X '), ['trailing whitespace']);
});

test('plan picks out only the malformed masters', () => {
  const { repairs, blocked } = planMasterNameRepairs([CRLF, 'KRISHNA ADDITIVES', 'Airtel Mobile']);
  assert.equal(blocked.length, 0);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.stored, CRLF);
  assert.equal(repairs[0]?.proposed, CLEAN);
});

test('a rename that would collide with an existing master is BLOCKED, not merged', () => {
  // Merging two ledgers silently moves balances — strictly worse than the problem being fixed.
  const { repairs, blocked } = planMasterNameRepairs([CRLF, CLEAN]);
  assert.deepEqual(repairs, []);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.collidesWith, CLEAN);
});

test('rename XML carries the exact stored bytes as the match key', () => {
  const xml = buildRenameMasterXml('LEDGER', CRLF, CLEAN, 'ALG CHEMICALS');
  // A literal CR in the attribute would be normalized to LF when Tally parses it, and the match would
  // miss — the numeric-reference form is the only one that survives.
  assert.ok(xml.includes('<LEDGER NAME="BHARTI AIRTEL LIMITED&#13;&#10;" RESERVEDNAME="" ACTION="Alter">'));
  assert.ok(xml.includes('<NAME.LIST TYPE="String"><NAME>BHARTI AIRTEL LIMITED</NAME></NAME.LIST>'));
  assert.ok(xml.includes('<REPORTNAME>All Masters</REPORTNAME>'));
  assert.ok(xml.includes('<SVCURRENTCOMPANY>ALG CHEMICALS</SVCURRENTCOMPANY>'));
});

test('rename XML escapes ampersands in both the key and the new name', () => {
  const xml = buildRenameMasterXml('LEDGER', 'A & B\r\n', 'A & B');
  assert.ok(xml.includes('NAME="A &amp; B&#13;&#10;"'));
  assert.ok(xml.includes('<NAME>A &amp; B</NAME>'));
});

// ── verification: the counters cannot be trusted, the re-read can ───────────
test('a clean rename is confirmed by the re-read', () => {
  assert.deepEqual(verifyRename([CRLF, 'Cash'], [CLEAN, 'Cash'], CRLF, CLEAN), { status: 'renamed' });
});

test('a master count that grew means Tally created instead of renaming', () => {
  const v = verifyRename([CRLF, 'Cash'], [CRLF, 'Cash', CLEAN], CRLF, CLEAN);
  assert.equal(v.status, 'created_instead');
});

test('old name surviving alongside the new one is also a create', () => {
  // Same count can still hide a create if something else vanished; both names present is decisive.
  const v = verifyRename([CRLF, 'Cash'], [CRLF, CLEAN], CRLF, CLEAN);
  assert.equal(v.status, 'created_instead');
});

test('an unchanged list means the rename silently did nothing', () => {
  const v = verifyRename([CRLF, 'Cash'], [CRLF, 'Cash'], CRLF, CLEAN);
  assert.equal(v.status, 'not_applied');
});
