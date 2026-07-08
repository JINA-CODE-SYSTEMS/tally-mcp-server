import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeXml, decodeXmlEntities, xmlName, masterKey,
  findMissingMasters, buildVoucherXml, buildCancelVoucherXml,
} from './voucher.mjs';

// ── P0-1: ledger/master names containing & < > " ' must round-trip ──────────

test('decodeXmlEntities is the inverse of escapeXml for the 5 predefined entities', () => {
  const raw = `R&D <lab> "main" o'brien`;
  assert.equal(decodeXmlEntities(escapeXml(raw)), raw);
});

test('decodeXmlEntities decodes &amp; LAST so &amp;lt; → literal &lt; (not <)', () => {
  assert.equal(decodeXmlEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeXmlEntities('A &amp; B'), 'A & B');
});

test('decodeXmlEntities handles numeric + hex entities', () => {
  assert.equal(decodeXmlEntities('A &#38; B'), 'A & B');
  assert.equal(decodeXmlEntities('A &#x26; B'), 'A & B');
});

test('xmlName is idempotent w.r.t. caller escaping (raw == already-escaped)', () => {
  const raw = 'LEGAL & PROFESSIONAL FEES';
  const pre = 'LEGAL &amp; PROFESSIONAL FEES';
  assert.equal(xmlName(raw), 'LEGAL &amp; PROFESSIONAL FEES');
  assert.equal(xmlName(pre), 'LEGAL &amp; PROFESSIONAL FEES'); // NOT &amp;amp; (no double-escape)
  assert.equal(xmlName(raw), xmlName(pre));
});

test('masterKey folds escaping + case + surrounding space to one key', () => {
  assert.equal(masterKey('LEGAL & PROFESSIONAL FEES'), masterKey('  legal &amp; professional fees '));
});

// The reported blocker: BOTH the literal and the pre-escaped spelling must resolve to the same
// existing master — neither should raise MASTER_NOT_FOUND.
test('findMissingMasters is escape-insensitive on BOTH sides (P0-1)', () => {
  const knownLiteral = ['LEGAL & PROFESSIONAL FEES', 'Cash'];
  assert.deepEqual(findMissingMasters(['LEGAL & PROFESSIONAL FEES'], knownLiteral), []);
  assert.deepEqual(findMissingMasters(['LEGAL &amp; PROFESSIONAL FEES'], knownLiteral), []);
  // and when Tally reported the name still-escaped:
  const knownEscaped = ['LEGAL &amp; PROFESSIONAL FEES', 'Cash'];
  assert.deepEqual(findMissingMasters(['LEGAL & PROFESSIONAL FEES'], knownEscaped), []);
});

test('findMissingMasters still flags a genuinely absent ledger', () => {
  assert.deepEqual(findMissingMasters(['Ghost & Co'], ['Cash', 'Bank']), ['Ghost & Co']);
});

// ── the write path emits well-formed, single-escaped XML for every special ──

test('buildVoucherXml escapes & < > " \' in ledger, party, type and company', () => {
  const xml = buildVoucherXml({
    voucherType: 'Sales & Returns',
    date: '2026-06-01',
    partyLedger: 'A<B>Co',
    entries: [
      { ledger: 'LEGAL & PROFESSIONAL FEES', drCr: 'dr', amount: 100 },
      { ledger: `O'Brien "Cash"`, drCr: 'cr', amount: 100 },
    ],
  }, 'JINA & CO');

  assert.match(xml, /<LEDGERNAME>LEGAL &amp; PROFESSIONAL FEES<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>O&apos;Brien &quot;Cash&quot;<\/LEDGERNAME>/);
  assert.match(xml, /<PARTYLEDGERNAME>A&lt;B&gt;Co<\/PARTYLEDGERNAME>/);
  assert.match(xml, /<VOUCHERTYPENAME>Sales &amp; Returns<\/VOUCHERTYPENAME>/);
  assert.match(xml, /VCHTYPE="Sales &amp; Returns"/);
  assert.match(xml, /<SVCURRENTCOMPANY>JINA &amp; CO<\/SVCURRENTCOMPANY>/);
  // No raw ampersand ever reaches the wire (every & is the start of an entity).
  assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), false);
});

test('buildVoucherXml does NOT double-escape a pre-escaped ledger name', () => {
  const xml = buildVoucherXml({
    voucherType: 'Journal',
    date: '2026-06-01',
    entries: [
      { ledger: 'LEGAL &amp; PROFESSIONAL FEES', drCr: 'dr', amount: 1 },
      { ledger: 'Cash', drCr: 'cr', amount: 1 },
    ],
  });
  assert.match(xml, /<LEDGERNAME>LEGAL &amp; PROFESSIONAL FEES<\/LEDGERNAME>/);
  assert.equal(xml.includes('&amp;amp;'), false);
});

test('buildCancelVoucherXml escapes the voucher type', () => {
  const xml = buildCancelVoucherXml({ voucherType: 'Sales & Returns', voucherNumber: 'S/1', date: '2026-06-01' });
  assert.match(xml, /<VOUCHERTYPENAME>Sales &amp; Returns<\/VOUCHERTYPENAME>/);
  assert.match(xml, /VCHTYPE="Sales &amp; Returns"/);
});
