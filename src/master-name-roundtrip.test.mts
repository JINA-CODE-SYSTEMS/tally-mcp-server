import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { utility } from './utility.mjs';
import { xmlName, masterKey } from './voucher.mjs';

// A master name has to survive the READ path and come back out the WRITE path byte-identical. When it
// does not, every read looks fine (the reports echo the mangled name back to you) but the import is
// rejected with "ledger does not exist" — and the posting silently lands in suspense. These guard the
// two places the read path was quietly rewriting names.

// Mirrors extractReport's parseString: unescape named entities, then handle numeric references.
const readName = (raw: string) => utility.String.decodeNumericRefs(utility.String.unescapeHTML(raw));

test('a non-ASCII name survives the read instead of losing characters', () => {
  // The old behaviour deleted &#NNN; outright, so this read back as "Caf Chemicals" — a name that
  // exists nowhere, which is exactly what makes the later write fail.
  assert.equal(readName('Caf&#233; Chemicals'), 'Café Chemicals');
  assert.equal(readName('BHARTI AIRTEL LIMITED&#160;'), 'BHARTI AIRTEL LIMITED ');
});

test('the hex form of a numeric reference is decoded too', () => {
  assert.equal(readName('Caf&#xE9; Chemicals'), 'Café Chemicals');
});

test('genuinely unreadable control characters are still dropped', () => {
  // The original intent — Tally does emit stray control codes — is preserved.
  assert.equal(readName('ACME&#4; LTD'), 'ACME LTD');
  assert.equal(readName('ACME&#127; LTD'), 'ACME LTD');
});

test('named entities still decode, and only once', () => {
  assert.equal(readName('LEGAL &amp; PROFESSIONAL FEES'), 'LEGAL & PROFESSIONAL FEES');
});

test('a name read from Tally re-escapes to the identical bytes on the write path', () => {
  // The full round trip: what list-master hands the caller must be what the import envelope sends.
  for (const raw of ['LEGAL &amp; PROFESSIONAL FEES', 'Caf&#233; Chemicals', 'BHARTI AIRTEL LIMITED']) {
    const asRead = readName(raw);
    const asWritten = xmlName(asRead);
    assert.equal(masterKey(asWritten), masterKey(asRead), `round trip changed the identity of ${raw}`);
  }
});

// ── the second mangler: the XML parser's default trimming ─────────────────
test('fast-xml-parser trims values by default — a name with edge whitespace loses it', () => {
  // Documents WHY the parser config matters. A ledger genuinely named with a trailing space reads
  // back trimmed, and the trimmed name is then rejected on write. Tally does allow such names.
  const xml = '<DATA><ROW><F01>BHARTI AIRTEL LIMITED </F01></ROW></DATA>';
  const trimming = new XMLParser({ parseTagValue: false }).parse(xml);
  assert.equal(trimming.DATA.ROW.F01, 'BHARTI AIRTEL LIMITED', 'default parser is expected to trim');

  const faithful = new XMLParser({ parseTagValue: false, trimValues: false }).parse(xml);
  assert.equal(faithful.DATA.ROW.F01, 'BHARTI AIRTEL LIMITED ', 'trimValues:false preserves the real name');
});

test('internal whitespace is never collapsed (real names in these books rely on it)', () => {
  // e.g. "MATRIX  SEAFOODS INDIA LIMITED", "S D  Fine-Chem Limited" — double spaces are load-bearing.
  const xml = '<DATA><ROW><F01>MATRIX  SEAFOODS INDIA LIMITED</F01></ROW></DATA>';
  const parsed = new XMLParser({ parseTagValue: false }).parse(xml);
  assert.equal(parsed.DATA.ROW.F01, 'MATRIX  SEAFOODS INDIA LIMITED');
});
