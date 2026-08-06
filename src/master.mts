// Master-level (ledger / stock item / group / …) repair operations.
//
// Why this exists: Tally stores a master's name as typed, and matches it on import by EXACT string
// equality. A ledger created by pasting from a spreadsheet keeps the pasted line break, so Tally holds
// "BHARTI AIRTEL LIMITED\r\n" and exports it as "BHARTI AIRTEL LIMITED&#13;&#10;". Nothing shows it: the
// trial balance, the ledger collection and every report display the name, and displaying it hides the
// two trailing characters. Only an import notices, and it notices by rejecting the voucher — which then
// lands in suspense.
//
// canonicalizeVoucherMasters (voucher.mts) makes writes work DESPITE such a name. This module fixes the
// name itself, so the master stops being a trap for anything else that touches it — and does it over
// XML, so no one has to open Tally.

import { escapeXml, xmlName, masterKey, decodeXmlEntities } from './voucher.mjs';

// The master collections we can repair, mapped to their Tally import tag. Keyed by the same collection
// names list-master already accepts, so a caller names the collection once and it works everywhere.
export const MASTER_TAGS: Record<string, string> = {
  ledger: 'LEDGER',
  group: 'GROUP',
  stockitem: 'STOCKITEM',
  stockgroup: 'STOCKGROUP',
  vouchertype: 'VOUCHERTYPE',
  costcentre: 'COSTCENTRE',
  costcategory: 'COSTCATEGORY',
  godown: 'GODOWN',
  currency: 'CURRENCY',
  unit: 'UNIT',
};

// Tally collection TYPE for each supported master, for the raw Collection export below.
export const MASTER_COLLECTION_TYPES: Record<string, string> = {
  ledger: 'Ledger',
  group: 'Group',
  stockitem: 'StockItem',
  stockgroup: 'StockGroup',
  vouchertype: 'VoucherType',
  costcentre: 'CostCentre',
  costcategory: 'CostCategory',
  godown: 'Godown',
  currency: 'Currency',
  unit: 'Unit',
};

// Master names read the ONLY way that preserves their exact bytes.
//
// Verified against a live company: the list-master TDL projection and the raw Collection export return
// the same 3,632 ledgers with DIFFERENT names. A ledger stored as "BHARTI AIRTEL LIMITED\r\n" comes back
// 21 characters through the template and 23 through the collection. The template's field projection
// drops the trailing CRLF (a trailing TAB, oddly, survives it); the collection emits the name as an XML
// attribute with numeric character references, which round-trips intact.
//
// Anything comparing a master name for EQUALITY — the write-path canonicalization, this module's repair
// scan — must read from here. Reading from the template makes a malformed name look identical to a clean
// one, which is exactly the bug: the check passes and Tally rejects the import.
export function buildMasterNamesCollectionXml(collectionType: string, company?: string): string {
  const svCompany = company ? `<SVCURRENTCOMPANY>${xmlName(company)}</SVCURRENTCOMPANY>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>` +
    `<ID>MCPExactMasterNames</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany}</STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="MCPExactMasterNames" ISMODIFY="No">` +
    `<TYPE>${escapeXml(collectionType)}</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD>` +
    `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// Pulls each master's name from the NAME attribute of its element. The attribute (not the nested
// LANGUAGENAME.LIST/NAME text) is the master's own identity — the language-name list also contains a
// NAME element, and a text-node scrape would mix aliases in with primary names.
export function parseMasterNamesFromCollection(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*?\\sNAME\\s*=\\s*"([^"]*)"`, 'gi');
  const out: string[] = [];
  for (const m of String(xml ?? '').matchAll(re)) {
    const name = decodeXmlEntities(m[1] ?? '');
    if (name) out.push(name);
  }
  return out;
}

// C0 and C1 control characters. These are never a legitimate part of a master name — they arrive from a
// paste (CR/LF/TAB) or a bad encoding round-trip, and they are invisible in every Tally report.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

// The name a master SHOULD have: control characters removed anywhere, edge whitespace trimmed.
//
// INTERNAL whitespace is deliberately preserved, including runs. "MATRIX  SEAFOODS INDIA LIMITED" and
// "S D  Fine-Chem Limited" are real, distinct ledgers in these books whose double spaces are part of the
// name — collapsing them would rename masters that are working correctly.
export function sanitizeMasterName(name: string): string {
  return String(name ?? '').replace(CONTROL_CHARS, '').trim();
}

// Human-readable account of what is wrong with a stored name, for the dry-run report. Empty ⇒ the name
// is fine. Describing the damage matters more than usual here: the operator cannot see any of it.
export function describeNameIssues(name: string): string[] {
  const s = String(name ?? '');
  const issues: string[] = [];
  const controls = s.match(CONTROL_CHARS);
  if (controls?.length) {
    const shown = [...new Set(controls)]
      .map(c => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    issues.push(`${controls.length} control character(s): ${shown.join(', ')}`);
  }
  const noControls = s.replace(CONTROL_CHARS, '');
  if (noControls !== noControls.trimStart()) issues.push('leading whitespace');
  if (noControls !== noControls.trimEnd()) issues.push('trailing whitespace');
  return issues;
}

export type NameRepair = {
  stored: string;          // exactly what Tally holds today
  proposed: string;        // what it should be
  issues: string[];
  collidesWith?: string;   // an existing master the rename would collide with
};

// Splits the master list into what can be repaired and what must not be touched.
//
// A repair is BLOCKED when the cleaned name already belongs to another master. Renaming into it would
// either fail or merge two ledgers — and merging ledgers silently moves balances, which is far worse
// than the invisible-character problem being fixed. Those are reported for a human to resolve.
export function planMasterNameRepairs(stored: string[]): { repairs: NameRepair[]; blocked: NameRepair[] } {
  const repairs: NameRepair[] = [];
  const blocked: NameRepair[] = [];
  // Index every master by its clean key so a collision is detectable before any write.
  const byKey = new Map<string, string[]>();
  for (const s of stored) {
    const k = masterKey(sanitizeMasterName(s));
    if (!k) continue;
    const list = byKey.get(k);
    if (list) list.push(s); else byKey.set(k, [s]);
  }
  for (const s of stored) {
    const proposed = sanitizeMasterName(s);
    if (!proposed || proposed === s) continue;          // already clean, or nothing left after cleaning
    const issues = describeNameIssues(s);
    const sharing = (byKey.get(masterKey(proposed)) ?? []).filter(o => o !== s);
    if (sharing.length) {
      blocked.push({ stored: s, proposed, issues, collidesWith: sharing[0]! });
    } else {
      repairs.push({ stored: s, proposed, issues });
    }
  }
  return { repairs, blocked };
}

// Renames a master in place. The NAME attribute identifies the EXISTING master and must carry its exact
// stored bytes — escapeXml re-encodes the control characters as numeric references, which is the only
// form that survives XML parsing (a literal CR is rewritten to LF by line-ending normalization, so the
// attribute would no longer match). NAME.LIST supplies the new name, mirroring the shape Tally itself
// uses when it exports a master.
//
// Identity is the whole game here, exactly as with alter-voucher: an ACTION="Alter" whose NAME does not
// match an existing master does not fail — Tally CREATES one. The caller must verify against a re-read
// rather than trust the response counters. See verifyRename.
export function buildRenameMasterXml(tag: string, oldName: string, newName: string, company?: string): string {
  const svCompany = company ? `<SVCURRENTCOMPANY>${xmlName(company)}</SVCURRENTCOMPANY>` : '';
  const body =
    `<${tag} NAME="${escapeXml(oldName)}" RESERVEDNAME="" ACTION="Alter">` +
    `<NAME.LIST TYPE="String"><NAME>${xmlName(newName)}</NAME></NAME.LIST>` +
    `</${tag}>`;
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES>${svCompany}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>` +
    `</IMPORTDATA></BODY></ENVELOPE>`;
}

// A rename is only believable when checked against a re-read of the master list. Tally reports
// altered/created counters, but the alter-voucher work established that those cannot be trusted to
// distinguish a match from a fallback create on these builds. The master COUNT can: renaming preserves
// it, creating increments it.
export type RenameVerdict =
  | { status: 'renamed' }
  | { status: 'created_instead'; before: number; after: number }
  | { status: 'not_applied'; reason: string };

export function verifyRename(
  before: string[], after: string[], oldName: string, newName: string
): RenameVerdict {
  const stillOld = after.includes(oldName);
  const hasNew = after.includes(newName);
  if (after.length > before.length) return { status: 'created_instead', before: before.length, after: after.length };
  if (stillOld && hasNew) return { status: 'created_instead', before: before.length, after: after.length };
  if (stillOld) return { status: 'not_applied', reason: 'the master still carries its old name' };
  if (!hasNew) return { status: 'not_applied', reason: 'neither the old nor the new name is present afterwards' };
  return { status: 'renamed' };
}
