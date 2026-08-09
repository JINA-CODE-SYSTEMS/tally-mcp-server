import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatchToBlock } from './voucher.mjs';

// The fixtures in alter-voucher.test.mts use bare <DATE>…</DATE>. A real Tally export does not:
// every header scalar carries a type attribute, and the allocation lists nested inside
// ALLLEDGERENTRIES.LIST carry their OWN <DATE>. That combination is what let a bare-<TAG> patcher
// miss the voucher date, silently rewrite the bank allocation date instead, and still come back
// from Tally as altered=1 — an alter that reports success and moves nothing.
const BLOCK =
  `<VOUCHER REMOTEID="rid-0001338d" VCHKEY="vk:00000090" VCHTYPE="Payment" OBJVIEW="Accounting Voucher View">` +
  `<DATE TYPE="Date">20260625</DATE>` +
  `<REFERENCEDATE TYPE="Date"></REFERENCEDATE>` +
  `<NARRATION TYPE="String">INB/IFT/TPARTY TRANSFER</NARRATION>` +
  `<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>` +
  `<PARTYLEDGERNAME TYPE="String">AXIS BANK CC A/C-93392</PARTYLEDGERNAME>` +
  `<VOUCHERNUMBER>782</VOUCHERNUMBER>` +
  `<REFERENCE TYPE="String"></REFERENCE>` +
  `<EFFECTIVEDATE TYPE="Date">20260625</EFFECTIVEDATE>` +
  `<ALLLEDGERENTRIES.LIST>` +
  `<ORIGPURCHINVDATE/>` +
  `<NARRATION/>` +
  `<LEDGERNAME>AXIS BANK CC A/C-93392</LEDGERNAME>` +
  `<AMOUNT>27000.00</AMOUNT>` +
  `<BANKALLOCATIONS.LIST>` +
  `<DATE>20260625</DATE>` +
  `<INSTRUMENTDATE>20260625</INSTRUMENTDATE>` +
  `<BANKERSDATE/>` +
  `</BANKALLOCATIONS.LIST>` +
  `</ALLLEDGERENTRIES.LIST>` +
  `</VOUCHER>`;

const voucherLevelDate = (xml: string): string =>
  (xml.match(/<VOUCHER[^>]*>[\s\S]*?<DATE[^>]*>(\d+)<\/DATE>/) ?? [, ''])[1] as string;

const bankAllocationDate = (xml: string): string =>
  (xml.match(/<BANKALLOCATIONS\.LIST>[\s\S]*?<DATE>(\d+)<\/DATE>/) ?? [, ''])[1] as string;

test('a date patch moves the voucher date even though the tag carries an attribute', () => {
  const out = applyPatchToBlock(BLOCK, { date: '2026-06-26' });
  assert.equal(voucherLevelDate(out), '20260626');
});

test('a date patch does not clobber the nested bank allocation date', () => {
  const out = applyPatchToBlock(BLOCK, { date: '2026-06-26' });
  assert.equal(bankAllocationDate(out), '20260625');
});

test('a date patch leaves exactly one EFFECTIVEDATE, not a duplicate appended at the tail', () => {
  const out = applyPatchToBlock(BLOCK, { date: '2026-06-26' });
  assert.equal((out.match(/<EFFECTIVEDATE[^>]*>/g) ?? []).length, 1);
  assert.match(out, /<EFFECTIVEDATE>20260626<\/EFFECTIVEDATE>/);
});

test('patching REFERENCE does not capture the distinct REFERENCEDATE tag', () => {
  const out = applyPatchToBlock(BLOCK, { reference: 'UTR-105202500062437' });
  assert.match(out, /<REFERENCE>UTR-105202500062437<\/REFERENCE>/);
  assert.match(out, /<REFERENCEDATE TYPE="Date"><\/REFERENCEDATE>/);
});

test('patching NARRATION hits the voucher-level tag, not the self-closing one inside the entry list', () => {
  const out = applyPatchToBlock(BLOCK, { narration: 'moved to 26-Jun' });
  const patchedAt = out.indexOf('<NARRATION>moved to 26-Jun</NARRATION>');
  assert.ok(patchedAt > 0 && patchedAt < out.indexOf('<ALLLEDGERENTRIES.LIST>'));
  assert.ok(out.includes('<NARRATION/>'), 'the nested self-closing NARRATION must survive');
});

test('patching an attribute-bearing PARTYLEDGERNAME replaces rather than appends', () => {
  const out = applyPatchToBlock(BLOCK, { partyLedger: 'AXIS BANK C/A -63925' });
  assert.equal((out.match(/<PARTYLEDGERNAME[^>]*>/g) ?? []).length, 1);
  assert.match(out, /<PARTYLEDGERNAME>AXIS BANK C\/A -63925<\/PARTYLEDGERNAME>/);
});
