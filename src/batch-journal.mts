// Batch journal: resume a half-posted batch, and undo a whole batch (#31).
//
// Tally has no transaction across vouchers. A 300-voucher batch that dies at row 140 (Tally popup, a
// restart, the laptop lid) leaves 139 vouchers posted and the caller with no reliable record of which:
// the tool result never arrived. Re-sending the batch double-posts the first 139; guessing from the Day
// Book is how accountants lose an afternoon. And when a whole import turns out to be wrong (wrong
// month, wrong company, wrong mapping), there was no way to take back exactly that import and nothing
// else.
//
// So every write batch gets a batchId and a journal file, rewritten after EVERY row (temp + rename), so
// whatever happens the file says which rows are in Tally:
//
//   <TALLY_DATA_PATH>/.tally-mcp-batches/<batchId>.json
//
// - resume (resumeBatchId): rows the journal records as posted are not sent again; the rest are, into
//   the same journal and under the same batchId. Refused if the caller's rows no longer match what was
//   journalled for the rows being skipped — a changed batch is a different batch.
// - undo-batch: deletes exactly the vouchers this batch posted, through the same safe delete path as
//   delete-vouchers, after a preview — and refuses any voucher that was changed after it was posted.
//
// HOW "CHANGED AFTER POSTING" IS DECIDED. At post time the journal stores `postedHash`, a sha256 over a
// normalised summary of what the voucher puts into the books, computed from the INPUT that was posted.
// At undo time the same summary is computed from the voucher's live export (the same export block the
// delete path fetches anyway) and compared. Reading every voucher back right after posting would make
// that baseline exact, but doubles the Tally round-trips of a 500-row import; the input is what Tally
// accepted, so it is the baseline. The normalisation (normalizedPostingFromInput /
// normalizedPostingFromExport) is:
//   - date: YYYY-MM-DD
//   - voucher type: trimmed, case-folded
//   - ledger lines: (ledger name via masterKey — entity-decoded, trimmed, case-folded — , dr|cr,
//     absolute amount); lines for the same ledger and side are summed, amounts rounded to 2 dp, sorted
//   - stock lines: (stock item via masterKey, absolute amount), summed per item, 2 dp, sorted
// Narration, reference, voucher number and bill/cost-centre allocations are deliberately NOT part of it:
// the question undo has to answer is "would deleting this remove exactly the posting we made", and the
// money is that posting. A voucher whose ledgers, amounts, date or type were edited is refused.
// If the summaries ever disagree for a voucher nobody touched (a Tally build exporting lines in a shape
// this does not read), the failure is a refusal, never a wrong delete.
//
// ONE RUN AT A TIME. Each run works on its own in-memory copy of the journal and rewrites the whole file
// after every row, so two runs on one batch (a resume started while an earlier call on the same batch is
// still posting in the background, or an undo during a resume) would both post the rows the other has not
// reached yet and overwrite each other's record of what is in Tally. Every run and every undo therefore
// holds the batch's lock file, <batchId>.lock next to the journal (see lock() below), for its whole run.
//
// "SENT, OUTCOME UNKNOWN". A row is marked 'sending' (and saved) just before it goes to Tally, and a row
// whose request failed after it may have reached Tally (a timeout, a dropped connection, an unreadable
// answer) is journalled 'unknown', not 'error': Tally may have saved it. Neither is re-sent blindly on
// resume. A row with a REMOTEID is (Tally alters the voucher bound to that REMOTEID instead of making a
// second one); one without is refused until the caller confirms it is not in the Day Book.
//
// "EXISTED BEFORE THIS BATCH". A row whose REMOTEID matches a voucher already in Tally makes Tally ALTER
// that voucher (created 0 / altered 1) rather than create one. Undo must not delete such a voucher: it was
// in the books before the batch. So before a row is first sent, the vouchers already holding its reference
// AND the vouchers already bound to its REMOTEID (cancelled and optional ones included) are looked up and
// their master ids journalled; undo refuses those (existed_before). The reference lookup alone is not
// enough: it matches the exact reference text of live vouchers, while Tally's alter is keyed on the REMOTEID,
// a slug of the reference ("INV/55", "INV 55" and "INV-55" of one type and party share it), which a
// cancelled or optional voucher, or one whose reference was edited in Tally, also keeps. And no lookup can
// be fully trusted to have seen everything (a Tally build whose $RemoteID reads empty finds nothing). So a
// row Tally ALTERED is never deleted on the lookups' say-so: undo deletes it only with proof that its
// voucher is new — the REMOTEID lookup found nothing before the row was sent, and the same lookup run at
// undo time finds exactly this voucher, so it does see this build's REMOTEIDs. Otherwise it is listed as
// needs_confirmation, for the user to confirm by master id.
//
// A RE-SENT ROW WHOSE FIRST ATTEMPT LANDED. An outcome-unknown row with a REMOTEID is re-sent on resume.
// If the first attempt did reach Tally, the re-send meets that voucher: skipIfExists skips the row
// (ALREADY_EXISTS), or a manual-numbered type refuses it (DUPLICATE_NUMBER) — both naming the voucher they
// found. Recording that as a plain skip or refusal would drop the voucher this batch posted out of undo.
// So for such a row: a found voucher that was not in Tally before the batch (not among the master ids
// journalled before the first send) and, for a number clash, carries the row's reference, is this batch's
// voucher — journalled as posted (landedEarlier), and undo then treats it like an altered row (deleted only
// with proof it is new, else needs_confirmation). When that cannot be decided (no pre-send lookup, several
// candidates), or the re-send was refused for any other reason, the row stays outcome-unknown — with the
// candidate master ids, when there are any, for undo to list — and is never silently dropped. Lookups made
// for a re-send are never journalled as "before the batch": they may see the first attempt's own voucher.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from './coordination.mjs';
import { deriveRemoteId, masterKey, decodeXmlEntities } from './voucher.mjs';
import type { BatchResult, BatchRow } from './mcp.mjs';

export const BATCH_DIR_NAME = '.tally-mcp-batches';
export const DEFAULT_JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_ID_RE = /^b-\d{8}-\d{6}-[a-z0-9]{6}$/;

/**
 * pending: never sent. sending: about to be sent, or in flight when the process died (outcome unknown).
 * unknown: sent, and the request failed in a way that does not say whether Tally saved it.
 */
export type JournalRowStatus = 'pending' | 'sending' | 'unknown' | 'success' | 'error' | 'skipped' | 'undone';

/** Rows that may be in Tally although the journal has no master id for them. */
export const isOutcomeUnknown = (status: JournalRowStatus) => status === 'sending' || status === 'unknown';

/**
 * Row code for a request that may or may not have reached Tally. Not a ToolErrorCode: it only ever
 * appears on a batch row, never as a whole tool's error.
 */
export const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN';
/** Row code for a row never sent because the call was cancelled first (still 'pending' in the journal). */
export const NOT_SENT = 'NOT_SENT';

export type JournalRow = {
  index: number;
  /** sha256 of the canonical JSON of the row input (control flags excluded; see voucherInputHash). */
  inputHash: string;
  voucherType: string;
  date: string;
  voucherNumber?: string;
  reference?: string;
  /** Sum of the debit lines: the voucher's amount as an accountant reads it. */
  amount: number;
  remoteId?: string;
  status: JournalRowStatus;
  masterId?: string;
  code?: string;
  message?: string;
  postedHash?: string;
  postedAt?: string;
  undoneAt?: string;
  /** Tally's counters for the post. created 0 / altered > 0: Tally altered a voucher bound to the REMOTEID. */
  created?: number;
  altered?: number;
  /**
   * Master ids of the vouchers that already held this row's reference before it was first sent. Undo never
   * deletes one of them. Absent with preExistingChecked false/absent: the lookup did not run or failed.
   */
  preExistingMasterIds?: string[];
  preExistingChecked?: boolean;
  /**
   * Master ids of the vouchers already bound to this row's REMOTEID (cancelled and optional ones included)
   * before it was first sent; [] = looked up, none. Absent: the lookup did not run or failed. Also merged
   * into preExistingMasterIds.
   */
  remoteIdMasterIds?: string[];
  /**
   * Posted by an earlier attempt whose answer was lost: the re-send on resume found this voucher (skipped
   * ALREADY_EXISTS or refused DUPLICATE_NUMBER) and it was not in Tally before the batch.
   */
  landedEarlier?: boolean;
  /** Outcome-unknown row: vouchers in Tally that may be its earlier attempt (found when it was re-sent). */
  candidateMasterIds?: string[];
  /** import-vouchers: the spreadsheet rows this voucher came from (header = row 1). */
  sourceRows?: number[];
};

export type BatchJournal = {
  schemaVersion: 1;
  batchId: string;
  tool: string;
  company: string;
  createdAt: string;
  updatedAt: string;
  source?: { path?: string; sheet?: string };
  rows: JournalRow[];
};

/** The voucher fields the journal reads. Structural, so both create-vouchers and import rows fit. */
export type JournalVoucherInput = {
  voucherType: string;
  date: string;
  voucherNumber?: string;
  reference?: string;
  partyLedger?: string;
  remoteId?: string;
  entries?: Array<{ ledger: string; drCr: 'dr' | 'cr'; amount: number }>;
  debitLedger?: string;
  creditLedger?: string;
  amount?: number;
  inventory?: Array<{ stockItem: string; quantity: number; rate?: number; amount?: number }>;
  [k: string]: unknown;
};

// ── ids and hashes ──────────────────────────────────────────────────────────────────────────────

export function newBatchId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rand = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  return `b-${stamp}-${rand}`;
}

/** Strict: a batchId arrives from the caller and becomes a file name, so nothing but the exact shape. */
export function isValidBatchId(id: unknown): id is string {
  return typeof id === 'string' && BATCH_ID_RE.test(id);
}

/** JSON with object keys sorted at every level and undefined dropped: equal inputs, equal text. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(x => (x === undefined ? null : norm(x)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Flags that change how a row is posted, not what is posted. A resume that turns skipIfExists on, or
// confirms a duplicate number, is still the same batch; targetCompany is filled in by the handler.
const CONTROL_KEYS = new Set(['targetCompany', 'skipIfExists', 'allowDuplicateNumber', 'idempotencyKey', 'dryRun']);

export function voucherInputHash(row: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!CONTROL_KEYS.has(k)) content[k] = v;
  return sha256(canonicalJson(content));
}

export type NormalizedPosting = { date: string; voucherType: string; ledgers: string[]; stock: string[] };

const r2 = (n: number) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2);

function summarize(date: string, voucherType: string, ledgerLines: Array<[string, 'dr' | 'cr', number]>, stockLines: Array<[string, number]>): NormalizedPosting {
  const led = new Map<string, number>();
  for (const [name, side, amt] of ledgerLines) {
    const k = `${masterKey(name)}|${side}`;
    led.set(k, (led.get(k) ?? 0) + Math.abs(amt));
  }
  const stk = new Map<string, number>();
  for (const [item, amt] of stockLines) {
    const k = masterKey(item);
    stk.set(k, (stk.get(k) ?? 0) + Math.abs(amt));
  }
  return {
    date,
    voucherType: String(voucherType ?? '').trim().toLowerCase(),
    ledgers: [...led].map(([k, v]) => `${k}|${r2(v)}`).sort(),
    stock: [...stk].map(([k, v]) => `${k}|${r2(v)}`).sort(),
  };
}

function inputEntries(v: JournalVoucherInput): Array<{ ledger: string; drCr: 'dr' | 'cr'; amount: number }> {
  if (v.entries && v.entries.length) return v.entries;
  if (v.debitLedger && v.creditLedger && typeof v.amount === 'number') {
    return [{ ledger: v.debitLedger, drCr: 'dr', amount: v.amount }, { ledger: v.creditLedger, drCr: 'cr', amount: v.amount }];
  }
  return [];
}

export function normalizedPostingFromInput(v: JournalVoucherInput): NormalizedPosting {
  return summarize(
    v.date, v.voucherType,
    inputEntries(v).map(e => [e.ledger, e.drCr, Number(e.amount)] as [string, 'dr' | 'cr', number]),
    (v.inventory ?? []).map(i => [i.stockItem, Number(i.amount ?? (i.rate != null ? i.quantity * i.rate : 0))] as [string, number]),
  );
}

// Removes every nested *.LIST element, leaving the direct children of the element being read. A ledger
// line's own <AMOUNT> must not be confused with the amounts of its bill or cost-centre allocations.
function stripLists(xml: string): string {
  let prev: string;
  let cur = xml;
  do {
    prev = cur;
    cur = cur
      .replace(/<([A-Z0-9_.]+\.LIST)\b[^>]*\/>/g, '')
      .replace(/<([A-Z0-9_.]+\.LIST)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  } while (cur !== prev);
  return cur;
}
const child = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXmlEntities(m[1] ?? '').trim() : undefined;
};
const num = (s: string | undefined): number => {
  const n = Number(String(s ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * The same summary, read from a voucher's export block (fetchVoucherExportBlock). Ledger lines come from
 * ALLLEDGERENTRIES.LIST, falling back to LEDGERENTRIES.LIST when the block has none (invoice-mode
 * vouchers carry the party line there); stock lines from ALLINVENTORYENTRIES.LIST / INVENTORYENTRIES.LIST.
 * Side: ISDEEMEDPOSITIVE=Yes is a debit; without that tag, a negative AMOUNT is (Tally's sign convention).
 */
export function normalizedPostingFromExport(block: string): NormalizedPosting | null {
  const b = String(block ?? '');
  if (!/<VOUCHER\b/.test(b)) return null;
  const header = stripLists(b);
  const rawDate = child(header, 'DATE') ?? '';
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate) ?? /^(\d{4})-(\d{2})-(\d{2})/.exec(rawDate);
  const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : rawDate;
  const vchType = child(header, 'VOUCHERTYPENAME') ?? decodeXmlEntities((/\bVCHTYPE="([^"]*)"/.exec(b) || [])[1] ?? '');
  const lists = (tag: string) => [...b.matchAll(new RegExp(`<${tag.replace(/\./g, '\\.')}\\b[^>]*>([\\s\\S]*?)</${tag.replace(/\./g, '\\.')}>`, 'g'))].map(m => stripLists(m[1] ?? ''));
  const readLedgers = (tag: string) => lists(tag)
    .map(e => {
      const name = child(e, 'LEDGERNAME');
      if (!name) return null;
      const amt = num(child(e, 'AMOUNT'));
      const deemed = child(e, 'ISDEEMEDPOSITIVE');
      const dr = deemed ? /^yes$/i.test(deemed) : amt < 0;
      return [name, dr ? 'dr' : 'cr', amt] as [string, 'dr' | 'cr', number];
    })
    .filter((x): x is [string, 'dr' | 'cr', number] => !!x);
  let ledgers = readLedgers('ALLLEDGERENTRIES.LIST');
  if (!ledgers.length) ledgers = readLedgers('LEDGERENTRIES.LIST');
  const readStock = (tag: string) => lists(tag)
    .map(e => { const item = child(e, 'STOCKITEMNAME'); return item ? [item, num(child(e, 'AMOUNT'))] as [string, number] : null; })
    .filter((x): x is [string, number] => !!x);
  let stock = readStock('ALLINVENTORYENTRIES.LIST');
  if (!stock.length) stock = readStock('INVENTORYENTRIES.LIST');
  return summarize(date, vchType, ledgers, stock);
}

export function postingHash(p: NormalizedPosting): string {
  return sha256(canonicalJson(p));
}

// ── the store ───────────────────────────────────────────────────────────────────────────────────

export type BatchLockHolder = { batchId: string; pid: number; tool: string; host: string; token: string; startedAt: string; heartbeatAt: string };
export type BatchLockAttempt =
  | { ok: true; release: () => void; holder: BatchLockHolder }
  | { ok: false; holder: BatchLockHolder | null; retryAfterSec: number };

export type BatchJournalStore = {
  dir: string;
  create(params: { tool: string; company: string; rows: JournalVoucherInput[]; source?: BatchJournal['source']; sourceRows?: number[][] }): BatchJournal;
  /**
   * create() under the batch's lock, taken BEFORE the journal file exists, so no other call can open the
   * batch between its creation and the start of the run. The caller releases the lock when the run ends.
   */
  createLocked(params: { tool: string; company: string; rows: JournalVoucherInput[]; source?: BatchJournal['source']; sourceRows?: number[][] }, tool: string): { journal: BatchJournal; release: () => void };
  load(batchId: string): BatchJournal | null;
  save(journal: BatchJournal): void;
  /** Journals last written within `withinMs`, newest first. Unreadable files are skipped. */
  list(withinMs: number): BatchJournal[];
  /** One attempt at the batch's exclusive lock (see lockBatch). Never waits. */
  lock(batchId: string, tool: string): BatchLockAttempt;
  sweep(): void;
};

// ── the per-batch lock ──────────────────────────────────────────────────────────────────────────
//
// <batchId>.lock, created with exclusive create, holds who is working on the batch. It is cross-process
// because every AI window runs its own server on the same data folder, and in-process concurrent tool
// calls are told apart by token (a lock file with this pid whose token this process does not hold is a
// leftover of an earlier process that had the same pid).
//
// A batch can legitimately run for many minutes, so staleness is judged by a HEARTBEAT the holder
// refreshes every BATCH_LOCK_HEARTBEAT_MS, not by how long it has held the lock: stale when the heartbeat
// is older than BATCH_LOCK_STALE_MS, or the holder's process (on this host) is gone. Takeover of a stale
// lock is guarded by a short-lived second file, as the machine lock does (coordination.mts): without it two
// processes that both judged the same lock stale could each unlink it, and the slower would delete the
// fresh lock the faster had just made.

export const BATCH_LOCK_HEARTBEAT_MS = 15_000;
export const BATCH_LOCK_STALE_MS = 120_000;

// batchId -> token of every lock this process holds right now.
const heldBatchLocks = new Map<string, string>();

function readJsonFile(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^﻿/, '')); } catch { return null; }
}

export function isBatchLockStale(holder: BatchLockHolder | null, fileMtimeMs: number, nowMs: number, opts: { staleMs?: number; alive?: (pid: number) => boolean } = {}): boolean {
  // Unreadable contents count as stale only once the file itself is old: it may be caught half-written.
  if (!holder) return nowMs - fileMtimeMs > 5000;
  const beat = Date.parse(holder.heartbeatAt ?? holder.startedAt);
  if (!Number.isFinite(beat) || nowMs - beat > (opts.staleMs ?? BATCH_LOCK_STALE_MS)) return true;
  // A holder on another machine (a shared data folder) cannot be pid-checked from here; heartbeat only.
  if (holder.host && holder.host !== os.hostname()) return false;
  if (holder.pid === process.pid) return heldBatchLocks.get(holder.batchId) !== holder.token;
  return !(opts.alive ?? isPidAlive)(holder.pid);
}

function lockBatch(dir: string, batchId: string, tool: string, now: () => number, staleMs: number): BatchLockAttempt {
  const file = path.join(dir, `${batchId}.lock`);
  const at = new Date(now()).toISOString();
  const holder: BatchLockHolder = {
    batchId, pid: process.pid, tool, host: os.hostname(), startedAt: at, heartbeatAt: at,
    token: `${process.pid}-${now()}-${crypto.randomBytes(5).toString('hex')}`,
  };
  const create = (): boolean => {
    fs.mkdirSync(dir, { recursive: true });
    let fd: number;
    try { fd = fs.openSync(file, 'wx'); } catch (err: any) { if (err?.code === 'EEXIST') return false; throw err; }
    try { fs.writeSync(fd, JSON.stringify(holder)); } finally { fs.closeSync(fd); }
    return true;
  };
  const takeOver = (): boolean => {
    const guard = `${file}.takeover`;
    try { if (now() - fs.statSync(guard).mtimeMs > 10_000) fs.unlinkSync(guard); } catch { /* no guard */ }
    let gfd: number;
    try { gfd = fs.openSync(guard, 'wx'); } catch { return false; }
    try {
      fs.closeSync(gfd);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return create(); }
      if (!isBatchLockStale(readJsonFile(file), st.mtimeMs, now(), { staleMs })) return false;
      try { fs.unlinkSync(file); } catch { /* someone else removed it */ }
      return create();
    } finally {
      try { fs.unlinkSync(guard); } catch { /* ignore */ }
    }
  };
  if (!create() && !takeOver()) {
    const current = readJsonFile(file) as BatchLockHolder | null;
    return { ok: false, holder: current, retryAfterSec: 30 };
  }
  heldBatchLocks.set(batchId, holder.token);
  const ours = () => (readJsonFile(file) as BatchLockHolder | null)?.token === holder.token;
  // The heartbeat rewrites the file (temp + rename) only while it is still ours; unref'd so a held lock
  // never keeps the process alive on its own.
  const beat = setInterval(() => {
    try {
      if (!ours()) return;
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...holder, heartbeatAt: new Date(now()).toISOString() }), 'utf-8');
      fs.renameSync(tmp, file);
    } catch { /* the next beat retries */ }
  }, BATCH_LOCK_HEARTBEAT_MS);
  beat.unref?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    if (heldBatchLocks.get(batchId) === holder.token) heldBatchLocks.delete(batchId);
    // Only remove the lock if it is still ours: after a stale takeover by someone else it is not.
    if (ours()) { try { fs.unlinkSync(file); } catch { /* gone */ } }
  };
  return { ok: true, release, holder };
}

/** What a refused resume or undo tells the caller. */
export function describeBatchBusy(batchId: string, holder: BatchLockHolder | null): string {
  if (!holder) return `Batch ${batchId} is being worked on by another call right now.`;
  const who = holder.pid === process.pid ? 'An earlier call in this AI window' : 'Another AI window';
  const what = holder.tool === 'undo-batch' ? 'undoing' : 'posting';
  return `${who} is still ${what} batch ${batchId} (${holder.tool}, started ${holder.startedAt}). Nothing was done, so the two runs cannot both post the same rows.`;
}

function journalRowFor(v: JournalVoucherInput, index: number, sourceRows?: number[]): JournalRow {
  const amount = inputEntries(v).filter(e => e.drCr === 'dr').reduce((s, e) => s + Number(e.amount || 0), 0);
  const row: JournalRow = {
    index,
    inputHash: voucherInputHash(v as Record<string, unknown>),
    voucherType: v.voucherType,
    date: v.date,
    amount: Math.round(amount * 100) / 100,
    status: 'pending',
  };
  if (v.voucherNumber) row.voucherNumber = v.voucherNumber;
  if (v.reference) row.reference = v.reference;
  // Same derivation executeVoucher stamps the voucher with.
  const remoteId = (v.remoteId as string | undefined) ?? deriveRemoteId(v.voucherType, v.reference, v.partyLedger);
  if (remoteId) row.remoteId = remoteId;
  if (sourceRows?.length) row.sourceRows = sourceRows;
  return row;
}

/** A journal object, not yet written anywhere (a dryRun preview uses one without ever saving it). */
export function buildJournal(params: { tool: string; company: string; rows: JournalVoucherInput[]; source?: BatchJournal['source']; sourceRows?: number[][]; now?: Date }): BatchJournal {
  const now = params.now ?? new Date();
  const at = now.toISOString();
  return {
    schemaVersion: 1, batchId: newBatchId(now), tool: params.tool, company: params.company, createdAt: at, updatedAt: at,
    ...(params.source ? { source: params.source } : {}),
    rows: params.rows.map((v, i) => journalRowFor(v, i, params.sourceRows?.[i])),
  };
}

export function makeBatchJournalStore(baseDir: string, opts: { ttlMs?: number; now?: () => number; sweepEverySaves?: number; lockStaleMs?: number } = {}): BatchJournalStore {
  const dir = path.join(baseDir, BATCH_DIR_NAME);
  const ttl = opts.ttlMs ?? DEFAULT_JOURNAL_TTL_MS;
  const now = opts.now ?? Date.now;
  const lockStaleMs = opts.lockStaleMs ?? BATCH_LOCK_STALE_MS;
  const sweepEvery = Math.max(1, opts.sweepEverySaves ?? 2000);
  let swept = false;
  let saves = 0;
  const fileFor = (id: string) => path.join(dir, `${id}.json`);

  const sweep = () => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (name.endsWith('.tmp')) { if (now() - st.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(file); continue; }
        // A lock left by a process that died: its heartbeat (which rewrites the file) stopped long ago.
        if (name.endsWith('.lock')) { if (now() - st.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(file); continue; }
        if (!name.endsWith('.json')) continue;
        let at = st.mtimeMs;
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
          const t = Date.parse(j?.updatedAt ?? j?.createdAt);
          if (Number.isFinite(t)) at = t;
        } catch { /* judged by file time */ }
        if (now() - at > ttl) fs.unlinkSync(file);
      } catch { /* raced with another process; skip */ }
    }
  };
  const sweepOnce = () => { if (!swept) { swept = true; try { sweep(); } catch { /* never throws */ } } };

  const write = (j: BatchJournal) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(j.batchId);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(j, null, 1), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      throw err;
    }
  };

  const load = (batchId: string): BatchJournal | null => {
    if (!isValidBatchId(batchId)) return null;
    sweepOnce();
    try {
      const j = JSON.parse(fs.readFileSync(fileFor(batchId), 'utf-8').replace(/^﻿/, ''));
      return j && j.schemaVersion === 1 && j.batchId === batchId && Array.isArray(j.rows) ? j as BatchJournal : null;
    } catch {
      return null;
    }
  };
  const lock = (batchId: string, tool: string): BatchLockAttempt => {
    if (!isValidBatchId(batchId)) return { ok: false, holder: null, retryAfterSec: 0 };
    return lockBatch(dir, batchId, tool, now, lockStaleMs);
  };

  return {
    dir,
    create(params) {
      sweepOnce();
      const j = buildJournal({ ...params, now: new Date(now()) });
      write(j);
      return j;
    },
    createLocked(params, tool) {
      sweepOnce();
      const j = buildJournal({ ...params, now: new Date(now()) });
      // A brand-new id: nobody else can hold it, so a refusal here is a file-system failure.
      const got = lock(j.batchId, tool);
      if (!got.ok) throw new Error(`could not create the lock file for batch ${j.batchId}`);
      try { write(j); } catch (err) { got.release(); throw err; }
      return { journal: j, release: got.release };
    },
    load,
    save(j) {
      j.updatedAt = new Date(now()).toISOString();
      write(j);
      if (++saves >= sweepEvery) { saves = 0; try { sweep(); } catch { /* never throws */ } }
    },
    list(withinMs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      const out: BatchJournal[] = [];
      for (const name of names) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!isValidBatchId(id)) continue;
        // The file time first, so old journals are never parsed.
        try { if (now() - fs.statSync(path.join(dir, name)).mtimeMs > withinMs) continue; } catch { continue; }
        const j = load(id);
        if (j) out.push(j);
      }
      return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    lock,
    sweep,
  };
}

// ── resume ──────────────────────────────────────────────────────────────────────────────────────

export type ResumeCheck =
  | { ok: true; journal: BatchJournal }
  | { ok: false; code: 'PRECONDITION_FAILED' | 'COMPANY_MISMATCH'; message: string; remedy?: string };

/**
 * Opens a journal for resumeBatchId and checks the caller is resuming the SAME batch: same company,
 * same number of rows, and every row the journal says is already posted still hashes the same. Rows
 * not yet posted may have been corrected (that is often why the batch is being resumed), so only the
 * skipped rows are compared.
 */
export function openJournalForResume(store: BatchJournalStore, batchId: string, rows: JournalVoucherInput[], company: string): ResumeCheck {
  if (!isValidBatchId(batchId)) {
    return { ok: false, code: 'PRECONDITION_FAILED', message: `"${batchId}" is not a batchId (expected b-YYYYMMDD-HHMMSS-xxxxxx).` };
  }
  const journal = store.load(batchId);
  if (!journal) {
    return { ok: false, code: 'PRECONDITION_FAILED', message: `No journal for batch ${batchId} (it may have expired after 30 days, or belong to another machine's data folder).`, remedy: 'Check what is already in Tally (find-voucher-by-reference / the Day Book) before re-posting anything.' };
  }
  if (journal.company.trim().toLowerCase() !== String(company).trim().toLowerCase()) {
    return { ok: false, code: 'COMPANY_MISMATCH', message: `Batch ${batchId} was posted to "${journal.company}", but the loaded company is "${company}". Nothing was posted.` };
  }
  if (journal.rows.some(r => r.status === 'undone')) {
    return { ok: false, code: 'PRECONDITION_FAILED', message: `Batch ${batchId} has been undone (undo-batch); it cannot be resumed. Post the vouchers as a new batch if they are wanted.` };
  }
  if (rows.length !== journal.rows.length) {
    return { ok: false, code: 'PRECONDITION_FAILED', message: `Batch ${batchId} has ${journal.rows.length} row(s) but ${rows.length} were sent. Resume with exactly the same rows in the same order. Nothing was posted.` };
  }
  const differ: number[] = [];
  journal.rows.forEach((jr, i) => {
    // An outcome-unknown row may be in Tally too, and is re-sent by REMOTEID: it must not have changed either.
    if ((jr.status === 'success' || isOutcomeUnknown(jr.status)) && jr.inputHash !== voucherInputHash(rows[i] as Record<string, unknown>)) differ.push(i);
  });
  if (differ.length) {
    return {
      ok: false, code: 'PRECONDITION_FAILED',
      message: `Refusing to resume batch ${batchId}: ${differ.length} row(s) already posted by it differ from what was posted — rows ${differ.join(', ')} (0-based). Nothing was posted.`,
      remedy: 'Resume with the original rows unchanged (only rows that did NOT post may be corrected), or undo-batch and post a new batch.',
    };
  }
  return { ok: true, journal };
}

/** How long a new batch looks back for an earlier batch of the same rows (see findEarlierBatch). */
export const EARLIER_BATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type EarlierBatch = { batchId: string; createdAt: string; posted: number; outcomeUnknown: number; failed: number; notSent: number };

/**
 * The newest recent batch of the same tool and company whose rows are exactly these rows (same count, every
 * input hash equal) and of which something may be in Tally (a row posted, or sent with an unknown outcome).
 * A batch whose tool result never arrived (client timeout, crash) leaves the caller without its batchId;
 * re-sending the rows without resumeBatchId would start a second batch and post every row again. Finding
 * the earlier batch by content lets the new call refuse and name the batchId to resume instead. Undone
 * batches are ignored: their vouchers were deleted, so posting the rows again is what the user wants.
 */
export function findEarlierBatch(store: BatchJournalStore, tool: string, company: string, rows: JournalVoucherInput[], withinMs: number = EARLIER_BATCH_WINDOW_MS): EarlierBatch | null {
  const hashes = rows.map(r => voucherInputHash(r as Record<string, unknown>));
  const co = String(company).trim().toLowerCase();
  for (const j of store.list(withinMs)) {
    if (j.tool !== tool || j.company.trim().toLowerCase() !== co || j.rows.length !== hashes.length) continue;
    if (j.rows.some(r => r.status === 'undone')) continue;
    if (!j.rows.every((r, i) => r.inputHash === hashes[i])) continue;
    const count = (pred: (r: JournalRow) => boolean) => j.rows.filter(pred).length;
    const posted = count(r => r.status === 'success');
    const outcomeUnknown = count(r => isOutcomeUnknown(r.status));
    if (!posted && !outcomeUnknown) continue;
    return { batchId: j.batchId, createdAt: j.createdAt, posted, outcomeUnknown, failed: count(r => r.status === 'error'), notSent: count(r => r.status === 'pending') };
  }
  return null;
}

// ── the journaled run ───────────────────────────────────────────────────────────────────────────

export type ChunkSummary = { chunk: number; rows: [number, number]; posted: number; skipped: number; errors: number };
export type JournaledBatchResult = BatchResult & { batchId?: string; alreadyPosted: number; chunks?: ChunkSummary[]; cancelled?: boolean };

/**
 * Called just before a row goes to Tally, with the master ids of the vouchers already holding its
 * reference, and of those already bound to its REMOTEID (each null when it could not be looked up). The
 * journal marks the row 'sending' and saves.
 */
export type BeforeSend = (localIndex: number, info: { preExistingMasterIds: string[] | null; remoteIdMasterIds?: string[] | null }) => void;

export type BatchExecutor<R> = (rows: R[], o: { dryRun?: boolean; atomic?: boolean; onRow?: (row: BatchRow) => void; onBeforeSend?: BeforeSend; signal?: AbortSignal }) => Promise<BatchResult>;

/** A master id Tally really returned: a positive integer. LASTVCHID defaults to 0 when Tally leaves it out. */
export function validMasterId(v: unknown): string | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? String(n) : undefined;
}

export type ResendSettlement =
  | { kind: 'landed'; masterId: string }
  | { kind: 'unknown'; candidates: string[] }
  | { kind: 'not_ours' };

const refKey = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * What the re-send of an outcome-unknown row says about its earlier attempt, when the re-send did not
 * post (see "A RE-SENT ROW WHOSE FIRST ATTEMPT LANDED" in the module header). Pure.
 *
 * - skipped (ALREADY_EXISTS) / DUPLICATE_NUMBER, naming the vouchers they met: those not in Tally before
 *   the batch (jr.preExistingMasterIds) are candidates — for a number clash only those carrying the row's
 *   reference (the number alone is shared with whoever else used it). Exactly one candidate, with the
 *   pre-send lookup on record so "not before the batch" is known: 'landed' (this batch's voucher). None:
 *   'not_ours', the result stands. Otherwise 'unknown' with the candidates.
 * - any other refusal (a validation refusal, BUSY, Tally rejecting the re-send): says nothing about the
 *   earlier attempt — 'unknown'.
 */
export function settleResend(jr: Pick<JournalRow, 'reference' | 'preExistingMasterIds' | 'preExistingChecked'>, row: BatchRow): ResendSettlement {
  const met = row.status === 'skipped' || (row.status === 'error' && row.code === 'DUPLICATE_NUMBER');
  // A skip or clash that does not say which vouchers it met cannot rule the earlier attempt in or out.
  if (!met || !row.existing?.length) return { kind: 'unknown', candidates: [] };
  const before = new Set((jr.preExistingMasterIds ?? []).map(String));
  let found = [...new Set(row.existing.map(e => String(e.masterId)).filter(m => validMasterId(m) && !before.has(m)))]
    .map(m => row.existing!.find(e => String(e.masterId) === m)!);
  // The number clash: the earlier attempt's voucher carries the row's reference as well as its number.
  if (row.status === 'error' && jr.reference) found = found.filter(e => refKey(e.reference) === refKey(jr.reference));
  const ids = found.map(e => String(e.masterId));
  if (!ids.length) return { kind: 'not_ours' };
  if (ids.length === 1 && jr.preExistingChecked) return { kind: 'landed', masterId: ids[0]! };
  return { kind: 'unknown', candidates: ids };
}

const notSentRow = (index: number): BatchRow => ({
  index, status: 'error', code: NOT_SENT, retryable: true,
  message: 'Not sent: the call was cancelled before this row was reached. Nothing was posted for it; resume the batch with resumeBatchId.',
});

/**
 * Runs a batch under a journal. `execute` is executeVoucherBatch bound to the company context (injected,
 * so this module never imports the server). Rows the journal already records as posted are reported as
 * skipped and not sent; the rest go in chunks of `chunkSize`, each row recorded the moment it settles.
 * The caller holds the batch's lock for the whole run (see the module header).
 *
 * preErrors: rows refused before anything is sent (import rows that are not vouchers, a REMOTEID or
 * manual-number clash with an earlier row of the file). They are reported and journalled as errors and
 * never reach Tally.
 *
 * Outcome-unknown rows ('sending' / 'unknown' from an earlier run) are re-sent only when they carry a
 * REMOTEID (Tally then alters the voucher bound to it rather than making a second one), or when the caller
 * lists them in confirmedNotPosted after checking the Day Book. Otherwise they are refused with
 * OUTCOME_UNKNOWN and left as they are in the journal.
 *
 * atomic: every remaining row is validated first in one dryRun pass (so a duplicate number or a missing
 * ledger anywhere aborts before the first chunk), then the chunks post best-effort — exactly what an
 * atomic create-vouchers batch promised before; Tally still cannot roll back a mid-batch write failure.
 *
 * dryRun: same selection of rows, validation only, the journal is not touched.
 *
 * signal: the tool call's abort signal. Once it fires no further row is sent (rows not reached stay
 * 'pending' and are reported NOT_SENT), so a call the client gave up on does not keep posting unseen.
 */
export async function runJournaledBatch<R extends JournalVoucherInput>(params: {
  store: BatchJournalStore;
  journal: BatchJournal;
  rows: R[];
  execute: BatchExecutor<R>;
  atomic?: boolean;
  dryRun?: boolean;
  chunkSize?: number;
  preErrors?: Map<number, { code: string; message: string }>;
  confirmedNotPosted?: Set<number>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<JournaledBatchResult> {
  const { store, journal, rows, execute, signal } = params;
  const now = params.now ?? Date.now;
  const atomic = !!params.atomic;
  const save = () => { if (!params.dryRun) { try { store.save(journal); } catch { /* a journal write must not fail the post */ } } };
  const results: BatchRow[] = new Array(rows.length);

  // Rows that may already be in Tally from an earlier run (sent, answer lost). Taken before anything is
  // sent: a re-send marks them 'sending' again.
  const wasUnknown = new Set<number>();
  journal.rows.forEach((jr, i) => { if (isOutcomeUnknown(jr.status)) wasUnknown.add(i); });
  // What the caller is shown for a row whose journal entry record() decided differently from the raw result
  // (a re-sent row recognised as already in Tally, or one whose outcome is still unknown).
  const shown = new Map<number, BatchRow>();
  let landedNow = 0;

  const record = (orig: number, row: BatchRow) => {
    const jr = journal.rows[orig];
    if (!jr || params.dryRun) return;
    // Never sent (the call was cancelled first): the row is still exactly as it was.
    if (row.status === 'error' && row.code === NOT_SENT) return;
    if (row.status === 'success') {
      jr.status = 'success';
      // Only a real master id: a "0" would look up nothing and undo would call the voucher already gone.
      const mid = validMasterId(row.masterId);
      if (mid) jr.masterId = mid; else delete jr.masterId;
      if (typeof row.created === 'number') jr.created = row.created;
      if (typeof row.altered === 'number') jr.altered = row.altered;
      jr.postedHash = postingHash(normalizedPostingFromInput(rows[orig]!));
      jr.postedAt = new Date(now()).toISOString();
      delete jr.code; delete jr.message; delete jr.landedEarlier; delete jr.candidateMasterIds;
      return;
    }
    // A re-send of a row whose earlier attempt may be in Tally, that did not post this time (see the module
    // header): never let the earlier attempt drop out of the journal.
    if (wasUnknown.has(orig) && row.code !== OUTCOME_UNKNOWN) {
      const settled = settleResend(jr, row);
      if (settled.kind === 'landed') {
        jr.status = 'success';
        jr.masterId = settled.masterId;
        jr.landedEarlier = true;
        // Tally's counters for the earlier attempt never arrived.
        delete jr.created; delete jr.altered;
        jr.postedHash = postingHash(normalizedPostingFromInput(rows[orig]!));
        jr.postedAt = new Date(now()).toISOString();
        delete jr.code; delete jr.message; delete jr.candidateMasterIds;
        landedNow++;
        shown.set(orig, {
          index: orig, status: 'skipped', masterId: Number(settled.masterId), ...(jr.reference ? { reference: jr.reference } : {}),
          note: `Already in Tally: an earlier run of batch ${journal.batchId} sent this voucher and its answer was lost; the re-send found it as master_id ${settled.masterId}, which was not in Tally before the batch. Journalled as posted by this batch (undo-batch includes it); not sent again.`,
        });
        return;
      }
      if (settled.kind === 'unknown') {
        jr.status = 'unknown';
        jr.code = OUTCOME_UNKNOWN;
        const why = row.status === 'skipped' ? 'skipped (ALREADY_EXISTS)' : `refused (${row.code ?? 'error'}${row.message ? `: ${row.message}` : ''})`;
        const cands = settled.candidates;
        if (cands.length) {
          jr.candidateMasterIds = cands;
          // So a candidate the user confirms can still be checked for changes before undo deletes it.
          jr.postedHash = postingHash(normalizedPostingFromInput(rows[orig]!));
        }
        jr.message = cands.length
          ? `An earlier run sent this voucher and never learned whether Tally saved it. Re-sent on resume, it was ${why}, matching master_id ${cands.join(', ')} — which may be that earlier attempt or a voucher that was already in Tally; it could not be told which.`
          : `An earlier run sent this voucher and never learned whether Tally saved it. Re-sent on resume, it was ${why}, so that is still not known.`;
        shown.set(orig, {
          index: orig, status: 'error', code: OUTCOME_UNKNOWN, retryable: false,
          message: `${jr.message} Check the Day Book for ${jr.date}${cands.length ? ` (master_id ${cands.join(', ')})` : ''}; undo-batch lists this row for confirmation instead of passing over it.`,
          ...(row.existing ? { existing: row.existing } : {}),
        });
        return;
      }
      // 'not_ours': the vouchers the re-send met were all in Tally before the batch (or carry another
      // reference): the earlier attempt did not leave a voucher of its own, so the result stands.
    }
    if (row.status === 'error') {
      // Sent, and Tally may have saved it: not a refusal, so not re-sent blindly (see the module header).
      jr.status = row.code === OUTCOME_UNKNOWN ? 'unknown' : 'error';
      jr.code = row.code;
      jr.message = row.message;
    } else {
      jr.status = 'skipped';
      delete jr.code; delete jr.message;
    }
    delete jr.candidateMasterIds;
  };
  const remap = (local: BatchRow, orig: number): BatchRow => ({ ...local, index: orig });

  const remaining: number[] = [];
  let alreadyPosted = 0;
  let preRefused = 0;
  journal.rows.forEach((jr, i) => {
    const pre = params.preErrors?.get(i);
    if (jr.status === 'success') {
      alreadyPosted++;
      results[i] = { index: i, status: 'skipped', ...(validMasterId(jr.masterId) ? { masterId: Number(jr.masterId) } : {}), ...(jr.reference ? { reference: jr.reference } : {}), note: `Already posted by batch ${journal.batchId} in an earlier run (journal); not sent again.` };
    } else if (pre) {
      preRefused++;
      results[i] = { index: i, status: 'error', code: pre.code, message: pre.message };
      record(i, results[i]!);
      results[i] = shown.get(i) ?? results[i]!;
    } else if (isOutcomeUnknown(jr.status) && !jr.remoteId && !params.confirmedNotPosted?.has(i)) {
      // No REMOTEID, so a re-send would make Tally create a second voucher if the first one did land.
      preRefused++;
      const num = jr.voucherNumber ? ` #${jr.voucherNumber}` : '';
      results[i] = {
        index: i, status: 'error', code: OUTCOME_UNKNOWN, retryable: false,
        message: `Not re-sent: an earlier run of batch ${journal.batchId} sent this voucher (${jr.voucherType}${num}, ${jr.date}, amount ${jr.amount}) but never learned whether Tally saved it${jr.message ? ` (${jr.message})` : ' (the run stopped mid-request)'}. It has no reference, so sending it again could book it twice. Check the Day Book for ${jr.date}: only if it is NOT there, resume again listing this row as not posted.`,
      };
    } else {
      remaining.push(i);
    }
  });
  if (preRefused) save();
  let postedNow = 0;

  const finish = (aborted: boolean, chunks?: ChunkSummary[]): JournaledBatchResult => {
    const all = Array.from({ length: rows.length }, (_, i) => results[i] ?? { index: i, status: 'error' as const, code: 'UNKNOWN', message: 'Row was not processed.' });
    return {
      atomic, aborted,
      // Only rows posted by THIS run; rows posted by an earlier run are counted in alreadyPosted, and a
      // validation pass (dryRun / an aborted atomic batch) posts nothing.
      posted: postedNow,
      skipped: all.filter(r => r.status === 'skipped').length,
      results: all,
      ...(params.dryRun ? {} : { batchId: journal.batchId }),
      // Rows a re-send found already in Tally from an earlier attempt were posted by an earlier run too.
      alreadyPosted: alreadyPosted + landedNow,
      ...(chunks ? { chunks } : {}),
      ...(signal?.aborted && !params.dryRun ? { cancelled: true } : {}),
    };
  };

  if (!remaining.length) return finish(atomic && preRefused > 0, []);
  let toSend = remaining;

  if (atomic || params.dryRun) {
    const check = await execute(remaining.map(i => rows[i]!), { dryRun: true, atomic: false });
    check.results.forEach((r, k) => { results[remaining[k]!] = remap(r, remaining[k]!); });
    if (params.dryRun) return finish(atomic && (preRefused > 0 || check.results.some(r => r.status === 'error')));
    // Journal the refusals. A re-sent outcome-unknown row refused by its own earlier attempt's voucher
    // (DUPLICATE_NUMBER naming it) is settled as posted by record(): no failure, and not sent again.
    check.results.forEach((r, k) => {
      if (r.status !== 'error') return;
      record(remaining[k]!, r);
      results[remaining[k]!] = shown.get(remaining[k]!) ?? results[remaining[k]!]!;
    });
    if (preRefused > 0 || remaining.some(i => results[i]!.status === 'error')) {
      save();
      return finish(true);
    }
    if (shown.size) save();
    toSend = remaining.filter(i => journal.rows[i]!.status !== 'success');
    if (!toSend.length) return finish(false, []);
  }

  const size = Math.max(1, Math.floor(params.chunkSize ?? toSend.length));
  const chunks: ChunkSummary[] = [];
  for (let start = 0; start < toSend.length; start += size) {
    const idx = toSend.slice(start, start + size);
    if (signal?.aborted) {
      for (const orig of idx) results[orig] = notSentRow(orig);
      continue;
    }
    const seen = new Set<number>();
    const out = await execute(idx.map(i => rows[i]!), {
      atomic: false,
      signal,
      onBeforeSend: (local, info) => {
        const orig = idx[local];
        const jr = orig === undefined ? undefined : journal.rows[orig];
        if (!jr) return;
        jr.status = 'sending';
        // Only what was in Tally BEFORE the batch counts, so the first successful lookup of each kind wins,
        // and a re-send of an outcome-unknown row records none: a lookup now could find this batch's own
        // voucher from the earlier attempt and call it pre-existing (and settleResend would then lose it).
        if (!wasUnknown.has(orig)) {
          const merge = (ids: string[]) => { jr.preExistingMasterIds = [...new Set([...(jr.preExistingMasterIds ?? []), ...ids.map(String)])]; };
          if (!jr.preExistingChecked && info.preExistingMasterIds) {
            merge(info.preExistingMasterIds);
            jr.preExistingChecked = true;
          }
          if (!jr.remoteIdMasterIds && info.remoteIdMasterIds) {
            jr.remoteIdMasterIds = info.remoteIdMasterIds.map(String);
            merge(jr.remoteIdMasterIds);
          }
        }
        save();
      },
      onRow: (row) => { const orig = idx[row.index]; if (orig === undefined) return; seen.add(orig); record(orig, row); save(); },
    });
    const final: BatchRow[] = out.results.map((r, k) => {
      const orig = idx[k]!;
      // Belt and braces: a row onRow never saw (an executor that does not call it) is still journalled.
      if (!seen.has(orig)) { record(orig, r); save(); }
      results[orig] = shown.get(orig) ?? remap(r, orig);
      if (results[orig]!.status === 'success') postedNow++;
      return results[orig]!;
    });
    chunks.push({
      chunk: chunks.length + 1, rows: [idx[0]!, idx[idx.length - 1]!],
      posted: final.filter(r => r.status === 'success').length,
      skipped: final.filter(r => r.status === 'skipped').length,
      errors: final.filter(r => r.status === 'error').length,
    });
  }
  return finish(false, chunks);
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────

export type UndoDeps = {
  /** resolveDeleteTarget({ voucherType, masterId }) bound to the company. */
  resolve: (masterId: string, voucherType: string) => Promise<{ status: string; located?: any; message?: string }>;
  /** The voucher's export block (fetchVoucherExportBlock), for the "changed after posting" check. */
  fetchBlock: (located: any) => Promise<{ block?: string; error?: string }>;
  /** deleteResolvedVoucher bound to the company: the delete-vouchers path. */
  deleteOne: (located: any) => Promise<{ status: string; message?: string; deleteForm?: string; created?: number; form?: string }>;
  /**
   * The vouchers bound to a REMOTEID now (cancelled and optional included), or null on a read failure. The
   * proof that an altered or re-sent row's voucher is this batch's own (see provenNew). Without it such a
   * row always needs confirmation.
   */
  findByRemoteId?: (remoteId: string) => Promise<any[] | null>;
};

export type UndoPlanRow = {
  index: number;
  masterId: string;
  voucherType: string;
  voucherNumber?: string;
  date: string;
  amount: number;
  reference?: string;
  sourceRows?: number[];
  status: 'will_delete' | 'already_gone' | 'changed' | 'existed_before' | 'needs_confirmation' | 'error';
  code?: string;
  message?: string;
  /** Outcome-unknown row: the vouchers that may be its earlier attempt (confirm one by master id). */
  candidateMasterIds?: string[];
  located?: any;
};

/**
 * True only when it is shown that `mid` did not exist before the batch: the REMOTEID lookup made before
 * the row was first sent ran and found NO voucher bound to the row's REMOTEID — the key Tally alters by,
 * which also catches slug-equivalent references, cancelled/optional vouchers and edited references — and
 * the same lookup, now, finds exactly `mid`, so on this Tally build it does see the REMOTEID it was asked
 * for (a build whose $RemoteID reads empty would have "found nothing" before the batch too).
 */
async function provenNew(jr: JournalRow, mid: string, deps: UndoDeps): Promise<boolean> {
  if (!deps.findByRemoteId || !jr.remoteId || !Array.isArray(jr.remoteIdMasterIds) || jr.remoteIdMasterIds.length) return false;
  try {
    const now = await deps.findByRemoteId(jr.remoteId);
    return !!now?.some((r: any) => String(r?.master_id ?? '').trim() === mid);
  } catch {
    return false;
  }
}

/**
 * Resolves and verifies every voucher the batch posted. Read-only.
 *
 * A row Tally ALTERED (created 0 / altered > 0), or one journalled as posted because its re-send found the
 * earlier attempt's voucher (landedEarlier), is will_delete only when provenNew shows its voucher did not
 * exist before the batch; one whose master id was already in Tally is existed_before, and any other is
 * needs_confirmation. An outcome-unknown row is always listed: with the candidate vouchers its re-send met
 * (needs_confirmation), or as unresolved.
 *
 * confirmMasterIds: vouchers the caller has explicitly confirmed may be deleted although this batch may
 * not have created them (existed_before / needs_confirmation). They still have to resolve and be unchanged.
 */
export async function planUndo(journal: BatchJournal, deps: UndoDeps, opts: { confirmMasterIds?: Set<string> } = {}): Promise<UndoPlanRow[]> {
  const plan: UndoPlanRow[] = [];
  for (const jr of journal.rows) {
    const base = {
      index: jr.index, masterId: validMasterId(jr.masterId) ?? '', voucherType: jr.voucherType, voucherNumber: jr.voucherNumber,
      date: jr.date, amount: jr.amount, ...(jr.reference ? { reference: jr.reference } : {}), ...(jr.sourceRows ? { sourceRows: jr.sourceRows } : {}),
    };
    const what = `${jr.voucherType}${jr.voucherNumber ? ' #' + jr.voucherNumber : ''}, ${jr.date}, amount ${jr.amount}`;
    // A row that may be in Tally with no master id to find it by: say so, never pass over it in silence.
    if (isOutcomeUnknown(jr.status)) {
      const candidates = (jr.candidateMasterIds ?? []).map(String).filter(m => validMasterId(m));
      const picked = candidates.find(m => opts.confirmMasterIds?.has(m));
      if (picked) {
        // The user has confirmed which voucher is this row's: verified like any other before it goes.
        plan.push(await verifyForDelete({ ...base, masterId: picked }, jr, deps));
        continue;
      }
      if (candidates.length) {
        const list = candidates.join(', ');
        plan.push({
          ...base, masterId: candidates.length === 1 ? candidates[0]! : '', candidateMasterIds: candidates, status: 'needs_confirmation', code: OUTCOME_UNKNOWN,
          message: `Row ${jr.index} (${what}) was sent but the batch never learned whether Tally saved it. Re-sent later, it met master_id ${list} in Tally, which may be that earlier attempt or a voucher that was already there. Not deleted; only if the user confirms (Day Book) that one of them is this batch's voucher, re-call with confirmMasterIds including that master id.`,
        });
        continue;
      }
      plan.push({ ...base, status: 'error', code: OUTCOME_UNKNOWN, message: `Row ${jr.index} (${what}) was sent but the batch never learned whether Tally saved it, so there is no master id to delete. Check the Day Book and delete it there if it is present.` });
      continue;
    }
    if (jr.status !== 'success') continue;
    if (!base.masterId) {
      plan.push({ ...base, status: 'error', code: 'PRECONDITION_FAILED', message: `Row ${jr.index} (${what}) was posted, but Tally's master id for it was not recorded. Locate it (find-voucher-by-reference / the Day Book) and delete it with delete-voucher.` });
      continue;
    }
    const mid = base.masterId;
    const confirmed = !!opts.confirmMasterIds?.has(mid);
    // The batch ALTERED a voucher that was already in Tally (same reference or REMOTEID): deleting it would
    // take a voucher out of the books that this batch did not put there.
    if (!confirmed && jr.preExistingMasterIds?.includes(mid)) {
      plan.push({ ...base, status: 'existed_before', code: 'PRECONDITION_FAILED', message: `master_id ${mid} (${what}) was already in Tally before this batch: the batch's row carried the same reference (or REMOTEID), so Tally altered that voucher instead of creating one. Deleting it would remove a voucher this batch did not create. Not deleted; only if the user confirms it should go, re-call with confirmMasterIds including ${mid}.` });
      continue;
    }
    // Tally altered rather than created, or the voucher was found by a re-send rather than reported by the
    // post: unless it is proven new, it may be a voucher that was in the books before the batch, which the
    // pre-send lookups missed. (A legitimately new voucher can come back altered too — a retry of a rejected
    // attempt — so this asks rather than refuses.)
    const alteredOnly = (jr.altered ?? 0) > 0 && !((jr.created ?? 0) > 0);
    if (!confirmed && (alteredOnly || jr.landedEarlier) && !(await provenNew(jr, mid, deps))) {
      const why = jr.landedEarlier
        ? `was found in Tally when this row was re-sent on resume (the earlier attempt's answer was lost) and is taken to be that attempt's voucher, but it could not be proven that it did not exist before this batch`
        : !jr.preExistingChecked && !Array.isArray(jr.remoteIdMasterIds)
          ? `was ALTERED by Tally rather than created, and it could not be checked whether that voucher existed before this batch`
          : `was ALTERED by Tally rather than created. No earlier voucher with this reference was found before the batch, but Tally alters by REMOTEID, which an earlier voucher can share without the same reference text (punctuation spelled differently, a cancelled or optional voucher, a reference edited in Tally), and that could not be ruled out`;
      plan.push({ ...base, status: 'needs_confirmation', code: 'PRECONDITION_FAILED', message: `master_id ${mid} (${what}) ${why}. Not deleted; if the user confirms this batch created it, re-call with confirmMasterIds including ${mid}.` });
      continue;
    }
    plan.push(await verifyForDelete(base, jr, deps));
  }
  return plan;
}

type UndoBase = Omit<UndoPlanRow, 'status' | 'code' | 'message' | 'located' | 'candidateMasterIds'>;

/** Resolves master id `base.masterId` and checks the live voucher still posts what the row posted. */
async function verifyForDelete(base: UndoBase, jr: JournalRow, deps: UndoDeps): Promise<UndoPlanRow> {
  const mid = base.masterId;
  let r: { status: string; located?: any; message?: string };
  try { r = await deps.resolve(mid, jr.voucherType); } catch (e: any) { r = { status: 'error', message: String(e?.message ?? e) }; }
  if (r.status === 'already_gone') return { ...base, status: 'already_gone', message: r.message };
  if (r.status !== 'resolved' || !r.located) {
    return { ...base, status: 'error', code: r.status === 'mismatch' ? 'VOUCHER_CHANGED' : 'PRECONDITION_FAILED', message: r.message ?? `master_id ${mid} did not resolve (${r.status}).` };
  }
  const located = r.located;
  const live = { ...base, voucherNumber: located.voucher_number != null && String(located.voucher_number) !== '' ? String(located.voucher_number) : base.voucherNumber };
  if (!jr.postedHash) {
    return { ...live, status: 'error', code: 'PRECONDITION_FAILED', message: `No posting fingerprint was journalled for master_id ${mid}, so it cannot be shown to be unchanged.` };
  }
  let ex: { block?: string; error?: string };
  try { ex = await deps.fetchBlock(located); } catch (e: any) { ex = { error: String(e?.message ?? e) }; }
  const posting = ex.block ? normalizedPostingFromExport(ex.block) : null;
  if (!posting) {
    return { ...live, status: 'error', code: 'PRECONDITION_FAILED', message: `Could not read master_id ${mid} back from Tally to check it is unchanged: ${ex.error ?? 'no export block'}.` };
  }
  if (postingHash(posting) !== jr.postedHash) {
    return { ...live, status: 'changed', code: 'VOUCHER_CHANGED', message: `master_id ${mid} (${jr.voucherType}${live.voucherNumber ? ' #' + live.voucherNumber : ''}, ${jr.date}) was changed after this batch posted it (date, type, ledgers or amounts differ). Not deleted.` };
  }
  return { ...live, status: 'will_delete', located };
}

export type UndoRowResult = Omit<UndoPlanRow, 'located' | 'status'> & {
  status: 'deleted' | 'already_gone' | 'changed' | 'existed_before' | 'needs_confirmation' | 'requires_gui' | 'failed' | 'error' | 'not_attempted';
  deleteForm?: string;
};

/**
 * Deletes the will_delete rows one by one through deps.deleteOne, marking each undone in the journal as
 * it goes. Halts at once if a delete makes Tally CREATE a row (the delete-vouchers rule). A voucher only
 * deletable on screen (Edit Log builds refuse XML deletes of unkeyed vouchers) comes back requires_gui.
 * Every other plan status is reported and left alone.
 */
export async function executeUndo(
  journal: BatchJournal, plan: UndoPlanRow[], deps: UndoDeps, save: () => void, now: () => number = Date.now
): Promise<{ halted: boolean; results: UndoRowResult[] }> {
  const results: UndoRowResult[] = [];
  const strip = ({ located: _l, status: _s, ...rest }: UndoPlanRow) => rest;
  const markUndone = (index: number) => {
    const jr = journal.rows[index];
    if (jr) { jr.status = 'undone'; jr.undoneAt = new Date(now()).toISOString(); }
    try { save(); } catch { /* best effort */ }
  };
  let halted = false;
  for (const p of plan) {
    if (halted) { results.push({ ...strip(p), status: 'not_attempted', message: 'Not attempted: the undo halted on an earlier voucher.' }); continue; }
    if (p.status === 'already_gone') { markUndone(p.index); results.push({ ...strip(p), status: 'already_gone' }); continue; }
    if (p.status !== 'will_delete') { results.push({ ...strip(p), status: p.status }); continue; }
    let out: { status: string; message?: string; deleteForm?: string; created?: number; form?: string };
    try { out = await deps.deleteOne(p.located); } catch (e: any) { out = { status: 'error', message: String(e?.message ?? e) }; }
    if (out.status === 'deleted') { markUndone(p.index); results.push({ ...strip(p), status: 'deleted', ...(out.deleteForm ? { deleteForm: out.deleteForm } : {}) }); continue; }
    if (out.status === 'created_instead') {
      halted = true;
      results.push({ ...strip(p), status: 'failed', code: 'PRECONDITION_FAILED', message: `HALTED: deleting master_id ${p.masterId} made Tally CREATE ${out.created ?? '?'} voucher(s) via form "${out.form ?? '?'}". Check the Day Book. Remaining vouchers were not processed.` });
      continue;
    }
    if (out.status === 'requires_gui') {
      results.push({ ...strip(p), status: 'requires_gui', message: `${out.message ?? 'Tally refused every XML delete form for this voucher.'} Use gui-delete-voucher with masterId ${p.masterId} (navigate to it and confirm by screenshot), then run undo-batch again to record it.` });
      continue;
    }
    results.push({ ...strip(p), status: 'failed', message: out.message ?? `Delete of master_id ${p.masterId} did not take effect.` });
  }
  return { halted, results };
}
