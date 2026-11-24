import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeVoucherBatch } from './mcp.mjs';
import {
  BATCH_DIR_NAME, canonicalJson, executeUndo, isValidBatchId, makeBatchJournalStore, newBatchId, normalizedPostingFromExport,
  normalizedPostingFromInput, openJournalForResume, planUndo, postingHash, runJournaledBatch, voucherInputHash, type UndoDeps,
} from './batch-journal.mjs';
import { importOk, importRejected, isImport, startFakeTally, voucherBlockOf } from './testkit-fake-tally.mjs';

// Batch journal, resume and undo (#31). Posting runs through the REAL executeVoucher → pushXml path
// against a fake Tally on a local port; undo runs against the same fake's voucher store.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
process.env.TALLY_DATA_PATH = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const receipt = (n: number, over: object = {}) => ({
  voucherType: 'Receipt', date: '2026-07-03', reference: `UTR${n}`, narration: `row ${n}`,
  entries: [{ ledger: 'HDFC Bank', drCr: 'dr' as const, amount: 100 + n }, { ledger: `Party ${n}`, drCr: 'cr' as const, amount: 100 + n }],
  ...over,
});

// A fake Tally that keeps what it was sent: masterId → voucher block. `reject` decides which imports fail.
async function fakeBooks(reject: (block: string) => string | undefined = () => undefined) {
  const books = new Map<string, string>();
  let next = 1000;
  const tally = await startFakeTally(xml => {
    if (!isImport(xml)) return undefined;
    const block = voucherBlockOf(xml);
    const why = reject(block);
    if (why) return importRejected(why);
    const id = ++next;
    books.set(String(id), block);
    return importOk(id);
  });
  const deps = (): UndoDeps => ({
    resolve: async (masterId, voucherType) => {
      const b = books.get(masterId);
      if (!b) return { status: 'already_gone', message: `master_id ${masterId} no longer exists` };
      const type = (/<VOUCHERTYPENAME>([^<]*)</.exec(b) || [])[1];
      if (type !== voucherType) return { status: 'mismatch', message: 'wrong type' };
      return { status: 'resolved', located: { master_id: masterId, voucher_type: type, voucher_number: '', date: '2026-07-03' } };
    },
    fetchBlock: async located => ({ block: books.get(String(located.master_id)) }),
    deleteOne: async located => (books.delete(String(located.master_id)) ? { status: 'deleted', deleteForm: 'derived-remoteid' } : { status: 'failed', message: 'gone' }),
  });
  return { books, tally, deps };
}

const storeIn = () => makeBatchJournalStore(fs.mkdtempSync(path.join(dataDir, 'store-')));
const exec = (company = 'Acme') => (r: any[], o: any) => executeVoucherBatch(r, { exactCompany: company, ...o });

test('batch ids are unique, time-stamped and strictly validated (they become file names)', () => {
  const id = newBatchId(new Date(2026, 10, 23, 9, 5, 7));
  assert.match(id, /^b-20261123-090507-[a-z0-9]{6}$/);
  assert.equal(isValidBatchId(id), true);
  assert.notEqual(newBatchId(), newBatchId());
  for (const bad of ['../../etc/passwd', 'b-20261123-090507-ABCDEF', 'b-20261123-090507-abc', '', null, 42]) assert.equal(isValidBatchId(bad), false, String(bad));
});

test('the input hash ignores key order and control flags, but not content', () => {
  const a = receipt(1);
  const b = JSON.parse(canonicalJson(a));
  assert.equal(voucherInputHash(a), voucherInputHash({ ...b, skipIfExists: true, targetCompany: 'X', allowDuplicateNumber: true }));
  assert.notEqual(voucherInputHash(a), voucherInputHash(receipt(1, { narration: 'changed' })));
});

test('partial failure: the journal records exactly which rows posted, and the result has the batchId', async () => {
  const { tally, books } = await fakeBooks(block => (/Party 2</.test(block) ? "Ledger 'Party 2' does not exist!" : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2), receipt(3)];
    const journal = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const res = await runJournaledBatch({ store, journal, rows, execute: exec() });
    assert.equal(res.batchId, journal.batchId);
    assert.deepEqual(res.results.map(r => r.status), ['success', 'error', 'success']);
    assert.equal(res.posted, 2);
    assert.equal(books.size, 2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(store.dir, `${journal.batchId}.json`), 'utf-8'));
    assert.deepEqual(onDisk.rows.map((r: any) => r.status), ['success', 'error', 'success']);
    assert.equal(onDisk.rows[0].masterId, '1001');
    assert.equal(onDisk.rows[0].remoteId, 'TMCP-Receipt-UTR1');
    assert.equal(onDisk.rows[0].amount, 101);
    assert.match(onDisk.rows[1].message, /Party 2/);
    assert.ok(onDisk.rows[0].postedHash && onDisk.rows[0].postedAt);
    assert.equal(onDisk.company, 'Acme');
  } finally { await tally.close(); }
});

test('the journal is written after EVERY row, so a crash mid-batch leaves it accurate', async () => {
  const { tally } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2), receipt(3)];
    const journal = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const snapshots: string[][] = [];
    const file = path.join(store.dir, `${journal.batchId}.json`);
    // An executor that "crashes" after the second row: whatever is on disk at that point is what a
    // resume would see.
    const crashing = async (r: any[], o: any) => executeVoucherBatch(r.slice(0, 2), { exactCompany: 'Acme', ...o, onRow: (row: any) => { o.onRow(row); snapshots.push(JSON.parse(fs.readFileSync(file, 'utf-8')).rows.map((x: any) => x.status)); } });
    await runJournaledBatch({ store, journal, rows, execute: crashing as any });
    assert.deepEqual(snapshots[0], ['success', 'pending', 'pending']);
    assert.deepEqual(snapshots[1], ['success', 'success', 'pending']);
  } finally { await tally.close(); }
});

test('resume posts only the rows not yet in Tally, under the same batchId', async () => {
  let failParty2 = true;
  const { tally, books } = await fakeBooks(block => (failParty2 && /Party 2</.test(block) ? "Ledger 'Party 2' does not exist!" : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2), receipt(3)];
    const first = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: first, rows, execute: exec() });
    assert.equal(books.size, 2);

    failParty2 = false; // the ledger has been created in Tally
    const opened = openJournalForResume(store, first.batchId, rows, 'acme');
    assert.ok(opened.ok);
    const before = tally.requests.filter(isImport).length;
    const res = await runJournaledBatch({ store, journal: (opened as any).journal, rows, execute: exec() });
    assert.equal(tally.requests.filter(isImport).length - before, 1, 'only the missing row was sent');
    assert.equal(res.batchId, first.batchId);
    assert.equal(res.posted, 1);
    assert.equal(res.alreadyPosted, 2);
    assert.deepEqual(res.results.map(r => r.status), ['skipped', 'success', 'skipped']);
    assert.match(res.results[0]!.note!, /Already posted by batch/);
    assert.equal(books.size, 3);
    assert.deepEqual(store.load(first.batchId)!.rows.map(r => r.status), ['success', 'success', 'success']);

    // A second resume has nothing left to do.
    const again = await runJournaledBatch({ store, journal: store.load(first.batchId)!, rows, execute: exec() });
    assert.equal(again.posted, 0);
    assert.equal(books.size, 3);
  } finally { await tally.close(); }
});

test('resume is refused when a row it would skip has changed, or the batch is not the same', async () => {
  const { tally } = await fakeBooks(block => (/Party 2</.test(block) ? 'nope' : undefined));
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    const changed = openJournalForResume(store, j.batchId, [receipt(1, { entries: [{ ledger: 'HDFC Bank', drCr: 'dr', amount: 999 }, { ledger: 'Party 1', drCr: 'cr', amount: 999 }] }), receipt(2)], 'Acme');
    assert.equal(changed.ok, false);
    assert.equal((changed as any).code, 'PRECONDITION_FAILED');
    assert.match((changed as any).message, /rows 0 \(0-based\)/);
    // The row that did NOT post may be corrected.
    assert.equal(openJournalForResume(store, j.batchId, [receipt(1), receipt(2, { narration: 'fixed' })], 'Acme').ok, true);
    assert.equal((openJournalForResume(store, j.batchId, [receipt(1)], 'Acme') as any).code, 'PRECONDITION_FAILED');
    assert.equal((openJournalForResume(store, j.batchId, rows, 'Other Co') as any).code, 'COMPANY_MISMATCH');
    assert.equal((openJournalForResume(store, 'b-20990101-000000-zzzzzz', rows, 'Acme') as any).code, 'PRECONDITION_FAILED');
    assert.equal((openJournalForResume(store, '../x', rows, 'Acme') as any).code, 'PRECONDITION_FAILED');
  } finally { await tally.close(); }
});

test('atomic: a validation failure anywhere aborts before the first chunk, and is journalled', async () => {
  const { tally, books } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2, { entries: [{ ledger: 'A', drCr: 'dr', amount: 5 }, { ledger: 'B', drCr: 'cr', amount: 4 }] }), receipt(3)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    const res = await runJournaledBatch({ store, journal: j, rows, execute: exec(), atomic: true, chunkSize: 1 });
    assert.equal(res.aborted, true);
    assert.equal(res.posted, 0);
    assert.equal(books.size, 0);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['pending', 'error', 'pending']);
  } finally { await tally.close(); }
});

test('chunks: each chunk is summarised and indexes stay aligned to the input', async () => {
  const { tally, books } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = Array.from({ length: 7 }, (_, i) => receipt(i));
    const j = store.create({ tool: 'import-vouchers', company: 'Acme', rows });
    const res = await runJournaledBatch({ store, journal: j, rows, execute: exec(), chunkSize: 3 });
    assert.deepEqual(res.chunks!.map(c => c.rows), [[0, 2], [3, 5], [6, 6]]);
    assert.deepEqual(res.results.map(r => r.index), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(books.size, 7);
  } finally { await tally.close(); }
});

// ── the "changed after posting" fingerprint ──

test('the posting fingerprint reads a real Tally export the same as the input that produced it', () => {
  const input = { voucherType: 'Receipt', date: '2026-07-03', entries: [{ ledger: 'HDFC Bank', drCr: 'dr' as const, amount: 1500 }, { ledger: 'Acme &amp; Sons', drCr: 'cr' as const, amount: 1500 }] };
  // Shaped like Tally's own export: typed scalars, allocations nested inside the ledger lines (whose own
  // AMOUNT must not be read as the line's), the party line first, names in a different case.
  const exported = `<VOUCHER REMOTEID="TMCP-Receipt-UTR1" VCHKEY="x" VCHTYPE="Receipt" ACTION="Create">
    <DATE TYPE="Date">20260703</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><NARRATION>edited narration</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>ACME &amp; SONS</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <BILLALLOCATIONS.LIST><NAME>INV-1</NAME><AMOUNT>700.00</AMOUNT></BILLALLOCATIONS.LIST><AMOUNT>1500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1500.00</AMOUNT>
      <BANKALLOCATIONS.LIST><DATE>20260705</DATE><AMOUNT>-1500.00</AMOUNT></BANKALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
  </VOUCHER>`;
  assert.deepEqual(normalizedPostingFromExport(exported), normalizedPostingFromInput(input));
  assert.equal(postingHash(normalizedPostingFromExport(exported)!), postingHash(normalizedPostingFromInput(input)));
  const altered = exported.replace('<AMOUNT>1500.00</AMOUNT>', '<AMOUNT>1600.00</AMOUNT>').replace('<AMOUNT>-1500.00</AMOUNT>', '<AMOUNT>-1600.00</AMOUNT>');
  assert.notEqual(postingHash(normalizedPostingFromExport(altered)!), postingHash(normalizedPostingFromInput(input)));
  const redated = exported.replace('20260703', '20260704');
  assert.notEqual(postingHash(normalizedPostingFromExport(redated)!), postingHash(normalizedPostingFromInput(input)));
  assert.equal(normalizedPostingFromExport('not a voucher'), null);
});

// ── undo ──

test('undo previews exactly this batch, deletes only it, and marks the journal', async () => {
  const { tally, books, deps } = await fakeBooks();
  try {
    const store = storeIn();
    // Someone else's voucher in the same books, and another batch: neither may be touched.
    const other = store.create({ tool: 'create-vouchers', company: 'Acme', rows: [receipt(9)] });
    await runJournaledBatch({ store, journal: other, rows: [receipt(9)], execute: exec() });
    books.set('5', '<VOUCHER VCHTYPE="Receipt"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME></VOUCHER>');

    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    assert.equal(books.size, 4);

    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => [p.status, p.masterId, p.voucherType, p.amount, p.date]), [
      ['will_delete', '1002', 'Receipt', 101, '2026-07-03'],
      ['will_delete', '1003', 'Receipt', 102, '2026-07-03'],
    ]);
    assert.equal(books.size, 4, 'the preview deletes nothing');

    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, plan, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['deleted', 'deleted']);
    assert.deepEqual([...books.keys()].sort(), ['1001', '5']);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['undone', 'undone']);
    // Undone batches cannot be resumed, and a second undo has nothing to do.
    assert.equal((openJournalForResume(store, j.batchId, rows, 'Acme') as any).code, 'PRECONDITION_FAILED');
    assert.deepEqual(await planUndo(store.load(j.batchId)!, deps()), []);
  } finally { await tally.close(); }
});

test('undo refuses a voucher that was altered after posting, and still deletes the untouched ones', async () => {
  const { tally, books, deps } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    // Someone edits voucher 1002's amount in Tally.
    books.set('1002', books.get('1002')!.replace(/<AMOUNT>-?102<\/AMOUNT>/g, m => m.replace('102', '120')));
    const plan = await planUndo(store.load(j.batchId)!, deps());
    assert.deepEqual(plan.map(p => p.status), ['will_delete', 'changed']);
    assert.equal(plan[1]!.code, 'VOUCHER_CHANGED');
    const journal = store.load(j.batchId)!;
    const out = await executeUndo(journal, plan, deps(), () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['deleted', 'changed']);
    assert.ok(books.has('1002'), 'the altered voucher is left alone');
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['undone', 'success']);
  } finally { await tally.close(); }
});

test('undo: a voucher already deleted is recorded, an Edit Log GUI-only voucher is reported, a CREATE halts', async () => {
  const { tally, books, deps } = await fakeBooks();
  try {
    const store = storeIn();
    const rows = [receipt(1), receipt(2), receipt(3)];
    const j = store.create({ tool: 'create-vouchers', company: 'Acme', rows });
    await runJournaledBatch({ store, journal: j, rows, execute: exec() });
    books.delete('1001');
    const d = deps();
    d.deleteOne = async (located) => (String(located.master_id) === '1002'
      ? { status: 'requires_gui', message: 'No XML delete form worked.' }
      : { status: 'created_instead', created: 1, form: 'block-verbatim' });
    const journal = store.load(j.batchId)!;
    const plan = await planUndo(journal, d);
    assert.deepEqual(plan.map(p => p.status), ['already_gone', 'will_delete', 'will_delete']);
    const out = await executeUndo(journal, plan, d, () => store.save(journal));
    assert.deepEqual(out.results.map(r => r.status), ['already_gone', 'requires_gui', 'failed']);
    assert.match(out.results[1]!.message!, /gui-delete-voucher with masterId 1002/);
    assert.equal(out.halted, true);
    assert.deepEqual(store.load(j.batchId)!.rows.map(r => r.status), ['undone', 'success', 'success']);
  } finally { await tally.close(); }
});

test('journals older than 30 days are swept; fresh ones and foreign files are kept', () => {
  const base = fs.mkdtempSync(path.join(dataDir, 'sweep-'));
  let now = Date.parse('2026-11-23T00:00:00Z');
  const store = makeBatchJournalStore(base, { now: () => now });
  const old = store.create({ tool: 't', company: 'C', rows: [receipt(1)] });
  now += 31 * 24 * 60 * 60 * 1000;
  const fresh = makeBatchJournalStore(base, { now: () => now });
  const kept = fresh.create({ tool: 't', company: 'C', rows: [receipt(2)] }); // first use sweeps
  assert.equal(fs.existsSync(path.join(base, BATCH_DIR_NAME, `${old.batchId}.json`)), false);
  assert.ok(fresh.load(kept.batchId));
  assert.equal(fresh.load(old.batchId), null);
});

// Through the registered tool: the gates that run before any Tally call.
test('undo-batch tool: READONLY_MODE refuses it, and a malformed or unknown batchId is refused', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerMcpServer } = await import('./mcp.mjs');
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'undo-test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'undo-batch', arguments: args }) as any;
    return { isError: res.isError === true, text: (res.content ?? []).map((c: any) => c.text ?? '').join('\n') };
  };
  const saved = process.env.READONLY_MODE;
  try {
    process.env.READONLY_MODE = 'true';
    assert.match((await call({ batchId: newBatchId(), dryRun: false, confirm: true })).text, /"code":\s*"READONLY"/);
    process.env.READONLY_MODE = 'false';
    const bad = await call({ batchId: 'b-1/../../x' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /"code":\s*"PRECONDITION_FAILED"/);
    const unknown = await call({ batchId: 'b-20990101-000000-zzzzzz' });
    assert.match(unknown.text, /No journal for batch/);
  } finally {
    if (saved === undefined) delete process.env.READONLY_MODE; else process.env.READONLY_MODE = saved;
    await client.close();
    await server.close();
  }
});
