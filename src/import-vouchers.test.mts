import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isPathWithinRoots, registerMcpServer } from './mcp.mjs';
import {
  allowedImportRoots, checkImportPath, convertRows, excelSerialToIso, parseAmountCell, parseDateCell, parseSideCell,
  type ImportMapping,
} from './import-vouchers.mjs';
import { parseCsv, readXlsx, type Table } from './spreadsheet.mjs';
import { buildXlsx } from './testkit-zip.mjs';
import { importOk, importRejected, isImport, startFakeTally, voucherBlockOf } from './testkit-fake-tally.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
process.env.TALLY_DATA_PATH = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const csvTable = (text: string): Table => ({ format: 'csv', rows: parseCsv(text).rows });

// ── cell conversions ──

test('Excel serial dates, including the 1900 leap-year bug and the 1904 system', () => {
  assert.equal(excelSerialToIso(1), '1900-01-01');
  assert.equal(excelSerialToIso(59), '1900-02-28');
  assert.equal(excelSerialToIso(60), null, '29 Feb 1900 never existed');
  assert.equal(excelSerialToIso(61), '1900-03-01');
  assert.equal(excelSerialToIso(44197), '2021-01-01');
  assert.equal(excelSerialToIso(46206.75), '2026-07-03', 'the time part is dropped');
  assert.equal(excelSerialToIso(0, true), '1904-01-01');
  assert.equal(excelSerialToIso(44197 - 1462, true), '2021-01-01');
  assert.equal(excelSerialToIso(0), null);
});

test('date strings: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYYMMDD, 3-Jul-2026; impossible dates refused', () => {
  assert.equal(parseDateCell('03-07-2026'), '2026-07-03');
  assert.equal(parseDateCell('3/7/2026'), '2026-07-03');
  assert.equal(parseDateCell('03.07.2026'), '2026-07-03');
  assert.equal(parseDateCell('3/7/2026', { dateOrder: 'MDY' }), '2026-03-07');
  assert.equal(parseDateCell('2026-07-03'), '2026-07-03');
  assert.equal(parseDateCell('2026-07-03T00:00:00'), '2026-07-03');
  assert.equal(parseDateCell('20260703'), '2026-07-03');
  assert.equal(parseDateCell('3-Jul-2026'), '2026-07-03');
  assert.equal(parseDateCell('03 Sept 26'), '2026-09-03');
  assert.equal(parseDateCell(46206), '2026-07-03');
  assert.equal(parseDateCell('46206'), '2026-07-03');
  for (const bad of ['31-02-2026', '2026-13-01', 'yesterday', '', null, true]) assert.equal(parseDateCell(bad as any), null, String(bad));
});

test('amounts as accountants write them; thousands separators only where the decimal mark allows', () => {
  assert.deepEqual(parseAmountCell('1,23,456.50'), { value: 123456.5 });
  assert.deepEqual(parseAmountCell('₹ 1,000'), { value: 1000 });
  assert.deepEqual(parseAmountCell('Rs.250'), { value: 250 });
  assert.deepEqual(parseAmountCell('(500.00)'), { value: -500 });
  assert.deepEqual(parseAmountCell('-42'), { value: -42 });
  assert.deepEqual(parseAmountCell('1,000.00 Cr'), { value: 1000, side: 'cr' });
  assert.deepEqual(parseAmountCell('750Dr'), { value: 750, side: 'dr' });
  assert.deepEqual(parseAmountCell(99.5), { value: 99.5 });
  assert.deepEqual(parseAmountCell('1.234,50', ','), { value: 1234.5 });
  assert.equal(parseAmountCell('1,2345'), null);
  assert.equal(parseAmountCell('1.234,50'), null, 'a European amount is not silently misread with "." as the decimal mark');
  assert.equal(parseAmountCell('12abc'), null);
  assert.equal(parseSideCell('Debit'), 'dr');
  assert.equal(parseSideCell(' CR. '), 'cr');
  assert.equal(parseSideCell('x'), null);
});

test('a 2-digit final group is a decimal comma read with the wrong separator, never 100x the amount', () => {
  // European amounts below 1000 used to slip through the '.' branch: '234,50' → 23450.
  for (const bad of ['234,50', '450,00', '89,90', '12,50', '1,23', '1,234,56', '12,34,56']) {
    assert.equal(parseAmountCell(bad), null, bad);
  }
  // ...and the mirror case in the ',' branch: '1.50' → 150.
  for (const bad of ['1.50', '12.34', '1.234.56']) assert.equal(parseAmountCell(bad, ','), null, bad);
  // Western and Indian grouping both still parse; the last group is always 3 digits.
  assert.deepEqual(parseAmountCell('1,234,567.89'), { value: 1234567.89 });
  assert.deepEqual(parseAmountCell('12,34,56,789'), { value: 123456789 });
  assert.deepEqual(parseAmountCell('12,345'), { value: 12345 });
  assert.deepEqual(parseAmountCell('1,000'), { value: 1000 });
  assert.deepEqual(parseAmountCell('234.50'), { value: 234.5 });
  assert.deepEqual(parseAmountCell('234,50', ','), { value: 234.5 });
  assert.deepEqual(parseAmountCell('1.234.567,50', ','), { value: 1234567.5 });
});

// ── mapping ──

const shapeA: ImportMapping = { date: 'Date', reference: 'UTR', amount: 'Amount', narration: 'Narration', voucherTypeConstant: 'Receipt', debitLedgerConstant: 'HDFC Bank', creditLedger: 'Party' };

test('shape A: one row per voucher, constants for one side, errors carry spreadsheet row numbers', () => {
  const t = csvTable('Date,UTR,Party,Amount,Narration\n03-07-2026,U1,Acme,"1,500.00",first\n\n31-02-2026,U2,Beta,10,\n04-07-2026,U3,,abc,\n05-07-2026,U4,Gamma,0,');
  const c = convertRows(t, shapeA);
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal(c.totalRows, 4);
  assert.equal(c.blankRows, 1);
  assert.deepEqual(c.slots[0], { sourceRows: [2], voucher: {
    voucherType: 'Receipt', date: '2026-07-03', reference: 'U1', narration: 'first', skipIfExists: true,
    entries: [{ ledger: 'HDFC Bank', drCr: 'dr', amount: 1500 }, { ledger: 'Acme', drCr: 'cr', amount: 1500 }],
  } });
  assert.deepEqual(c.slots.slice(1).map(s => s.error?.rows), [[4], [5], [6]]);
  assert.match(c.slots[1]!.error!.message, /^Row 4: date "31-02-2026" is not a date/);
  assert.match(c.slots[2]!.error!.message, /amount "abc" is not a number; credit ledger is empty/);
  assert.match(c.slots[3]!.error!.message, /must be greater than 0/);
});

test('mapping mistakes fail the whole call with the real headers listed', () => {
  const t = csvTable('Txn Date,Amount\n03-07-2026,5');
  const c = convertRows(t, { ...shapeA, date: 'Date' });
  assert.equal(c.ok, false);
  assert.match((c as any).message, /date → "Date".*"Txn Date", "Amount"/);
  assert.match((convertRows(csvTable('Date,Amount\n1,2'), { date: 'Date', amount: 'Amount', debitLedgerConstant: 'A', creditLedgerConstant: 'B' }) as any).message, /voucherType/);
  assert.match((convertRows(csvTable('Date,Amount,L\n1,2,x'), { date: 'Date', voucherTypeConstant: 'Journal', ledger: 'L', amount: 'Amount' }) as any).message, /groupBy/);
  // Headers match case-insensitively and ignore extra spaces.
  assert.equal(convertRows(csvTable('DATE ,  utr,party,AMOUNT,narration\n03-07-2026,U1,A,1,'), shapeA).ok, true);
});

test('headerRow skips title rows above the header', () => {
  const c = convertRows(csvTable('HDFC statement\nJuly 2026\nDate,UTR,Party,Amount,Narration\n03-07-2026,U1,Acme,5,'), { ...shapeA, headerRow: 3 });
  assert.ok(c.ok && c.slots.length === 1 && c.slots[0]!.sourceRows[0] === 4);
});

test('shape B: rows grouped into vouchers by side, by Dr/Cr columns, or by sign', () => {
  const t = csvTable([
    'Voucher,Date,Type,Ledger,Side,Amount,Narration',
    'J1,03-07-2026,Journal,Rent,Dr,1000,July rent',
    'J2,04-07-2026,Journal,Cash,Dr,50,',
    'J1,,,TDS Payable,Cr,100,',
    'J1,03-07-2026,,HDFC Bank,Cr,900,',
    'J2,04-07-2026,Journal,Sales,Cr,50,',
  ].join('\n'));
  const c = convertRows(t, { groupBy: 'Voucher', date: 'Date', voucherType: 'Type', ledger: 'Ledger', side: 'Side', amount: 'Amount', narration: 'Narration' });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.equal(c.shape, 'B');
  assert.deepEqual(c.slots.map(s => s.sourceRows), [[2, 4, 5], [3, 6]]);
  assert.deepEqual(c.slots[0]!.voucher!.entries, [
    { ledger: 'Rent', drCr: 'dr', amount: 1000 }, { ledger: 'TDS Payable', drCr: 'cr', amount: 100 }, { ledger: 'HDFC Bank', drCr: 'cr', amount: 900 },
  ]);
  assert.equal(c.slots[0]!.voucher!.narration, 'July rent');

  const signed = convertRows(csvTable('Ref,Date,Ledger,Amt\nA,03-07-2026,Rent,100\nA,03-07-2026,Cash,-100'), { groupBy: 'Ref', date: 'Date', voucherTypeConstant: 'Payment', ledger: 'Ledger', amount: 'Amt' });
  assert.ok(signed.ok);
  if (signed.ok) assert.deepEqual(signed.slots[0]!.voucher!.entries.map(e => e.drCr), ['dr', 'cr']);

  const twoCols = convertRows(csvTable('Ref,Date,Ledger,Debit,Credit\nA,03-07-2026,Rent,100,\nA,03-07-2026,Cash,,100'), { groupBy: 'Ref', date: 'Date', voucherTypeConstant: 'Payment', ledger: 'Ledger', debitAmount: 'Debit', creditAmount: 'Credit' });
  assert.ok(twoCols.ok);
  if (twoCols.ok) assert.deepEqual(twoCols.slots[0]!.voucher!.entries, [{ ledger: 'Rent', drCr: 'dr', amount: 100 }, { ledger: 'Cash', drCr: 'cr', amount: 100 }]);
});

test('shape B: a group whose rows disagree on the date, or a row with no group key, is reported by row', () => {
  const t = csvTable('Ref,Date,Ledger,Side,Amount\nA,03-07-2026,Rent,Dr,100\nA,04-07-2026,Cash,Cr,100\n,03-07-2026,Cash,Cr,5\nB,03-07-2026,Cash,Sideways,5');
  const c = convertRows(t, { groupBy: 'Ref', date: 'Date', voucherTypeConstant: 'Payment', ledger: 'Ledger', side: 'Side', amount: 'Amount' });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.deepEqual(c.slots.map(s => s.error?.rows), [[2, 3], [4], [5]]);
  assert.match(c.slots[0]!.error!.message, /row 3: date "2026-07-04" differs from "2026-07-03" in row 2/);
  assert.match(c.slots[2]!.error!.message, /side "Sideways" is not Dr or Cr/);
});

test('XLSX rows convert the same way, with Excel serial dates in the date column', () => {
  const t = readXlsx(buildXlsx([{ name: 'Sheet1', rows: [['Date', 'UTR', 'Party', 'Amount', 'Narration'], [46206, 'U1', 'Acme', 1500, null]] }]));
  const c = convertRows(t, shapeA);
  assert.ok(c.ok && c.slots[0]!.voucher!.date === '2026-07-03' && c.slots[0]!.voucher!.entries[0]!.amount === 1500);
});

// ── where files may be read from ──

test('import roots: the data folder, the configured roots, and the user folders', () => {
  const roots = allowedImportRoots({ TALLY_DATA_PATH: '/data', TALLY_ALLOWED_IMPORT_ROOTS: '/share/a; /share/b,"/share/c"', OneDrive: '/od' }, '/home/u');
  for (const r of ['/data', '/share/a', '/share/b', '/share/c', path.join('/home/u', 'Downloads'), path.join('/od', 'Documents')]) assert.ok(roots.includes(r), r);
});

test('the import path must be absolute, inside a root, and a real file — symlinks are resolved first', () => {
  const root = fs.mkdtempSync(path.join(dataDir, 'root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  try {
    const inFile = path.join(root, 'ok.csv');
    fs.writeFileSync(inFile, 'a\n1');
    fs.writeFileSync(path.join(outside, 'secret.csv'), 'x');
    assert.equal(checkImportPath(inFile, [root], isPathWithinRoots).ok, true);
    assert.equal(checkImportPath('relative/ok.csv', [root], isPathWithinRoots).ok, false);
    assert.match((checkImportPath(path.join(outside, 'secret.csv'), [root], isPathWithinRoots) as any).message, /outside the folders/);
    assert.match((checkImportPath(path.join(root, '..', path.basename(outside), 'secret.csv'), [root], isPathWithinRoots) as any).message, /outside the folders/);
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(root, 'link.csv'));
    assert.match((checkImportPath(path.join(root, 'link.csv'), [root], isPathWithinRoots) as any).message, /outside the folders/, 'a link out of the root does not pass');
    assert.match((checkImportPath(path.join(root, 'missing.csv'), [root], isPathWithinRoots) as any).message, /not found/);
    assert.match((checkImportPath(root, [root], isPathWithinRoots) as any).message, /not a file/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

// ── end to end through the registered tool, against a fake Tally ──

async function connect() {
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'import-test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args }) as any;
    const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* error text */ }
    return { isError: res.isError === true, text, body };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

function statement(rows: number, broken: boolean): string {
  const lines = ['Date,UTR,Party,Amount,Narration'];
  for (let i = 1; i <= rows; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, '0');
    let date = `${day}-07-2026`;
    let amount = `"${(1000 + i).toLocaleString('en-IN')}.00"`;
    if (broken && i === 10) date = 'not a date';
    if (broken && i === 20) amount = 'abc';
    if (broken && i === 30) amount = '-5';
    lines.push(`${date},UTR${i},Party ${i},${amount},Receipt ${i}`);
  }
  return lines.join('\r\n') + '\r\n';
}

test('a 500-row CSV: preview with errors by row number, chunked post under one batchId, then resume', async () => {
  let rejectParty250 = true;
  const posted: string[] = [];
  let nextId = 5000;
  const tally = await startFakeTally(xml => {
    if (/MCPLoadedCompaniesList/.test(xml)) return '<ENVELOPE><COMPANY NAME="Acme Traders"/></ENVELOPE>';
    if (/ClaudallyVchTypeNumbering/.test(xml)) return '<ENVELOPE><VOUCHERTYPE NAME="Receipt"><NUMBERINGMETHOD>Automatic</NUMBERINGMETHOD></VOUCHERTYPE></ENVELOPE>';
    if (!isImport(xml)) return undefined;
    const block = voucherBlockOf(xml);
    if (rejectParty250 && /Party 250</.test(block)) return importRejected("Ledger 'Party 250' does not exist!");
    posted.push((/<REFERENCE>([^<]*)</.exec(block) || [])[1]!);
    return importOk(++nextId);
  });
  const { call, close } = await connect();
  const file = path.join(dataDir, 'hdfc-july.csv');
  const mapping = shapeA;
  try {
    fs.writeFileSync(file, statement(500, true));

    // 1. Preview: nothing posted, totals, sample, every error by spreadsheet row (header = row 1).
    const preview = await call('import-vouchers', { path: file, mapping });
    assert.equal(preview.isError, false, preview.text);
    const p = preview.body;
    assert.equal(p.dryRun, true);
    assert.equal(p.totalRows, 500);
    assert.equal(p.totalVouchers, 500);
    assert.equal(p.wouldPost, 497);
    assert.equal(p.invalid, 3);
    assert.deepEqual(p.errors.map((e: any) => e.rows), [[11], [21], [31]]);
    assert.match(p.errors[0].message, /^Row 11: date "not a date"/);
    assert.equal(p.byVoucherType.Receipt.count, 497);
    const expected = Array.from({ length: 500 }, (_, k) => k + 1).filter(i => ![10, 20, 30].includes(i)).reduce((s, i) => s + 1000 + i, 0);
    assert.equal(p.byVoucherType.Receipt.amount, expected);
    assert.equal(p.sample.length, 5);
    assert.deepEqual(p.sample[0], { sourceRows: [2], voucher: {
      voucherType: 'Receipt', date: '2026-07-01', reference: 'UTR1', narration: 'Receipt 1', skipIfExists: true,
      entries: [{ ledger: 'HDFC Bank', drCr: 'dr', amount: 1001 }, { ledger: 'Party 1', drCr: 'cr', amount: 1001 }],
    } });
    assert.ok(!preview.text.includes('<ENVELOPE>'), 'no XML in the preview');
    assert.equal(posted.length, 0);
    assert.equal(tally.requests.filter(isImport).length, 0);

    // 2. Post: chunks of 50 under one batch; Tally rejects one row, reported by its spreadsheet row.
    const run = await call('import-vouchers', { path: file, mapping, dryRun: false, chunkSize: 50 });
    assert.equal(run.isError, false, run.text);
    const r = run.body;
    assert.match(r.batchId, /^b-\d{8}-\d{6}-[a-z0-9]{6}$/);
    assert.equal(r.posted, 496);
    assert.equal(r.invalid, 4);
    assert.equal(posted.length, 496);
    assert.equal(r.chunks.length, 10);
    assert.deepEqual(r.chunks[0].sourceRows, [2, 54], 'the 50 vouchers of chunk 1 span rows 2-54: rows 11, 21, 31 never post');
    const tallyError = r.errors.find((e: any) => e.rows[0] === 251);
    assert.match(tallyError.message, /Party 250/);
    const journal = JSON.parse(fs.readFileSync(path.join(dataDir, '.tally-mcp-batches', `${r.batchId}.json`), 'utf-8'));
    assert.equal(journal.tool, 'import-vouchers');
    assert.equal(journal.rows.filter((x: any) => x.status === 'success').length, 496);
    assert.deepEqual(journal.rows[249].sourceRows, [251]);
    assert.equal(journal.rows[249].status, 'error');
    assert.equal(journal.source.path, fs.realpathSync(file));

    // 3. Fix the file and the ledger, resume: only the 4 missing vouchers are sent.
    fs.writeFileSync(file, statement(500, false));
    rejectParty250 = false;
    const before = posted.length;
    const resumed = await call('import-vouchers', { path: file, mapping, dryRun: false, resumeBatchId: r.batchId });
    assert.equal(resumed.isError, false, resumed.text);
    assert.equal(resumed.body.batchId, r.batchId);
    assert.equal(resumed.body.posted, 4);
    assert.equal(resumed.body.alreadyPosted, 496);
    assert.equal(resumed.body.invalid, 0);
    assert.deepEqual(posted.slice(before).sort(), ['UTR10', 'UTR20', 'UTR250', 'UTR30']);

    // 4. Changing a row that was already posted makes the resume refuse, posting nothing.
    fs.writeFileSync(file, statement(500, false).replace('UTR1,Party 1,', 'UTR1,Party One,'));
    const changed = await call('import-vouchers', { path: file, mapping, dryRun: false, resumeBatchId: r.batchId });
    assert.equal(changed.isError, true);
    assert.match(changed.text, /PRECONDITION_FAILED/);
    assert.equal(posted.length, before + 4);
  } finally {
    await close();
    await tally.close();
  }
});

test('XLSX shape B through the tool: grouped vouchers, serial dates, a manual number used twice in the file', async () => {
  const tally = await startFakeTally(xml => {
    if (/MCPLoadedCompaniesList/.test(xml)) return '<ENVELOPE><COMPANY NAME="Acme Traders"/></ENVELOPE>';
    if (/ClaudallyVchTypeNumbering/.test(xml)) return '<ENVELOPE><VOUCHERTYPE NAME="Journal"><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></ENVELOPE>';
    return undefined;
  });
  const { call, close } = await connect();
  const file = path.join(dataDir, 'journals.xlsx');
  try {
    fs.writeFileSync(file, buildXlsx([{ name: 'Notes', rows: [['ignore me']] }, { name: 'Journals', rows: [
      ['No', 'Date', 'Ledger', 'Dr', 'Cr'],
      ['JV-1', 46206, 'Rent', 1000, null],
      ['JV-1', 46206, 'HDFC Bank', null, 1000],
      ['JV-2', 46207, 'Rent', 200, null],
      ['JV-2', 46207, 'Cash', null, 200],
      ['jv-1 ', 46208, 'Rent', 5, null],
      ['jv-1 ', 46208, 'Cash', null, 5],
    ] }]));
    const res = await call('import-vouchers', {
      path: file, sheet: 'journals',
      mapping: { groupBy: 'No', voucherNumber: 'No', date: 'Date', voucherTypeConstant: 'Journal', ledger: 'Ledger', debitAmount: 'Dr', creditAmount: 'Cr' },
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.body.sheet, 'Journals');
    assert.equal(res.body.totalVouchers, 3);
    assert.equal(res.body.wouldPost, 2);
    assert.deepEqual(res.body.sample.map((s: any) => [s.voucher.voucherNumber, s.voucher.date, s.sourceRows]), [['JV-1', '2026-07-03', [2, 3]], ['JV-2', '2026-07-04', [4, 5]]]);
    assert.equal(res.body.errors.length, 1);
    assert.equal(res.body.errors[0].code, 'DUPLICATE_NUMBER');
    assert.deepEqual(res.body.errors[0].rows, [6, 7]);
    assert.match(res.body.errors[0].message, /also used by row\(s\) 2, 3/);
  } finally {
    await close();
    await tally.close();
  }
});

test('the tool refuses a file outside the allowed folders, and posting in READONLY_MODE', async () => {
  const { call, close } = await connect();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-allowed-'));
  const saved = process.env.READONLY_MODE;
  try {
    const f = path.join(outside, 'x.csv');
    fs.writeFileSync(f, 'Date,UTR,Party,Amount,Narration\n03-07-2026,U,P,1,');
    const r = await call('import-vouchers', { path: f, mapping: shapeA });
    assert.equal(r.isError, true);
    assert.match(r.text, /PRECONDITION_FAILED[\s\S]*outside the folders/);
    process.env.READONLY_MODE = 'true';
    const ro = await call('import-vouchers', { path: path.join(dataDir, 'any.csv'), mapping: shapeA, dryRun: false });
    assert.match(ro.text, /"code":\s*"READONLY"/);
  } finally {
    if (saved === undefined) delete process.env.READONLY_MODE; else process.env.READONLY_MODE = saved;
    fs.rmSync(outside, { recursive: true, force: true });
    await close();
  }
});
