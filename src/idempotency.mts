import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// File-backed idempotency store (#95 H-9, #97 H-11). Maps an idempotency key to the prior result so
// replaying the same key returns the stored outcome instead of re-posting a voucher (→ DUPLICATE /
// dedupe).
//
// ONE FILE PER KEY (#27). The first version kept every record in a single JSON file and rewrote the
// whole file on each put: read all → add one → write temp → rename. That is a lost update the moment
// two processes write at once, and they do — every AI app window runs its own server process, and a
// Windows service may run one more, all sharing TALLY_DATA_PATH. Process A reads {k1}, B reads {k1},
// A writes {k1,k2}, B writes {k1,k3}: k2 is gone, and a replay of k2 re-posts a voucher that is
// already in the books. Both processes even shared the same ".tmp" name, so one rename could publish
// the other's half-written file.
//
// With one file per key there is nothing to merge: a put writes only its own record, via a temp file
// whose name carries pid + random (so no two writers ever share one) and an atomic rename. Two puts
// of the SAME key race harmlessly — both carry a result for that key, and the last rename wins whole.
//
//   <baseDir>/.tally-mcp-idempotency/<sha256(key) hex>.json   one record: { key, result, at }
//   <baseDir>/.tally-mcp-idempotency.json                     legacy single file, migrated once
//
// The key is hashed for the file name because keys are caller-chosen strings (":" "/" "\" are all
// legal in a key and in a batch key "batch:<k>"), and a hash is always a safe, fixed-length name.
// The record keeps the plain key too, and get() checks it, so a hash collision could never replay a
// different key's result.
//
// IN-FLIGHT RESERVATION. A record only exists once Tally has answered, so get()-then-post alone leaves
// a window: a replay of the same key that arrives while the first call is still posting (the client
// timed out at 60s and the model re-sent; a 50-row batch takes 90s) finds no record and posts again.
// reserve() closes it. Before the first write the caller exclusively creates
//
//   <baseDir>/.tally-mcp-idempotency/<sha256(key) hex>.pending    { key, pid, host, token, startedAt }
//
// and a second caller that finds a live reservation is told the first is still running instead of
// posting. On success the final record is written FIRST and the reservation removed after, so a reader
// never sees neither. Every other exit (refusal, error, dry run, throw) just releases it, so a failed
// first attempt never blocks a legitimate retry.
//
// A reservation is stale (taken over) when its process is gone, when it is older than any write could
// take (pendingStaleMs, default 30 min), or when it carries THIS process's pid but a token this process
// never issued: pids are reused (Windows reuses them readily), so a leftover from a crashed earlier
// process can carry our own pid, and only the token tells it from a live call of ours.
//
// Deliberately synchronous: writes are rare (only after a successful write to Tally) and small.
export type IdempotencyRecord = { key: string; result: unknown; at: string };

export type PendingRecord = { key: string; pid: number; host: string; token: string; startedAt: string };

export type IdempotencyReservation = {
  /** Removes the reservation if it is still ours. Idempotent; never throws. */
  release(): void;
};

export type ReserveResult =
  | { ok: true; reservation: IdempotencyReservation }
  | { ok: false; holder: PendingRecord | null; retryAfterSec: number };

export type IdempotencyStore = {
  get(key: string): IdempotencyRecord | null;
  put(key: string, result: unknown, at: string): void;
  /** Claims the key for one in-flight write. Never waits. */
  reserve(key: string): ReserveResult;
};

export type IdempotencyStoreOptions = {
  /** Records older than this (by their `at`) are swept away. Default 30 days. */
  ttlMs?: number;
  /** Sweep again after this many puts by this process (besides once per process start). Default 500. */
  sweepEveryPuts?: number;
  /** A reservation older than this is stale whatever its pid. Default 30 minutes: longer than any batch. */
  pendingStaleMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Process liveness, for tests. */
  isPidAlive?: (pid: number) => boolean;
};

export const IDEMPOTENCY_DIR_NAME = '.tally-mcp-idempotency';
export const LEGACY_IDEMPOTENCY_FILE_NAME = '.tally-mcp-idempotency.json';
export const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_PENDING_STALE_MS = 30 * 60 * 1000;

// Reservation tokens issued by THIS process and not yet released, across every store instance.
const heldTokens = new Set<string>();

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

export function idempotencyPendingFileName(key: string): string {
  return idempotencyKeyFileName(key).replace(/\.json$/, '.pending');
}

/** Is this reservation stale (safe to take over)? Pure over its inputs, for the test. */
export function isPendingStale(
  rec: PendingRecord | null,
  fileMtimeMs: number,
  nowMs: number,
  staleMs: number,
  alive: (pid: number) => boolean = defaultIsPidAlive,
  ownTokens: ReadonlySet<string> = heldTokens,
  thisHost: string = os.hostname(),
  thisPid: number = process.pid
): boolean {
  // Unreadable: most likely caught half-written by its creator. Stale only once the file is old.
  if (!rec) return nowMs - fileMtimeMs > 5_000;
  const started = Date.parse(rec.startedAt);
  if (!Number.isFinite(started) || nowMs - started > staleMs) return true;
  // Another machine sharing the data folder cannot be pid-checked from here; age only.
  if (rec.host && rec.host !== thisHost) return false;
  if (rec.pid === thisPid) return !ownTokens.has(rec.token);
  return !alive(rec.pid);
}

export function idempotencyKeyFileName(key: string): string {
  return `${crypto.createHash('sha256').update(key, 'utf8').digest('hex')}.json`;
}

function writeAtomic(file: string, value: unknown): void {
  // pid + random: two processes (or two stores in one process) never write the same temp file, so a
  // rename can only ever publish a file its own writer finished.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

function readPending(file: string): PendingRecord | null {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
    return obj && typeof obj === 'object' && typeof obj.token === 'string' ? obj as PendingRecord : null;
  } catch {
    return null;
  }
}

function tryCreatePending(file: string, rec: PendingRecord): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try { fs.writeSync(fd, JSON.stringify(rec)); } finally { fs.closeSync(fd); }
  return true;
}

function readRecord(file: string): IdempotencyRecord | null {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''));
    return obj && typeof obj === 'object' && typeof obj.key === 'string' ? obj as IdempotencyRecord : null;
  } catch {
    return null;
  }
}

/**
 * The store for one base directory (TALLY_DATA_PATH in production). Migration of the legacy single
 * file and the first expiry sweep both run lazily on first use, never at construction, so creating the
 * store can never fail a tool call.
 */
export function makeIdempotencyStore(baseDir: string, opts: IdempotencyStoreOptions = {}): IdempotencyStore {
  const dir = path.join(baseDir, IDEMPOTENCY_DIR_NAME);
  const legacyFile = path.join(baseDir, LEGACY_IDEMPOTENCY_FILE_NAME);
  const ttlMs = opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const sweepEvery = Math.max(1, opts.sweepEveryPuts ?? 500);
  const now = opts.now ?? Date.now;
  const pendingStaleMs = opts.pendingStaleMs ?? DEFAULT_PENDING_STALE_MS;
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  let initialised = false;
  let putsSinceSweep = 0;

  const fileFor = (key: string) => path.join(dir, idempotencyKeyFileName(key));
  const pendingFor = (key: string) => path.join(dir, idempotencyPendingFileName(key));
  const pendingIsStale = (file: string): boolean => {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return false; } // gone: nothing to take over
    return isPendingStale(readPending(file), st.mtimeMs, now(), pendingStaleMs, alive);
  };

  // Takeover of a stale reservation goes through a short-lived exclusive guard file, as the machine lock
  // does: without it two callers that both judged the same reservation stale could each unlink it, and
  // the slower one would delete the fresh reservation the faster one had just made.
  const takeOverStalePending = (file: string, rec: PendingRecord): boolean => {
    const guard = `${file}.takeover`;
    try { if (now() - fs.statSync(guard).mtimeMs > 10_000) fs.unlinkSync(guard); } catch { /* no guard */ }
    let gfd: number;
    try { gfd = fs.openSync(guard, 'wx'); } catch { return false; }
    try {
      fs.closeSync(gfd);
      if (fs.existsSync(file)) {
        if (!pendingIsStale(file)) return false;
        try { fs.unlinkSync(file); } catch { /* someone else removed it */ }
      }
      return tryCreatePending(file, rec);
    } finally {
      try { fs.unlinkSync(guard); } catch { /* ignore */ }
    }
  };
  const isExpired = (at: string | undefined, fallbackMs?: number): boolean => {
    const t = Date.parse(String(at ?? ''));
    const when = Number.isFinite(t) ? t : fallbackMs;
    return when !== undefined && now() - when > ttlMs;
  };

  // Legacy single-file migration. Every record is written as its own file unless one already exists
  // (a per-key file is always at least as new as the legacy copy), then the legacy file is renamed to
  // .migrated so no process migrates it twice. Two processes migrating at once is harmless: both write
  // identical records, and the loser's rename fails quietly because the file is already gone.
  const migrateLegacy = () => {
    let raw: string;
    try { raw = fs.readFileSync(legacyFile, 'utf-8'); } catch { return; }
    let all: Record<string, IdempotencyRecord> = {};
    try {
      const obj = JSON.parse(raw.replace(/^﻿/, ''));
      if (obj && typeof obj === 'object') all = obj;
    } catch { /* unreadable legacy file: keep it renamed aside rather than retrying forever */ }
    for (const [key, rec] of Object.entries(all)) {
      if (!key || !rec || typeof rec !== 'object') continue;
      const file = fileFor(key);
      if (fs.existsSync(file)) continue;
      try { writeAtomic(file, { key, result: (rec as IdempotencyRecord).result, at: (rec as IdempotencyRecord).at }); } catch { /* best effort */ }
    }
    try { fs.renameSync(legacyFile, `${legacyFile}.migrated`); } catch { /* another process got there first */ }
  };

  // Expiry sweep. Never throws: an unreadable record is judged by its file time, and a stray temp file
  // left by a crashed writer is removed once it is an hour old.
  const sweep = () => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (name.endsWith('.tmp')) {
          if (now() - fs.statSync(file).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(file);
          continue;
        }
        // Reservations left by a crashed call. A live one is left alone, whoever holds it.
        if (name.endsWith('.pending')) {
          if (pendingIsStale(file)) fs.unlinkSync(file);
          continue;
        }
        if (!name.endsWith('.json')) continue;
        const rec = readRecord(file);
        if (isExpired(rec?.at, rec ? undefined : fs.statSync(file).mtimeMs)) fs.unlinkSync(file);
      } catch { /* raced with another sweeper or writer; skip */ }
    }
  };

  const init = () => {
    if (initialised) return;
    initialised = true;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* get() then simply finds nothing */ }
    try { migrateLegacy(); } catch { /* never block a write on housekeeping */ }
    try { sweep(); } catch { /* idem */ }
  };

  return {
    get(key: string): IdempotencyRecord | null {
      if (!key) return null;
      init();
      const rec = readRecord(fileFor(key));
      if (!rec || rec.key !== key) return null;
      // An expired record is not replayed even if the sweep has not reached it yet: expiry has to mean
      // the same thing whichever process (and whichever sweep timing) answers.
      if (isExpired(rec.at)) return null;
      return rec;
    },
    put(key: string, result: unknown, at: string): void {
      if (!key) return;
      init();
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(fileFor(key), { key, result, at });
      if (++putsSinceSweep >= sweepEvery) {
        putsSinceSweep = 0;
        try { sweep(); } catch { /* never throws */ }
      }
    },
    reserve(key: string): ReserveResult {
      if (!key) return { ok: true, reservation: { release() { /* nothing reserved */ } } };
      init();
      fs.mkdirSync(dir, { recursive: true });
      const file = pendingFor(key);
      const rec: PendingRecord = {
        key, pid: process.pid, host: os.hostname(),
        token: `${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
        startedAt: new Date(now()).toISOString(),
      };
      // Registered before the file exists, so a concurrent call in this process that reads the file the
      // instant it appears never judges our own live reservation stale.
      heldTokens.add(rec.token);
      let got = false;
      try {
        got = tryCreatePending(file, rec) || (pendingIsStale(file) && takeOverStalePending(file, rec));
      } catch (err) {
        heldTokens.delete(rec.token);
        throw err;
      }
      if (!got) {
        heldTokens.delete(rec.token);
        const holder = readPending(file);
        const elapsedSec = holder ? Math.max(0, (now() - Date.parse(holder.startedAt)) / 1000) : 0;
        return { ok: false, holder, retryAfterSec: Math.max(5, Math.min(60, Math.ceil(30 - elapsedSec))) };
      }
      let released = false;
      return {
        ok: true,
        reservation: {
          release() {
            if (released) return;
            released = true;
            heldTokens.delete(rec.token);
            // Only remove it if it is still ours: after a takeover (we were judged stale) it is not.
            if (readPending(file)?.token === rec.token) { try { fs.unlinkSync(file); } catch { /* gone */ } }
          },
        },
      };
    },
  };
}
