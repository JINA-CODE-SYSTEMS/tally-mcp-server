import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTallyDate, parseCompanyPeriod, computeFinancialYear } from './mcp.mjs';

// #4: derive the CURRENT financial year from the working date + FY-start month/day.
test('computeFinancialYear: current FY from working date (April-start)', () => {
  // $StartingFrom is an OLD year (2023); working date 2026-10-10 → current FY 2026-04-01..2027-03-31
  assert.deepEqual(computeFinancialYear('2023-04-01', '2026-10-10'), { fyFrom: '2026-04-01', fyTo: '2027-03-31' });
  // before this year's FY start → previous FY
  assert.deepEqual(computeFinancialYear('2020-04-01', '2026-02-15'), { fyFrom: '2025-04-01', fyTo: '2026-03-31' });
  // non-April FY start (July)
  assert.deepEqual(computeFinancialYear('2019-07-01', '2026-10-10'), { fyFrom: '2026-07-01', fyTo: '2027-06-30' });
  assert.equal(computeFinancialYear(null, '2026-10-10'), null);
});

test('parseCompanyPeriod fixes the wrong FY end (report #4): $EndingAt = working date', () => {
  // Exactly the reported payload: StartingFrom old, EndingAt == currentDate == lastEntry
  const xml = '<DATA><ROW><F01>ROSS COMPUTERS PVT. LTD.</F01><F02>1-Apr-2023</F02><F03>10-Oct-2026</F03><F04>10-Oct-2026</F04><F05>10-Oct-2026</F05><F06>1-Apr-2023</F06></ROW></DATA>';
  const p = parseCompanyPeriod(xml);
  assert.equal(p.fyFrom, '2026-04-01'); // current FY start, not 2023
  assert.equal(p.fyTo, '2027-03-31');   // real FY end, NOT the working date
  assert.equal(p.currentDate, '2026-10-10');
  assert.equal(p.booksFrom, '2023-04-01');
});

// ── normalizeTallyDate ─────────────────────────────────────────────────────
test('normalizeTallyDate converts d-MMM-yyyy to ISO', () => {
  assert.equal(normalizeTallyDate('1-Apr-2026'), '2026-04-01');
  assert.equal(normalizeTallyDate('31-Mar-2027'), '2027-03-31');
  assert.equal(normalizeTallyDate('10-Oct-2026'), '2026-10-10');
});

test('normalizeTallyDate handles d-MMM-yy and already-ISO input', () => {
  assert.equal(normalizeTallyDate('1-Apr-26'), '2026-04-01');
  assert.equal(normalizeTallyDate('1-Apr-99'), '1999-04-01'); // >= 70 → 19xx
  assert.equal(normalizeTallyDate('2026-04-01'), '2026-04-01');
});

test('normalizeTallyDate returns null for empty/garbage', () => {
  assert.equal(normalizeTallyDate(''), null);
  assert.equal(normalizeTallyDate('   '), null);
  assert.equal(normalizeTallyDate(null), null);
  assert.equal(normalizeTallyDate(undefined), null);
  assert.equal(normalizeTallyDate('not-a-date'), null);
  assert.equal(normalizeTallyDate('1-Xyz-2026'), null); // bad month
});

// ── parseCompanyPeriod ─────────────────────────────────────────────────────
const row = (name: string, from: string, to: string, cur: string, last: string, books = from) =>
  `<ROW><F01>${name}</F01><F02>${from}</F02><F03>${to}</F03><F04>${cur}</F04><F05>${last}</F05><F06>${books}</F06></ROW>`;
const wrap = (...rows: string[]) => `<DATA>${rows.join('')}</DATA>`;

test('parses a single company period row', () => {
  const xml = wrap(row('Ross Industries', '1-Apr-2026', '31-Mar-2027', '10-Oct-2026', '10-Oct-2026'));
  const p = parseCompanyPeriod(xml);
  assert.equal(p.company, 'Ross Industries');
  assert.equal(p.fyFrom, '2026-04-01');
  assert.equal(p.fyTo, '2027-03-31');
  assert.equal(p.booksFrom, '2026-04-01');
  assert.equal(p.currentDate, '2026-10-10');
  assert.equal(p.lastEntryDate, '2026-10-10');
  assert.equal(p.fyToInferred, true); // FY is now derived from working date + FY-start month (#4)
});

test('parses booksFrom when it differs from fyFrom (company started mid-year)', () => {
  const xml = wrap(row('New Co', '1-Apr-2026', '31-Mar-2027', '1-Sep-2026', '1-Sep-2026', '1-Sep-2026'));
  const p = parseCompanyPeriod(xml);
  assert.equal(p.fyFrom, '2026-04-01');
  assert.equal(p.booksFrom, '2026-09-01'); // later than fyFrom — the real earliest valid date
});

test('booksFrom is null when Tally supplies none', () => {
  const xml = wrap('<ROW><F01>No Books Co</F01><F02>1-Apr-2026</F02><F03>31-Mar-2027</F03><F04>1-Apr-2026</F04><F05>1-Apr-2026</F05><F06></F06></ROW>');
  const p = parseCompanyPeriod(xml);
  assert.equal(p.fyFrom, '2026-04-01');
  assert.equal(p.booksFrom, null);
});

test('infers fyTo (fyFrom + 1 year − 1 day) when Tally leaves $EndingAt empty', () => {
  const xml = wrap(row('Ross Industries', '1-Apr-2026', '', '10-Oct-2026', '10-Oct-2026'));
  const p = parseCompanyPeriod(xml);
  assert.equal(p.fyFrom, '2026-04-01');
  assert.equal(p.fyTo, '2027-03-31');
  assert.equal(p.fyToInferred, true);
});

test('picks the row matching preferCompany (case-insensitive), not the first', () => {
  const xml = wrap(
    row('Spectrum Pvt Ltd', '1-Apr-2025', '31-Mar-2026', '1-Jan-2026', '2-Jan-2026'),
    row('Ross Industries', '1-Apr-2026', '31-Mar-2027', '10-Oct-2026', '10-Oct-2026')
  );
  const p = parseCompanyPeriod(xml, 'ross industries');
  assert.equal(p.company, 'Ross Industries');
  assert.equal(p.fyFrom, '2026-04-01');
});

test('falls back to the first row when preferCompany does not match', () => {
  const xml = wrap(
    row('Spectrum Pvt Ltd', '1-Apr-2025', '31-Mar-2026', '1-Jan-2026', '2-Jan-2026'),
    row('Ross Industries', '1-Apr-2026', '31-Mar-2027', '10-Oct-2026', '10-Oct-2026')
  );
  const p = parseCompanyPeriod(xml, 'Nonexistent Co');
  assert.equal(p.company, 'Spectrum Pvt Ltd');
});

test('unescapes XML entities in the company name', () => {
  const xml = wrap(row('Ross &amp; Co', '1-Apr-2026', '31-Mar-2027', '10-Oct-2026', '10-Oct-2026'));
  const p = parseCompanyPeriod(xml, 'Ross & Co');
  assert.equal(p.company, 'Ross & Co');
});

test('returns all-null on empty / rowless XML', () => {
  const empty = parseCompanyPeriod('');
  assert.equal(empty.company, null);
  assert.equal(empty.fyFrom, null);
  assert.equal(empty.fyToInferred, false);

  const noRows = parseCompanyPeriod('<DATA></DATA>');
  assert.equal(noRows.company, null);
  assert.equal(noRows.fyTo, null);
});

test('tolerates a missing optional field (empty lastEntryDate)', () => {
  const xml = wrap('<ROW><F01>New Co</F01><F02>1-Apr-2026</F02><F03>31-Mar-2027</F03><F04>1-Apr-2026</F04><F05></F05></ROW>');
  const p = parseCompanyPeriod(xml);
  assert.equal(p.company, 'New Co');
  assert.equal(p.lastEntryDate, null);
  assert.equal(p.fyTo, '2027-03-31');
});
