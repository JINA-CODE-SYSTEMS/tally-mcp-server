import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeMojibake, demojibake, foldSmartQuotes, sanitizeMasterName, planMasterNameRepairs } from './master.mjs';

// The real ledger, byte for byte as Tally stores it: "XI" + U+00E2 U+0080 U+0099 + "AN YUANFAR...".
// That is UTF-8 E2 80 99 (U+2019, right single quote) decoded as Latin-1.
const MOJI = 'XIâAN YUANFAR INTERNATIONAL TRADE COMPANY';
const INTENDED = "XI'AN YUANFAR INTERNATIONAL TRADE COMPANY";

test('the trap: sanitizing mojibake DELETES the evidence and yields a wrong, plausible name', () => {
  // This is why mojibake must never reach the generic sanitizer. U+0080/U+0099 are inside the C1 range,
  // so stripping controls leaves the a-circumflex standing in for the apostrophe — wrong, and clean
  // enough to survive review and be written back.
  const stripped = sanitizeMasterName(MOJI);
  assert.equal(stripped, 'XIâAN YUANFAR INTERNATIONAL TRADE COMPANY');
  assert.notEqual(stripped, INTENDED);
});

test('mojibake is detected by its signature, not by guesswork', () => {
  assert.equal(looksLikeMojibake(MOJI), true);
  // A bare control character is NOT mojibake — that is ordinary paste damage for the sanitizer.
  assert.equal(looksLikeMojibake('BHARTI AIRTEL LIMITED\r\n'), false);
  assert.equal(looksLikeMojibake('KRISHNA ADDITIVES'), false);
  // Legitimate accented text must not be mistaken for it.
  assert.equal(looksLikeMojibake('Café Chemicals'), false);
});

test('re-decoding recovers the real character', () => {
  assert.equal(demojibake(MOJI), 'XI’AN YUANFAR INTERNATIONAL TRADE COMPANY');
});

test('the full repair reaches the intended ASCII-apostrophe name', () => {
  assert.equal(sanitizeMasterName(foldSmartQuotes(demojibake(MOJI))), INTENDED);
});

test('demojibake declines rather than corrupts when the string is not a Latin-1 round-trip', () => {
  // Already-correct text containing a real U+2019 is above U+00FF and must be left alone.
  const fine = 'XI’AN YUANFAR';
  assert.equal(demojibake(fine), fine);
  // Bytes that are not valid UTF-8 underneath are left alone rather than guessed at.
  assert.equal(demojibake('Café'), 'Café');
});

test('mojibake is never auto-applied — it lands in blocked, flagged for review', () => {
  const { repairs, blocked } = planMasterNameRepairs([MOJI, 'KRISHNA ADDITIVES']);
  assert.deepEqual(repairs, [], 'must not be queued for an unattended rename');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.stored, MOJI);
  assert.equal(blocked[0]?.proposed, INTENDED, 'proposes the RE-DECODED name, not the stripped one');
  assert.equal(blocked[0]?.needsReview, true);
  assert.match(blocked[0]?.issues.join(' ') ?? '', /mojibake/);
});

test('ordinary control-character damage still repairs automatically', () => {
  // The mojibake branch must not swallow the common case.
  const { repairs, blocked } = planMasterNameRepairs(['VIJAY SALES\r\n']);
  assert.equal(blocked.length, 0);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.proposed, 'VIJAY SALES');
  assert.equal(repairs[0]?.needsReview, undefined);
});
