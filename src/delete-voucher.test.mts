import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { interpretDeleteResponse, decideDeleteGate, toIsoDate, parseVoucherKeysFromExport, buildDeleteVariants } from './mcp.mjs';
import { buildDeleteVoucherXml } from './voucher.mjs';
import { reportColumnMetadata } from './tally.mjs';

// The self-brute-forcing delete: from the voucher's own export block, build candidate delete envelopes
// and try them in order until one takes. Every single form we tried per-redeploy was rejected by the
// ALG build, so the tool now tries them all in ONE call and reports the winner.
const REAL_BLOCK = `<VOUCHER REMOTEID="ca36e34b-e468-4110-bee2-d33dbe65cdb6-00013535" VCHKEY="ca36e34b-e468-4110-bee2-d33dbe65cdb6-0000b481:000000d8" VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>20260707</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>214</VOUCHERNUMBER><AMOUNT>-200000</AMOUNT></VOUCHER>`;

test('buildDeleteVariants returns the forms in order, all keyed on this voucher + company', () => {
  const vs = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07', 'ALG CHEMICALS');
  assert.deepEqual(vs.map(v => v.name), ['block-minus-remoteid', 'vchkey-only', 'block-verbatim', 'remoteid-only']);
  vs.forEach(v => { assert.match(v.xml, /ACTION="Delete"/); assert.match(v.xml, /<SVCURRENTCOMPANY>ALG CHEMICALS<\/SVCURRENTCOMPANY>/); });
});

test('buildDeleteVariants: block-minus-remoteid drops REMOTEID but keeps VCHKEY + body', () => {
  const v = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07').find(x => x.name === 'block-minus-remoteid')!;
  assert.equal(/REMOTEID=/.test(v.xml), false);
  assert.match(v.xml, /VCHKEY="ca36e34b-e468-4110-bee2-d33dbe65cdb6-0000b481:000000d8"/);
  assert.match(v.xml, /<AMOUNT>-200000<\/AMOUNT>/);
  assert.equal(/ACTION="Create"/.test(v.xml), false);
});

test('buildDeleteVariants: vchkey-only is a minimal envelope with the real VCHKEY, no REMOTEID/body', () => {
  const v = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07').find(x => x.name === 'vchkey-only')!;
  assert.match(v.xml, /<VOUCHER VCHKEY="ca36e34b-e468-4110-bee2-d33dbe65cdb6-0000b481:000000d8" VCHTYPE="Receipt" ACTION="Delete">/);
  assert.match(v.xml, /<VOUCHERNUMBER>214<\/VOUCHERNUMBER>/);
  assert.equal(/REMOTEID=/.test(v.xml), false);
  assert.equal(/<AMOUNT>/.test(v.xml), false);
});

test('buildDeleteVariants: verbatim keeps REMOTEID, remoteid-only is minimal with it', () => {
  const vs = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07');
  assert.match(vs.find(x => x.name === 'block-verbatim')!.xml, /REMOTEID="ca36e34b-e468-4110-bee2-d33dbe65cdb6-00013535"/);
  assert.match(vs.find(x => x.name === 'remoteid-only')!.xml, /<VOUCHER REMOTEID="ca36e34b-e468-4110-bee2-d33dbe65cdb6-00013535" VCHTYPE="Receipt" ACTION="Delete">/);
});

// When a reference is known, the FIRST form tried is the REMOTEID we derive from it — the exact key we
// stamp at create-time — so a voucher WE authored deletes without depending on the export block. Absent
// a reference, deriveRemoteId returns undefined and the derived form is skipped (legacy vouchers).
test('buildDeleteVariants: a known reference prepends a derived-remoteid form keyed on TMCP-<type>-<ref>', () => {
  const vs = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07', 'ALG', 'RCV00351');
  assert.equal(vs[0].name, 'derived-remoteid');
  assert.match(vs[0].xml, /<VOUCHER REMOTEID="TMCP-Receipt-RCV00351" VCHTYPE="Receipt" ACTION="Delete">/);
  assert.match(vs[0].xml, /<VOUCHERNUMBER>214<\/VOUCHERNUMBER>/);
});

test('buildDeleteVariants: no reference → no derived form (legacy/hand-keyed vouchers)', () => {
  const names = buildDeleteVariants(REAL_BLOCK, 'Receipt', '214', '2026-07-07').map(v => v.name);
  assert.equal(names.includes('derived-remoteid'), false);
});

const resp = (o: Partial<{ success: boolean; created: number; altered: number; cancelled: number; deleted: number; lastVchId: number; error: string }>) =>
  ({ success: false, created: 0, altered: 0, cancelled: 0, deleted: 0, lastVchId: 0, ...o });

// Three live probes settled the identity: MASTERID (child OR attribute) → "Cannot delete unnamed
// object"; REMOTEID/VCHKEY attribute + $VoucherKey → "does not exist". Tally matches the voucher by its
// GUID, supplied as a <GUID> CHILD element inside <VOUCHER ACTION="Delete">.
test('buildDeleteVoucherXml keys the delete on the GUID as a <GUID> child element', () => {
  const xml = buildDeleteVoucherXml({ voucherType: 'Receipt', date: '2026-07-07', guid: 'ca36e34b-e468-4110-bee2-d33dbe65cdb6-00013535' }, 'ALG');
  assert.match(xml, /<VOUCHER ACTION="Delete"><GUID>ca36e34b-e468-4110-bee2-d33dbe65cdb6-00013535<\/GUID>/);
  assert.match(xml, /<DATE>20260707<\/DATE>/);
  assert.match(xml, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<SVCURRENTCOMPANY>ALG<\/SVCURRENTCOMPANY>/);
  // none of the forms Tally rejected:
  assert.equal(/MASTERID|REMOTEID|VCHKEY/.test(xml), false);
  assert.equal(/ISCANCELLED/.test(xml), false); // a delete is not a cancel
});

test('buildDeleteVoucherXml omits GUID/DATE when not supplied', () => {
  const xml = buildDeleteVoucherXml({ voucherType: 'Journal' });
  assert.match(xml, /<VOUCHER ACTION="Delete">/);
  assert.equal(/<GUID>/.test(xml), false);
  assert.equal(/<DATE>/.test(xml), false);
  assert.match(xml, /<VOUCHERTYPENAME>Journal<\/VOUCHERTYPENAME>/);
});

// Real Day Book export shape (from a live Tally): REMOTEID + VCHKEY live as attributes on the
// <VOUCHER> tag. The collection scalar $Guid comes back empty on this build, so the delete reads keys
// from here instead. Two vouchers so the number/type match is exercised.
const EXPORT_SAMPLE = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><VOUCHER REMOTEID="ca36e34b-e468-4110-bee2-d33dbe65cdb6-00012742" VCHKEY="ca36e34b-e468-4110-bee2-d33dbe65cdb6-0000b51e:00000008" VCHTYPE="Expenses GST" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>20260701</DATE><VOUCHERTYPENAME>Expenses GST</VOUCHERTYPENAME><VOUCHERNUMBER>7</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER REMOTEID="aa11bb22-0000abcd-00099999" VCHKEY="aa11bb22-0000abcd-0000b51e:00000021" VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>20260701</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>200</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

test('parseVoucherKeysFromExport pulls REMOTEID + VCHKEY for the matching type+number', () => {
  const k = parseVoucherKeysFromExport(EXPORT_SAMPLE, 'Receipt', '200');
  assert.equal(k.remoteId, 'aa11bb22-0000abcd-00099999');
  assert.equal(k.vchKey, 'aa11bb22-0000abcd-0000b51e:00000021');
});

test('parseVoucherKeysFromExport does not cross-match a different voucher (number must match)', () => {
  const k = parseVoucherKeysFromExport(EXPORT_SAMPLE, 'Receipt', '7'); // #7 is the Expenses GST one, not a Receipt
  assert.deepEqual(k, {});
});

test('parseVoucherKeysFromExport returns {} when no block matches', () => {
  assert.deepEqual(parseVoucherKeysFromExport(EXPORT_SAMPLE, 'Payment', '999'), {});
  assert.deepEqual(parseVoucherKeysFromExport('', 'Receipt', '200'), {});
});

test('toIsoDate normalizes a parsed Date (local parts) and an ISO string, else undefined', () => {
  assert.equal(toIsoDate(new Date(2026, 6, 1)), '2026-07-01'); // month is 0-based; local parts, no UTC shift
  assert.equal(toIsoDate('2026-07-01T00:00:00'), '2026-07-01');
  assert.equal(toIsoDate('not a date'), undefined);
  assert.equal(toIsoDate(undefined), undefined);
});

// The delete reason tag is deliberately NOT emitted (version-specific, unverified). Guard that so it
// isn't reintroduced without a live probe.
test('buildDeleteVoucherXml emits no delete-reason tag (pending live verification)', () => {
  const xml = buildDeleteVoucherXml({ voucherType: 'Journal', guid: 'g-1' });
  assert.equal(/AUDITDELETEDNARRATION|DELETEDREASON|REMOVALREASON/i.test(xml), false);
});

test('delete: DELETED>0 → deleted', () => {
  const o = interpretDeleteResponse(resp({ success: true, deleted: 1 }), '4321');
  assert.equal(o.status, 'deleted');
  assert.equal((o as any).deleted, 1);
});

test('delete: CREATED>0 → created_instead (never report a mis-keyed delete as success)', () => {
  const o = interpretDeleteResponse(resp({ success: true, created: 1 }), '4321');
  assert.equal(o.status, 'created_instead');
});

test('delete: nothing deleted → failed with a diagnostic (names master_id + hints at Edit Log)', () => {
  const o = interpretDeleteResponse(resp({ success: false }), '4321');
  assert.equal(o.status, 'failed');
  assert.match((o as any).message, /master_id 4321/);
});

// ── decideDeleteGate: the safety gate. 'proceed' (the only path that deletes) REQUIRES confirm:true
//    AND a master_id, so a destructive call can never be bound to a voucher number that Tally can renumber.
test('gate: dryRun always previews, even with confirm+masterId', () => {
  assert.equal(decideDeleteGate({ dryRun: true, confirm: true, hasMasterId: true }), 'dryRun');
});

test('gate: confirm:true + masterId → proceed (the ONLY delete path)', () => {
  assert.equal(decideDeleteGate({ confirm: true, hasMasterId: true }), 'proceed');
});

test('gate: confirm:true WITHOUT masterId → needs_confirm (number+confirm can never delete — the TOCTOU fix)', () => {
  assert.equal(decideDeleteGate({ confirm: true, hasMasterId: false }), 'needs_confirm');
});

test('gate: masterId WITHOUT confirm → needs_confirm', () => {
  assert.equal(decideDeleteGate({ confirm: false, hasMasterId: true }), 'needs_confirm');
});

test('gate: neither → needs_confirm', () => {
  assert.equal(decideDeleteGate({ hasMasterId: false }), 'needs_confirm');
});

// ── voucher-by-masterid report: verifies a master_id against Tally before an irreversible delete.
test('voucher-by-masterid report is declared with the identity fields and filters on $MasterID', () => {
  const fields = reportColumnMetadata('voucher-by-masterid');
  assert.ok(fields, 'voucher-by-masterid must be a declared pull report');
  assert.deepEqual(fields!.map(f => f.name), ['master_id', 'date', 'voucher_number', 'voucher_type', 'reference', 'party_ledger', 'amount', 'is_cancelled', 'guid', 'vchkey']);
  const xml = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'voucher-by-masterid.xml'), 'utf-8');
  assert.match(xml, /FilterMasterId">\$MasterID = \{masterId\}/); // numeric compare, unquoted
  assert.match(xml, /<TYPE>Voucher<\/TYPE>/);
  assert.match(xml, /<SET>\$Guid<\/SET>/);        // GUID → REMOTEID for the delete
  assert.match(xml, /<SET>\$VoucherKey<\/SET>/);  // VCHKEY for the delete
});
