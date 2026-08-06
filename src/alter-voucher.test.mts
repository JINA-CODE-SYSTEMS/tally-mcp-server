import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatchToBlock, buildAlterVoucherXml } from './voucher.mjs';
import { buildAlterVariants, interpretAlterResponse } from './mcp.mjs';
import type { ModelPushResponse } from './models.mjs';

// A voucher block shaped like what Tally's Day Book export actually returns: identity attributes on
// the tag, and fields this server does not model (GSTREGISTRATION, PERSISTEDVIEW, a UDF) that an alter
// must not drop.
const REMOTE = 'ca36e34b-2e4f-4a0e-9c31-6b2d5f1a7c88-00013289';
const VCHKEY = 'ca36e34b-2e4f-4a0e-9c31-6b2d5f1a7c88-0000b467:00000060';
const BLOCK =
  `<VOUCHER REMOTEID="${REMOTE}" VCHKEY="${VCHKEY}" VCHTYPE="Payment" ACTION="Create">` +
  `<DATE>20260410</DATE>` +
  `<EFFECTIVEDATE>20260410</EFFECTIVEDATE>` +
  `<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>` +
  `<VOUCHERNUMBER>673</VOUCHERNUMBER>` +
  `<NARRATION>Paid to wrong head</NARRATION>` +
  `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>` +
  `<GSTREGISTRATION>Regular</GSTREGISTRATION>` +
  `<UDF:MYFIELD>keep me</UDF:MYFIELD>` +
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Suspense</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-5000</AMOUNT>` +
  `<BILLALLOCATIONS.LIST><NAME>OLD-REF</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-5000</AMOUNT></BILLALLOCATIONS.LIST>` +
  `</ALLLEDGERENTRIES.LIST>` +
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>5000</AMOUNT></ALLLEDGERENTRIES.LIST>` +
  `</VOUCHER>`;

const NEW_ENTRIES = [
  { ledger: 'BHARTI AIRTEL LIMITED', drCr: 'dr' as const, amount: 5000 },
  { ledger: 'HDFC Bank', drCr: 'cr' as const, amount: 5000 },
];

test('applyPatchToBlock flips ACTION to Alter and keeps Tally identity attributes', () => {
  const out = applyPatchToBlock(BLOCK, { entries: NEW_ENTRIES });
  assert.match(out, /ACTION="Alter"/);
  assert.equal(/ACTION="Create"/.test(out), false);
  // The keys are the whole point — an alter that loses them creates a duplicate instead of matching.
  assert.match(out, new RegExp(`REMOTEID="${REMOTE}"`));
  assert.match(out, new RegExp(`VCHKEY="${VCHKEY.replace(':', ':')}"`));
});

test('replacement entries REPLACE the old ones rather than appending', () => {
  const out = applyPatchToBlock(BLOCK, { entries: NEW_ENTRIES });
  assert.equal(out.includes('Suspense'), false);
  assert.match(out, /BHARTI AIRTEL LIMITED/);
  assert.equal((out.match(/<ALLLEDGERENTRIES\.LIST>/g) || []).length, 2);
});

test('a nested allocation list is removed together with its parent entry, not left orphaned', () => {
  const out = applyPatchToBlock(BLOCK, { entries: NEW_ENTRIES });
  assert.equal(out.includes('OLD-REF'), false);
  assert.equal(out.includes('<BILLALLOCATIONS.LIST>'), false);
});

test('fields the server does not model survive the alter', () => {
  const out = applyPatchToBlock(BLOCK, { entries: NEW_ENTRIES });
  for (const keep of ['<GSTREGISTRATION>Regular</GSTREGISTRATION>', '<PERSISTEDVIEW>', 'keep me']) {
    assert.ok(out.includes(keep), `expected the alter to preserve ${keep}`);
  }
});

test('an omitted field is left exactly as Tally had it (alter is not a wipe)', () => {
  const out = applyPatchToBlock(BLOCK, { entries: NEW_ENTRIES });
  assert.match(out, /<NARRATION>Paid to wrong head<\/NARRATION>/);
  assert.match(out, /<DATE>20260410<\/DATE>/);
});

test('a supplied scalar replaces in place; date rewrites DATE and EFFECTIVEDATE together', () => {
  const out = applyPatchToBlock(BLOCK, { narration: 'Reclassified to Airtel', date: '2026-04-15' });
  assert.match(out, /<NARRATION>Reclassified to Airtel<\/NARRATION>/);
  assert.equal(out.includes('Paid to wrong head'), false);
  assert.match(out, /<DATE>20260415<\/DATE>/);
  assert.match(out, /<EFFECTIVEDATE>20260415<\/EFFECTIVEDATE>/);
});

test('a scalar absent from the export block is inserted rather than dropped', () => {
  const out = applyPatchToBlock(BLOCK, { reference: 'NEFT-99881' });
  assert.match(out, /<REFERENCE>NEFT-99881<\/REFERENCE>/);
  assert.match(out, /<\/VOUCHER>$/);
});

test('scalar values are XML-escaped', () => {
  const out = applyPatchToBlock(BLOCK, { partyLedger: 'LEGAL & PROFESSIONAL FEES' });
  assert.match(out, /LEGAL &amp; PROFESSIONAL FEES/);
});

// ── variant ordering ───────────────────────────────────────────────────────
// Ordering here is a SAFETY property, not a performance one. An Alter that fails to match does not
// no-op: Tally creates a new voucher. So the keyed forms lead, and any form that would drop the last
// remaining identity attribute is not emitted at all.
test('buildAlterVariants leads with the verbatim keyed block and defers the REMOTEID-stripped form', () => {
  const variants = buildAlterVariants(BLOCK, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10', 'ALG CHEMICALS');
  assert.deepEqual(variants.map(v => v.name), [
    'block-verbatim', 'minimal-remoteid-vchkey', 'minimal-vchkey', 'minimal-remoteid', 'block-minus-remoteid',
  ]);
  assert.match(variants[0]!.xml, new RegExp(REMOTE));
  // The stripped form must genuinely have dropped the attribute, not merely be labelled so — and it is
  // only safe to send because VCHKEY survives to identify the voucher.
  const stripped = variants.at(-1)!;
  assert.equal(stripped.xml.includes(REMOTE), false);
  assert.match(stripped.xml, new RegExp(VCHKEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('an unkeyed voucher yields NO variants — the caller must not write at all', () => {
  // The live incident: voucher 673 was hand-keyed, so it had neither identity attribute. Every form
  // previously emitted for it was unmatchable, and the first one Tally saw became a new voucher (1026).
  // Returning [] is what lets the handler refuse before anything is written.
  const unkeyed = BLOCK
    .replace(new RegExp(` REMOTEID="${REMOTE}"`), '')
    .replace(new RegExp(` VCHKEY="${VCHKEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '');
  assert.equal(/REMOTEID=/.test(unkeyed), false, 'fixture sanity: no REMOTEID');
  assert.equal(/VCHKEY=/.test(unkeyed), false, 'fixture sanity: no VCHKEY');
  assert.deepEqual(buildAlterVariants(unkeyed, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10'), []);
});

test('every emitted variant carries at least one identity attribute', () => {
  // The invariant that makes create-instead-of-alter unreachable by construction.
  for (const v of buildAlterVariants(BLOCK, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10')) {
    assert.ok(/REMOTEID="|VCHKEY="/.test(v.xml), `${v.name} has nothing for Tally to match on`);
  }
});

test('every alter variant carries ACTION="Alter" and the target company', () => {
  const variants = buildAlterVariants(BLOCK, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10', 'ALG CHEMICALS');
  for (const v of variants) {
    assert.match(v.xml, /ACTION="Alter"/, `${v.name} must be an alter`);
    assert.match(v.xml, /<SVCURRENTCOMPANY>ALG CHEMICALS<\/SVCURRENTCOMPANY>/, `${v.name} must be company-scoped`);
    assert.match(v.xml, /<REPORTNAME>Vouchers<\/REPORTNAME>/);
  }
});

test('with REMOTEID but no VCHKEY, the REMOTEID-stripped form is withheld', () => {
  // Stripping the only key left would make the alter unmatchable — i.e. a create.
  const noKey = BLOCK.replace(new RegExp(` VCHKEY="${VCHKEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '');
  const names = buildAlterVariants(noKey, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10').map(v => v.name);
  assert.deepEqual(names, ['block-verbatim', 'minimal-remoteid']);
});

test('with VCHKEY but no REMOTEID, the stripped form is still safe to offer', () => {
  const noRemote = BLOCK.replace(new RegExp(` REMOTEID="${REMOTE}"`), '');
  const names = buildAlterVariants(noRemote, { entries: NEW_ENTRIES }, 'Payment', '673', '2026-04-10').map(v => v.name);
  assert.deepEqual(names, ['block-verbatim', 'minimal-vchkey', 'block-minus-remoteid']);
});

test('buildAlterVoucherXml emits both identity attributes when supplied', () => {
  const xml = buildAlterVoucherXml({ voucherType: 'Payment', date: '2026-04-10', voucherNumber: '673', remoteId: REMOTE, vchKey: VCHKEY, entries: NEW_ENTRIES });
  assert.match(xml, new RegExp(`REMOTEID="${REMOTE}"`));
  assert.match(xml, /ACTION="Alter"/);
  assert.match(xml, /<AMOUNT>-5000<\/AMOUNT>/); // debit is negative, matching the create convention
  assert.match(xml, /<AMOUNT>5000<\/AMOUNT>/);
});

// ── response interpretation ────────────────────────────────────────────────
const resp = (o: Partial<ModelPushResponse>): ModelPushResponse =>
  ({ success: true, created: 0, altered: 0, cancelled: 0, deleted: 0, lastVchId: 0, ...o } as ModelPushResponse);

test('altered>0 is success', () => {
  assert.deepEqual(interpretAlterResponse(resp({ altered: 1 }), '78473'), { status: 'altered', altered: 1 });
});

test('an alter that CREATED a voucher is a hard abort, never success', () => {
  // This is the duplicate-generating failure: the original stays mis-booked and a copy appears.
  const r = interpretAlterResponse(resp({ created: 1, altered: 1 }), '78473');
  assert.deepEqual(r, { status: 'created_instead', created: 1 });
});

test('altered=0 is a failure even when Tally reports success', () => {
  const r = interpretAlterResponse(resp({ success: true, altered: 0 }), '78473');
  assert.equal(r.status, 'failed');
});
