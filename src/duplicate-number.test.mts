import assert from 'node:assert/strict';
import test from 'node:test';
import { executeVoucher, executeVoucherBatch } from './mcp.mjs';
import {
  buildVoucherTypeNumberingXml, clearNumberingCache, financialYearOf, findDuplicateNumbersInBatch, isManualNumbering,
  makeDuplicateNumberChecker, makeNumberingResolver, parseVoucherTypeNumbering,
} from './voucher-numbering.mjs';

// Duplicate MANUAL voucher numbers (#28). The numbering method and the "already used" lookup are injected,
// so every path here runs without Tally (dryRun, or a refusal that returns before the write).

const v = (over: object = {}) => ({
  voucherType: 'Sales', date: '2026-07-03', voucherNumber: 'INV-104',
  entries: [{ ledger: 'Debtor', drCr: 'dr' as const, amount: 100 }, { ledger: 'Sales', drCr: 'cr' as const, amount: 100 }],
  ...over,
});
const manual = async () => 'Manual';
const automatic = async () => 'Automatic';
const taken = async () => [{ master_id: '77', voucher_number: 'INV-104', date: '2026-06-30', amount: 5000 }];
const free = async () => [];
const codeOf = (r: any) => (r.isError ? r.structuredContent?.code : undefined);

test('numbering methods: Manual and Automatic (Manual Override) count as manual, the rest do not', () => {
  assert.equal(isManualNumbering('Manual'), true);
  assert.equal(isManualNumbering(' automatic  (manual override) '), true);
  for (const m of ['Automatic', 'Multi-user Auto', 'None', '', null, undefined]) assert.equal(isManualNumbering(m as any), false, String(m));
});

test('the numbering collection is parsed by the NAME attribute, entities decoded', () => {
  const xml = `<ENVELOPE><VOUCHERTYPE NAME="Sales" RESERVEDNAME="Sales"><LANGUAGENAME.LIST><NAME.LIST><NAME>Sales</NAME><NAME>Inv</NAME></NAME.LIST></LANGUAGENAME.LIST><NUMBERINGMETHOD TYPE="String">Manual</NUMBERINGMETHOD></VOUCHERTYPE>` +
    `<VOUCHERTYPE NAME="R &amp; D Journal"><NUMBERINGMETHOD>Automatic (Manual Override)</NUMBERINGMETHOD></VOUCHERTYPE>` +
    `<VOUCHERTYPE NAME="Payment"><NUMBERINGMETHOD>Automatic</NUMBERINGMETHOD></VOUCHERTYPE><VOUCHERTYPE NAME="Empty"/></ENVELOPE>`;
  const m = parseVoucherTypeNumbering(xml);
  assert.equal(m.get('Sales'), 'Manual');
  assert.equal(m.get('R & D Journal'), 'Automatic (Manual Override)');
  assert.equal(m.get('Payment'), 'Automatic');
  assert.equal(m.has('Empty'), false);
  assert.match(buildVoucherTypeNumberingXml('A & B'), /<SVCURRENTCOMPANY>A &amp; B<\/SVCURRENTCOMPANY>/);
  assert.match(buildVoucherTypeNumberingXml(), /<NATIVEMETHOD>NumberingMethod<\/NATIVEMETHOD>/);
});

test('the resolver caches per company, matches types case-insensitively, and does not cache a failed read', async () => {
  clearNumberingCache();
  let calls = 0;
  const post = async () => { calls++; return '<VOUCHERTYPE NAME="Sales"><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE>'; };
  const r = makeNumberingResolver('Co A', post);
  assert.equal(await r('sales'), 'Manual');
  assert.equal(await r('Payment'), null);
  assert.equal(await makeNumberingResolver('Co A', post)('Sales'), 'Manual');
  assert.equal(calls, 1, 'one read per company per process');
  let failing = 0;
  const bad = makeNumberingResolver('Co B', async () => { failing++; throw new Error('down'); });
  assert.equal(await bad('Sales'), null);
  assert.equal(await bad('Sales'), null);
  assert.equal(failing, 2, 'failures are retried, not cached');
  clearNumberingCache();
});

test('the "already used" lookup is scoped to the voucher financial year', async () => {
  assert.deepEqual(financialYearOf('2026-07-03'), ['2026-04-01', '2027-03-31']);
  assert.deepEqual(financialYearOf('2027-02-10', '2019-04-01'), ['2026-04-01', '2027-03-31']);
  assert.deepEqual(financialYearOf('2026-03-31'), ['2025-04-01', '2026-03-31']);
  assert.deepEqual(financialYearOf('2026-07-03', '2020-01-01'), ['2026-01-01', '2026-12-31']);
  let seen: string[] = [];
  const check = makeDuplicateNumberChecker(async (t, n, from, to) => { seen = [t, n, from, to]; return { rows: [{ voucher_number: 'inv-104 ' }, { voucher_number: 'INV-1040' }] }; });
  const hits = await check('Sales', 'INV-104', '2026-07-03');
  assert.deepEqual(seen, ['Sales', 'INV-104', '2026-04-01', '2027-03-31']);
  assert.equal(hits?.length, 1, 'exact number only, trimmed and case-insensitive');
  assert.equal(await makeDuplicateNumberChecker(async () => ({ error: 'x' }))('Sales', '1', '2026-07-03'), null);
});

test('manual type + number already in Tally → DUPLICATE_NUMBER listing the existing voucher (dryRun too)', async () => {
  for (const dryRun of [false, true]) {
    const r = await executeVoucher(v(), { dryRun, numberingFor: manual, checkDuplicateNumber: taken });
    assert.equal(codeOf(r), 'DUPLICATE_NUMBER');
    const msg = (r as any).structuredContent.message as string;
    assert.match(msg, /INV-104/);
    assert.match(msg, /master_id 77/);
    assert.match(msg, /2026-06-30/);
    assert.match(msg, /amount 5000/);
  }
});

test('allowDuplicateNumber bypasses the refusal', async () => {
  const r = await executeVoucher(v({ allowDuplicateNumber: true }), { dryRun: true, numberingFor: manual, checkDuplicateNumber: taken });
  assert.equal(JSON.parse(r.content[0]!.text).wouldPost, true);
});

test('automatic numbering is unaffected, and so is a voucher with no number', async () => {
  let looked = 0;
  const spy = async () => { looked++; return [{ master_id: '1', voucher_number: 'INV-104' }]; };
  const a = await executeVoucher(v(), { dryRun: true, numberingFor: automatic, checkDuplicateNumber: spy });
  assert.equal(JSON.parse(a.content[0]!.text).wouldPost, true);
  const b = await executeVoucher(v({ voucherNumber: undefined }), { dryRun: true, numberingFor: manual, checkDuplicateNumber: spy });
  assert.equal(JSON.parse(b.content[0]!.text).wouldPost, true);
  assert.equal(looked, 0, 'no lookup when it cannot matter');
});

test('read failures never block the write', async () => {
  const a = await executeVoucher(v(), { dryRun: true, numberingFor: async () => null, checkDuplicateNumber: taken });
  assert.equal(JSON.parse(a.content[0]!.text).wouldPost, true, 'unknown numbering method');
  const b = await executeVoucher(v(), { dryRun: true, numberingFor: async () => { throw new Error('x'); }, checkDuplicateNumber: taken });
  assert.equal(JSON.parse(b.content[0]!.text).wouldPost, true, 'numbering read threw');
  const c = await executeVoucher(v(), { dryRun: true, numberingFor: manual, checkDuplicateNumber: async () => null });
  assert.equal(JSON.parse(c.content[0]!.text).wouldPost, true, 'lookup failed');
  const d = await executeVoucher(v(), { dryRun: true, numberingFor: manual, checkDuplicateNumber: free });
  assert.equal(JSON.parse(d.content[0]!.text).wouldPost, true, 'number free');
});

test('a skipIfExists hit wins over a number clash (the voucher is already booked)', async () => {
  const r = await executeVoucher(v({ reference: 'UTR1', skipIfExists: true }), {
    dryRun: true, numberingFor: manual, checkDuplicateNumber: taken,
    checkExisting: async () => [{ master_id: '77', voucher_number: 'INV-104' }],
  });
  assert.equal(JSON.parse(r.content[0]!.text).wouldSkip, true);
});

test('findDuplicateNumbersInBatch groups by type + number, ignoring opt-outs and automatic types', () => {
  const rows = [
    { voucherType: 'Sales', voucherNumber: 'A1' },
    { voucherType: 'sales', voucherNumber: ' a1 ' },
    { voucherType: 'Sales', voucherNumber: 'A1', allowDuplicateNumber: true },
    { voucherType: 'Payment', voucherNumber: 'A1' },
    { voucherType: 'Payment', voucherNumber: 'A1' },
    { voucherType: 'Sales', voucherNumber: 'A2' },
    { voucherType: 'Sales' },
    { voucherType: 'Sales' },
  ];
  const groups = findDuplicateNumbersInBatch(rows, t => t.toLowerCase() === 'sales');
  assert.deepEqual(groups.map(g => g.rows), [[0, 1]]);
});

test('in-batch duplicates are per financial year, like the Tally lookup: a restarted series is not a clash', () => {
  const rows = [
    { voucherType: 'Sales', voucherNumber: 'INV-1', date: '2025-04-02' },
    { voucherType: 'Sales', voucherNumber: 'INV-1', date: '2026-04-01' }, // next FY (April start)
    { voucherType: 'Sales', voucherNumber: 'INV-1', date: '2026-03-31' }, // same FY as row 0
  ];
  assert.deepEqual(findDuplicateNumbersInBatch(rows, () => true).map(g => g.rows), [[0, 2]]);
  // The company's own FY start moves the boundary: with a January year, rows 0 and 2 are different years
  // and rows 1 and 2 share 2026.
  assert.deepEqual(findDuplicateNumbersInBatch(rows, () => true, '2026-01-01').map(g => g.rows), [[1, 2]]);
  // A row whose date cannot be read still clashes conservatively with another such row.
  assert.deepEqual(findDuplicateNumbersInBatch([{ voucherType: 'Sales', voucherNumber: 'X' }, { voucherType: 'Sales', voucherNumber: 'X', date: 'bad' }], () => true).map(g => g.rows), [[0, 1]]);
});

test('batch: the same manual number in two financial years is not refused (FY start from the period)', async () => {
  const twoYears = [v({ voucherNumber: 'INV-1', date: '2025-04-02' }), v({ voucherNumber: 'INV-1', date: '2026-04-01' })];
  const a = await executeVoucherBatch(twoYears, { dryRun: true, numberingFor: manual, checkDuplicateNumber: free });
  assert.deepEqual(a.results.map(r => r.status), ['success', 'success']);
  // With a January FY start (from get-period) the same two dates fall in different years too, but
  // 2026-01-05 and 2026-04-01 then share one: refused.
  const b = await executeVoucherBatch([v({ voucherNumber: 'INV-1', date: '2026-01-05' }), v({ voucherNumber: 'INV-1', date: '2026-04-01' })], {
    dryRun: true, numberingFor: manual, checkDuplicateNumber: free, period: { fyFrom: '2026-01-01', fyTo: '2026-12-31', booksFrom: '2020-01-01' },
  });
  assert.deepEqual(b.results.map(r => r.code ?? r.status), ['success', 'DUPLICATE_NUMBER']);
  assert.match(b.results[1]!.message!, /same financial year/);
});

test('batch, best-effort: only the LATER rows sharing a manual number are refused', async () => {
  const b = await executeVoucherBatch([v(), v({ voucherNumber: 'INV-105' }), v(), v({ voucherNumber: 'inv-104' })], {
    dryRun: true, numberingFor: manual, checkDuplicateNumber: free,
  });
  assert.deepEqual(b.results.map(r => r.status), ['success', 'success', 'error', 'error']);
  assert.equal(b.results[2]!.code, 'DUPLICATE_NUMBER');
  assert.match(b.results[2]!.message!, /rows 0, 2, 3/);
  assert.equal(b.aborted, false);
});

test('batch, atomic: an in-batch duplicate aborts before anything posts', async () => {
  const b = await executeVoucherBatch([v(), v()], { atomic: true, numberingFor: manual, checkDuplicateNumber: free });
  assert.equal(b.aborted, true);
  assert.equal(b.posted, 0);
  assert.deepEqual(b.results.map(r => r.code ?? r.status), ['success', 'DUPLICATE_NUMBER']);
});

test('batch, atomic: a number already in Tally aborts too (pre-validation sees it)', async () => {
  const b = await executeVoucherBatch([v({ voucherNumber: 'NEW-1' }), v()], {
    atomic: true, numberingFor: manual,
    checkDuplicateNumber: async (_t, n) => (n === 'INV-104' ? await taken() : []),
  });
  assert.equal(b.aborted, true);
  assert.equal(b.results[1]!.code, 'DUPLICATE_NUMBER');
});

test('batch: allowDuplicateNumber rows and automatic types are not refused', async () => {
  const a = await executeVoucherBatch([v(), v({ allowDuplicateNumber: true })], { dryRun: true, numberingFor: manual, checkDuplicateNumber: free });
  assert.deepEqual(a.results.map(r => r.status), ['success', 'success']);
  const b = await executeVoucherBatch([v(), v()], { dryRun: true, numberingFor: automatic, checkDuplicateNumber: taken });
  assert.deepEqual(b.results.map(r => r.status), ['success', 'success']);
});
