// import-vouchers: post vouchers straight from a CSV or Excel file (#32).
//
// Without this, a 500-line bank statement or sales register reaches Tally by the model reading the file
// and re-typing every row into create-vouchers calls. That is slow, costs a fortune in tokens, and is
// exactly where a digit gets transposed or a row silently dropped — by a component nobody can audit.
// Here the server reads the file itself; the model only describes the MAPPING (which column is the
// date, which is the amount, which ledger is the other side). Every voucher then goes through the same
// deterministic checks as create-vouchers (balance, open period, masters, duplicate numbers), the
// preview shows totals and every bad row by its SPREADSHEET row number, and the real run posts in
// chunks under one batch journal, so resumeBatchId and undo-batch work on a whole import.
//
// This module is pure over its inputs (file bytes, mapping, an injected batch runner); the tool handler
// in mcp.mts binds it to the company context. It never imports mcp.mts at runtime.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readTable, SpreadsheetError, type Cell, type SheetRow, type Table } from './spreadsheet.mjs';

// ── where a file may be read from ───────────────────────────────────────────────────────────────

/**
 * Folders an import may read from. The server runs with the user's (or a service account's) rights and
 * the path comes from a model, so "any file the process can open" would let a prompt-injected request
 * read, say, a browser profile and echo it back through row errors. The allowed set is where people
 * actually keep exports: the Tally data folder, the user's Documents / Downloads / Desktop (including
 * OneDrive-redirected ones), plus TALLY_ALLOWED_IMPORT_ROOTS (comma or semicolon separated) for a shared
 * folder an office uses.
 */
export function allowedImportRoots(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const roots: string[] = [];
  const add = (p: string | undefined) => { const t = (p ?? '').trim().replace(/^"+|"+$/g, ''); if (t) roots.push(t); };
  add(env.TALLY_DATA_PATH);
  for (const r of String(env.TALLY_ALLOWED_IMPORT_ROOTS ?? '').split(/[;,]/)) add(r);
  const bases = [home, env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((b): b is string => !!b && !!b.trim());
  for (const b of bases) for (const sub of ['Documents', 'Downloads', 'Desktop']) add(path.join(b, sub));
  return [...new Set(roots)];
}

// Resolves symlinks in the deepest part of the path that exists, then re-appends the rest. A path to a
// file that does not exist yet must still resolve its folders: otherwise a root that goes through a
// link (macOS /var -> /private/var, a redirected profile folder) is resolved on one side only, and a
// missing file inside an allowed folder is wrongly reported as outside it instead of "not found".
// The missing tail cannot itself be a link, so this is no weaker than resolving the whole path.
const realOr = (p: string): string => {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* walk up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
};

/**
 * Resolves and checks the import path. Symlinks are resolved on BOTH sides before comparing, so a link
 * inside Downloads pointing at C:\Windows does not pass as "inside Downloads". Windows paths compare
 * case-insensitively.
 */
export function checkImportPath(
  candidate: string,
  roots: string[],
  isWithin: (candidate: string, roots: string[]) => { ok: boolean; resolved: string }
): { ok: true; resolved: string; size: number } | { ok: false; message: string } {
  if (!candidate || !String(candidate).trim()) return { ok: false, message: 'path is required.' };
  const raw = String(candidate).trim().replace(/^"+|"+$/g, '');
  if (!path.isAbsolute(raw)) return { ok: false, message: `path must be absolute (got "${raw}").` };
  const resolved = realOr(raw);
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const realRoots = roots.map(r => realOr(r));
  if (!isWithin(fold(resolved), realRoots.map(fold)).ok) {
    return { ok: false, message: `"${raw}" is outside the folders imports may read from (${roots.join('; ')}). Move the file into Documents, Downloads or Desktop, or add its folder to TALLY_ALLOWED_IMPORT_ROOTS in the server's .env.` };
  }
  let st: fs.Stats;
  try { st = fs.statSync(resolved); } catch { return { ok: false, message: `File not found: "${raw}".` }; }
  if (!st.isFile()) return { ok: false, message: `"${raw}" is not a file.` };
  if (st.size > 50 * 1024 * 1024) return { ok: false, message: `"${raw}" is ${(st.size / 1048576).toFixed(1)} MB; the limit is 50 MB. Split the file.` };
  return { ok: true, resolved, size: st.size };
}

// ── the mapping ─────────────────────────────────────────────────────────────────────────────────

const col = (what: string) => z.string().min(1).optional().describe(`column header for ${what} (matched case-insensitively, extra spaces ignored)`);

export const importMappingSchema = z.object({
  date: z.string().min(1).describe('column header holding the voucher date. Excel dates, DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYYMMDD and 3-Jul-2026 are all read; see dateOrder for ambiguous ones.'),
  voucherType: col('the voucher type (exact Tally name per row)'),
  voucherTypeConstant: z.string().min(1).optional().describe('voucher type for EVERY row, e.g. "Receipt" (use instead of voucherType when the file has no such column)'),
  voucherNumber: col('the voucher number (only for manually numbered types; leave out to let Tally number them)'),
  reference: col('the reference / UTR / cheque / invoice no. Used to skip rows already in Tally (skipIfExists) and as the voucher\'s durable key'),
  narration: col('the narration'),
  partyLedger: col('the party ledger (PARTYLEDGERNAME) for invoices'),
  // Shape (a): one row = one two-line voucher.
  debitLedger: col('shape A: the ledger debited on each row'),
  debitLedgerConstant: z.string().min(1).optional().describe('shape A: ledger debited on EVERY row, e.g. "HDFC Bank" for a receipts statement'),
  creditLedger: col('shape A: the ledger credited on each row'),
  creditLedgerConstant: z.string().min(1).optional().describe('shape A: ledger credited on EVERY row, e.g. "Sales"'),
  amount: col('the amount. Shape A: the voucher amount (must be positive). Shape B: the line amount, signed unless side / debitAmount+creditAmount say which side'),
  // Shape (b): one row = one ledger line; rows sharing groupBy form one voucher.
  groupBy: col('shape B: rows with the same value here form ONE voucher (typically the invoice / voucher no. or reference). Use with ledger + amount'),
  ledger: col('shape B: the ledger of each line'),
  side: col('shape B: Dr/Cr (also Debit/Credit, D/C) of each line'),
  debitAmount: col('shape B: debit amount column (a line uses whichever of debitAmount / creditAmount is filled)'),
  creditAmount: col('shape B: credit amount column'),
  signConvention: z.enum(['positive-is-debit', 'positive-is-credit']).optional().describe('shape B with a single signed amount column and no side: which sign is a debit. Default positive-is-debit.'),
  dateOrder: z.enum(['DMY', 'MDY', 'YMD']).optional().describe('how to read an ambiguous date like 03/07/2026. Default DMY (3 July), the Indian convention.'),
  decimalSeparator: z.enum(['.', ',']).optional().describe('"." (default: 1,23,456.50) or "," (European: 1.234,50)'),
  headerRow: z.number().int().min(1).optional().describe('spreadsheet row holding the column headers (default 1); rows above it are ignored'),
}).describe('How the file\'s columns become vouchers. Shape A (one row = one voucher): date, amount, and debitLedger/debitLedgerConstant + creditLedger/creditLedgerConstant. Shape B (several rows = one voucher): groupBy + ledger + amount (+ side, or debitAmount/creditAmount, or a signed amount). Either shape needs voucherType or voucherTypeConstant.');

export type ImportMapping = z.infer<typeof importMappingSchema>;

export const importVouchersInputShape = {
  path: z.string().min(1).describe('ABSOLUTE path of the .csv / .xlsx file on the Tally PC. Must be inside Documents, Downloads, Desktop, the Tally data folder, or a folder listed in TALLY_ALLOWED_IMPORT_ROOTS.'),
  sheet: z.string().optional().describe('Excel only: sheet name (or 1-based position). Default: the first sheet.'),
  mapping: importMappingSchema,
  dryRun: z.boolean().optional().describe('default TRUE: read and validate every row, return totals, a sample and every error by spreadsheet row number, post nothing. Set false to post.'),
  chunkSize: z.number().int().min(1).max(200).optional().describe('vouchers posted per chunk (default 50)'),
  atomic: z.boolean().optional().describe('true = post nothing unless EVERY row is valid (all are validated first). Default false: valid rows post, bad rows are reported.'),
  skipIfExists: z.boolean().optional().describe('default TRUE: a row whose reference is already on a live voucher in Tally is skipped, so re-running an import never double-posts'),
  resumeBatchId: z.string().optional().describe('batchId of an earlier import of THIS file that did not finish: rows it already posted are not sent again. Rows that failed may be corrected in the file before resuming; rows may not be added or removed.'),
  resendUnknownRows: z.array(z.number().int().min(1)).optional().describe('with resumeBatchId: SPREADSHEET row numbers of OUTCOME_UNKNOWN errors (no reference) that the USER has checked are NOT in the Day Book, so they may be sent again. Never list a row without that check: it would be booked twice.'),
  newBatch: z.boolean().optional().describe('post as a new batch even though an earlier import already sent these exact rows. Only when the user confirms they are meant to be booked a second time.'),
  sampleSize: z.number().int().min(0).max(50).optional().describe('how many vouchers to show in the preview (default 5)'),
  targetCompany: z.string().optional().describe('optional company name; defaults to the active company'),
};

// ── cell conversions ────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const validYmd = (y: number, m: number, d: number): string | null => {
  if (!(y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

/**
 * Excel serial date → YYYY-MM-DD. 1900 system: serial 1 is 1900-01-01, and Excel counts a 29 Feb 1900
 * that never existed (serial 60, Lotus 1-2-3's leap-year bug kept for compatibility), so serials after
 * it are one day ahead of the real calendar. 1904 system (old Mac workbooks): serial 0 is 1904-01-01.
 */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  let days = Math.floor(serial);
  let base: number;
  if (date1904) {
    if (days < 0) return null;
    base = Date.UTC(1904, 0, 1);
  } else {
    if (days < 1 || days === 60) return null;
    if (days > 60) days -= 1;
    base = Date.UTC(1899, 11, 31);
  }
  const dt = new Date(base + days * 86400000);
  return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function parseDateCell(v: Cell, opts: { dateOrder?: 'DMY' | 'MDY' | 'YMD'; date1904?: boolean } = {}): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return excelSerialToIso(v, opts.date1904);
  const s = String(v).trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ][\d:.]+Z?)?$/.exec(s))) return validYmd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) {
    return opts.dateOrder === 'MDY' ? validYmd(+m[3]!, +m[1]!, +m[2]!) : validYmd(+m[3]!, +m[2]!, +m[1]!);
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return validYmd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{2}|\d{4})$/.exec(s))) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith('sept') ? 4 : 3)];
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mon ? validYmd(y, mon, +m[1]!) : null;
  }
  // A date cell that reached a CSV as its serial number (a column formatted General).
  if (/^\d{4,5}(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s), opts.date1904);
  return null;
}

/**
 * An amount as accountants write it: "1,23,456.50", "₹ 1,000", "(500.00)" for a negative, a trailing
 * "Dr"/"Cr" naming the side. Thousands separators are only accepted in the position the chosen decimal
 * separator implies, so "1,234" can never be read as 1.234 by accident.
 *
 * The LAST group before the decimal part is always exactly 3 digits. Western grouping is all 3-digit
 * groups (1,234,567.50); Indian grouping is 2-digit groups followed by a final 3-digit group
 * (12,34,56,789). A 2-digit final group ("234,50", "1,23") is neither: it is a European decimal comma
 * read with the wrong separator, and accepting it would book the amount 100x (234,50 → 23450). The
 * ',' branch mirrors this with '.' groups of exactly 3, so "1.50" is not read as 150.
 */
export function parseAmountCell(v: Cell, decimalSeparator: '.' | ',' = '.'): { value: number; side?: 'dr' | 'cr' } | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : null;
  let s = String(v).replace(/[\u00a0\u202f\s]/g, '');
  if (!s) return null;
  let side: 'dr' | 'cr' | undefined;
  const sm = /(dr|cr)\.?$/i.exec(s);
  if (sm) { side = sm[1]!.toLowerCase() as 'dr' | 'cr'; s = s.slice(0, sm.index); }
  s = s.replace(/^(₹|rs\.?|inr)/i, '').replace(/(₹|rs\.?|inr)$/i, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  s = s.replace(/^(₹|rs\.?|inr)/i, '');
  if (decimalSeparator === ',') {
    if (!/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$|^\d+(?:,\d+)?$/.test(s)) return null;
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return { value: neg ? -n : n, ...(side ? { side } : {}) };
}

export function parseSideCell(v: Cell): 'dr' | 'cr' | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (['dr', 'debit', 'd', 'db'].includes(s)) return 'dr';
  if (['cr', 'credit', 'c'].includes(s)) return 'cr';
  return null;
}

const text = (v: Cell): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v)).trim();
const normHeader = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// ── rows → vouchers ─────────────────────────────────────────────────────────────────────────────

export type ImportEntry = { ledger: string; drCr: 'dr' | 'cr'; amount: number };
export type ImportVoucher = {
  voucherType: string;
  date: string;
  entries: ImportEntry[];
  voucherNumber?: string;
  reference?: string;
  narration?: string;
  partyLedger?: string;
  skipIfExists?: boolean;
};
export type ImportRowError = { rows: number[]; code: string; message: string };
/** One voucher position in the file: a voucher, or the reason its row(s) could not become one. */
export type ImportSlot = { sourceRows: number[]; voucher?: ImportVoucher; error?: ImportRowError };

export type Conversion =
  | { ok: false; message: string }
  | { ok: true; slots: ImportSlot[]; totalRows: number; blankRows: number; headers: string[]; shape: 'A' | 'B' };

const MAX_DATA_ROWS = 50_000;

/**
 * Applies the mapping. A mapping problem (unknown column, incomplete shape) fails the whole call — it is
 * the model's mistake and must be fixed before anything else makes sense. A data problem in a row (bad
 * date, unreadable amount, missing ledger) becomes that row's error, with its spreadsheet row number, and
 * the other rows carry on.
 */
export function convertRows(table: Table, mapping: ImportMapping, opts: { skipIfExists?: boolean } = {}): Conversion {
  const headerRowNo = mapping.headerRow ?? 1;
  const headerRow = table.rows.find(r => r.rowNumber === headerRowNo);
  if (!headerRow) return { ok: false, message: `Row ${headerRowNo} (the header row) is empty or missing.` };
  const headers = headerRow.cells.map(c => text(c));
  const index = new Map<string, number>();
  headers.forEach((h, i) => { const k = normHeader(h); if (k && !index.has(k)) index.set(k, i); });

  const missing: string[] = [];
  const colOf = (field: keyof ImportMapping): number | undefined => {
    const name = mapping[field];
    if (typeof name !== 'string' || !name.trim()) return undefined;
    const i = index.get(normHeader(name));
    if (i === undefined) missing.push(`${String(field)} → "${name}"`);
    return i;
  };
  const c = {
    date: colOf('date'), voucherType: colOf('voucherType'), voucherNumber: colOf('voucherNumber'), reference: colOf('reference'),
    narration: colOf('narration'), partyLedger: colOf('partyLedger'), debitLedger: colOf('debitLedger'), creditLedger: colOf('creditLedger'),
    amount: colOf('amount'), groupBy: colOf('groupBy'), ledger: colOf('ledger'), side: colOf('side'),
    debitAmount: colOf('debitAmount'), creditAmount: colOf('creditAmount'),
  };
  if (missing.length) {
    return { ok: false, message: `Mapped column(s) not found in the header row (row ${headerRowNo}): ${missing.join(', ')}. The headers are: ${headers.filter(Boolean).map(h => `"${h}"`).join(', ')}.` };
  }
  if (!mapping.voucherType && !mapping.voucherTypeConstant) return { ok: false, message: 'mapping needs voucherType (a column) or voucherTypeConstant.' };
  const shape: 'A' | 'B' = mapping.groupBy || mapping.ledger ? 'B' : 'A';
  if (shape === 'B') {
    if (!mapping.groupBy || !mapping.ledger) return { ok: false, message: 'Shape B (several rows per voucher) needs both groupBy and ledger.' };
    if (!mapping.amount && !(mapping.debitAmount || mapping.creditAmount)) return { ok: false, message: 'Shape B needs amount, or debitAmount / creditAmount.' };
  } else {
    if (!mapping.amount) return { ok: false, message: 'mapping needs amount.' };
    if (!mapping.debitLedger && !mapping.debitLedgerConstant) return { ok: false, message: 'Shape A needs debitLedger (a column) or debitLedgerConstant.' };
    if (!mapping.creditLedger && !mapping.creditLedgerConstant) return { ok: false, message: 'Shape A needs creditLedger (a column) or creditLedgerConstant.' };
  }

  const dataRows = table.rows.filter(r => r.rowNumber > headerRowNo);
  const blank = (r: SheetRow) => r.cells.every(v => text(v) === '');
  const live = dataRows.filter(r => !blank(r));
  if (live.length > MAX_DATA_ROWS) return { ok: false, message: `The file has ${live.length} data rows; the limit is ${MAX_DATA_ROWS} per import. Split it.` };
  const dec = mapping.decimalSeparator ?? '.';
  const get = (r: SheetRow, i: number | undefined): Cell => (i === undefined ? null : r.cells[i] ?? null);
  const dateOpts = { dateOrder: mapping.dateOrder, date1904: table.date1904 };
  const skip = opts.skipIfExists ?? true;

  // The voucher-level fields one row carries (shape A: the whole voucher; shape B: the group header).
  const headerFields = (r: SheetRow): { fields?: Omit<ImportVoucher, 'entries'>; problems: string[] } => {
    const problems: string[] = [];
    const dateCell = get(r, c.date);
    const date = parseDateCell(dateCell, dateOpts);
    if (!date) problems.push(text(dateCell) ? `date "${text(dateCell)}" is not a date` : 'date is empty');
    const voucherType = mapping.voucherTypeConstant ?? text(get(r, c.voucherType));
    if (!voucherType) problems.push('voucher type is empty');
    if (problems.length) return { problems };
    const f: Omit<ImportVoucher, 'entries'> = { voucherType, date: date! };
    const num = text(get(r, c.voucherNumber)); if (num) f.voucherNumber = num;
    const ref = text(get(r, c.reference)); if (ref) f.reference = ref;
    const nar = text(get(r, c.narration)); if (nar) f.narration = nar;
    const party = text(get(r, c.partyLedger)); if (party) f.partyLedger = party;
    if (skip) f.skipIfExists = true;
    return { fields: f, problems };
  };
  const rowError = (rows: number[], message: string): ImportSlot => ({ sourceRows: rows, error: { rows, code: 'INVALID_ROW', message } });

  const slots: ImportSlot[] = [];
  if (shape === 'A') {
    for (const r of live) {
      const h = headerFields(r);
      const amt = parseAmountCell(get(r, c.amount), dec);
      const problems = [...h.problems];
      if (!amt) problems.push(text(get(r, c.amount)) ? `amount "${text(get(r, c.amount))}" is not a number` : 'amount is empty');
      else if (!(amt.value > 0)) problems.push(`amount ${amt.value} must be greater than 0`);
      const dr = mapping.debitLedgerConstant ?? text(get(r, c.debitLedger));
      const cr = mapping.creditLedgerConstant ?? text(get(r, c.creditLedger));
      if (!dr) problems.push('debit ledger is empty');
      if (!cr) problems.push('credit ledger is empty');
      if (problems.length) { slots.push(rowError([r.rowNumber], `Row ${r.rowNumber}: ${problems.join('; ')}.`)); continue; }
      const value = Math.round(amt!.value * 100) / 100;
      slots.push({ sourceRows: [r.rowNumber], voucher: { ...h.fields!, entries: [{ ledger: dr, drCr: 'dr', amount: value }, { ledger: cr, drCr: 'cr', amount: value }] } });
    }
  } else {
    // Group in order of first appearance. A row with no group key cannot belong anywhere: its own slot.
    const groups = new Map<string, SheetRow[]>();
    const order: Array<{ key?: string; row?: SheetRow }> = [];
    for (const r of live) {
      const key = text(get(r, c.groupBy));
      if (!key) { order.push({ row: r }); continue; }
      if (!groups.has(key)) { groups.set(key, []); order.push({ key }); }
      groups.get(key)!.push(r);
    }
    const positiveIsDebit = (mapping.signConvention ?? 'positive-is-debit') === 'positive-is-debit';
    for (const o of order) {
      if (o.row) { slots.push(rowError([o.row.rowNumber], `Row ${o.row.rowNumber}: the ${mapping.groupBy} column is empty, so the row cannot be grouped into a voucher.`)); continue; }
      const rows = groups.get(o.key!)!;
      const nums = rows.map(r => r.rowNumber);
      const problems: string[] = [];
      const h = headerFields(rows[0]!);
      problems.push(...h.problems.map(p => `row ${rows[0]!.rowNumber}: ${p}`));
      // Every row of a voucher must agree on the voucher-level fields it fills in.
      if (h.fields) {
        for (const r of rows.slice(1)) {
          const other = headerFields(r);
          if (!other.fields) continue; // a later row may leave the header fields blank
          for (const k of ['date', 'voucherType', 'voucherNumber', 'reference', 'partyLedger'] as const) {
            const a = h.fields[k], b = other.fields[k];
            if (b && a !== b) problems.push(`row ${r.rowNumber}: ${k} "${b}" differs from "${a}" in row ${rows[0]!.rowNumber}`);
          }
        }
      }
      const entries: ImportEntry[] = [];
      for (const r of rows) {
        const ledger = text(get(r, c.ledger));
        if (!ledger) { problems.push(`row ${r.rowNumber}: ledger is empty`); continue; }
        let side: 'dr' | 'cr' | null = null;
        let amount: number | null = null;
        const dAmt = c.debitAmount !== undefined ? parseAmountCell(get(r, c.debitAmount), dec) : null;
        const cAmt = c.creditAmount !== undefined ? parseAmountCell(get(r, c.creditAmount), dec) : null;
        if ((dAmt && dAmt.value !== 0) || (cAmt && cAmt.value !== 0)) {
          if (dAmt && dAmt.value !== 0 && cAmt && cAmt.value !== 0) { problems.push(`row ${r.rowNumber}: both debit and credit amounts are filled`); continue; }
          side = dAmt && dAmt.value !== 0 ? 'dr' : 'cr';
          amount = (dAmt && dAmt.value !== 0 ? dAmt : cAmt)!.value;
          if (amount < 0) { problems.push(`row ${r.rowNumber}: a ${side === 'dr' ? 'debit' : 'credit'} amount cannot be negative`); continue; }
        } else if (c.amount !== undefined) {
          const a = parseAmountCell(get(r, c.amount), dec);
          if (!a) { problems.push(`row ${r.rowNumber}: ${text(get(r, c.amount)) ? `amount "${text(get(r, c.amount))}" is not a number` : 'amount is empty'}`); continue; }
          const sideCell = c.side !== undefined ? get(r, c.side) : null;
          const explicit = c.side !== undefined ? parseSideCell(sideCell) : null;
          if (c.side !== undefined && !explicit && text(sideCell)) { problems.push(`row ${r.rowNumber}: side "${text(sideCell)}" is not Dr or Cr`); continue; }
          side = explicit ?? a.side ?? null;
          if (side) {
            if (a.value < 0) { problems.push(`row ${r.rowNumber}: amount is negative but the side is given as ${side === 'dr' ? 'Dr' : 'Cr'}`); continue; }
            amount = a.value;
          } else {
            side = (a.value >= 0) === positiveIsDebit ? 'dr' : 'cr';
            amount = Math.abs(a.value);
          }
        } else {
          problems.push(`row ${r.rowNumber}: no amount`);
          continue;
        }
        if (!(amount! > 0)) { problems.push(`row ${r.rowNumber}: amount must be greater than 0`); continue; }
        entries.push({ ledger, drCr: side!, amount: Math.round(amount! * 100) / 100 });
      }
      if (problems.length) { slots.push(rowError(nums, `Rows ${nums.join(', ')} (${mapping.groupBy} "${o.key}"): ${problems.join('; ')}.`)); continue; }
      // The voucher's narration is the first one filled in, wherever it sits in the group.
      const nar = rows.map(r => text(get(r, c.narration))).find(Boolean);
      const v: ImportVoucher = { ...h.fields!, entries };
      if (nar) v.narration = nar;
      slots.push({ sourceRows: nums, voucher: v });
    }
  }
  return { ok: true, slots, totalRows: live.length, blankRows: dataRows.length - live.length, headers, shape };
}

/** Reads the file into a table, turning reader failures into a message. */
export function loadImportTable(file: string, sheet?: string): { ok: true; table: Table } | { ok: false; message: string } {
  try {
    const buf = fs.readFileSync(file);
    return { ok: true, table: readTable(buf, { sheet, fileName: file }) };
  } catch (err: any) {
    if (err instanceof SpreadsheetError) return { ok: false, message: err.message };
    return { ok: false, message: `Could not read "${file}": ${err?.message ?? err}` };
  }
}

// ── reporting ───────────────────────────────────────────────────────────────────────────────────

/** A per-voucher batch outcome, as runJournaledBatch / executeVoucherBatch report it. */
export type SlotOutcome = { status: 'success' | 'error' | 'skipped'; code?: string; message?: string; masterId?: number; note?: string };

const voucherAmount = (v: ImportVoucher) => Math.round(v.entries.filter(e => e.drCr === 'dr').reduce((s, e) => s + e.amount, 0) * 100) / 100;

/** Errors by source row number, plus the totals a person checks before saying "post it". */
export function summarizeImport(slots: ImportSlot[], outcomes: SlotOutcome[], opts: { sampleSize?: number; dryRun: boolean }) {
  const errors: ImportRowError[] = [];
  const byVoucherType: Record<string, { count: number; amount: number }> = {};
  let ok = 0, skipped = 0, failed = 0, alreadyPosted = 0;
  slots.forEach((s, i) => {
    const o = outcomes[i];
    if (s.error) { errors.push(s.error); failed++; return; }
    if (!o) return;
    if (o.status === 'error') {
      failed++;
      errors.push({ rows: s.sourceRows, code: o.code ?? 'UNKNOWN', message: `Row${s.sourceRows.length > 1 ? 's' : ''} ${s.sourceRows.join(', ')}: ${o.message ?? 'failed'}` });
      return;
    }
    if (o.status === 'skipped') {
      if (/Already posted by batch/.test(o.note ?? '')) alreadyPosted++; else skipped++;
      return;
    }
    ok++;
    const v = s.voucher!;
    const t = (byVoucherType[v.voucherType] ??= { count: 0, amount: 0 });
    t.count++;
    t.amount = Math.round((t.amount + voucherAmount(v)) * 100) / 100;
  });
  const n = opts.sampleSize ?? 5;
  const sample = slots
    .map((s, i) => ({ s, o: outcomes[i] }))
    .filter(x => x.s.voucher && x.o?.status === 'success')
    .slice(0, n)
    .map(x => ({ sourceRows: x.s.sourceRows, voucher: x.s.voucher }));
  return {
    [opts.dryRun ? 'wouldPost' : 'posted']: ok,
    [opts.dryRun ? 'wouldSkip' : 'skipped']: skipped,
    ...(alreadyPosted ? { alreadyPosted } : {}),
    invalid: failed,
    byVoucherType,
    ...(opts.dryRun ? { sample } : {}),
    errors,
  };
}

// ── guide text (to be inserted into the feeding guide; see the report on #32) ───────────────────

export const IMPORT_VOUCHERS_GUIDE = `### Files of vouchers: \`import-vouchers\`, resume and undo

When the user gives you a CSV or Excel FILE of transactions (a bank statement, a sales register, an
export from another system), do NOT read it and re-type the rows into \`create-vouchers\`. Use
\`import-vouchers\`: the server reads the file itself, so nothing is mistyped or skipped and it costs a
fraction of the tokens.

1. Look at the header row (ask the user, or open the file) and build the mapping: which column is the
   date, the amount, the reference, and which ledgers are debited and credited. One row per voucher is
   shape A (debitLedger / creditLedger columns, or a constant such as creditLedgerConstant: "Sales");
   several rows per voucher is shape B (groupBy + ledger + amount, with side or debit/credit columns).
2. Run it with \`dryRun\` (the default). Show the user the totals per voucher type, the sample vouchers and
   every error by its spreadsheet row number. Fix the mapping, or ask the user to fix the rows.
3. Only when they agree, run it again with \`dryRun\`: false. It posts in chunks of 50 and returns a \`batchId\`.

Every real batch (\`create-vouchers\` and \`import-vouchers\`) returns a \`batchId\`. If a batch stops part-way
(Tally popup, some rows failed), call it again with the SAME rows and \`resumeBatchId\`: rows already posted
are not sent twice. If the call timed out and you never got a \`batchId\`, send the SAME rows again WITHOUT
changing them: the server recognises them, posts nothing, and tells you the \`batchId\` to resume. A resume
while the earlier call is still posting comes back \`BUSY\`: wait, then resume again.

A row reported \`OUTCOME_UNKNOWN\` was sent but Tally's answer never arrived, so it may be in the books.
With a reference it is re-sent safely on resume. Without one it is not re-sent: ask the user to check the
Day Book for it, and only if it is NOT there resume with that row in \`resendUnknownRows\`.

To take back a whole batch, call \`undo-batch\` with its \`batchId\`: it previews the exact vouchers it would
delete, refuses any that were edited in Tally since, and deletes only after the user confirms (\`dryRun\`:
false, confirm: true). A voucher that was already in Tally before the batch (Tally altered it because the
row carried the same reference) is listed under \`existedBefore\` and is not deleted unless the user
confirms it by master id (\`confirmMasterIds\`).

A voucherNumber on a manually numbered voucher type that is already used is refused with
\`DUPLICATE_NUMBER\`. Do not retry with \`allowDuplicateNumber\` unless the user confirms the repeat is intended.`;
