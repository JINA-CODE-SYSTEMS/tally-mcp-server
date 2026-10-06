import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePartyFields, validatePartyFields, planPartyUpdate, changesFromPlan, buildPartyAlterXml,
  verifyPartyFields, partyValueKey,
} from './party.mjs';

// A made-up Sundry Debtor (synthetic PAN / GSTIN; no real party data in tests).
const PARTY = {
  party_name: 'ACME TRADERS', mailing_name: 'ACME TRADERS',
  address: '12 Example Lane & Annexe, Industrial Estate, Sector 5, Mumbai - 400099',
  state: 'Maharashtra', country: 'India', pincode: '400099', pan: '', gst_registration_type: 'Regular', gstin: '',
};

// ── normalize / validate ───────────────────────────────────────────────────
test('normalize trims, upper-cases identifiers, and drops blanks so they never clear a field', () => {
  const f = normalizePartyFields({ pan: ' abcde1234f ', gstin: '27abcde1234f1z5', state: '  ', address: [' 12 Example Lane ', '', '  '], pincode: '400 099' });
  assert.deepEqual(f, { pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5', address: ['12 Example Lane'], pincode: '400099' });
});

test('a consistent PAN + GSTIN + state passes cleanly', () => {
  const r = validatePartyFields({ pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra', pincode: '400099' });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test('PAN that disagrees with the PAN inside the GSTIN is refused (one was misread)', () => {
  const r = validatePartyFields({ pan: 'ABCDE1234G', gstin: '27ABCDE1234F1Z5' });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /does not match the PAN inside GSTIN/);
});

test('malformed PAN, GSTIN and Indian pincode are refused', () => {
  const r = validatePartyFields({ pan: 'AAB6407Q', gstin: '27ABCDE1234F1Z', pincode: '40005' });
  assert.equal(r.errors.length, 3);
});

test('a non-Indian pincode is not held to the 6-digit rule', () => {
  assert.deepEqual(validatePartyFields({ country: 'United Kingdom', pincode: 'SW1A 1AA' }).errors, []);
});

test('state disagreeing with the GSTIN state code only warns; known spellings do not', () => {
  assert.equal(validatePartyFields({ gstin: '27ABCDE1234F1Z5', state: 'Karnataka' }).warnings.length, 1);
  assert.equal(validatePartyFields({ gstin: '27ABCDE1234F1Z5', state: 'Karnataka' }).errors.length, 0);
  assert.deepEqual(validatePartyFields({ gstin: '21ABCDE1234F1Z5', state: 'Orissa' }).warnings, []);
  assert.deepEqual(validatePartyFields({ gstin: '01ABCDE1234F1Z5', state: 'Jammu and Kashmir' }).warnings, []);
  assert.deepEqual(validatePartyFields({ gstin: '26ABCDE1234F1Z5', state: 'Dadra and Nagar Haveli and Daman and Diu' }).warnings, []);
});

// ── plan ───────────────────────────────────────────────────────────────────
test('blank fields are filled, equal ones left alone, different ones are conflicts by default', () => {
  const plan = planPartyUpdate(PARTY, { pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5', state: 'MAHARASHTRA', pincode: '400098' }, false);
  const by = Object.fromEntries(plan.map(p => [p.field, p.action]));
  assert.deepEqual(by, { pan: 'fill', gstin: 'fill', state: 'unchanged', pincode: 'conflict' });
  // only the fills are written; the conflict is NOT
  assert.deepEqual(changesFromPlan(plan, { pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5', state: 'MAHARASHTRA', pincode: '400098' }),
    { pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5' });
});

test('overwrite turns conflicts into replacements', () => {
  const plan = planPartyUpdate(PARTY, { pincode: '400098' }, true);
  assert.equal(plan[0]!.action, 'replace');
  assert.deepEqual(changesFromPlan(plan, { pincode: '400098' }), { pincode: '400098' });
});

test('an address split into different lines than Tally holds is still "unchanged"', () => {
  const lines = ['12 Example Lane & Annexe', 'Industrial Estate', 'Sector 5', 'Mumbai - 400099'];
  assert.equal(planPartyUpdate(PARTY, { address: lines }, false)[0]!.action, 'unchanged');
  assert.equal(partyValueKey(['a,', ' b']), partyValueKey('A, B'));
});

// ── XML ────────────────────────────────────────────────────────────────────
test('ALTER envelope carries only the changed fields, escaped, under the stored name', () => {
  const xml = buildPartyAlterXml('BHARTI AIRTEL LIMITED\r\n', { address: ['A & B Towers', 'Lane <2>'], pan: 'ABCDE1234F' }, 'ROSS & CO');
  assert.match(xml, /<LEDGER NAME="BHARTI AIRTEL LIMITED&#13;&#10;" RESERVEDNAME="" ACTION="Alter">/);
  assert.match(xml, /<ADDRESS\.LIST TYPE="String"><ADDRESS>A &amp; B Towers<\/ADDRESS><ADDRESS>Lane &lt;2&gt;<\/ADDRESS><\/ADDRESS\.LIST>/);
  assert.match(xml, /<INCOMETAXNUMBER>ABCDE1234F<\/INCOMETAXNUMBER>/);
  assert.match(xml, /<SVCURRENTCOMPANY>ROSS &amp; CO<\/SVCURRENTCOMPANY>/);
  // nothing that was not asked for — no NAME child (that would be a rename), no other party tags
  assert.equal(/<NAME>|<NAME\.LIST|PARTYGSTIN|LEDSTATENAME|PINCODE|MAILINGNAME/.test(xml), false);
});

// ── verify ─────────────────────────────────────────────────────────────────
test('read-back verification reports exactly the fields Tally did not store', () => {
  const after = { ...PARTY, pan: 'ABCDE1234F', gstin: '' };
  assert.deepEqual(verifyPartyFields(after, { pan: 'ABCDE1234F', gstin: '27ABCDE1234F1Z5' }),
    [{ field: 'gstin', expected: '27ABCDE1234F1Z5', actual: '' }]);
  assert.equal(verifyPartyFields(undefined, { pan: 'ABCDE1234F' }).length, 1);
});
