import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { executeVoucherBatch, idempotentResumeTarget, isTransportOutcomeUnknown, registerMcpServer, resolveUndoTarget } from './mcp.mjs';
import {
  BATCH_DIR_NAME, NOT_SENT, OUTCOME_UNKNOWN, describeBatchBusy, executeUndo, findEarlierBatch, isBatchLockStale,
  makeBatchJournalStore, openJournalForResume, planUndo, runJournaledBatch, settleResend, validMasterId, type BatchLockHolder, type UndoDeps,
} from './batch-journal.mjs';
import { makeIdempotencyStore } from './idempotency.mjs';
import { importOk, importRejected, isImport, startFakeTally, voucherBlockOf } from './testkit-fake-tally.mjs';
import { reportColumnMetadata } from './tally.mjs';

// The batch journal's safety rules from the review of #44: one run per batch (lock + cancellation),
// rows whose outcome is unknown, vouchers Tally altered rather than created, master ids that were never
// returned, voucher types spelled differently, finding a batch whose result never arrived, and replays
// of an idempotency key that resume instead of returning a stale partial result.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-safety-'));
process.env.TALLY_DATA_PATH = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const receipt = (n: number, over: object = {}) => ({
  voucherType: 'Receipt', date: '2026-07-03', reference: `UTR${n}`, narration: `row ${n}`,
  entries: [{ ledger: 'HDFC Bank', drCr: 'dr' as const, amount: 100 + n }, { ledger: `Party ${n}`, drCr: 'cr' as const, amount: 100 + n }],
  ...over,
});
// A voucher with no reference: no REMOTEID, so Tally can only ever create it.
const noRef = (n: number) => { const { reference: _r, ...v } = receipt(n); return v; };

const altered = (masterId: number) => `<RESPONSE><CREATED>0</CREATED><ALTERED>1</ALTERED><DELETED>0</DELETED><LASTVCHID>${masterId}</LASTVCHID><ERRORS>0</ERRORS></RESPONSE>`;

type Answer = string | { body: string; keep?: boolean };

// A fake Tally keeping masterId → voucher block. `answer` may override the reply to an import (and say
// whether the voucher was saved anyway, as Tally does when only the reply is lost). With alterByRemoteId,
// an import whose REMOTEID a voucher in the books already holds ALTERS that voucher (created 0 / altered 1),
// as Tally does. It also answers the voucher-by-remoteid report, and `lookups` reads the books the way the
// server's reference (live vouchers only), REMOTEID (all vouchers) and voucher-number lookups do.
async function fakeBooks(answer: (block: string) => Answer | undefined = () => undefined, opts: { alterByRemoteId?: boolean } = {}) {
  const books = new Map<string, string>();
  let next = 1000;
  const tag = (b: string, t: string) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(b) || [])[1];
  const remoteIdOf = (b: string) => (/<VOUCHER\b[^>]*\bREMOTEID="([^"]*)"/.exec(b) || [])[1];
  const row = (id: string, b: string) => ({ master_id: id, voucher_number: tag(b, 'VOUCHERNUMBER') ?? '', reference: tag(b, 'REFERENCE') ?? '', date: '2026-07-03' });
  const lookups = {
    byReference: async (ref: string) => [...books].filter(([, b]) => tag(b, 'REFERENCE') === ref && tag(b, 'ISCANCELLED') !== 'Yes').map(([id, b]) => row(id, b)),
    byRemoteId: async (rid: string) => [...books].filter(([, b]) => remoteIdOf(b) === rid).map(([id, b]) => row(id, b)),
    byNumber: async (_type: string, num: string) => [...books].filter(([, b]) => tag(b, 'VOUCHERNUMBER') === num).map(([id, b]) => row(id, b)),
  };
  const tally = await startFakeTally(xml => {
    if (/MCPLoadedCompaniesList/.test(xml)) return '<ENVELOPE><COMPANY NAME="Acme"/></ENVELOPE>';
    if (/FldRemoteId/.test(xml)) {
      const rid = tag(xml, 'MCPREMOTEID') ?? '';
      return `<DATA>${[...books].filter(([, b]) => remoteIdOf(b) === rid).map(([id, b]) => `<ROW><F01>${id}</F01><F02>2026-07-03</F02><F03>${tag(b, 'VOUCHERNUMBER') ?? ''}</F03><F04>Receipt</F04><F05>${tag(b, 'REFERENCE') ?? ''}</F05><F10>${rid}</F10></ROW>`).join('')}</DATA>`;
    }
    if (!isImport(xml)) return undefined;
    const block = voucherBlockOf(xml);
    const a = answer(block);
    if (a !== undefined) {
      const { body, keep } = typeof a === 'string' ? { body: a, keep: false } : a;
      if (keep) books.set(String(++next), block);
      return body;
    }
    const rid = remoteIdOf(block);
    const bound = opts.alterByRemoteId && rid ? [...books].find(([, b]) => remoteIdOf(b) === rid) : undefined;
    if (bound) {
      books.set(bound[0], block);
      return altered(Number(bound[0]));
    }
    const id = ++next;
    books.set(String(id), block);
    return importOk(id);
  });
  const typeOf = (b: string) => (/<VOUCHERTYPENAME>([^<]*)</.exec(b) || [])[1];
  const deps = (): UndoDeps => ({
    resolve: (masterId, voucherType) => resolveUndoTarget(masterId, voucherType, async mid => {
      const b = books.get(mid);
      return { voucher: b ? { master_id: mid, voucher_type: typeOf(b), voucher_number: '', date: '2026-07-03' } : null };
    }),
    fetchBlock: async located => ({ block: books.get(String(located.master_id)) }),
    deleteOne: async located => (books.delete(String(located.master_id)) ? { status: 'deleted', deleteForm: 'derived-remoteid' } : { status: 'failed', message: 'gone' }),
    findByRemoteId: lookups.byRemoteId,
  });
  return { books, tally, deps, lookups };
}

const storeIn = () => makeBatchJournalStore(fs.mkdtempSync(path.join(dataDir, 'store-')));
const exec = (extra: object = {}) => (r: any[], o: any) => executeVoucherBatch(r, { exactCompany: 'Acme', ...extra, ...o });

async function connect() {
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'batch-safety', version: '0' });
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

// ── one run per batch ──

test('a batch is locked for the whole run: a second lock is refused until the first is released', () => {
  const store = storeIn();
  const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows: [receipt(1)] });
  const a = store.lock(j.batchId, 'create-vouchers');
  assert.ok(a.ok);
  const b = store.lock(j.batchId, 'undo-batch');
  assert.equal(b.ok, false);
  assert.equal((b as any).holder.tool, 'create-vouchers');
  assert.match(describeBatchBusy(j.batchId, (b as any).holder), /still posting batch/);
  a.release();
  assert.equal(fs.existsSync(path.join(store.dir, `${j.batchId}.lock`)), false, 'released locks are removed');
  const c = store.lock(j.batchId, 'undo-batch');
  assert.ok(c.ok);
  c.release();
  // createLocked holds the lock from before the journal exists.
  const made = store.createLocked({ tool: 'create-vouchers', company: 'Acme', rows: [receipt(2)] }, 'create-vouchers');
  assert.equal(store.lock(made.journal.batchId, 'undo-batch').ok, false);
  made.release();
});

test('a lock left by a dead or silent holder is taken over; a live one on this or another host is not', () => {
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const holder = (over: Partial<BatchLockHolder>): BatchLockHolder => ({ batchId: 'b-20261123-000000-aaaaaa', pid: process.ppid, tool: 'create-vouchers', host: os.hostname(), token: 't', startedAt: at(0), heartbeatAt: at(0), ...over });
  const deadPid = 2 ** 22 + 4321;
  assert.equal(isBatchLockStale(holder({}), now, now), false, 'live process, fresh heartbeat');
  assert.equal(isBatchLockStale(holder({ startedAt: at(60 * 60 * 1000) }), now, now), false, 'a long run is fine while it beats');
  assert.equal(isBatchLockStale(holder({ heartbeatAt: at(10 * 60 * 1000) }), now, now), true, 'heartbeat stopped');
  assert.equal(isBatchLockStale(holder({ pid: deadPid }), now, now, { alive: () => false }), true, 'process gone');
  assert.equal(isBatchLockStale(holder({ pid: process.pid, token: 'not-ours' }), now, now), true, 'this pid, but not a lock this process holds');
  assert.equal(isBatchLockStale(holder({ host: 'OTHER-PC', pid: deadPid }), now, now), false, 'another host: heartbeat only');
  assert.equal(isBatchLockStale(null, now - 1000, now), false, 'a half-written file is not stolen');

  const store = storeIn();
  const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows: [receipt(1)] });
  const file = path.join(store.dir, `${j.batchId}.lock`);
  fs.writeFileSync(file, JSON.stringify(holder({ batchId: j.batchId, heartbeatAt: at(10 * 60 * 1000) })));
  const got = store.lock(j.batchId, 'create-vouchers');
  assert.ok(got.ok, 'stale lock taken over');
  got.release();
  fs.writeFileSync(file, JSON.stringify(holder({ batchId: j.batchId })));
  assert.equal(store.lock(j.batchId, 'create-vouchers').ok, false, 'a live holder keeps it');
  fs.unlinkSync(file);
});

test('create-vouchers resume and undo-batch are refused with BUSY while another call holds the batch', async () => {
  const { tally, books } = await fakeBooks();
  const { call, close } = await connect();
  try {
    const store = makeBatchJournalStore(dataDir);
    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const held = store.lock(j.batchId, 'create-vouchers');
    assert.ok(held.ok);
    const resumed = await call('create-vouchers', { vouchers: rows, resumeBatchId: j.batchId });
    assert.equal(resumed.isError, true);
    assert.match(resumed.text, /"code":\s*"BUSY"/);
    assert.match(resumed.text, /still posting batch/);
    const undo = await call('undo-batch', { batchId: j.batchId });
    assert.match(undo.text, /"code":\s*"BUSY"/);
    assert.equal(books.size, 0, 'nothing was posted');
    held.release();
    const after = await call('create-vouchers', { vouchers: rows, resumeBatchId: j.batchId });
    assert.equal(after.isError, false, after.text);
    assert.equal(after.body.posted, 2);
    assert.equal(fs.existsSync(path.join(dataDir, BATCH_DIR_NAME, `${j.batchId}.lock`)), false, 'the run released its lock');
  } finally {
    await close();
    await tally.close();
  }
});

test('a cancelled call stops sending: rows not reached stay pending and are reported NOT_SENT', async () => {
  const { tally, books } = await fakeBooks();
  try {
    for (const chunkSize of [undefined, 1]) {
      const store = storeIn();
      const rows = [receipt(1), receipt(2), receipt(3)];
      const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
      const ctl = new AbortController();
      const before = books.size;
      const execute = (r: any[], o: any) => executeVoucherBatch(r, { exactCompany: 'Acme', ...o, onRow: (row: any) => { o.onRow?.(row); ctl.abort(); } });
      const res = await runJournaledBatch({ store, journal: j, rows, execute, chunkSize, signal: ctl.signal });
      assert.equal(books.size - before, 1, `only the first row was sent (chunkSize ${chunkSize})`);
      assert.deepEqual(res.results.map(r => r.code ?? r.status), ['success', NOT_SENT, NOT_SENT]);
      assert.equal(res.cancelled, true);
      assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['success', 'pending', 'pending']);
    }
  } finally { await tally.close(); }
});

// ── sent, outcome unknown ──

test('a request that failed after reaching Tally is journalled unknown, and is not re-sent blindly', async () => {
  let flaky = true;
  // Tally saves the voucher, but the reply is lost (empty), for rows 1 and 2.
  const { tally, books, deps } = await fakeBooks(block => (flaky && /Party [12]</.test(block) ? { body: '', keep: true } : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), noRef(2), noRef(3)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const seenWhileSending: string[] = [];
    const file = path.join(store.dir, `${j.batchId}.json`);
    const watch = (r: any[], o: any) => executeVoucherBatch(r, { exactCompany: 'Acme', ...o, onBeforeSend: (i: number, info: any) => { o.onBeforeSend(i, info); seenWhileSending.push(JSON.parse(fs.readFileSync(file, 'utf-8')).rows[i].status); } });
    const first = await runJournaledBatch({ store, journal: j, rows, execute: watch as any });
    assert.deepEqual(seenWhileSending, ['sending', 'sending', 'sending'], 'each row is saved as sending before it goes');
    assert.deepEqual(first.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, OUTCOME_UNKNOWN, 'success']);
    assert.equal(first.results[0]!.retryable, false);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['unknown', 'unknown', 'success']);
    assert.equal(books.size, 3, 'Tally did save rows 1 and 2');

    // Resume: the row with a REMOTEID is re-sent (Tally alters by REMOTEID), the one without is refused.
    flaky = false;
    const before = tally.requests.filter(isImport).length;
    const opened = openJournalForResume(store, j.batchId, rows, 'Acme');
    assert.ok(opened.ok);
    const second = await runJournaledBatch({ store, journal: (opened as any).journal, rows, execute: exec() });
    assert.equal(tally.requests.filter(isImport).length - before, 1);
    assert.deepEqual(second.results.map(r => r.code ?? r.status), ['success', OUTCOME_UNKNOWN, 'skipped']);
    assert.match(second.results[1]!.message!, /Check the Day Book for 2026-07-03/);
    assert.equal(store.load(j.batchId)!.rows[1]!.status, 'unknown');

    // Undo lists the unknown row instead of passing over it.
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => [p.index, p.code ?? p.status]), [[0, 'will_delete'], [1, OUTCOME_UNKNOWN], [2, 'will_delete']]);

    // Only after the user confirms it is not in the Day Book is it sent again.
    const third = await runJournaledBatch({ store, journal: store.load(j.batchId)!, rows, execute: exec(), confirmedNotPosted: new Set([1]) });
    assert.deepEqual(third.results.map(r => r.status), ['skipped', 'success', 'skipped']);
  } finally { await tally.close(); }
});

test('a row left "sending" by a crash is treated as outcome unknown on resume', async () => {
  const { tally, books } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [noRef(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    j.rows[0]!.status = 'sending';
    j.rows[1]!.status = 'sending';
    store.save(j);
    const res = await runJournaledBatch({ store, journal: store.load(j.batchId)!, rows, execute: exec() });
    assert.deepEqual(res.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, 'success']);
    assert.equal(books.size, 1);
    // An outcome-unknown row must not have changed before a resume either.
    const changed = openJournalForResume(store, j.batchId, [noRef(9), receipt(2)], 'Acme');
    assert.equal(changed.ok, false);
  } finally { await tally.close(); }
});

test('a re-sent row whose first attempt landed is skipped by skipIfExists, journalled as posted, and undone', async () => {
  let flaky = true;
  // Row 1 reaches Tally on the first run but the reply is lost.
  const { tally, books, deps, lookups } = await fakeBooks(block => (flaky && /UTR1</.test(block) ? { body: '', keep: true } : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1, { skipIfExists: true }), receipt(2, { skipIfExists: true })];
    const j = store.create({ tool: 'import-vouchers', company: 'Acme', rows });
    const opts = { checkExisting: lookups.byReference, checkRemoteId: lookups.byRemoteId };
    const first = await runJournaledBatch({ store, journal: j, rows, execute: exec(opts) });
    assert.deepEqual(first.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, 'success']);
    const [landed, second] = [...books.keys()];
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => [r.preExistingChecked, r.preExistingMasterIds, r.remoteIdMasterIds]), [[true, [], []], [true, [], []]]);

    // Resume: the re-send meets the voucher its own first attempt made, and skips.
    flaky = false;
    const before = tally.requests.filter(isImport).length;
    const opened = openJournalForResume(store, j.batchId, rows, 'Acme');
    assert.ok(opened.ok);
    const res = await runJournaledBatch({ store, journal: (opened as any).journal, rows, execute: exec(opts) });
    assert.equal(tally.requests.filter(isImport).length - before, 0, 'nothing was sent to Tally again');
    assert.deepEqual(res.results.map(r => [r.status, r.masterId]), [['skipped', Number(landed)], ['skipped', Number(second)]]);
    assert.match(res.results[0]!.note!, /answer was lost.*found it as master_id/);
    assert.equal(res.alreadyPosted, 2);
    assert.equal(res.posted, 0);
    const jr = store.load(j.batchId)!.rows[0]!;
    assert.deepEqual([jr.status, jr.masterId, jr.landedEarlier, jr.preExistingMasterIds], ['success', landed, true, []], 'the re-send lookup is not taken for "before the batch"');
    assert.ok(jr.postedHash);

    // undo-batch includes it: deleted with the REMOTEID proof, listed for confirmation without it.
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => [p.masterId, p.status]), [[landed, 'will_delete'], [second, 'will_delete']]);
    const { findByRemoteId: _f, ...noProof } = deps();
    const asked = await planUndo(store.load(j.batchId)!, noProof);
    assert.deepEqual(asked.map(p => [p.masterId, p.status]), [[landed, 'needs_confirmation'], [second, 'will_delete']]);
    assert.match(asked[0]!.message!, /re-sent on resume/);
    assert.deepEqual((await planUndo(store.load(j.batchId)!, noProof, { confirmMasterIds: new Set([landed!]) })).map(p => p.status), ['will_delete', 'will_delete']);
    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, plan, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['deleted', 'deleted']);
    assert.equal(books.size, 0, 'the voucher the lost reply hid is gone too');
  } finally { await tally.close(); }
});

test('a re-sent row refused DUPLICATE_NUMBER by its own first attempt is journalled as posted; a real clash stays an error', async () => {
  let flaky = true;
  // Both rows are sent and their replies lost; only row 1 actually reached Tally.
  const { tally, books, deps, lookups } = await fakeBooks(block => (flaky && /UTR[12]</.test(block) ? { body: '', keep: /UTR1</.test(block) } : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1, { voucherNumber: 'R-1' }), receipt(2, { voucherNumber: 'R-2' })];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const opts = { checkExisting: lookups.byReference, checkRemoteId: lookups.byRemoteId, numberingFor: async () => 'Manual', checkDuplicateNumber: lookups.byNumber };
    const first = await runJournaledBatch({ store, journal: j, rows, execute: exec(opts) });
    assert.deepEqual(first.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, OUTCOME_UNKNOWN]);
    const [landed] = [...books.keys()];
    // Meanwhile somebody keys another receipt numbered R-2 by hand.
    books.set('5000', '<VOUCHER VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-2</VOUCHERNUMBER><REFERENCE>OTHER</REFERENCE></VOUCHER>');

    flaky = false;
    const before = tally.requests.filter(isImport).length;
    const res = await runJournaledBatch({ store, journal: store.load(j.batchId)!, rows, execute: exec(opts) });
    assert.equal(tally.requests.filter(isImport).length - before, 0);
    assert.deepEqual(res.results.map(r => r.code ?? r.status), ['skipped', 'DUPLICATE_NUMBER']);
    assert.equal(res.results[0]!.masterId, Number(landed));
    assert.deepEqual(res.results[1]!.existing, [{ masterId: '5000', reference: 'OTHER' }], 'the refusal names the voucher it met');
    const jr = store.load(j.batchId)!.rows;
    assert.deepEqual(jr.map(r => [r.status, r.masterId, r.landedEarlier]), [['success', landed, true], ['error', undefined, undefined]],
      'R-2 belongs to a voucher with another reference: the first attempt did not land, the refusal stands');
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => [p.index, p.masterId, p.status]), [[0, landed, 'will_delete']]);
  } finally { await tally.close(); }
});

test('an atomic resume is not aborted by a row whose own earlier attempt holds its number', async () => {
  let flaky = true;
  // Row 1 lands with its reply lost; row 3 is rejected by Tally outright.
  const { tally, books, lookups } = await fakeBooks(block => (!flaky ? undefined : /UTR1</.test(block) ? { body: '', keep: true } : /UTR3</.test(block) ? importRejected('nope') : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1, { voucherNumber: 'R-1' }), receipt(3, { voucherNumber: 'R-3' })];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const opts = { checkExisting: lookups.byReference, checkRemoteId: lookups.byRemoteId, numberingFor: async () => 'Manual', checkDuplicateNumber: lookups.byNumber };
    const first = await runJournaledBatch({ store, journal: j, rows, execute: exec(opts) });
    assert.deepEqual(first.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, 'UNKNOWN']);
    const [landed] = [...books.keys()];
    flaky = false;
    const before = tally.requests.filter(isImport).length;
    const res = await runJournaledBatch({ store, journal: store.load(j.batchId)!, rows, execute: exec(opts), atomic: true });
    assert.equal(res.aborted, false);
    assert.deepEqual(res.results.map(r => [r.status, r.masterId === Number(landed)]), [['skipped', true], ['success', false]]);
    assert.equal(tally.requests.filter(isImport).length - before, 1, 'only row 3 was sent');
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => [r.status, r.landedEarlier]), [['success', true], ['success', undefined]]);
  } finally { await tally.close(); }
});

test('a re-sent row whose earlier attempt cannot be told apart stays outcome-unknown, and undo lists it', async () => {
  let flaky = true;
  let readable = false;
  const { tally, books, deps, lookups } = await fakeBooks(block => (flaky ? { body: '', keep: true } : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1, { skipIfExists: true }), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    // The first run could not read Tally before sending, so what was there before the batch is unknown.
    const checkExisting = async (ref: string) => (readable ? lookups.byReference(ref) : null);
    await runJournaledBatch({ store, journal: j, rows, execute: exec({ checkExisting, checkRemoteId: async () => null }) });
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => [r.status, r.preExistingChecked]), [['unknown', undefined], ['unknown', undefined]]);
    const [first] = [...books.keys()];

    // Resume: row 1 is skipped on a voucher that may be its own or an older one; row 2 is refused before
    // it is sent (its ledger is not known any more). Neither says what happened to the earlier attempt.
    flaky = false;
    readable = true;
    const res = await runJournaledBatch({ store, journal: store.load(j.batchId)!, rows, execute: exec({ checkExisting, checkRemoteId: lookups.byRemoteId, knownLedgers: ['HDFC Bank', 'Party 1'] }) });
    assert.deepEqual(res.results.map(r => r.code ?? r.status), [OUTCOME_UNKNOWN, OUTCOME_UNKNOWN]);
    assert.match(res.results[0]!.message!, new RegExp(`matching master_id ${first}`));
    assert.match(res.results[1]!.message!, /refused \(MASTER_NOT_FOUND[\s\S]*still not known/);
    assert.equal(res.results[1]!.retryable, false);
    const jr = store.load(j.batchId)!.rows;
    assert.deepEqual(jr.map(r => [r.status, r.code, r.candidateMasterIds]), [['unknown', OUTCOME_UNKNOWN, [first]], ['unknown', OUTCOME_UNKNOWN, undefined]]);
    assert.match(jr[1]!.message!, /MASTER_NOT_FOUND[\s\S]*still not known/);
    assert.deepEqual(jr.map(r => r.preExistingChecked), [undefined, undefined], 'the re-send lookups are not taken for "before the batch"');

    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => [p.status, p.code, p.masterId]), [['needs_confirmation', OUTCOME_UNKNOWN, first], ['error', OUTCOME_UNKNOWN, '']]);
    assert.deepEqual(plan[0]!.candidateMasterIds, [first]);
    // Confirming the candidate deletes it, after the same change check as any other voucher.
    const confirmed = await planUndo(store.load(j.batchId)!, deps(), { confirmMasterIds: new Set([first!]) });
    assert.deepEqual(confirmed.map(p => p.status), ['will_delete', 'error']);
    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, confirmed, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['deleted', 'error']);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['undone', 'unknown']);
  } finally { await tally.close(); }
});

test('settleResend: only an unambiguous voucher that was not there before the batch is taken as the earlier attempt', () => {
  const skip = (...ids: Array<[string, string?]>) => ({ index: 0, status: 'skipped' as const, existing: ids.map(([masterId, reference]) => ({ masterId, ...(reference ? { reference } : {}) })) });
  const dup = (...ids: Array<[string, string?]>) => ({ ...skip(...ids), status: 'error' as const, code: 'DUPLICATE_NUMBER' });
  const checked = { reference: 'INV-1', preExistingMasterIds: ['10'], preExistingChecked: true };
  assert.deepEqual(settleResend(checked, skip(['10', 'INV-1'], ['11', 'INV-1'])), { kind: 'landed', masterId: '11' });
  assert.deepEqual(settleResend(checked, skip(['10', 'INV-1'])), { kind: 'not_ours' }, 'only what was there before: the skip stands');
  assert.deepEqual(settleResend(checked, skip(['11'], ['12'])), { kind: 'unknown', candidates: ['11', '12'] }, 'two new ones: cannot tell');
  assert.deepEqual(settleResend({ ...checked, preExistingChecked: undefined, preExistingMasterIds: undefined }, skip(['11'])), { kind: 'unknown', candidates: ['11'] }, 'no pre-send lookup: cannot tell');
  assert.deepEqual(settleResend(checked, dup(['11', 'inv-1 '])), { kind: 'landed', masterId: '11' }, 'number clash carrying the reference');
  assert.deepEqual(settleResend(checked, dup(['11', 'OTHER'])), { kind: 'not_ours' }, 'number clash with someone else');
  assert.deepEqual(settleResend(checked, { index: 0, status: 'skipped' }), { kind: 'unknown', candidates: [] }, 'a skip that names nothing');
  assert.deepEqual(settleResend(checked, { index: 0, status: 'error', code: 'BUSY' }), { kind: 'unknown', candidates: [] });
  assert.deepEqual(settleResend(checked, skip(['0'])), { kind: 'not_ours' }, 'never a "0" master id');
});

test('only transport failures count as an unknown outcome, never a definite Tally answer', () => {
  const row = (message: string) => ({ index: 0, status: 'error' as const, code: 'UNKNOWN', message });
  for (const m of ['Server exception', 'Empty response received from Tally', 'Unexpected response format from Tally']) assert.equal(isTransportOutcomeUnknown(row(m)), true, m);
  for (const m of ['Tally is not responding (ping timed out). Dismiss any Tally popups and retry, or restart Tally.', "Ledger 'X' does not exist!", 'Failed to create voucher.']) assert.equal(isTransportOutcomeUnknown(row(m)), false, m);
  assert.equal(isTransportOutcomeUnknown({ index: 0, status: 'error', code: 'BUSY', message: 'Server exception' }), false);
});

// ── vouchers Tally altered instead of created ──

test('undo never deletes a voucher that was already in Tally and that the batch only altered', async () => {
  // UTR55 is an invoice posted last week (master id 777); re-posting it makes Tally alter 777.
  const { tally, books, deps } = await fakeBooks(block => (/<REFERENCE>UTR55</.test(block) ? altered(777) : undefined));
  try {
    books.set('777', '<VOUCHER VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME></VOUCHER>');
    let lookups = 0;
    const checkExisting = async (ref: string) => { lookups++; return ref === 'UTR55' ? [{ master_id: '777' }] : []; };
    const store = storeIn();
    const rows = [receipt(55), receipt(1, { skipIfExists: true })];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const res = await runJournaledBatch({ store, journal: j, rows, execute: exec({ checkExisting }) });
    assert.deepEqual(res.results.map(r => r.status), ['success', 'success']);
    assert.equal(lookups, 2, 'the skipIfExists check reuses the pre-send lookup: one read per row');
    // Tally altered 777 with this batch's posting (what it does with a matching REMOTEID).
    books.set('777', voucherBlockOf(tally.requests.filter(isImport)[0]!));
    const jr = store.load(j.batchId)!.rows;
    assert.deepEqual([jr[0]!.created, jr[0]!.altered, jr[0]!.preExistingMasterIds, jr[0]!.preExistingChecked], [0, 1, ['777'], true]);
    assert.deepEqual([jr[1]!.created, jr[1]!.preExistingMasterIds], [1, []]);

    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => p.status), ['existed_before', 'will_delete']);
    assert.match(plan[0]!.message!, /already in Tally before this batch/);
    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, plan, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['existed_before', 'deleted']);
    assert.ok(books.has('777'), 'the pre-existing voucher stays in the books');
    // Only an explicit confirmation by master id lets it go (still checked for changes).
    const confirmed = await planUndo(store.load(j.batchId)!, deps(), { confirmMasterIds: new Set(['777']) });
    assert.deepEqual(confirmed.map(p => p.status), ['will_delete']);
  } finally { await tally.close(); }
});

test('an altered row is never deleted on the reference lookup alone: it asks for confirmation', async () => {
  const { tally, books, deps } = await fakeBooks(block => (/<REFERENCE>UTR[12]</.test(block) ? altered(/UTR1</.test(block) ? 801 : 802) : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    // Row 1's lookup fails (read error); row 2's succeeds and finds nothing by reference. Tally altered both,
    // and with no REMOTEID lookup nothing shows that 802 is new: an earlier voucher sharing the REMOTEID
    // under another reference spelling would look exactly like this.
    await runJournaledBatch({ store, journal: j, rows, execute: exec({ checkExisting: async (ref: string) => (ref === 'UTR1' ? null : []) }) });
    const imports = tally.requests.filter(isImport);
    books.set('801', voucherBlockOf(imports[0]!));
    books.set('802', voucherBlockOf(imports[1]!));
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => p.status), ['needs_confirmation', 'needs_confirmation']);
    assert.match(plan[0]!.message!, /could not be checked whether that voucher existed before/);
    assert.match(plan[1]!.message!, /Tally alters by REMOTEID[\s\S]*could not be ruled out/);
    assert.deepEqual((await planUndo(store.load(j.batchId)!, deps(), { confirmMasterIds: new Set(['801']) })).map(p => p.status), ['will_delete', 'needs_confirmation']);
  } finally { await tally.close(); }
});

test('an altered row proven new by its REMOTEID (nothing bound before, this voucher bound now) is undoable', async () => {
  // The retry-after-rejection case: no voucher held the REMOTEID, yet Tally reports the write as an alter.
  let ledger: Map<string, string> | undefined;
  const { tally, books, deps, lookups } = await fakeBooks(block => (/<REFERENCE>UTR3</.test(block) ? (ledger!.set('901', block), altered(901)) : undefined));
  ledger = books;
  try {
    const store = storeIn();
    const rows = [receipt(3)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec({ checkExisting: lookups.byReference, checkRemoteId: lookups.byRemoteId }) });
    const jr = store.load(j.batchId)!.rows[0]!;
    assert.deepEqual([jr.created, jr.altered, jr.remoteIdMasterIds, jr.masterId], [0, 1, [], '901']);
    assert.deepEqual((await planUndo(store.load(j.batchId)!, deps())).map(p => p.status), ['will_delete']);
    // A build whose REMOTEID lookup sees nothing cannot prove it, so it asks instead.
    const blind = { ...deps(), findByRemoteId: async () => [] };
    assert.deepEqual((await planUndo(store.load(j.batchId)!, blind)).map(p => p.status), ['needs_confirmation']);
    // So does a failed read, or an undo without the lookup at all.
    assert.deepEqual((await planUndo(store.load(j.batchId)!, { ...deps(), findByRemoteId: async () => null })).map(p => p.status), ['needs_confirmation']);
    const { findByRemoteId: _f, ...without } = deps();
    assert.deepEqual((await planUndo(store.load(j.batchId)!, without)).map(p => p.status), ['needs_confirmation']);
  } finally { await tally.close(); }
});

test('a voucher Tally altered through a slug-equivalent or cancelled REMOTEID twin is never will_delete', async () => {
  const { tally, books, deps, lookups } = await fakeBooks(undefined, { alterByRemoteId: true });
  // 777: an invoice keyed in last month as "INV/55" (same REMOTEID as "INV 55": TMCP-Receipt-INV-55).
  // 778: a CANCELLED voucher with exactly the row's reference, which the live-only reference lookup skips.
  const seed = () => {
    books.clear();
    books.set('777', '<VOUCHER REMOTEID="TMCP-Receipt-INV-55" VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>INV/55</REFERENCE></VOUCHER>');
    books.set('778', '<VOUCHER REMOTEID="TMCP-Receipt-UTR9" VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>UTR9</REFERENCE><ISCANCELLED>Yes</ISCANCELLED></VOUCHER>');
  };
  const rows = [receipt(1, { reference: 'INV 55' }), receipt(9), receipt(2)];
  const post = async (extra: object) => {
    seed();
    const store = storeIn();
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const res = await runJournaledBatch({ store, journal: j, rows, execute: exec({ checkExisting: lookups.byReference, ...extra }) });
    assert.deepEqual(res.results.map(r => [r.created, r.altered]), [[0, 1], [0, 1], [1, 0]], 'Tally altered 777 and 778 and created row 2');
    assert.deepEqual(res.results.map(r => r.masterId).slice(0, 2), [777, 778]);
    return store.load(j.batchId)!;
  };
  try {
    // With the REMOTEID lookup, both twins are recorded as there before the batch.
    const found = await post({ checkRemoteId: lookups.byRemoteId });
    assert.deepEqual(found.rows.map(r => r.preExistingMasterIds), [['777'], ['778'], []]);
    const plan = await planUndo(found, deps());
    assert.deepEqual(plan.map(p => p.status), ['existed_before', 'existed_before', 'will_delete']);
    // Without it (lookup failed, or a build that cannot read REMOTEIDs) they are still never will_delete.
    const blind = { ...deps(), findByRemoteId: async () => [] };
    const cases: Array<[string, object, UndoDeps[]]> = [
      // No REMOTEID lookup before the send, or a failed one: even a working lookup at undo time proves
      // nothing, since what was bound before the batch is not known.
      ['not looked up', {}, [deps(), blind]],
      ['lookup failed', { checkRemoteId: async () => null }, [deps(), blind]],
      // A build whose $RemoteID reads empty: it finds nothing before the send AND nothing at undo time
      // (the same Tally), so the proof — the lookup seeing this very voucher — never comes.
      ['build cannot read REMOTEIDs', { checkRemoteId: async () => [] }, [blind]],
    ];
    for (const [what, extra, undoDeps] of cases) {
      const missed = await post(extra);
      assert.deepEqual(missed.rows.map(r => r.preExistingMasterIds), [[], [], []], 'the reference lookup alone misses both');
      for (const d of undoDeps) {
        const p = await planUndo(missed, d);
        assert.deepEqual(p.map(x => x.status), ['needs_confirmation', 'needs_confirmation', 'will_delete'], what);
      }
      // The user can still confirm one, by master id.
      assert.deepEqual((await planUndo(missed, blind, { confirmMasterIds: new Set(['777']) })).map(p => p.status), ['will_delete', 'needs_confirmation', 'will_delete']);
    }
  } finally { await tally.close(); }
});

test('voucher-by-remoteid filters on the REMOTEID and keeps cancelled and optional vouchers', () => {
  assert.deepEqual(reportColumnMetadata('voucher-by-remoteid')!.map(f => f.name),
    ['master_id', 'date', 'voucher_number', 'voucher_type', 'reference', 'party_ledger', 'amount', 'is_cancelled', 'is_optional', 'remote_id']);
  const xml = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'voucher-by-remoteid.xml'), 'utf-8');
  // The value travels as a Tally variable, never pasted into the formula (template-injection.test).
  assert.match(xml, /<MCPREMOTEID>\{remoteId\}<\/MCPREMOTEID>/);
  assert.match(xml, /FilterRemoteId">\$RemoteID = ##MCPRemoteId OR \$Guid = ##MCPRemoteId</);
  assert.match(xml, /<FILTER>FilterRemoteId<\/FILTER>/);
  assert.doesNotMatch(xml, /NOT \$IsCancelled|NOT \$IsOptional/, 'an alter matches a cancelled or optional voucher too');
});

test('create-vouchers + undo-batch: a voucher altered through a slug-equivalent reference is listed as existed-before, never deleted', async () => {
  const { tally, books } = await fakeBooks(undefined, { alterByRemoteId: true });
  const { call, close } = await connect();
  try {
    // Keyed earlier as "INV/61"; the batch's "INV 61" derives the same REMOTEID, so Tally alters 777.
    books.set('777', '<VOUCHER REMOTEID="TMCP-Receipt-INV-61" VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>INV/61</REFERENCE></VOUCHER>');
    const posted = await call('create-vouchers', { vouchers: [receipt(61, { reference: 'INV 61' }), receipt(62)] });
    assert.equal(posted.isError, false, posted.text);
    assert.deepEqual(posted.body.results.map((r: any) => [r.created, r.altered]), [[0, 1], [1, 0]]);
    assert.equal(posted.body.results[0].masterId, 777);
    assert.ok(tally.requests.some(x => /<MCPREMOTEID>TMCP-Receipt-INV-61<\/MCPREMOTEID>/.test(x)), 'the REMOTEID was looked up before sending');
    const preview = await call('undo-batch', { batchId: posted.body.batchId });
    assert.equal(preview.isError, false, preview.text);
    assert.deepEqual(preview.body.existedBefore.map((p: any) => p.masterId), ['777']);
    assert.ok(!preview.body.wouldDelete.some((p: any) => p.masterId === '777'));
    assert.ok(books.has('777'));
  } finally {
    await close();
    await tally.close();
  }
});

// ── master ids ──

test('a success without a real master id is journalled without one, and undo reports it instead of calling it gone', async () => {
  const noId = '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>';
  const { tally, deps } = await fakeBooks(block => (/UTR1</.test(block) ? noId : undefined));
  try {
    assert.equal(validMasterId(0), undefined);
    assert.equal(validMasterId('0'), undefined);
    assert.equal(validMasterId('abc'), undefined);
    assert.equal(validMasterId(-3), undefined);
    assert.equal(validMasterId(1001), '1001');
    const store = storeIn();
    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    const jr = store.load(j.batchId)!.rows;
    assert.equal(jr[0]!.status, 'success');
    assert.equal(jr[0]!.masterId, undefined, 'no "0" in the journal');
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => p.status), ['error', 'will_delete']);
    assert.match(plan[0]!.message!, /master id for it was not recorded/);
    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, plan, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['error', 'deleted']);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['success', 'undone'], 'never marked undone while it is still in the books');
  } finally { await tally.close(); }
});

// ── voucher type spelling ──

test('undo resolves a voucher whose type the caller spelled in another case than Tally stores it', async () => {
  const { tally, books, deps } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [receipt(1, { voucherType: 'receipt' }), receipt(2, { voucherType: ' RECEIPT ' })];
    const j = store.create({ tool: 'import-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec({ knownVoucherTypes: ['Receipt'] }) });
    assert.deepEqual([...books.values()].map(b => (/<VOUCHERTYPENAME>([^<]*)</.exec(b) || [])[1]), ['Receipt', 'Receipt'], 'posted under the stored spelling');
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => p.status), ['will_delete', 'will_delete']);

    const locate = async () => ({ voucher: { master_id: '5', voucher_type: 'Receipt', voucher_number: '7' } });
    assert.equal((await resolveUndoTarget('5', 'receipt', locate)).status, 'resolved');
    assert.equal((await resolveUndoTarget('5', 'Payment', locate)).status, 'mismatch');
    assert.equal((await resolveUndoTarget('5', 'Receipt', async () => ({ voucher: null }))).status, 'already_gone');
    assert.equal((await resolveUndoTarget('5', 'Receipt', async () => ({ error: 'down' }))).status, 'error');
  } finally { await tally.close(); }
});

// ── a batch whose result never arrived ──

test('the same rows sent again are matched to the earlier batch that put them in Tally', async () => {
  const { tally } = await fakeBooks(block => (/Party 2</.test(block) ? '<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>nope</LINEERROR></RESPONSE>' : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2), receipt(3)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    const found = findEarlierBatch(store, 'create-vouchers', 'ACME', rows.map(r => ({ ...r, targetCompany: 'Acme', skipIfExists: true })));
    assert.deepEqual(found && { ...found, createdAt: undefined }, { batchId: j.batchId, createdAt: undefined, posted: 2, outcomeUnknown: 0, failed: 1, notSent: 0 });
    assert.equal(findEarlierBatch(store, 'create-vouchers', 'Acme', [receipt(1), receipt(2), receipt(4)]), null, 'other rows');
    assert.equal(findEarlierBatch(store, 'import-vouchers', 'Acme', rows), null, 'other tool');
    assert.equal(findEarlierBatch(store, 'create-vouchers', 'Other', rows), null, 'other company');
    // A batch of which nothing reached Tally is no reason to refuse.
    const failedOnly = [receipt(2)];
    const k = store.create({ tool: 'create-vouchers', company: 'Acme', rows: failedOnly });
    await runJournaledBatch({ store, journal: k, rows: failedOnly, execute: exec() });
    assert.equal(findEarlierBatch(store, 'create-vouchers', 'Acme', failedOnly), null);
    // Nor is an undone one.
    const undone = store.load(j.batchId)!;
    undone.rows.forEach(r => { if (r.status === 'success') r.status = 'undone'; });
    store.save(undone);
    assert.equal(findEarlierBatch(store, 'create-vouchers', 'Acme', rows), null);
  } finally { await tally.close(); }
});

test('create-vouchers: re-sending the rows of a batch whose result was lost names that batch and posts nothing', async () => {
  const { tally, books } = await fakeBooks();
  const { call, close } = await connect();
  try {
    const rows = [noRef(31), noRef(32)];
    const first = await call('create-vouchers', { vouchers: rows });
    assert.equal(first.isError, false, first.text);
    assert.equal(books.size, 2);
    // The caller never saw that result (client timeout) and sends the batch again.
    const again = await call('create-vouchers', { vouchers: rows });
    assert.equal(again.isError, true);
    assert.match(again.text, new RegExp(`resumeBatchId:\\\\?"${first.body.batchId}`));
    assert.equal(books.size, 2, 'nothing was posted twice');
    // The preview says so too.
    const preview = await call('create-vouchers', { vouchers: rows, dryRun: true });
    assert.equal(preview.body.earlierBatch.batchId, first.body.batchId);
    // Resuming it is a no-op; only an explicit newBatch books them again.
    const resumed = await call('create-vouchers', { vouchers: rows, resumeBatchId: first.body.batchId });
    assert.equal(resumed.body.posted, 0);
    assert.equal(resumed.body.alreadyPosted, 2);
    const forced = await call('create-vouchers', { vouchers: rows, newBatch: true });
    assert.equal(forced.isError, false, forced.text);
    assert.equal(books.size, 4);
  } finally {
    await close();
    await tally.close();
  }
});

// ── idempotency keys that resume ──

test('idempotentResumeTarget: resume an unfinished run or retryable rows, replay a settled result', () => {
  const id = 'b-20261123-101010-abcdef';
  assert.equal(idempotentResumeTarget({ inProgress: true, batchId: id }), id);
  assert.equal(idempotentResumeTarget({ batchId: id, results: [{ index: 0, status: 'success' }, { index: 1, status: 'error', code: 'BUSY', retryable: true }] }), id);
  assert.equal(idempotentResumeTarget({ batchId: id, results: [{ index: 0, status: 'error', code: NOT_SENT }] }), id);
  assert.equal(idempotentResumeTarget({ batchId: id, results: [{ index: 0, status: 'success' }, { index: 1, status: 'error', code: 'MASTER_NOT_FOUND', retryable: false }] }), null);
  assert.equal(idempotentResumeTarget({ batchId: id, results: [{ index: 0, status: 'error', code: OUTCOME_UNKNOWN, retryable: false }] }), null, 'needs a person, not a retry');
  assert.equal(idempotentResumeTarget({ results: [{ index: 0, status: 'error', retryable: true }] }), null, 'no batch to resume');
  assert.equal(idempotentResumeTarget(null), null);
});

test('create-vouchers: a replayed key resumes rows left BUSY or a run that never finished, and never re-posts', async () => {
  const { tally, books } = await fakeBooks();
  const { call, close } = await connect();
  try {
    const journals = makeBatchJournalStore(dataDir);
    const keys = makeIdempotencyStore(dataDir);
    const rows = [noRef(41), noRef(42)];
    // An earlier call posted row 0 and got BUSY for row 1 (another window was reloading Tally).
    const j = journals.create({ tool: 'create-vouchers', company: 'Acme', rows });
    j.rows[0]!.status = 'success'; j.rows[0]!.masterId = '9001'; j.rows[1]!.status = 'error'; j.rows[1]!.code = 'BUSY';
    journals.save(j);
    keys.put('batch:k-busy', { batchId: j.batchId, results: [{ index: 0, status: 'success', masterId: 9001 }, { index: 1, status: 'error', code: 'BUSY', retryable: true }] }, new Date().toISOString());
    const retry = await call('create-vouchers', { vouchers: rows, idempotencyKey: 'k-busy' });
    assert.equal(retry.isError, false, retry.text);
    assert.equal(retry.body.idempotentReplay, undefined, 'resumed, not replayed');
    assert.equal(retry.body.batchId, j.batchId);
    assert.deepEqual(retry.body.results.map((r: any) => r.status), ['skipped', 'success']);
    assert.equal(books.size, 1, 'only the BUSY row was posted');
    // Now settled: the same key replays.
    const replay = await call('create-vouchers', { vouchers: rows, idempotencyKey: 'k-busy' });
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(books.size, 1);

    // A run that wrote its in-progress marker and never finished (crash, timeout) is resumed by the key.
    const rows2 = [noRef(43)];
    const k = journals.create({ tool: 'create-vouchers', company: 'Acme', rows: rows2 });
    keys.put('batch:k-crash', { inProgress: true, batchId: k.batchId }, new Date().toISOString());
    const resumed = await call('create-vouchers', { vouchers: rows2, idempotencyKey: 'k-crash' });
    assert.equal(resumed.body.batchId, k.batchId);
    assert.equal(resumed.body.posted, 1);
    // A new keyed call records its batchId under the key at the start, then the result at the end.
    const fresh = await call('create-vouchers', { vouchers: [noRef(44)], idempotencyKey: 'k-new' });
    assert.equal((keys.get('batch:k-new')!.result as any).batchId, fresh.body.batchId);
    // An explicit resumeBatchId is never short-circuited by a settled key.
    const explicit = await call('create-vouchers', { vouchers: rows, idempotencyKey: 'k-busy', resumeBatchId: j.batchId });
    assert.equal(explicit.body.idempotentReplay, undefined);
    assert.equal(explicit.body.alreadyPosted, 2);
  } finally {
    await close();
    await tally.close();
  }
});
