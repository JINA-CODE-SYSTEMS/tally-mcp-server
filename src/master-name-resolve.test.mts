import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMasterNames, canonicalizeVoucherMasters, findMissingMasters, buildVoucherXml, xmlName, decodeXmlEntities, type VoucherInput } from './voucher.mjs';

// These pin the fix for the failure that put four real purchase bills into suspense.
//
// Tally stores some ledgers with a trailing CRLF — the line break survives from a spreadsheet paste at
// ledger-creation time — and exports the name as "BHARTI AIRTEL LIMITED&#13;&#10;". Every read surface
// shows the trimmed form, so that is what a caller reads and types back. The existence check passes
// (it compares on the edge-trimmed key) and Tally then rejects the import, because its importer matches
// masters by exact string equality. Verified against live Tally: three ledgers in these books are in
// exactly this state.
const CRLF = 'BHARTI AIRTEL LIMITED\r\n';
const CLEAN = 'BHARTI AIRTEL LIMITED';

test('the trap: existence check ACCEPTS the trimmed name, so it cannot be what protects the write', () => {
  // Not a bug in findMissingMasters — this tolerance is deliberate. It is the reason a separate
  // canonicalization step is required rather than a stricter check.
  assert.deepEqual(findMissingMasters([CLEAN], [CRLF]), [], 'trimmed name passes the existence check');
  assert.notEqual(CLEAN, CRLF, 'yet the bytes differ, which is all Tally compares');
});

test('resolves a caller-typed name to the exact stored bytes', () => {
  const { resolved, ambiguous } = resolveMasterNames([CLEAN], [CRLF]);
  assert.equal(resolved.get(CLEAN), CRLF);
  assert.deepEqual(ambiguous, []);
});

test('resolution is what actually lands in the import XML', () => {
  const v: VoucherInput = {
    voucherType: 'Purchase', date: '2026-07-15',
    entries: [{ ledger: CLEAN, drCr: 'dr', amount: 1767.64 }, { ledger: 'Cash', drCr: 'cr', amount: 1767.64 }],
  };
  const before = buildVoucherXml(v);
  assert.ok(before.includes(`<LEDGERNAME>${CLEAN}</LEDGERNAME>`), 'unfixed: XML carries the trimmed name Tally rejects');

  const { voucher } = canonicalizeVoucherMasters(v, [CRLF, 'Cash']);
  const after = buildVoucherXml(voucher);
  assert.ok(after.includes('<LEDGERNAME>BHARTI AIRTEL LIMITED&#13;&#10;</LEDGERNAME>'),
    'fixed: the CRLF is re-escaped and the name matches what Tally stores');
});

test('a CR in a name survives XML round-trip as a numeric reference, not a literal', () => {
  // XML line-ending normalization rewrites a literal CR (and CRLF) to a bare LF when the document is
  // parsed. Emitting the CR literally would therefore hand Tally "...LIMITED\n" — a different string
  // from the "...LIMITED\r\n" it stores — and the exact-match lookup fails just as before. Only the
  // numeric-reference form survives, which is the form Tally itself exports.
  assert.equal(xmlName(CRLF), 'BHARTI AIRTEL LIMITED&#13;&#10;');
  assert.equal(decodeXmlEntities(xmlName(CRLF)), CRLF, 'round-trips byte-for-byte');
});

test('escaping control characters composes with entity escaping, without double-escaping', () => {
  assert.equal(xmlName('A & B\r\n'), 'A &amp; B&#13;&#10;');
  assert.equal(decodeXmlEntities(xmlName('A & B\r\n')), 'A & B\r\n');
});

test('internal whitespace is never collapsed — those double spaces are real names', () => {
  // "MATRIX  SEAFOODS INDIA LIMITED" and "S D  Fine-Chem Limited" exist in these books. A fix that
  // normalized internal runs would break masters that currently work.
  const stored = 'MATRIX  SEAFOODS INDIA LIMITED';
  const { resolved } = resolveMasterNames(['MATRIX SEAFOODS INDIA LIMITED'], [stored]);
  assert.equal(resolved.size, 0, 'single-spaced name must NOT resolve to the double-spaced ledger');
});

test('case and XML-entity form still resolve to stored bytes', () => {
  const stored = 'LEGAL & PROFESSIONAL FEES';
  assert.equal(resolveMasterNames(['legal & professional fees'], [stored]).resolved.get('legal & professional fees'), stored);
  assert.equal(resolveMasterNames(['LEGAL &amp; PROFESSIONAL FEES'], [stored]).resolved.get('LEGAL &amp; PROFESSIONAL FEES'), stored);
});

test('ambiguity is reported, never guessed', () => {
  // Both spellings exist as separate ledgers; picking one would post to a ledger nobody named.
  const { resolved, ambiguous } = resolveMasterNames([CLEAN], [CRLF, CLEAN + ' ']);
  assert.equal(resolved.size, 0, 'nothing is resolved when the pick is not forced');
  assert.equal(ambiguous.length, 1);
  assert.deepEqual(ambiguous[0]?.candidates, [CRLF, CLEAN + ' ']);
});

test('a byte-exact caller is never ambiguous — they already said which one', () => {
  const { resolved, ambiguous } = resolveMasterNames([CRLF], [CRLF, CLEAN + ' ']);
  assert.equal(resolved.get(CRLF), CRLF);
  assert.deepEqual(ambiguous, []);
});

test('unknown masters are left untouched for findMissingMasters to report', () => {
  const { resolved, ambiguous } = resolveMasterNames(['NO SUCH LEDGER'], [CRLF]);
  assert.equal(resolved.size, 0);
  assert.deepEqual(ambiguous, []);
});

test('empty known list means unknown — never rewrite on no information', () => {
  const v: VoucherInput = {
    voucherType: 'Purchase', date: '2026-07-15',
    entries: [{ ledger: CLEAN, drCr: 'dr', amount: 1 }, { ledger: 'Cash', drCr: 'cr', amount: 1 }],
  };
  const { voucher, ambiguous } = canonicalizeVoucherMasters(v, []);
  assert.equal(voucher.entries[0]?.ledger, CLEAN);
  assert.deepEqual(ambiguous, []);
});

test('canonicalization covers party, inventory accounting ledger, stock item and voucher type', () => {
  const v: VoucherInput = {
    voucherType: 'rm purchase',
    date: '2026-07-15',
    partyLedger: CLEAN,
    entries: [{ ledger: CLEAN, drCr: 'dr', amount: 100 }, { ledger: 'Cash', drCr: 'cr', amount: 100 }],
    inventory: [{ stockItem: 'WIDGET', quantity: 1, rate: 100, accountingLedger: CLEAN }],
  };
  const { voucher } = canonicalizeVoucherMasters(v, [CRLF, 'Cash'], ['WIDGET\r\n'], ['RM Purchase']);
  assert.equal(voucher.entries[0]?.ledger, CRLF);
  assert.equal(voucher.partyLedger, CRLF);
  assert.equal(voucher.inventory?.[0]?.accountingLedger, CRLF);
  assert.equal(voucher.inventory?.[0]?.stockItem, 'WIDGET\r\n');
  assert.equal(voucher.voucherType, 'RM Purchase');
});
