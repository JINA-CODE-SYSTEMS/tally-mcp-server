import assert from 'node:assert/strict';
import test from 'node:test';
import { columnIndex, decodeText, detectDelimiter, MAX_COLUMN_INDEX, MAX_ROW_NUMBER, MAX_SHEET_CELLS, MAX_SHEET_ROWS, parseCsv, parseSharedStrings, parseSheetXml, readTable, readXlsx, SpreadsheetError } from './spreadsheet.mjs';
import { buildXlsx, buildZip } from './testkit-zip.mjs';

// ── CSV (RFC 4180 and what real exports add) ──

test('CSV: quoted fields, escaped quotes, embedded delimiters and newlines, CRLF', () => {
  const csv = 'Date,Party,Narration,Amount\r\n03-07-2026,"Acme, Ltd","He said ""paid""",100\r\n04-07-2026,Beta,"two\r\nlines",200\r\n';
  const { rows, delimiter } = parseCsv(csv);
  assert.equal(delimiter, ',');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1]!.cells, ['03-07-2026', 'Acme, Ltd', 'He said "paid"', '100']);
  assert.deepEqual(rows[2]!.cells, ['04-07-2026', 'Beta', 'two\r\nlines', '200']);
  // A record spanning two lines is still ONE spreadsheet row.
  assert.deepEqual(rows.map(r => r.rowNumber), [1, 2, 3]);
});

test('CSV: BOM, no trailing newline, empty fields become null, LF and lone CR line ends', () => {
  const { rows } = parseCsv('﻿a,b,c\n1,,3\r4,"",6');
  assert.deepEqual(rows.map(r => r.cells), [['a', 'b', 'c'], ['1', null, '3'], ['4', null, '6']]);
});

test('CSV: delimiter auto-detection (comma, semicolon, tab), ignoring delimiters inside quotes', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('"x;y;z",b,c'), ',');
  assert.deepEqual(parseCsv('Date;Amount\n03.07.2026;1.234,50').rows[1]!.cells, ['03.07.2026', '1.234,50']);
});

test('CSV: an unterminated quote is an error, not silently swallowed rows', () => {
  assert.throws(() => parseCsv('a,b\n"open,1\n2,3'), SpreadsheetError);
});

test('text decoding: UTF-8 with BOM, UTF-16LE (Excel "Unicode text"), Windows-1252 fallback', () => {
  assert.equal(decodeText(Buffer.from('﻿Café ₹', 'utf8')), 'Café ₹');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\tb', 'utf16le')])), 'a\tb');
  assert.equal(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9])), 'Café');
});

// ── XLSX ──

test('column letters map to zero-based indexes', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex('BC'), 54);
});

for (const store of [false, true]) {
  test(`XLSX (${store ? 'stored' : 'deflated'} entries): shared, rich, inline, formula, boolean, number and sparse cells`, () => {
    const buf = buildXlsx([{ name: 'Receipts', rows: [
      ['Date', 'Party', 'Amount', 'Flag', 'Note'],
      [46206, { rich: ['Acme ', '& Sons'] }, 1500.5, true, { inline: 'inline <text>' }],
      [46207, 'Beta', null, false, { formulaString: 'computed' }],
    ] }], { store });
    const t = readXlsx(buf);
    assert.equal(t.format, 'xlsx');
    assert.equal(t.sheet, 'Receipts');
    assert.deepEqual(t.rows[0]!.cells, ['Date', 'Party', 'Amount', 'Flag', 'Note']);
    assert.deepEqual(t.rows[1]!.cells, [46206, 'Acme & Sons', 1500.5, true, 'inline <text>']);
    assert.deepEqual(t.rows[2]!.cells, [46207, 'Beta', null, false, 'computed']);
    assert.deepEqual(t.rows.map(r => r.rowNumber), [1, 2, 3]);
  });
}

test('XLSX: sheet by name (case-insensitive) or position, and a clear error naming the sheets', () => {
  const buf = buildXlsx([{ name: 'Summary', rows: [['x']] }, { name: 'Bank Feb', rows: [['y']] }]);
  assert.equal(readXlsx(buf).sheet, 'Summary');
  assert.equal(readXlsx(buf, 'bank feb').rows[0]!.cells[0], 'y');
  assert.equal(readXlsx(buf, '2').sheet, 'Bank Feb');
  assert.throws(() => readXlsx(buf, 'March'), /"Summary", "Bank Feb"/);
});

test('XLSX: the 1904 date system flag is read', () => {
  assert.equal(readXlsx(buildXlsx([{ name: 'S', rows: [['x']] }], { date1904: true })).date1904, true);
  assert.equal(readXlsx(buildXlsx([{ name: 'S', rows: [['x']] }])).date1904, false);
});

test('readTable decides by content: zip → xlsx, old .xls refused, anything else CSV', () => {
  assert.equal(readTable(buildXlsx([{ name: 'S', rows: [['x']] }])).format, 'xlsx');
  assert.equal(readTable(Buffer.from('a,b\n1,2')).format, 'csv');
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => readTable(ole), /old \.xls workbook/);
});

test('XLSX: damaged, encrypted or non-workbook zips are refused with a reason', () => {
  assert.throws(() => readXlsx(Buffer.from('PK\x03\x04 not really a zip at all, no directory')), SpreadsheetError);
  assert.throws(() => readXlsx(buildZip([{ name: 'readme.txt', data: 'hi' }])), /workbook\.xml is missing/);
  const enc = buildXlsx([{ name: 'S', rows: [['x']] }]);
  // Set the "encrypted" flag on every central-directory entry.
  for (let i = 0; i < enc.length - 4; i++) if (enc.readUInt32LE(i) === 0x02014b50) enc.writeUInt16LE(enc.readUInt16LE(i + 8) | 1, i + 8);
  for (let i = 0; i < enc.length - 4; i++) if (enc.readUInt32LE(i) === 0x04034b50) enc.writeUInt16LE(enc.readUInt16LE(i + 6) | 1, i + 6);
  assert.throws(() => readXlsx(enc), /Password-protected/);
});

// ── hostile or damaged sheets: refused with a SpreadsheetError, never a crash or a hang (review of #44) ──

const sheetDoc = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;

test('XLSX: a cell reference past XFD is refused before anything is allocated (was a fatal heap OOM)', () => {
  // r="ZZZZZZ1" used to become array index ~2e8 and abort the whole server process.
  assert.throws(() => parseSheetXml(sheetDoc('<row r="1"><c r="ZZZZZZ1"><v>1</v></c></row>'), []), /beyond Excel's last column XFD/);
  assert.throws(() => parseSheetXml(sheetDoc('<row r="1"><c r="XFE1"><v>1</v></c></row>'), []), SpreadsheetError);
  // XFD itself is Excel's last column and still reads.
  const ok = parseSheetXml(sheetDoc('<row r="1"><c r="XFD1"><v>7</v></c></row>'), []);
  assert.equal(ok[0]!.cells.length, MAX_COLUMN_INDEX + 1);
  assert.equal(ok[0]!.cells[MAX_COLUMN_INDEX], 7);
  // The same bound applies to the implicit column counter of cells without r.
  assert.throws(() => parseSheetXml(sheetDoc('<row r="1"><c r="XFD1"><v>1</v></c><c><v>2</v></c></row>'), []), SpreadsheetError);
});

test('XLSX: row numbers outside 1..1,048,576 are refused', () => {
  for (const r of ['0', '1048577', 'abc', '2.5', '-3']) {
    assert.throws(() => parseSheetXml(sheetDoc(`<row r="${r}"><c r="A1"><v>1</v></c></row>`), []), /outside Excel's rows/, r);
  }
  assert.equal(parseSheetXml(sheetDoc(`<row r="${MAX_ROW_NUMBER}"><c><v>1</v></c></row>`), [])[0]!.rowNumber, MAX_ROW_NUMBER);
});

test('XLSX: an empty styled cell far to the right does not widen the row', () => {
  const rows = parseSheetXml(sheetDoc('<row r="1"><c r="A1"><v>1</v></c><c r="XFD1" s="3"/></row><row r="2"><c r="A2"><v>2</v></c><c r="C2" s="1"/><c r="D2"><v>4</v></c></row>'), []);
  assert.deepEqual(rows[0]!.cells, [1]);
  assert.deepEqual(rows[1]!.cells, [2, null, null, 4]);
});

test('XLSX: rows and cells parsed are capped, so rows reaching XFD cannot exhaust memory', () => {
  // ~306 rows each 16,384 wide pass the 5M cell budget: refused part-way, never materialised in full.
  const wide = Array.from({ length: Math.ceil(MAX_SHEET_CELLS / (MAX_COLUMN_INDEX + 1)) + 1 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join('');
  assert.throws(() => parseSheetXml(sheetDoc(wide), []), new RegExp(`more than ${MAX_SHEET_CELLS} cells`));
  const many = '<row><c><v>1</v></c></row>'.repeat(MAX_SHEET_ROWS + 1);
  assert.throws(() => parseSheetXml(sheetDoc(many), []), new RegExp(`more than ${MAX_SHEET_ROWS} rows`));
});

test('XLSX: unclosed elements are a damaged file, found in linear time (the lazy regex was quadratic)', () => {
  const t0 = Date.now();
  assert.throws(() => parseSheetXml(sheetDoc('<row r="1">'.repeat(200_000)), []), /never closed/);
  assert.throws(() => parseSheetXml(sheetDoc('<row r="1">'.repeat(200_000) + '</row>'), []), /never closed/);
  assert.throws(() => parseSheetXml(sheetDoc(`<row r="1">${'<c r="A1"><v>1</v>'.repeat(100_000)}</c></row>`), []), /never closed/);
  assert.throws(() => parseSharedStrings(`<sst>${'<si><t>x'.repeat(100_000)}</si></sst>`), /never closed/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  // A longer element name that merely starts with the same letters is not mistaken for one.
  assert.deepEqual(parseSheetXml(sheetDoc('<row r="1"><c r="A1"><v>5</v></c></row><rowBreaks count="1"/>'), []).map(r => r.cells), [[5]]);
});

test('XLSX: the inflate budget covers the whole workbook, not each entry', () => {
  // Two parts of ~600 KB each (shared strings and the sheet): either alone fits a 1 MB budget, together not.
  const big = 'x'.repeat(600 * 1024);
  for (const store of [false, true]) {
    const buf = buildXlsx([{ name: 'S', rows: [[big], [{ inline: big }]] }], { store });
    assert.equal(readXlsx(buf, undefined, { maxInflatedBytes: 4 * 1024 * 1024 }).rows.length, 2);
    assert.throws(() => readXlsx(buf, undefined, { maxInflatedBytes: 1024 * 1024 }), /expands to more than 1 MB/);
  }
});
