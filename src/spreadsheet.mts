// Minimal CSV and XLSX readers for import-vouchers (#32).
//
// NO NEW DEPENDENCIES, by policy: every package added to a server that writes into someone's books is
// one more supply-chain path into it. Both formats are small enough to read correctly by hand:
//
//   - CSV per RFC 4180 (quoted fields, "" escapes, CRLF/LF/CR, newlines inside quotes), plus what real
//     exports add: a UTF-8 or UTF-16 BOM, Windows-1252 text from older Excel, and a delimiter that is a
//     comma, a semicolon (European Excel) or a tab ("Unicode text" exports).
//   - XLSX: a zip archive of XML parts. The zip central directory is read directly and entries are
//     inflated with node:zlib (stored and deflate only; ZIP64 and encryption are refused — a sheet of
//     vouchers never needs either). Then workbook.xml + its rels map sheet names to parts,
//     sharedStrings.xml supplies the strings, and the sheet XML supplies cells. Parsing is a forward-only
//     indexOf scan over these well-defined, machine-written parts; no DTD or entity expansion exists to
//     be abused, because nothing here resolves entities beyond the five XML ones and numeric references.
//
// The file is untrusted input parsed on the server's only thread, and a V8 out-of-memory is a process
// abort no try/catch sees, so every dimension is bounded before it is allocated (see the limits below):
// total inflated bytes, column letters and row numbers (Excel's own XFD / 1,048,576), rows and cells
// parsed, and no element scan ever rescans the rest of the document.
//
// Cell values come back as the spreadsheet holds them: strings, numbers (dates are numbers in XLSX —
// the caller converts the columns it knows are dates), booleans, or null for an empty cell.

import zlib from 'node:zlib';

export type Cell = string | number | boolean | null;
export type SheetRow = { rowNumber: number; cells: Cell[] };
export type Table = { format: 'csv' | 'xlsx'; sheet?: string; sheetNames?: string[]; rows: SheetRow[]; delimiter?: string; date1904?: boolean };

export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
// Ceiling on inflated XML across the WHOLE workbook (workbook, rels, shared strings and the sheet
// together; per-entry caps let several bombs add up). The 50,000 rows the importer accepts are tens of MB
// of sheet XML; anything beyond this is a zip bomb, not a voucher list.
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
// Excel's own grid: columns A..XFD, rows 1..1,048,576. A reference outside it is not a real workbook, and
// an unbounded column letter used to become an array index ("ZZZZZZ1" -> a 2e8-slot array -> fatal OOM).
export const MAX_COLUMN_INDEX = 16383;
export const MAX_ROW_NUMBER = 1_048_576;
// Rows and cells materialised from one sheet. import-vouchers accepts 50,000 data rows; the margin is for
// blank and formatted rows. The cell budget counts each row's width (gaps included), so rows that each
// reach far-right columns cannot multiply memory past it.
export const MAX_SHEET_ROWS = 100_000;
export const MAX_SHEET_CELLS = 5_000_000;

export class SpreadsheetError extends Error {
  constructor(message: string) { super(message); this.name = 'SpreadsheetError'; }
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────

/** Text from file bytes: UTF-8 (BOM optional) or UTF-16 by BOM; invalid UTF-8 is read as Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Excel's "CSV (Comma delimited)" writes the ANSI code page. latin1 is its superset for the
    // characters that matter in ledger names; the rare 0x80-0x9F punctuation is cosmetic.
    return new TextDecoder('windows-1252').decode(body);
  }
}

/** Comma, semicolon or tab: whichever occurs most often outside quotes in the first record. */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  if (counts['\t']! > counts[',']! && counts['\t']! >= counts[';']!) return '\t';
  if (counts[';']! > counts[',']!) return ';';
  return ',';
}

/**
 * RFC 4180 parser. Rows are numbered as a spreadsheet would show them: one per RECORD (a quoted field
 * spanning lines is still one row), starting at 1. A leading BOM is ignored.
 */
export function parseCsv(input: string, delimiter?: string): { rows: SheetRow[]; delimiter: string } {
  const text = input.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(text);
  const rows: SheetRow[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;
  let rowNumber = 1;
  const endField = () => { record.push(field); field = ''; fieldStarted = false; };
  const endRecord = () => { endField(); rows.push({ rowNumber: rowNumber++, cells: record }); record = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; continue; }
    if (ch === d) { endField(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      continue;
    }
    // A quote in the middle of an unquoted field is kept literally (lenient, as Excel reads it).
    field += ch;
    fieldStarted = true;
  }
  if (inQuotes) throw new SpreadsheetError(`Unterminated quoted field starting in row ${rowNumber}.`);
  // The final record, unless the file ended with a newline.
  if (field.length || record.length || fieldStarted) endRecord();
  const cells = rows.map(r => ({ rowNumber: r.rowNumber, cells: r.cells.map(c => (c === '' ? null : c)) as Cell[] }));
  return { rows: cells, delimiter: d };
}

// ── ZIP ─────────────────────────────────────────────────────────────────────────────────────────

type ZipEntry = { name: string; method: number; flags: number; compressedSize: number; size: number; localOffset: number };

function readCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const EOCD = 0x06054b50;
  const minEocd = 22;
  if (buf.length < minEocd) throw new SpreadsheetError('Not a valid .xlsx file (too small to be a zip archive).');
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new SpreadsheetError('Not a valid .xlsx file (no zip directory found). If it is an old .xls workbook, save it as .xlsx or .csv.');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new SpreadsheetError('ZIP64 workbooks are not supported; save a smaller file or a .csv.');
  if (cdOffset + cdSize > buf.length) throw new SpreadsheetError('The .xlsx file is truncated or damaged.');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError('The .xlsx file is damaged (bad zip directory entry).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new SpreadsheetError('ZIP64 workbooks are not supported.');
    entries.set(name.replace(/\\/g, '/'), { name, method, flags, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** What is left of the workbook's inflate budget; every entry read draws on the same one. */
type InflateBudget = { left: number; total: number };

const tooLarge = (name: string, budget: InflateBudget) => new SpreadsheetError(`The workbook expands to more than ${Math.round(budget.total / (1024 * 1024))} MB of XML (at ${name}); that is not a voucher list. Save the sheet as .csv, or split it.`);

function readEntry(buf: Buffer, e: ZipEntry, budget: InflateBudget): Buffer {
  if (e.flags & 0x1) throw new SpreadsheetError('Password-protected workbooks cannot be read. Remove the password in Excel and try again.');
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new SpreadsheetError(`The .xlsx file is damaged (bad local header for ${e.name}).`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new SpreadsheetError(`The .xlsx file is truncated (${e.name}).`);
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) {
    if (raw.length > budget.left) throw tooLarge(e.name, budget);
    out = Buffer.from(raw);
  } else if (e.method === 8) {
    if (budget.left <= 0) throw tooLarge(e.name, budget);
    try {
      // The REMAINING budget, not a fixed per-entry cap: zlib stops inflating the moment it is passed.
      out = zlib.inflateRawSync(raw, { maxOutputLength: budget.left });
    } catch (err: any) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(e.name, budget);
      throw new SpreadsheetError(`Could not decompress ${e.name} (damaged).`);
    }
  } else {
    throw new SpreadsheetError(`Unsupported zip compression method ${e.method} in ${e.name}.`);
  }
  budget.left -= out.length;
  return out;
}

// ── XLSX ────────────────────────────────────────────────────────────────────────────────────────

export function decodeXmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // OOXML's own escape for characters XML cannot carry (e.g. _x000D_ for a carriage return).
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? decodeXmlText(m[1] ?? '') : undefined;
};

// ── a linear element scanner ──
//
// Every element read here (<row>, <c>, <v>, <is>, <si>, <t>, <rPh>) never nests inside another of the
// same name, so an element runs from its start tag to the FIRST matching close tag. A lazy regex such
// as <row\b...>([\s\S]*?)</row> gets that right on a well-formed part, but on an unclosed <row> it
// rescans to the end of the text for every start tag: O(n^2), minutes of a pinned event loop for a few
// MB of XML. The scan below only moves forward, and treats an element whose close tag is missing, or
// comes after the next start tag of the same name, as a damaged file.

type XmlElement = { attrs: string; body: string | null; start: number; end: number };

const isNameEnd = (ch: string | undefined) => ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/** Index of the next <tag start tag at or after `from` (not a longer name such as <rowBreaks), or -1. */
function findStartTag(xml: string, tag: string, from: number): number {
  const open = `<${tag}`;
  let i = xml.indexOf(open, from);
  while (i >= 0 && !isNameEnd(xml[i + open.length])) i = xml.indexOf(open, i + 1);
  return i;
}

function* xmlElements(xml: string, tag: string): Generator<XmlElement> {
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const start = findStartTag(xml, tag, pos);
    if (start < 0) return;
    const gt = xml.indexOf('>', start);
    if (gt < 0) throw new SpreadsheetError(`The .xlsx file is damaged (an unterminated <${tag}> tag).`);
    const selfClosing = xml[gt - 1] === '/';
    const attrs = xml.slice(start + tag.length + 1, selfClosing ? gt - 1 : gt);
    if (selfClosing) { yield { attrs, body: null, start, end: gt + 1 }; pos = gt + 1; continue; }
    const closeAt = xml.indexOf(close, gt + 1);
    // The next start tag is normally just past this element's close, so this search stays local.
    const next = findStartTag(xml, tag, gt + 1);
    if (closeAt < 0 || (next >= 0 && next < closeAt)) throw new SpreadsheetError(`The .xlsx file is damaged (a <${tag}> element is never closed).`);
    yield { attrs, body: xml.slice(gt + 1, closeAt), start, end: closeAt + close.length };
    pos = closeAt + close.length;
  }
}

function firstElement(xml: string, tag: string): XmlElement | undefined {
  for (const el of xmlElements(xml, tag)) return el;
  return undefined;
}

/** Text of every <t> in a fragment (rich-text runs concatenated), without phonetic <rPh> runs. */
function textRuns(fragment: string): string {
  let clean = '';
  let pos = 0;
  for (const ph of xmlElements(fragment, 'rPh')) { clean += fragment.slice(pos, ph.start); pos = ph.end; }
  clean += fragment.slice(pos);
  let out = '';
  for (const t of xmlElements(clean, 't')) out += decodeXmlText(t.body ?? '');
  return out;
}

export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xmlElements(xml, 'si')) out.push(textRuns(si.body ?? ''));
  return out;
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseSheetXml(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  let nextRow = 1;
  let cellBudget = MAX_SHEET_CELLS;
  for (const row of xmlElements(xml, 'row')) {
    const rAttr = attr(row.attrs, 'r');
    const rowNumber = rAttr !== undefined ? Number(rAttr) : nextRow;
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROW_NUMBER) {
      throw new SpreadsheetError(`The sheet has a row numbered "${rAttr ?? rowNumber}", outside Excel's rows 1-${MAX_ROW_NUMBER}. The file is damaged or was not written by a spreadsheet program.`);
    }
    nextRow = rowNumber + 1;
    if (rows.length >= MAX_SHEET_ROWS) {
      throw new SpreadsheetError(`The sheet has more than ${MAX_SHEET_ROWS} rows; an import takes at most 50,000 data rows. Split it into several files.`);
    }
    const cells: Cell[] = [];
    let nextCol = 0;
    for (const c of xmlElements(row.body ?? '', 'c')) {
      const body = c.body ?? '';
      const ref = attr(c.attrs, 'r');
      let col = nextCol;
      if (ref) {
        const letters = (/^[A-Za-z]+/.exec(ref) || ['A'])[0];
        // More than 3 letters is past XFD whatever they are; not converting them keeps the number small.
        col = letters.length > 3 ? Number.POSITIVE_INFINITY : columnIndex(letters);
      }
      if (!(col >= 0 && col <= MAX_COLUMN_INDEX)) {
        throw new SpreadsheetError(`Row ${rowNumber} has a cell at "${ref ?? `column ${col + 1}`}", beyond Excel's last column XFD. The file is damaged or was not written by a spreadsheet program.`);
      }
      nextCol = col + 1;
      const t = attr(c.attrs, 't') ?? 'n';
      const v = firstElement(body, 'v');
      const vText = v && v.body !== null ? decodeXmlText(v.body) : undefined;
      let value: Cell = null;
      if (t === 's') {
        const idx = vText !== undefined ? Number(vText) : NaN;
        value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx]! : null;
      } else if (t === 'inlineStr') {
        const is = firstElement(body, 'is');
        value = is ? textRuns(is.body ?? '') : null;
      } else if (t === 'b') {
        value = vText === undefined ? null : vText.trim() === '1' || vText.trim().toLowerCase() === 'true';
      } else if (t === 'str' || t === 'e' || t === 'd') {
        // A formula's cached string result, an error value (#N/A), or an ISO date string.
        value = vText ?? null;
      } else if (vText !== undefined && vText.trim() !== '') {
        const n = Number(vText);
        value = Number.isFinite(n) ? n : vText;
      }
      if (value === '') value = null;
      // An empty cell (often only a style, which spreadsheet programs may write far to the right) does not
      // widen the row: a row is as wide as its last value, so formatting alone cannot spend the budget.
      if (value !== null || col < cells.length) cells[col] = value;
    }
    // The row's width, gaps included, is what back-filling allocates: charge it before allocating.
    cellBudget -= cells.length;
    if (cellBudget < 0) {
      throw new SpreadsheetError(`The sheet has more than ${MAX_SHEET_CELLS} cells (counting the gaps up to each row's last value). A voucher list never needs that many; keep only the needed columns, or split the file.`);
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows.push({ rowNumber, cells });
  }
  return rows;
}

/** Workbook sheet names, in tab order, with the zip part each one lives in. */
function workbookSheets(entries: Map<string, ZipEntry>, buf: Buffer, budget: InflateBudget): { sheets: Array<{ name: string; part: string }>; date1904: boolean } {
  const wbEntry = entries.get('xl/workbook.xml');
  if (!wbEntry) throw new SpreadsheetError('Not an Excel workbook (xl/workbook.xml is missing).');
  const wb = readEntry(buf, wbEntry, budget).toString('utf8');
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relsEntry) {
    for (const m of readEntry(buf, relsEntry, budget).toString('utf8').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = attr(m[1] ?? '', 'Id');
      const target = attr(m[1] ?? '', 'Target');
      if (id && target) rels.set(id, target);
    }
  }
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/i.test(wb);
  const sheets: Array<{ name: string; part: string }> = [];
  let n = 0;
  for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    n++;
    const a = m[1] ?? '';
    const name = attr(a, 'name') ?? `Sheet${n}`;
    const rid = attr(a, 'r:id') ?? (/\s[\w]+:id\s*=\s*"([^"]*)"/.exec(a) || [])[1];
    let target = rid ? rels.get(rid) : undefined;
    if (!target) target = `worksheets/sheet${n}.xml`;
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    sheets.push({ name, part: part.replace(/\/[^/]+\/\.\.\//g, '/') });
  }
  return { sheets, date1904 };
}

/**
 * Reads one sheet of an .xlsx file: `sheet` by name (case-insensitive) or 1-based position, else the
 * first sheet.
 */
export function readXlsx(buf: Buffer, sheet?: string, limits: { maxInflatedBytes?: number } = {}): Table {
  if (buf.length > MAX_IMPORT_FILE_BYTES) throw new SpreadsheetError('The workbook is larger than 50 MB.');
  const entries = readCentralDirectory(buf);
  const total = limits.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  const budget: InflateBudget = { left: total, total };
  const { sheets, date1904 } = workbookSheets(entries, buf, budget);
  if (!sheets.length) throw new SpreadsheetError('The workbook has no sheets.');
  let chosen = sheets[0]!;
  if (sheet !== undefined && String(sheet).trim() !== '') {
    const want = String(sheet).trim().toLowerCase();
    const byName = sheets.find(s => s.name.trim().toLowerCase() === want);
    const byPos = /^\d+$/.test(want) ? sheets[Number(want) - 1] : undefined;
    const found = byName ?? byPos;
    if (!found) throw new SpreadsheetError(`No sheet named "${sheet}". The workbook has: ${sheets.map(s => `"${s.name}"`).join(', ')}.`);
    chosen = found;
  }
  const part = entries.get(chosen.part);
  if (!part) throw new SpreadsheetError(`Sheet "${chosen.name}" is missing from the workbook (${chosen.part}).`);
  const ssEntry = entries.get('xl/sharedStrings.xml');
  const shared = ssEntry ? parseSharedStrings(readEntry(buf, ssEntry, budget).toString('utf8')) : [];
  const rows = parseSheetXml(readEntry(buf, part, budget).toString('utf8'), shared);
  return { format: 'xlsx', sheet: chosen.name, sheetNames: sheets.map(s => s.name), rows, date1904 };
}

/** True when the bytes are a zip archive (an .xlsx), by magic number rather than file name. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** CSV or XLSX from file bytes, decided by content. */
export function readTable(buf: Buffer, opts: { sheet?: string; fileName?: string } = {}): Table {
  if (buf.length > MAX_IMPORT_FILE_BYTES) throw new SpreadsheetError('The file is larger than 50 MB.');
  if (looksLikeZip(buf)) return readXlsx(buf, opts.sheet);
  // An old binary .xls (OLE compound file) is neither: say so instead of parsing binary as CSV.
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) throw new SpreadsheetError('This is an old .xls workbook. Save it as .xlsx or .csv in Excel and try again.');
  const { rows, delimiter } = parseCsv(decodeText(buf));
  return { format: 'csv', rows, delimiter };
}
