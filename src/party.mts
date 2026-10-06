import { escapeXml, xmlName } from './voucher.mjs';

// Party (Sundry Debtor / Creditor) master details: the fields an invoice carries about the other side —
// mailing name, address, state, country, pincode, PAN, GST registration type and GSTIN.
//
// Writes use the flat ledger tags every Tally release imports (ADDRESS.LIST, LEDSTATENAME, PARTYGSTIN …).
// TallyPrime 3.0+ stores mailing and GST registration details as dated sub-lists instead, and how it maps
// the flat tags onto those on an ALTER has not been confirmed against a live company. That is why every
// write is followed by a read-back through the party-details report: a field Tally did not store is
// reported as a mismatch rather than claimed as written.

export type PartyFields = {
  mailingName?: string;
  address?: string[];
  state?: string;
  country?: string;
  pincode?: string;
  pan?: string;
  gstRegistrationType?: string;
  gstin?: string;
};
export type PartyField = keyof PartyFields;

// A row of the party-details report (only the columns this module reads).
export type PartyRow = {
  party_name?: string; mailing_name?: string; address?: string; state?: string; country?: string;
  pincode?: string; pan?: string; gst_registration_type?: string; gstin?: string;
};

export const PARTY_FIELDS: PartyField[] = ['mailingName', 'address', 'state', 'country', 'pincode', 'pan', 'gstRegistrationType', 'gstin'];

const ROW_COLUMN: Record<PartyField, keyof PartyRow> = {
  mailingName: 'mailing_name', address: 'address', state: 'state', country: 'country', pincode: 'pincode',
  pan: 'pan', gstRegistrationType: 'gst_registration_type', gstin: 'gstin',
};

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PINCODE_IN_RE = /^[1-9][0-9]{5}$/;

// GST state codes (first two digits of a GSTIN). Used only to WARN when the state given disagrees with the
// GSTIN — Tally's own state spellings vary a little across releases, so this never blocks a write.
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
const STATE_ALIASES: Record<string, string[]> = {
  '21': ['orissa'], '34': ['pondicherry'], '25': ['dadra nagar haveli daman diu'], '26': ['daman diu', 'dadra nagar haveli'],
};

const stateKey = (s: string) => s.toLowerCase().replace(/&/g, ' ').replace(/\band\b/g, ' ').replace(/[^a-z]+/g, ' ').trim();

// Trims every field, upper-cases the identifiers, and drops blanks — so an empty string from an invoice
// that lacked the field never reaches Tally as "clear this".
export function normalizePartyFields(f: PartyFields): PartyFields {
  const out: PartyFields = {};
  const t = (s?: string) => (typeof s === 'string' ? s.trim() : '');
  if (t(f.mailingName)) out.mailingName = t(f.mailingName);
  const lines = (f.address || []).map(l => t(l)).filter(Boolean);
  if (lines.length) out.address = lines;
  if (t(f.state)) out.state = t(f.state);
  if (t(f.country)) out.country = t(f.country);
  if (t(f.pincode)) out.pincode = t(f.pincode).replace(/\s+/g, '');
  if (t(f.pan)) out.pan = t(f.pan).toUpperCase();
  if (t(f.gstRegistrationType)) out.gstRegistrationType = t(f.gstRegistrationType);
  if (t(f.gstin)) out.gstin = t(f.gstin).toUpperCase();
  return out;
}

// Hard errors refuse the write; warnings are returned alongside it for the caller to relay.
export function validatePartyFields(f: PartyFields): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (f.pan && !PAN_RE.test(f.pan)) errors.push(`PAN "${f.pan}" is not in the format AAAAA9999A.`);
  if (f.gstin && !GSTIN_RE.test(f.gstin)) errors.push(`GSTIN "${f.gstin}" is not a valid 15-character GSTIN.`);
  // Characters 3-12 of a GSTIN ARE the holder's PAN, so a disagreement means one of the two was misread.
  if (f.pan && f.gstin && GSTIN_RE.test(f.gstin) && f.gstin.slice(2, 12) !== f.pan) {
    errors.push(`PAN ${f.pan} does not match the PAN inside GSTIN ${f.gstin} (${f.gstin.slice(2, 12)}). One of them was misread.`);
  }
  const india = !f.country || /^india$/i.test(f.country);
  if (f.pincode && india && !PINCODE_IN_RE.test(f.pincode)) errors.push(`Pincode "${f.pincode}" is not a 6-digit Indian pincode.`);
  if (f.gstin && f.state && GSTIN_RE.test(f.gstin)) {
    const code = f.gstin.slice(0, 2);
    const expected = GST_STATE_CODES[code];
    if (expected) {
      const given = stateKey(f.state);
      const ok = [stateKey(expected), ...(STATE_ALIASES[code] || [])].some(k => k === given);
      if (!ok) warnings.push(`GSTIN ${f.gstin} is registered in ${expected} (state code ${code}), but the state given is "${f.state}".`);
    }
  }
  return { errors, warnings };
}

// Comparison form: case-insensitive, and blind to how address lines were split (Tally's read joins them
// with commas, an invoice may break them anywhere).
export function partyValueKey(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return s.replace(/[,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const display = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));

export type PartyFieldPlan = {
  field: PartyField;
  action: 'fill' | 'replace' | 'unchanged' | 'conflict';
  current: string;
  proposed: string;
};

// Decides, field by field, what an update would do. A blank field in Tally is filled; an equal one is left
// alone; a DIFFERENT one is a conflict and is skipped unless overwrite is set — an invoice is evidence, not
// authority, and silently replacing a hand-entered address with an OCR'd one is the failure to avoid.
export function planPartyUpdate(current: PartyRow, proposed: PartyFields, overwrite: boolean): PartyFieldPlan[] {
  const plan: PartyFieldPlan[] = [];
  for (const field of PARTY_FIELDS) {
    const want = proposed[field];
    if (want === undefined) continue;
    const have = String(current[ROW_COLUMN[field]] ?? '');
    let action: PartyFieldPlan['action'];
    if (!partyValueKey(have)) action = 'fill';
    else if (partyValueKey(have) === partyValueKey(want)) action = 'unchanged';
    else action = overwrite ? 'replace' : 'conflict';
    plan.push({ field, action, current: have, proposed: display(want) });
  }
  return plan;
}

// The subset of `proposed` the plan says to write.
export function changesFromPlan(plan: PartyFieldPlan[], proposed: PartyFields): PartyFields {
  const out: PartyFields = {};
  for (const p of plan) {
    if (p.action === 'fill' || p.action === 'replace') (out as any)[p.field] = proposed[p.field];
  }
  return out;
}

// Ledger child elements for the given fields, in the flat form all releases import.
export function partyFieldsXml(f: PartyFields): string {
  let x = '';
  if (f.mailingName) x += `<MAILINGNAME>${escapeXml(f.mailingName)}</MAILINGNAME>`;
  if (f.address?.length) x += `<ADDRESS.LIST TYPE="String">${f.address.map(l => `<ADDRESS>${escapeXml(l)}</ADDRESS>`).join('')}</ADDRESS.LIST>`;
  if (f.state) x += `<LEDSTATENAME>${escapeXml(f.state)}</LEDSTATENAME>`;
  if (f.country) x += `<COUNTRYNAME>${escapeXml(f.country)}</COUNTRYNAME>`;
  if (f.pincode) x += `<PINCODE>${escapeXml(f.pincode)}</PINCODE>`;
  if (f.pan) x += `<INCOMETAXNUMBER>${escapeXml(f.pan)}</INCOMETAXNUMBER>`;
  if (f.gstRegistrationType) x += `<GSTREGISTRATIONTYPE>${escapeXml(f.gstRegistrationType)}</GSTREGISTRATIONTYPE>`;
  if (f.gstin) x += `<PARTYGSTIN>${escapeXml(f.gstin)}</PARTYGSTIN>`;
  return x;
}

// ALTER envelope for an existing party ledger. `storedName` must be the exact name Tally stores (see
// resolveMasterNames) — Tally matches the NAME attribute byte-for-byte, and an unmatched ALTER can fall
// back to creating a new master. Only the given fields are sent; Tally keeps every other field as it is.
export function buildPartyAlterXml(storedName: string, changes: PartyFields, company?: string): string {
  const svCompany = company ? `<SVCURRENTCOMPANY>${xmlName(company)}</SVCURRENTCOMPANY>` : '';
  const body = `<LEDGER NAME="${escapeXml(storedName)}" RESERVEDNAME="" ACTION="Alter">${partyFieldsXml(changes)}</LEDGER>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}

// Fields whose read-back value does not match what was written.
export function verifyPartyFields(row: PartyRow | undefined, written: PartyFields): Array<{ field: PartyField; expected: string; actual: string }> {
  const out: Array<{ field: PartyField; expected: string; actual: string }> = [];
  for (const field of PARTY_FIELDS) {
    const want = written[field];
    if (want === undefined) continue;
    const actual = String(row?.[ROW_COLUMN[field]] ?? '');
    if (partyValueKey(actual) !== partyValueKey(want)) out.push({ field, expected: display(want), actual });
  }
  return out;
}
