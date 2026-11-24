import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Fixes from the review of epic #44 (writes, idempotency, the #29 company guard). Everything here runs
// against a fake Tally (testkit-fake-tally) in a private coordination folder.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-writes-'));
process.env.TALLY_DATA_PATH = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const {
  busyWriteResult, companyIdMatches, decideAlreadyLoaded, executeVoucher, parseCompanyIdentity, pickVoucherToShow,
  registerMcpServer, tallyMachineName,
} = await import('./mcp.mjs');
const { pushXml } = await import('./tally.mjs');
const { lockFile } = await import('./coordination.mjs');
const { beginInflightWrite, inflightWritesDir, isInflightWriteLive, liveInflightWrites, waitForInflightWrites } = await import('./write-inflight.mjs');
const { makeIdempotencyStore, idempotencyPendingFileName, isPendingStale, IDEMPOTENCY_DIR_NAME } = await import('./idempotency.mjs');
const { makeBatchJournalStore } = await import('./batch-journal.mjs');
const { importOk, isImport, startFakeTally } = await import('./testkit-fake-tally.mjs');

const codeOf = (r: any) => r?.structuredContent?.code;

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function connect() {
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'core-writes-test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// A load lock held by another live process (our parent), as another AI window's load-company would.
const holdLoadLock = () => fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, tool: 'load-company', kind: 'load', startedAt: new Date().toISOString(), host: os.hostname(), token: 'other' }));
const dropLoadLock = () => { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } };

type Co = { name: string; guid: string; number: string; nameAttr?: string };
const svCompanyOf = (xml: string) => (/<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(xml) || [])[1] ?? null;

// A fake Tally with some companies loaded. `extra` answers anything else (return undefined to fall back).
async function fakeBooks(companies: Co[], extra: (xml: string) => string | undefined = () => undefined) {
  return startFakeTally(xml => {
    if (xml.includes('MCPLoadedCompaniesList')) {
      return `<ENVELOPE><COLLECTION>${companies.map(c => `<COMPANY NAME="${c.nameAttr ?? c.name}" RESERVEDNAME=""/>`).join('')}</COLLECTION></ENVELOPE>`;
    }
    if (xml.includes('MCPCompanyIdReport')) {
      // Like Tally: the Company collection lists every loaded company whatever SVCURRENTCOMPANY says.
      return `<ENVELOPE><DATA>${companies.map(c => `<ROW><F01>${c.name.replace(/&/g, '&amp;').replace(/'/g, '&apos;')}</F01><F02>${c.guid}</F02><F03>${c.number}</F03></ROW>`).join('')}</DATA></ENVELOPE>`;
    }
    return extra(xml);
  });
}

// ── #26: guardedWrite announces an in-flight write BEFORE it checks for a load ──

test('an in-flight marker is up for the whole write, independent of the activity signal, and gone after', async () => {
  let seenDuringWrite: number | null = null;
  const tally = await startFakeTally(xml => {
    if (isImport(xml)) { seenDuringWrite = liveInflightWrites().length; return importOk(1); }
    return undefined;
  });
  try {
    await withEnv({ CLAUDALLY_NO_ACTIVITY: '1' }, async () => {
      const r = await pushXml('<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER></ENVELOPE>');
      assert.equal(r.success, true);
    });
    assert.equal(seenDuringWrite, 1, 'a load polling for writes sees this one while Tally is processing it');
    assert.equal(liveInflightWrites().length, 0, 'and it is gone once the write is over');
  } finally { await tally.close(); }
});

test('a write refused because a load holds the lock leaves no marker behind', async () => {
  await withEnv({ XML_WRITE_LOAD_WAIT_SEC: '0' }, async () => {
    holdLoadLock();
    try {
      const r = await pushXml('<ENVELOPE/>');
      assert.equal(r.busy?.tool, 'load-company');
      assert.equal(liveInflightWrites().length, 0);
    } finally { dropLoadLock(); }
  });
});

test('isInflightWriteLive: live while its process runs and it is young; never for a dead pid or an old marker', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const rec = { schemaVersion: 1 as const, pid: 4242, host: 'PC', tool: 'tally-write', startedAt: '2026-11-23T09:59:58Z', token: 't' };
  assert.equal(isInflightWriteLive(rec, now, now, 60_000, () => true, 'PC'), true);
  assert.equal(isInflightWriteLive(rec, now, now, 60_000, () => false, 'PC'), false, 'process gone');
  assert.equal(isInflightWriteLive({ ...rec, startedAt: '2026-11-23T09:50:00Z' }, now, now, 60_000, () => true, 'PC'), false, 'older than any write');
  assert.equal(isInflightWriteLive({ ...rec, host: 'OTHER-PC' }, now, now, 60_000, () => false, 'PC'), true, 'another machine: age only');
  assert.equal(isInflightWriteLive(null, now - 1000, now, 60_000), true, 'caught half-written: counted');
  assert.equal(isInflightWriteLive(null, now - 60_000, now, 60_000), false);
});

test('waitForInflightWrites returns once the writes finish, or what is still running at the deadline', async () => {
  const end = beginInflightWrite('create-voucher');
  setTimeout(end, 150);
  assert.deepEqual(await waitForInflightWrites({ maxWaitMs: 5_000, pollMs: 20 }), []);
  const end2 = beginInflightWrite('create-vouchers');
  try {
    const left = await waitForInflightWrites({ maxWaitMs: 100, pollMs: 20 });
    assert.equal(left.length, 1);
    assert.equal(left[0]!.tool, 'create-vouchers');
  } finally { end2(); }
  // A dead process's marker does not hold a load up, and is cleaned away.
  fs.writeFileSync(path.join(inflightWritesDir(), '999999-dead.json'), JSON.stringify({ schemaVersion: 1, pid: 999999, host: os.hostname(), tool: 'x', startedAt: new Date().toISOString(), token: 'dead' }));
  assert.deepEqual(await waitForInflightWrites({ maxWaitMs: 100, alive: () => false }), []);
  assert.equal(fs.existsSync(path.join(inflightWritesDir(), '999999-dead.json')), false);
});

// ── #26: BUSY from a write is reported as BUSY on every write path ──

test('busyWriteResult: BUSY with retryAfterSec and the holder; null for any other failure', () => {
  const r: any = busyWriteResult({ busy: { retryAfterSec: 30, tool: 'load-company' }, error: 'Another AI window is reopening Tally.' }, { masterId: '5' });
  assert.equal(codeOf(r), 'BUSY');
  assert.equal(r.structuredContent.retryable, true);
  assert.equal(r.structuredContent.retryAfterSec, 30);
  assert.equal(r.structuredContent.holderTool, 'load-company');
  assert.equal(r.structuredContent.masterId, '5');
  assert.equal(busyWriteResult({ error: 'Ledger does not exist' }), null);
});

const VOUCHER_BLOCK = '<VOUCHER REMOTEID="r-555" VCHKEY="k-555" VCHTYPE="Receipt" ACTION="Create"><DATE>20260703</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>7</VOUCHERNUMBER><MASTERID>555</MASTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>';
const voucherLookup = (xml: string): string | undefined => {
  if (xml.includes('FldMasterId')) return '<DATA><ROW><F01>555</F01><F02>2026-07-03</F02><F03>7</F03><F04>Receipt</F04><F07>100</F07><F08>No</F08></ROW></DATA>';
  if (xml.includes('ClaudallyVchDel')) return `<ENVELOPE><BODY><DATA><COLLECTION>${VOUCHER_BLOCK}</COLLECTION></DATA></BODY></ENVELOPE>`;
  return undefined;
};

test('delete, alter, reverse, batch delete and master writes during another window\'s company load all report BUSY, not a Tally refusal', async () => {
  let imports = 0;
  const tally = await fakeBooks([{ name: 'Acme', guid: 'g-acme', number: '10000' }], xml => {
    if (isImport(xml)) { imports++; return importOk(1); }
    return voucherLookup(xml);
  });
  try {
    await withEnv({ XML_WRITE_LOAD_WAIT_SEC: '0', READONLY_MODE: undefined }, async () => {
      const { client, close } = await connect();
      holdLoadLock();
      try {
        const calls: Array<[string, Record<string, unknown>]> = [
          ['delete-voucher', { targetCompany: 'Acme', voucherType: 'Receipt', masterId: '555', confirm: true }],
          ['alter-voucher', { targetCompany: 'Acme', voucherType: 'Receipt', masterId: '555', newDate: '2026-07-04', confirm: true }],
          ['reverse-voucher', { targetCompany: 'Acme', voucherType: 'Receipt', voucherNumber: '7', date: '2026-07-03', masterId: '555' }],
          ['delete-vouchers', { targetCompany: 'Acme', targets: [{ voucherType: 'Receipt', masterId: '555' }], expectedCount: 1, confirm: true }],
          ['create-ledger', { targetCompany: 'Acme', name: 'New Party', parentGroup: 'Sundry Debtors' }],
          ['create-stock-item', { targetCompany: 'Acme', name: 'Widget' }],
        ];
        for (const [name, args] of calls) {
          const r: any = await client.callTool({ name, arguments: args });
          assert.equal(codeOf(r), 'BUSY', `${name}: ${r.content?.[0]?.text}`);
          assert.equal(r.structuredContent.retryable, true, name);
          assert.equal(r.structuredContent.holderTool, 'load-company', name);
          assert.doesNotMatch(r.structuredContent.message, /refused every|No alter form|requires_gui|Alt\+D/, name);
        }
        assert.equal(imports, 0, 'nothing reached Tally');
      } finally { dropLoadLock(); await close(); }
    });
  } finally { await tally.close(); }
});

// ── #27 follow-up: an idempotency key is reserved while its write is in flight ──

test('reserve: one holder at a time; released on demand; stale reservations are taken over', () => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'idem-'));
  const store = makeIdempotencyStore(dir);
  const a = store.reserve('K');
  assert.equal(a.ok, true);
  const b = store.reserve('K');
  assert.equal(b.ok, false, 'a live reservation (even from this process) blocks a second caller');
  if (!b.ok) { assert.equal(b.holder?.pid, process.pid); assert.ok(b.retryAfterSec >= 5); }
  if (a.ok) a.reservation.release();
  const c = store.reserve('K');
  assert.equal(c.ok, true, 'released: the next caller gets it');
  if (c.ok) c.reservation.release();

  // A reservation left by a crashed process is taken over.
  const pending = path.join(dir, IDEMPOTENCY_DIR_NAME, idempotencyPendingFileName('K'));
  fs.writeFileSync(pending, JSON.stringify({ key: 'K', pid: 999999, host: os.hostname(), token: 'dead', startedAt: new Date().toISOString() }));
  const deadStore = makeIdempotencyStore(dir, { isPidAlive: () => false });
  const d = deadStore.reserve('K');
  assert.equal(d.ok, true, 'dead holder: taken over');
  // ...and the old holder, if it ever came back, could not remove the new reservation.
  if (d.ok) d.reservation.release();
});

test('isPendingStale: dead pid, too old, or our own pid with a token we never issued (pid reuse)', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const rec = { key: 'K', pid: 4242, host: 'PC', token: 't1', startedAt: '2026-11-23T09:59:00Z' };
  const none = new Set<string>();
  assert.equal(isPendingStale(rec, now, now, 30 * 60_000, () => true, none, 'PC', 1), false, 'live other process');
  assert.equal(isPendingStale(rec, now, now, 30 * 60_000, () => false, none, 'PC', 1), true, 'dead process');
  assert.equal(isPendingStale({ ...rec, startedAt: '2026-11-23T09:00:00Z' }, now, now, 30 * 60_000, () => true, none, 'PC', 1), true, 'older than any batch');
  assert.equal(isPendingStale(rec, now, now, 30 * 60_000, () => true, none, 'PC', 4242), true, 'our pid, not our token: a crashed earlier process');
  assert.equal(isPendingStale(rec, now, now, 30 * 60_000, () => true, new Set(['t1']), 'PC', 4242), false, 'our own live call');
  assert.equal(isPendingStale({ ...rec, host: 'OTHER' }, now, now, 30 * 60_000, () => false, none, 'PC', 1), false, 'other machine: age only');
});

test('the sweep removes a stale reservation and leaves a live one', () => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'idem-sweep-'));
  const idem = path.join(dir, IDEMPOTENCY_DIR_NAME);
  fs.mkdirSync(idem, { recursive: true });
  const stale = path.join(idem, idempotencyPendingFileName('old'));
  const live = path.join(idem, idempotencyPendingFileName('live'));
  fs.writeFileSync(stale, JSON.stringify({ key: 'old', pid: 999999, host: os.hostname(), token: 'x', startedAt: new Date().toISOString() }));
  fs.writeFileSync(live, JSON.stringify({ key: 'live', pid: process.ppid, host: os.hostname(), token: 'y', startedAt: new Date().toISOString() }));
  makeIdempotencyStore(dir, { isPidAlive: pid => pid === process.ppid }).get('anything'); // first use sweeps
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
});

const receipt = { voucherType: 'Receipt', date: '2026-07-03', entries: [{ ledger: 'Cash', drCr: 'dr' as const, amount: 10 }, { ledger: 'Sales', drCr: 'cr' as const, amount: 10 }] };

test('a replay of the same key while the first call is still posting is refused, not posted twice', async () => {
  let imports = 0;
  const tally = await startFakeTally(xml => (isImport(xml) ? (imports++, importOk(900)) : undefined));
  const store = makeIdempotencyStore(fs.mkdtempSync(path.join(dataDir, 'idem-race-')));
  const opts = { exactCompany: 'Acme', idempotency: { store, now: new Date().toISOString() } };
  try {
    // The first call reserves its key synchronously and is then on the wire to Tally; the replay (a client
    // timeout and a resend, or a second window) arrives while it is still there.
    const firstCall = executeVoucher({ ...receipt, idempotencyKey: 'inv-7' }, opts);
    const replay: any = await executeVoucher({ ...receipt, idempotencyKey: 'inv-7' }, opts);
    const r1: any = await firstCall;
    assert.equal(JSON.parse(r1.content[0].text).masterId, 900);
    assert.equal(codeOf(replay), 'BUSY', replay.content[0].text);
    assert.equal(replay.structuredContent.inProgress, true);
    assert.equal(replay.structuredContent.retryable, true);
    assert.equal(imports, 1, 'posted once');
    // Once the first has finished, the same key replays its stored result.
    const later: any = await executeVoucher({ ...receipt, idempotencyKey: 'inv-7' }, opts);
    assert.equal(JSON.parse(later.content[0].text).idempotentReplay, true);
    assert.equal(imports, 1);
  } finally { await tally.close(); }
});

test('a failed first attempt releases its key, so a retry with the same key posts', async () => {
  let imports = 0;
  const tally = await startFakeTally(xml => {
    if (!isImport(xml)) return undefined;
    imports++;
    return imports === 1
      ? '<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger \'Sales\' does not exist!</LINEERROR></RESPONSE>'
      : importOk(901);
  });
  const store = makeIdempotencyStore(fs.mkdtempSync(path.join(dataDir, 'idem-retry-')));
  const opts = { exactCompany: 'Acme', idempotency: { store, now: new Date().toISOString() } };
  try {
    const bad: any = await executeVoucher({ ...receipt, idempotencyKey: 'k-retry' }, opts);
    assert.equal(bad.isError, true);
    const good: any = await executeVoucher({ ...receipt, idempotencyKey: 'k-retry' }, opts);
    assert.equal(JSON.parse(good.content[0].text).masterId, 901);
    // A refusal before any write (unbalanced) releases it too.
    const refused: any = await executeVoucher({ ...receipt, entries: [{ ledger: 'Cash', drCr: 'dr', amount: 1 }, { ledger: 'Sales', drCr: 'cr', amount: 2 }], idempotencyKey: 'k-unbal' }, opts);
    assert.equal(codeOf(refused), 'UNBALANCED');
    assert.equal(store.reserve('k-unbal').ok, true);
  } finally { await tally.close(); }
});

// ── #29: identity ──

test('parseCompanyIdentity never hands back another company\'s id', () => {
  const xml = '<DATA><ROW><F01>Alpha Ltd</F01><F02>g-a</F02><F03>10000</F03></ROW><ROW><F01>Shah&apos;s Enterprises</F01><F02>g-s</F02><F03>10001</F03></ROW></DATA>';
  assert.equal(parseCompanyIdentity(xml, "Shah's Enterprises", 'PC').companyGuid, 'g-s', 'names compare after full entity decoding');
  const missing = parseCompanyIdentity(xml, 'Beta Ltd', 'PC');
  assert.deepEqual(missing, { machine: 'PC', company: 'Beta Ltd', companyGuid: null, companyNumber: null, companyId: null }, 'a named company not in the report is unknown, not the first row');
  assert.equal(parseCompanyIdentity(xml, null, 'PC').companyId, null, 'no preference and two loaded: which one Tally lists first is arbitrary');
  assert.equal(parseCompanyIdentity('<ROW><F01>Only</F01><F02>g-o</F02><F03>1</F03></ROW>', null, 'PC').companyId, 'g-o');
  const twins = '<ROW><F01>Ross</F01><F02>g-1</F02><F03>100000</F03></ROW><ROW><F01>Ross</F01><F02>g-2</F02><F03>100001</F03></ROW>';
  assert.equal(parseCompanyIdentity(twins, 'Ross', 'PC').companyId, null, 'two loaded with one name cannot be told apart by name');
});

test('companyIdMatches: the GUID identifies the books; a bare company number only without a GUID and with the machine confirmed', () => {
  const id = { machine: 'PC', company: 'A', companyGuid: 'ABC-123', companyNumber: '10002', companyId: 'ABC-123' };
  assert.equal(companyIdMatches('abc-123', id), true);
  assert.equal(companyIdMatches('10002', id), false, 'numbers repeat across PCs; the GUID is readable, so it decides');
  assert.equal(companyIdMatches('10002', id, { machineConfirmed: true }), false);
  const noGuid = { ...id, companyGuid: null, companyId: '10002' };
  assert.equal(companyIdMatches('10002', noGuid), false, 'number alone: refused');
  assert.equal(companyIdMatches('10002', noGuid, { machineConfirmed: true }), true);
  assert.equal(companyIdMatches('x', { ...id, companyGuid: null, companyNumber: null, companyId: null }, { machineConfirmed: true }), false, 'unreadable id fails closed');
});

test('tallyMachineName: this PC for a local Tally; both ends for a Tally on another computer', () => {
  assert.equal(tallyMachineName(undefined, 'SERVER-PC'), 'SERVER-PC');
  assert.equal(tallyMachineName('localhost', 'SERVER-PC'), 'SERVER-PC');
  assert.equal(tallyMachineName('192.168.1.20', 'SERVER-PC'), 'SERVER-PC@192.168.1.20');
});

const ALPHA = { name: 'Alpha Ltd', guid: 'g-a', number: '10000' };
const BETA = { name: 'Beta Ltd', guid: 'g-b', number: '10001' };

test('the guard: right id passes, wrong id or wrong machine is refused, names with entities resolve', async () => {
  const shah = { name: "Shah's Enterprises", guid: 'g-s', number: '10002', nameAttr: 'Shah&apos;s Enterprises' };
  const tally = await fakeBooks([ALPHA, shah]);
  try {
    const { client, close } = await connect();
    try {
      const call = (args: Record<string, unknown>) => client.callTool({ name: 'create-voucher', arguments: { ...receipt, dryRun: true, ...args } }) as Promise<any>;
      assert.notEqual(codeOf(await call({ targetCompany: 'Alpha Ltd', expectedCompanyId: 'g-a' })), 'COMPANY_MISMATCH');
      assert.equal(codeOf(await call({ targetCompany: 'Alpha Ltd', expectedCompanyId: 'g-s' })), 'COMPANY_MISMATCH');
      const ok = await call({ targetCompany: "Shah's Enterprises", expectedCompanyId: 'g-s' });
      assert.notEqual(codeOf(ok), 'COMPANY_MISMATCH', `the guard compares Shah's own id: ${ok.content?.[0]?.text}`);
      assert.equal(codeOf(await call({ targetCompany: "Shah's Enterprises", expectedCompanyId: 'g-a' })), 'COMPANY_MISMATCH', 'and never the first-listed company\'s');
      // The same books on another PC (a copy carries the same GUID) are refused when the machine is given.
      const otherPc = await call({ targetCompany: 'Alpha Ltd', expectedCompanyId: 'g-a', expectedMachine: 'SOME-OTHER-PC' });
      assert.equal(codeOf(otherPc), 'COMPANY_MISMATCH');
      assert.match(otherPc.structuredContent.message, /different machine/);
      assert.notEqual(codeOf(await call({ targetCompany: 'Alpha Ltd', expectedCompanyId: 'g-a', expectedMachine: os.hostname().toLowerCase() })), 'COMPANY_MISMATCH');
    } finally { await close(); }
  } finally { await tally.close(); }
});

test('the guard: a bare company number is accepted only with the machine, and only where the GUID cannot be read', async () => {
  const tally = await fakeBooks([{ name: 'Alpha Ltd', guid: '', number: '10000' }]);
  try {
    const { client, close } = await connect();
    try {
      const call = (args: Record<string, unknown>) => client.callTool({ name: 'create-voucher', arguments: { ...receipt, dryRun: true, targetCompany: 'Alpha Ltd', ...args } }) as Promise<any>;
      const alone = await call({ expectedCompanyId: '10000' });
      assert.equal(codeOf(alone), 'COMPANY_MISMATCH');
      assert.match(alone.structuredContent.remedy, /expectedMachine/);
      assert.notEqual(codeOf(await call({ expectedCompanyId: '10000', expectedMachine: os.hostname() })), 'COMPANY_MISMATCH');
    } finally { await close(); }
  } finally { await tally.close(); }
});

test('update-party-details defaults to the active company for every read and the ALTER, the company the guard checked', async () => {
  const seen: Array<{ kind: string; company: string | null }> = [];
  const tally = await fakeBooks([ALPHA, BETA], xml => {
    if (xml.includes('MCPExactMasterNames')) { seen.push({ kind: 'ledgers', company: svCompanyOf(xml) }); return '<ENVELOPE><LEDGER NAME="XYZ Traders"/></ENVELOPE>'; }
    if (xml.includes('FldPartyType')) { seen.push({ kind: 'parties', company: svCompanyOf(xml) }); return '<DATA><ROW><F01>XYZ Traders</F01><F02>Debtor</F02><F03>Sundry Debtors</F03></ROW></DATA>'; }
    if (isImport(xml)) { seen.push({ kind: 'alter', company: svCompanyOf(xml) }); return '<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS></RESPONSE>'; }
    return undefined;
  });
  try {
    const { client, close } = await connect();
    try {
      await client.callTool({ name: 'set-active-company', arguments: { companyName: 'Alpha Ltd' } });
      await client.callTool({ name: 'update-party-details', arguments: { name: 'XYZ Traders', pincode: '400001', expectedCompanyId: 'g-a' } });
      assert.ok(seen.some(s => s.kind === 'alter'), JSON.stringify(seen));
      for (const s of seen) assert.equal(s.company, 'Alpha Ltd', `${s.kind} must target the checked company`);
    } finally { await close(); }
  } finally { await tally.close(); }
});

test('undo-batch: the guard checks the batch\'s own company, not the active one', async () => {
  const tally = await fakeBooks([ALPHA, BETA]);
  try {
    const journal = makeBatchJournalStore(dataDir).create({ tool: 'create-vouchers', company: 'Beta Ltd', rows: [receipt] });
    const { client, close } = await connect();
    try {
      await client.callTool({ name: 'set-active-company', arguments: { companyName: 'Alpha Ltd' } });
      const wrong: any = await client.callTool({ name: 'undo-batch', arguments: { batchId: journal.batchId, expectedCompanyId: 'g-a' } });
      assert.equal(codeOf(wrong), 'COMPANY_MISMATCH', 'the sheet is for Alpha; the batch deletes in Beta');
      const right: any = await client.callTool({ name: 'undo-batch', arguments: { batchId: journal.batchId, expectedCompanyId: 'g-b' } });
      assert.notEqual(codeOf(right), 'COMPANY_MISMATCH', right.content?.[0]?.text);
      assert.equal(JSON.parse(right.content[0].text).company, 'Beta Ltd');
    } finally { await close(); }
  } finally { await tally.close(); }
});

// ── #25: load-company's "already loaded" ──

test('decideAlreadyLoaded: a name match is not enough when folders share the name', () => {
  const folders = [{ folder: '100000', name: 'Ross Industries' }, { folder: '100001', name: 'Ross Industries' }, { folder: '100002', name: 'Other Co' }];
  const base = { folders, loaded: ['Ross Industries'], replace: false, scannedTallysDataPath: true };
  // The reported failure: 100000 is loaded, the caller asks for 100001 by id.
  assert.equal(decideAlreadyLoaded({ ...base, folderId: '100001', folderName: 'Ross Industries', residentNumber: '100000' }).skip, false);
  assert.equal(decideAlreadyLoaded({ ...base, folderId: '100001', folderName: 'Ross Industries', residentNumber: null }).skip, false, 'unidentified and the name is shared: restart');
  const same = decideAlreadyLoaded({ ...base, folderId: '100000', folderName: 'Ross Industries', residentNumber: '100000' });
  assert.deepEqual(same, { skip: true, resident: 'Ross Industries', via: 'company-number' });
  // Unique name, number unreadable: the name is enough, but only for the data path Tally loads from.
  const uniq = { ...base, loaded: ['Other Co'], folderId: '100002', folderName: 'Other Co', residentNumber: null };
  assert.deepEqual(decideAlreadyLoaded(uniq), { skip: true, resident: 'Other Co', via: 'unique-name' });
  assert.equal(decideAlreadyLoaded({ ...uniq, scannedTallysDataPath: false }).skip, false, 'a dataPath override is another folder tree');
  assert.equal(decideAlreadyLoaded({ ...uniq, residentNumber: '100009' }).skip, false, 'a readable number that differs decides');
  assert.equal(decideAlreadyLoaded({ ...uniq, loaded: ['Other Co', 'Ross Industries'], replace: true }).skip, false, 'replace with others loaded still restarts');
  assert.equal(decideAlreadyLoaded({ ...uniq, loaded: ['Ross Industries'] }).skip, false, 'not loaded');
});

// ── #23: show the altered voucher where it now is ──

test('pickVoucherToShow for alter-voucher uses the new date and number, never the old ones or a serialised Date', () => {
  // What alter-voucher returns after JSON: preview.date was a Date (15 Apr local) and is now a UTC string.
  const body = { success: true, masterId: '555', voucher: { voucher_type: 'Sales', date: '2025-04-14T18:30:00.000Z', voucher_number: '7' }, after: { date: '2025-04-15', voucherNumber: '7' } };
  assert.deepEqual(pickVoucherToShow('alter-voucher', { masterId: '555', voucherType: 'Sales', confirm: true }, body),
    { masterId: '555', voucherType: 'Sales', voucherNumber: '7', date: '2025-04-15' });
  assert.deepEqual(pickVoucherToShow('alter-voucher', { masterId: '555', voucherType: 'Sales', date: '2025-04-15', newDate: '2025-05-02', newVoucherNumber: '8' }, body),
    { masterId: '555', voucherType: 'Sales', voucherNumber: '8', date: '2025-05-02' });
  // Elsewhere, only a YYYY-MM-DD date is passed on; anything else opens the Day Book on its own date.
  assert.equal(pickVoucherToShow('create-voucher', {}, { success: true, masterId: 1, voucher: { date: '2025-04-14T18:30:00.000Z' } })!.date, undefined);
});

test('alter-voucher reports the date the voucher now carries, in local time', () => withEnv({ TZ: 'Asia/Kolkata' }, async () => {
  // In India a local-midnight Date serialises to the previous day in UTC; `after` must not.
  assert.equal(JSON.stringify(new Date(2026, 6, 3)), '"2026-07-02T18:30:00.000Z"', 'the zone took effect');
  const tally = await fakeBooks([{ name: 'Acme', guid: 'g-acme', number: '10000' }], xml => {
    if (isImport(xml)) return '<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><ERRORS>0</ERRORS><LASTVCHID>555</LASTVCHID></RESPONSE>';
    return voucherLookup(xml);
  });
  try {
    const { client, close } = await connect();
    try {
      const kept: any = await client.callTool({ name: 'alter-voucher', arguments: { targetCompany: 'Acme', voucherType: 'Receipt', masterId: '555', narration: 'fixed', confirm: true } });
      assert.deepEqual(JSON.parse(kept.content[0].text).after, { date: '2026-07-03', voucherNumber: '7' }, kept.content[0].text);
      const moved: any = await client.callTool({ name: 'alter-voucher', arguments: { targetCompany: 'Acme', voucherType: 'Receipt', masterId: '555', newDate: '2026-07-04', confirm: true } });
      assert.equal(JSON.parse(moved.content[0].text).after.date, '2026-07-04');
    } finally { await close(); }
  } finally { await tally.close(); }
}));
