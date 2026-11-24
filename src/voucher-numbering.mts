// Refusing duplicate MANUAL voucher numbers (#28).
//
// Tally only guards a voucher number when it numbers the voucher itself. Under "Automatic" numbering
// a number we send is overridden, so a clash cannot happen. Under "Manual" (and "Automatic (Manual
// Override)") the number we send is the number the voucher gets — and an XML import does NOT run the
// "Prevent Duplicates" check a person typing the voucher would hit. Two vouchers end up as Sales #INV-104,
// the GST return lists one invoice number twice, and nobody notices until the portal rejects the filing.
//
// So before posting a voucher that carries a voucherNumber under manual numbering, the write path asks
// Tally whether that number is already taken for that type in that financial year, and refuses with
// DUPLICATE_NUMBER unless the caller explicitly passes allowDuplicateNumber. A batch is also checked
// against ITSELF first (two rows with the same number), because the second row's Tally lookup would
// only see the first after it is posted.
//
// Every read here fails OPEN: if the numbering method or the lookup cannot be read, the write proceeds
// exactly as it did before this check existed. A check that could block legitimate writes on a flaky
// read would be turned off by the first person it annoyed.

import { escapeXml, decodeXmlEntities, xmlName } from './voucher.mjs';

/** The values Tally shows for a voucher type's "Method of Voucher Numbering". */
export const NUMBERING_METHODS = ['Automatic', 'Automatic (Manual Override)', 'Manual', 'Multi-user Auto', 'None'] as const;

/**
 * Manual numbering in the sense that matters here: the number WE send is the number the voucher keeps.
 * "Automatic (Manual Override)" counts — the override is exactly what an import with a VOUCHERNUMBER is.
 * "None" has no numbers to clash; "Multi-user Auto" and "Automatic" renumber whatever we send.
 */
export function isManualNumbering(method: string | null | undefined): boolean {
  const m = String(method ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return m === 'manual' || m === 'automatic (manual override)';
}

// The VoucherType collection with just the two fields we need, read the same way master.mts reads exact
// master names (a raw Collection export, not a report template).
//
// UNVERIFIED FIELD NAME: "NumberingMethod" is the VoucherType method TDL exposes for "Method of Voucher
// Numbering" in the TallyPrime builds documented publicly, but it has NOT been confirmed live on every
// TallyPrime version this server supports (3.x, 4.x, Edit Log). If a build names it differently the
// collection simply comes back without the field, every type reads as "unknown" (null), and the check
// fails open — no write is blocked. Confirm against each supported build before relying on it.
export function buildVoucherTypeNumberingXml(company?: string): string {
  const svCompany = company ? `<SVCURRENTCOMPANY>${xmlName(company)}</SVCURRENTCOMPANY>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>` +
    `<ID>ClaudallyVchTypeNumbering</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany}</STATICVARIABLES>` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="ClaudallyVchTypeNumbering" ISMODIFY="No">` +
    `<TYPE>${escapeXml('VoucherType')}</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>NumberingMethod</NATIVEMETHOD>` +
    `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/**
 * Voucher type name (as stored) → numbering method, from the collection export. The name comes from the
 * element's NAME attribute (see parseMasterNamesFromCollection for why not the nested NAME text). A type
 * whose export carries no NUMBERINGMETHOD is left out, which the caller reads as "unknown".
 */
export function parseVoucherTypeNumbering(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<VOUCHERTYPE\b([^>]*?)(?:\/>|>([\s\S]*?)<\/VOUCHERTYPE>)/gi;
  for (const m of String(xml ?? '').matchAll(re)) {
    const nameAttr = /\sNAME\s*=\s*"([^"]*)"/i.exec(m[1] ?? '');
    const name = nameAttr ? decodeXmlEntities(nameAttr[1] ?? '') : '';
    const body = m[2] ?? '';
    const meth = /<NUMBERINGMETHOD\b[^>]*>([\s\S]*?)<\/NUMBERINGMETHOD>/i.exec(body);
    const method = meth ? decodeXmlEntities(meth[1] ?? '').trim() : '';
    if (name && method) out.set(name, method);
  }
  return out;
}

// Per company, per process: voucher types change rarely, and a 500-voucher import must not re-read the
// collection 500 times. Ten minutes keeps a type someone switches to Manual mid-session from being
// missed for long.
export const NUMBERING_CACHE_TTL_MS = 10 * 60 * 1000;
const numberingCache = new Map<string, { at: number; methods: Map<string, string> }>();

export function clearNumberingCache(): void { numberingCache.clear(); }

/**
 * Returns a lookup voucherType → numbering method (or null when unknown / unreadable). `post` sends an
 * XML request to Tally and returns the response text; injected so this module stays I/O-agnostic.
 * A failed read is NOT cached, so the next voucher tries again.
 */
export function makeNumberingResolver(
  company: string | undefined,
  post: (xml: string) => Promise<string>,
  opts: { ttlMs?: number; now?: () => number } = {}
): (voucherType: string) => Promise<string | null> {
  const ttl = opts.ttlMs ?? NUMBERING_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const cacheKey = (company ?? '').trim().toLowerCase();
  let inflight: Promise<Map<string, string> | null> | null = null;
  const load = async (): Promise<Map<string, string> | null> => {
    const hit = numberingCache.get(cacheKey);
    if (hit && now() - hit.at < ttl) return hit.methods;
    if (!inflight) {
      inflight = (async () => {
        try {
          const methods = parseVoucherTypeNumbering(await post(buildVoucherTypeNumberingXml(company)));
          // An empty map means the field (or the collection) did not come back: do not cache that, it
          // may be a transient failure, and caching it would silence the check for ten minutes.
          if (methods.size) numberingCache.set(cacheKey, { at: now(), methods });
          return methods.size ? methods : null;
        } catch {
          return null;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
  return async (voucherType: string) => {
    const methods = await load();
    if (!methods) return null;
    const wanted = String(voucherType ?? '').trim().toLowerCase();
    for (const [name, method] of methods) if (name.trim().toLowerCase() === wanted) return method;
    return null;
  };
}

/**
 * The financial year containing `isoDate`, as [from, to] in YYYY-MM-DD. Tally's manual numbers are
 * unique per year (a business restarts INV-1 every April), so "already used" means "used in this
 * voucher's year", not "ever". The year starts on the company's own FY start month/day when known
 * (from get-period), else 1 April — the Indian default.
 */
export function financialYearOf(isoDate: string, fyStart?: string | null): [string, string] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return null;
  const s = /^\d{4}-(\d{2})-(\d{2})/.exec(fyStart || '');
  const sm = s ? Number(s[1]) : 4;
  const sd = s ? Number(s[2]) : 1;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const startYear = (mo > sm || (mo === sm && d >= sd)) ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${startYear}-${pad(sm)}-${pad(sd)}`;
  // The day before the next year's start.
  const next = new Date(Date.UTC(startYear + 1, sm - 1, sd));
  next.setUTCDate(next.getUTCDate() - 1);
  const to = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return [from, to];
}

export type DuplicateNumberChecker = (voucherType: string, voucherNumber: string, date: string) => Promise<any[] | null>;

/**
 * Binds the existing voucher-number lookup (locateVouchers in mcp.mts, injected as `locate`) to the
 * voucher's financial year. Returns the vouchers already carrying that number, or null on a read
 * failure so the write proceeds.
 */
export function makeDuplicateNumberChecker(
  locate: (voucherType: string, voucherNumber: string, fromDate: string, toDate: string) => Promise<{ rows: any[] } | { error: string }>,
  fyStart?: string | null
): DuplicateNumberChecker {
  return async (voucherType, voucherNumber, date) => {
    const fy = financialYearOf(date, fyStart) ?? ['1990-04-01', '2099-03-31'];
    try {
      const r = await locate(voucherType, voucherNumber, fy[0], fy[1]);
      if ('error' in r) return null;
      // The lookup matches the number exactly already; re-check here so a report that ever widened its
      // match could not turn into false refusals.
      const want = normalizeVoucherNumber(voucherNumber);
      return r.rows.filter(row => normalizeVoucherNumber(String(row?.voucher_number ?? '')) === want);
    } catch {
      return null;
    }
  };
}

/** Voucher numbers compare trimmed and case-insensitively: "inv-7" and "INV-7 " are the same printed number. */
export function normalizeVoucherNumber(n: string | undefined | null): string {
  return String(n ?? '').trim().toLowerCase();
}

/** The message listing the vouchers that already carry the number. */
export function describeExistingNumber(voucherType: string, voucherNumber: string, existing: any[]): string {
  const list = existing.slice(0, 10).map((e: any) => {
    const parts = [`master_id ${e.master_id}`, `#${e.voucher_number}`];
    if (e.date) parts.push(String(e.date instanceof Date ? e.date.toISOString().slice(0, 10) : e.date));
    if (e.amount != null && e.amount !== '') parts.push(`amount ${e.amount}`);
    if (String(e.is_cancelled ?? '').toLowerCase() === 'yes') parts.push('cancelled');
    return parts.join(', ');
  });
  const more = existing.length > 10 ? `; and ${existing.length - 10} more` : '';
  return `${voucherType} voucher number "${voucherNumber}" is already used in this financial year (manual numbering): ${list.join(' | ')}${more}. Nothing was posted.`;
}

export type InBatchNumberDuplicate = { voucherType: string; voucherNumber: string; rows: number[] };

/**
 * Rows of one batch that share (voucherType, financial year, voucherNumber). Only rows that carry a
 * number and did not opt out with allowDuplicateNumber take part. `isManual(type)` decides which types
 * are checked: rows of an automatically numbered type never clash, because Tally renumbers them. Returns
 * each clashing group with its row indexes in order; the first index is the one allowed to post in a
 * best-effort batch.
 *
 * The financial year is part of the key for the same reason the Tally lookup is scoped to it
 * (makeDuplicateNumberChecker): a business restarts INV-1 every year, so a two-year register holding
 * INV-1 in each year is not a clash. `fyStart` is the company's FY start (get-period fyFrom), else 1
 * April. A row whose date cannot be read keeps a year-less key, so it still clashes conservatively with
 * every other unreadable-date row of the same number (executeVoucher refuses a bad date anyway).
 */
export type InBatchNumberRow = { voucherType: string; voucherNumber?: string; allowDuplicateNumber?: boolean; date?: string };

export function findDuplicateNumbersInBatch(
  rows: InBatchNumberRow[],
  isManual: (voucherType: string) => boolean,
  fyStart?: string | null
): InBatchNumberDuplicate[] {
  const groups = new Map<string, InBatchNumberDuplicate>();
  rows.forEach((row, i) => {
    const num = normalizeVoucherNumber(row.voucherNumber);
    if (!num || row.allowDuplicateNumber) return;
    if (!isManual(row.voucherType)) return;
    const fy = financialYearOf(String(row.date ?? ''), fyStart)?.[0] ?? '';
    const key = `${String(row.voucherType).trim().toLowerCase()}\u0000${fy}\u0000${num}`;
    const g = groups.get(key) ?? { voucherType: row.voucherType, voucherNumber: String(row.voucherNumber).trim(), rows: [] };
    g.rows.push(i);
    groups.set(key, g);
  });
  return [...groups.values()].filter(g => g.rows.length > 1);
}

/**
 * The single-voucher check executeVoucher runs just before posting. Returns the vouchers already holding
 * the number when the type is manually numbered and the number is taken; null in every other case —
 * automatic numbering, no number, an opt-out, or any read failure (fail open).
 */
export async function findManualNumberClash(
  voucherType: string,
  voucherNumber: string | undefined,
  date: string,
  deps: { numberingFor?: (voucherType: string) => Promise<string | null>; checkDuplicateNumber?: DuplicateNumberChecker }
): Promise<any[] | null> {
  if (!normalizeVoucherNumber(voucherNumber) || !deps.numberingFor || !deps.checkDuplicateNumber) return null;
  let method: string | null = null;
  try { method = await deps.numberingFor(voucherType); } catch { return null; }
  if (!isManualNumbering(method)) return null;
  let existing: any[] | null = null;
  try { existing = await deps.checkDuplicateNumber(voucherType, String(voucherNumber).trim(), date); } catch { return null; }
  return existing && existing.length ? existing : null;
}

/**
 * The clashing groups of a batch, with each distinct type's numbering method read once up front. A type
 * whose method cannot be read is treated as not manual (fail open); with no resolver nothing is checked.
 */
export async function inBatchNumberClashes(
  rows: InBatchNumberRow[],
  numberingFor?: (voucherType: string) => Promise<string | null>,
  fyStart?: string | null
): Promise<InBatchNumberDuplicate[]> {
  if (!numberingFor) return [];
  const types = [...new Set(rows.filter(r => normalizeVoucherNumber(r.voucherNumber) && !r.allowDuplicateNumber).map(r => r.voucherType))];
  if (!types.length) return [];
  const manual = new Set<string>();
  for (const t of types) {
    let m: string | null = null;
    try { m = await numberingFor(t); } catch { m = null; }
    if (isManualNumbering(m)) manual.add(t);
  }
  return findDuplicateNumbersInBatch(rows, t => manual.has(t), fyStart);
}

/**
 * In-batch clashes for executeVoucherBatch: row index -> refusal message, for every LATER row of a
 * clashing group (the first row of each group is left to post, or to be refused by the Tally lookup on
 * its own merits).
 */
export async function inBatchNumberRefusals(
  rows: InBatchNumberRow[],
  numberingFor?: (voucherType: string) => Promise<string | null>,
  fyStart?: string | null
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const g of await inBatchNumberClashes(rows, numberingFor, fyStart)) {
    const [first, ...later] = g.rows;
    for (const i of later) {
      out.set(i, `${g.voucherType} voucher number "${g.voucherNumber}" is used by more than one row of this batch in the same financial year (rows ${g.rows.join(', ')}, 0-based; manual numbering). Row ${first} keeps it; this row was not posted.`);
    }
  }
  return out;
}
