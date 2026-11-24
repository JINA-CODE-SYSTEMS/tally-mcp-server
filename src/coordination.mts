// Coordination between the server processes that share one Tally, and the tray that watches them.
//
// Every AI app window starts its own server process (stdio), and a Windows service may run one more.
// They all talk to the single Tally on the PC and nothing else coordinates them. This module holds the
// three small file contracts that do:
//
//   1. ACTIVITY (#22): "the AI is working on Tally right now". One file per server process, refreshed
//      while a Tally write, a screen action or a company load runs. The tray reads them and draws the
//      orange frame around Tally. Never blocks or fails a tool.
//   2. MACHINE LOCK (#26): one screen action or company load at a time, across every process. Exclusive
//      create, stale-lock takeover, and a typed BUSY answer instead of a confusing timeout.
//   3. RESTART COUNTDOWN (#25): before load-company restarts Tally, a request the tray shows as a
//      cancellable countdown, and the person's answer.
//
// All three live in coordinationDir(), which is TALLY_DATA_PATH. Not %LOCALAPPDATA%: a packaged
// (MSIX) client such as Claude Desktop has its AppData writes redirected into a private package
// folder, so two apps would each see their own lock and the tray would see neither. The Tally data
// folder is outside that virtualisation, is the same path for the service and every stdio process,
// and is where the GUI-agent IPC files already live. The formats are documented for the tray in
// docs/dev/coordination.md; change them only together.

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TALLY_DATA_PATH = 'C:\\Users\\Public\\TallyPrimeEditLog\\data';

/** The shared folder for coordination files. */
export function coordinationDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.TALLY_DATA_PATH ?? '').trim();
  if (configured) return configured;
  // Off Windows (tests, a Linux remote server) there is no Tally data folder; keep the files out of
  // the install tree and somewhere every process agrees on.
  return process.platform === 'win32' ? DEFAULT_TALLY_DATA_PATH : path.join(os.tmpdir(), 'claudally');
}

// On Windows, renaming over a file fails with EPERM/EACCES/EBUSY while another handle has the target
// open without FILE_SHARE_DELETE. The tray reads these files with File.ReadAllText, which opens them
// exactly that way, and antivirus scanners briefly hold freshly written files too. Both clear within
// milliseconds, so a short retry turns a lost write into a slightly late one.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 20;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes JSON to a temp file and renames it into place, retrying a rename that a reader is briefly
 * blocking. The temp file is always removed on failure: the tray and readActivityRecords only look at
 * *.json, so nothing else would ever clean up a leaked one. `rename` is injectable for tests.
 */
export function writeJsonAtomic(file: string, value: unknown, rename: (from: string, to: string) => void = fs.renameSync): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
    for (let attempt = 0; ; attempt++) {
      try { rename(tmp, file); return; } catch (err: any) {
        if (attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(err?.code)) throw err;
        sleepSync(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''); } catch { return null; }
}

function parseJson(text: string | null): any | null {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function readJson(file: string): any | null {
  return parseJson(readText(file));
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

// ── 1. Activity signal (#22) ────────────────────────────────────────────────────────────────────────

export type ActivityKind = 'posting' | 'controlling' | 'loading';

export type ActivityRecord = {
  schemaVersion: 1;
  kind: ActivityKind;
  tool: string;
  at: string;
  pid: number;
  /** Set while a screenshot is being captured: the tray hides the frame so the model never sees it. */
  hideForScreenshot?: boolean;
};

/** How long after the last refresh the tray keeps the frame up. The tray uses the same number. */
export const ACTIVITY_FRESH_MS = 4000;
/** How often a long-running action refreshes its record, well inside ACTIVITY_FRESH_MS. */
export const ACTIVITY_HEARTBEAT_MS = 1000;

export function activityDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), '_mcp_activity');
}

export function activityFile(pid: number = process.pid, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(activityDir(env), `${pid}.json`);
}

const ACTIVITY_RANK: Record<ActivityKind, number> = { loading: 3, controlling: 2, posting: 1 };

// Every action running in THIS process right now, per activity file. A server process has exactly one
// record file, but MCP handlers run concurrently: a post's heartbeat and a screenshot in the same process
// would otherwise overwrite each other's record every second, and the screenshot's "hide the frame"
// request would be lost (and the frame captured into what the model sees). Every write is therefore
// a merge of everything still running: the strongest kind wins, and the hide request is kept while any
// screenshot is in progress. Keyed by file so tests with their own TALLY_DATA_PATH stay separate.
type ActiveActivity = { kind: ActivityKind; tool: string; hide: boolean };
const activeActivities = new Map<string, Map<number, ActiveActivity>>();
let activitySeq = 0;

function mergeActivity(file: string, kind: ActivityKind, tool: string, hide: boolean): { kind: ActivityKind; tool: string; hide: boolean } {
  let best = { kind, tool };
  let anyHide = hide;
  for (const a of activeActivities.get(file)?.values() ?? []) {
    if (a.hide) anyHide = true;
    if (ACTIVITY_RANK[a.kind] > ACTIVITY_RANK[best.kind]) best = { kind: a.kind, tool: a.tool };
  }
  return { ...best, hide: anyHide };
}

/**
 * Writes this process's activity record. Never throws: the signal must never cost a tool its result.
 * The record is merged with any other action still running in this process (see activeActivities), so
 * the kind written may be a stronger one, and hideForScreenshot stays set while a screenshot runs.
 */
export function recordActivity(
  kind: ActivityKind,
  tool: string,
  opts: { env?: NodeJS.ProcessEnv; now?: Date; hideForScreenshot?: boolean } = {}
): string | undefined {
  try {
    if ((opts.env ?? process.env).CLAUDALLY_NO_ACTIVITY === '1') return undefined;
    const file = activityFile(process.pid, opts.env);
    const merged = mergeActivity(file, kind, tool, !!opts.hideForScreenshot);
    const rec: ActivityRecord = { schemaVersion: 1, kind: merged.kind, tool: merged.tool, at: (opts.now ?? new Date()).toISOString(), pid: process.pid };
    if (merged.hide) rec.hideForScreenshot = true;
    writeJsonAtomic(file, rec);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Runs fn with the activity signal up: written at the start, refreshed every second while fn runs (a
 * company load takes half a minute) and once more at the end, so the frame fades ACTIVITY_FRESH_MS
 * after the action really finished rather than after it started.
 *
 * hideForScreenshot keeps the "hide the frame" request fresh for the whole capture: the agent may wait
 * up to its userIdleWaitSec for a person to stop typing before it captures, far past ACTIVITY_FRESH_MS,
 * and the tray ignores a hide request it judges stale.
 */
export async function withActivity<T>(
  kind: ActivityKind,
  tool: string,
  fn: () => Promise<T>,
  env?: NodeJS.ProcessEnv,
  opts: { hideForScreenshot?: boolean } = {}
): Promise<T> {
  const file = activityFile(process.pid, env);
  const id = ++activitySeq;
  let running = activeActivities.get(file);
  if (!running) { running = new Map(); activeActivities.set(file, running); }
  running.set(id, { kind, tool, hide: !!opts.hideForScreenshot });
  recordActivity(kind, tool, { env });
  const beat = setInterval(() => recordActivity(kind, tool, { env }), ACTIVITY_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    running.delete(id);
    if (!running.size) activeActivities.delete(file);
    // Written after this action left the registry, so its own hide request is gone: the frame may come
    // back once the capture is done (unless another screenshot in this process is still running).
    recordActivity(kind, tool, { env });
  }
}

/**
 * The record the tray should act on: the freshest one from a live process, or null when nothing is
 * fresh. Pure over its inputs so the tray's rule is pinned by a test. Precedence when several processes
 * are active at once: loading > controlling > posting, because the stronger warning must win.
 */
export function pickActiveRecord(records: ActivityRecord[], nowMs: number, freshMs: number = ACTIVITY_FRESH_MS): ActivityRecord | null {
  const rank = ACTIVITY_RANK;
  const fresh = records.filter(r => {
    const t = Date.parse(r?.at);
    return Number.isFinite(t) && nowMs - t <= freshMs && nowMs - t >= -freshMs && rank[r.kind] !== undefined;
  });
  if (!fresh.length) return null;
  fresh.sort((a, b) => (rank[b.kind] - rank[a.kind]) || (Date.parse(b.at) - Date.parse(a.at)));
  return fresh[0]!;
}

export function readActivityRecords(env: NodeJS.ProcessEnv = process.env): ActivityRecord[] {
  const dir = activityDir(env);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch { return []; }
  return names.map(n => readJson(path.join(dir, n))).filter((r): r is ActivityRecord => !!r && r.schemaVersion === 1);
}

/** Removes this process's record (on exit). Best-effort. */
export function clearActivity(env: NodeJS.ProcessEnv = process.env): void {
  try { fs.unlinkSync(activityFile(process.pid, env)); } catch { /* already gone */ }
}

/** Banner text per kind. The tray carries the same three strings. */
export const ACTIVITY_BANNERS: Record<ActivityKind, string> = {
  posting: 'Your AI assistant is posting to Tally',
  controlling: "Your AI assistant is controlling Tally - please don't use the keyboard or mouse",
  loading: 'Your AI assistant is reopening Tally',
};

// ── 2. Machine-wide lock (#26) ─────────────────────────────────────────────────────────────────────

/** 'gui' for one screen action; 'load' for a company load or switch, which XML writes must also wait out. */
export type LockKind = 'gui' | 'load';

export type LockHolder = {
  pid: number; tool: string; kind: LockKind; startedAt: string; host: string; token: string;
  /**
   * Refreshed every LOCK_REFRESH_MS while the holder runs. A holder that carries it is judged by its last
   * refresh rather than by startedAt, so a long but live load-company is never taken over mid-restart.
   */
  refreshedAt?: string;
  /**
   * A passive agent probe (ping / idle-status) holding the lock for one short IPC round-trip. Other
   * callers wait it out rather than answering BUSY, and status does not report it as "busy".
   */
  probe?: boolean;
};

export type LockAttempt =
  | { ok: true; release: () => void; holder: LockHolder }
  | { ok: false; holder: LockHolder | null; retryAfterSec: number };

/**
 * How long a holder that does NOT refresh (one written by an older server) may keep the lock: a
 * load-company restart plus a margin.
 */
export function lockStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.MACHINE_LOCK_STALE_SEC ?? '', 10);
  return (Number.isFinite(raw) && raw > 0 ? raw : 300) * 1000;
}

/** How often a holder refreshes the lock file while it runs. */
export const LOCK_REFRESH_MS = 5000;
/**
 * A refreshing holder whose last refresh is older than this is stale (its process hung or its event
 * loop is stuck), whatever its pid says. Six missed refreshes: a sync step (taskkill, tasklist) can
 * delay one, never six.
 */
export const LOCK_REFRESH_STALE_MS = 30_000;

/**
 * Hard ceiling on any one hold, refreshing or not. The refresh timer keeps running even if the action
 * itself hangs, so without a ceiling a hung holder would keep the lock forever. Must stay above the
 * longest legitimate load-company (countdown up to 120 s + taskkill + start-tally + up to
 * LOAD_COMPANY_MAX_WAIT_SEC for Tally's XML port + verification and login, about 11 min at most).
 */
export function lockMaxHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.MACHINE_LOCK_MAX_HOLD_SEC ?? '', 10);
  return Math.max(lockStaleMs(env), (Number.isFinite(raw) && raw > 0 ? raw : 900) * 1000);
}

/** How long any lock taker waits for a passive probe (one ping / idle-status round-trip) to finish. */
export const PROBE_LOCK_WAIT_MS = 10_000;

export function lockFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), '_mcp_tally.lock');
}

/**
 * Is this recorded holder stale? A holder is stale if its process is gone, or if it has held the lock
 * longer than any action is allowed to take. "Longer" is measured from its last refresh when it
 * refreshes (with lockMaxHoldMs as a hard ceiling), and from startedAt when it does not. Unreadable lock
 * contents count as stale only once the file itself is old, so a lock caught half-written is not stolen.
 */
export function isLockStale(
  holder: LockHolder | null,
  fileMtimeMs: number,
  nowMs: number,
  staleMs: number,
  alive: (pid: number) => boolean = isPidAlive,
  maxHoldMs: number = Math.max(staleMs, 900_000)
): boolean {
  if (!holder) return nowMs - fileMtimeMs > 5000;
  const started = Date.parse(holder.startedAt);
  if (!Number.isFinite(started)) return true;
  const refreshed = holder.refreshedAt ? Date.parse(holder.refreshedAt) : Number.NaN;
  if (Number.isFinite(refreshed)) {
    if (nowMs - refreshed > LOCK_REFRESH_STALE_MS || nowMs - started > maxHoldMs) return true;
  } else if (nowMs - started > staleMs) {
    return true;
  }
  // A holder on another machine (a shared data folder) cannot be pid-checked from here; age only.
  if (holder.host && holder.host !== os.hostname()) return false;
  return !alive(holder.pid);
}

/** Suggested wait before retrying, from how long the holder has had the lock and what it is doing. */
export function retryAfterFor(holder: LockHolder | null, nowMs: number): number {
  if (!holder || holder.probe) return 2;
  const elapsed = Math.max(0, (nowMs - Date.parse(holder.startedAt)) / 1000);
  const typical = holder.kind === 'load' ? 45 : 10;
  return Math.max(2, Math.min(60, Math.ceil(typical - elapsed)));
}

function tryCreateLock(file: string, holder: LockHolder): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try { fs.writeSync(fd, JSON.stringify(holder)); } finally { fs.closeSync(fd); }
  return true;
}

/**
 * Removes the file at `file` only if it is still the one this process judged (same token, or for an
 * unreadable file the same bytes). Deleting by path after judging is a race: in between, the judged
 * holder may release and a third process create a fresh lock, which an unlink by path would delete,
 * leaving two holders. So the file is first renamed to a name only this caller uses (atomic: whatever
 * is moved is what gets checked), checked, and put back with linkSync when it turns out to be someone
 * else's. linkSync never overwrites: if yet another lock appeared meanwhile, that one stays.
 * Returns true when the path is now free.
 */
export function removeIfUnchanged(file: string, judgedText: string | null, uniqueSuffix: string): boolean {
  const moved = `${file}.${uniqueSuffix}`;
  try { fs.renameSync(file, moved); } catch (err: any) { return err?.code === 'ENOENT'; }
  const movedText = readText(moved);
  const judged = parseJson(judgedText) as LockHolder | null;
  const now = parseJson(movedText) as LockHolder | null;
  const same = judged?.token ? now?.token === judged.token : movedText === judgedText;
  if (!same) {
    try { fs.linkSync(moved, file); } catch { /* a newer lock is already in place; leave it */ }
  }
  try { fs.unlinkSync(moved); } catch { /* ignore */ }
  return same;
}

// Takeover of a stale lock is guarded by a second, short-lived exclusive file. Without it two processes
// that both judged the same lock stale could each remove it, and the slower one would delete the fresh
// lock the faster one just created. Under the guard: re-read, re-judge, remove-if-unchanged, re-create.
// The guard carries its creator's token so a crashed guard is cleared, and our own guard released,
// without ever deleting a guard someone else has just created.
function clearCrashedGuard(guard: string, nowMs: number, myToken: string): void {
  let st: fs.Stats;
  try { st = fs.statSync(guard); } catch { return; }
  if (nowMs - st.mtimeMs <= 10_000) return;
  const judgedText = readText(guard);
  const moved = `${guard}.stale-${myToken}`;
  try { fs.renameSync(guard, moved); } catch { return; }
  let same = false;
  try { same = readText(moved) === judgedText && fs.statSync(moved).mtimeMs === st.mtimeMs; } catch { /* treat as changed */ }
  if (!same) { try { fs.linkSync(moved, guard); } catch { /* a newer guard is in place */ } }
  try { fs.unlinkSync(moved); } catch { /* ignore */ }
}

function takeOverStaleLock(file: string, holder: LockHolder, staleMs: number, maxHoldMs: number, now: () => number): boolean {
  const guard = `${file}.takeover`;
  clearCrashedGuard(guard, now(), holder.token);
  let gfd: number;
  try { gfd = fs.openSync(guard, 'wx'); } catch { return false; }
  try { fs.writeSync(gfd, holder.token); } catch { /* an empty guard still guards */ } finally { fs.closeSync(gfd); }
  try {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return tryCreateLock(file, holder); }
    const text = readText(file);
    const current = parseJson(text) as LockHolder | null;
    if (!isLockStale(current, st.mtimeMs, now(), staleMs, isPidAlive, maxHoldMs)) return false;
    if (!removeIfUnchanged(file, text, `stale-${holder.token}`)) return false;
    return tryCreateLock(file, holder);
  } finally {
    if (readText(guard) === holder.token) { try { fs.unlinkSync(guard); } catch { /* ignore */ } }
  }
}

export function readLockHolder(env: NodeJS.ProcessEnv = process.env): LockHolder | null {
  return readJson(lockFile(env)) as LockHolder | null;
}

/**
 * Is the lock file still ours? Only a readable lock with another token, or no lock at all, says no: a
 * read that fails while the file is being renamed over (Windows sharing violation) is not a takeover.
 */
function lockStillHeld(file: string, token: string): boolean {
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''); } catch (err: any) { return err?.code !== 'ENOENT'; }
  const cur = parseJson(text) as LockHolder | null;
  return cur === null || cur.token === token;
}

/**
 * Rewrites refreshedAt on a held lock, only while the file on disk still carries our token. Returns
 * false once the lock has been taken over (or removed), so the holder can stop acting on it. A takeover
 * landing between the token check and the rename is not excluded; it needs the holder to have missed
 * LOCK_REFRESH_STALE_MS of refreshes first, which a live holder does not.
 */
export function refreshMachineLock(file: string, holder: LockHolder, nowMs: number = Date.now()): boolean {
  if (!lockStillHeld(file, holder.token)) return false;
  try { writeJsonAtomic(file, { ...holder, refreshedAt: new Date(nowMs).toISOString() }); } catch { /* next beat retries */ }
  return true;
}

/** One attempt to take the machine-wide lock. Never waits. */
export function tryAcquireMachineLock(
  tool: string,
  kind: LockKind,
  opts: { env?: NodeJS.ProcessEnv; now?: () => number; probe?: boolean; refreshing?: boolean } = {}
): LockAttempt {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const file = lockFile(env);
  const startedAt = new Date(now()).toISOString();
  const holder: LockHolder = {
    pid: process.pid, tool, kind, startedAt, host: os.hostname(),
    token: `${process.pid}-${now()}-${Math.random().toString(36).slice(2, 10)}`,
    // Declared only by a holder that will actually refresh (withMachineLock); a bare attempt keeps the
    // startedAt + MACHINE_LOCK_STALE_SEC rule.
    ...(opts.refreshing ? { refreshedAt: startedAt } : {}),
    ...(opts.probe ? { probe: true } : {}),
  };
  const release = () => {
    // Only remove the lock if it is still ours: after a stale takeover by someone else it is not. The
    // removal itself is rename-and-verify, so a takeover between the read and the unlink is not undone.
    const text = readText(file);
    const cur = parseJson(text) as LockHolder | null;
    if (cur?.token === holder.token) removeIfUnchanged(file, text, `release-${holder.token}`);
  };
  if (tryCreateLock(file, holder)) return { ok: true, release, holder };
  if (takeOverStaleLock(file, holder, lockStaleMs(env), lockMaxHoldMs(env), now)) return { ok: true, release, holder };
  const current = readJson(file) as LockHolder | null;
  return { ok: false, holder: current, retryAfterSec: retryAfterFor(current, now()) };
}

// Re-entrancy is per async call chain, not per process. load-company holds the lock and then drives the
// GUI agent, which takes the lock too: that inner take must pass. But two independent tool calls in the
// SAME process (MCP handlers run concurrently) must still exclude each other, which a pid check would not.
type HeldLock = { holder: LockHolder; file: string; lost: boolean };
const heldLock = new AsyncLocalStorage<HeldLock>();

export class MachineBusyError extends Error {
  constructor(public holder: LockHolder | null, public retryAfterSec: number) {
    super(describeBusy(holder));
    this.name = 'MachineBusyError';
  }
}

export function describeBusy(holder: LockHolder | null): string {
  if (!holder) return 'Another AI window is using Tally right now.';
  const what = holder.probe ? 'checking the screen-control helper'
    : holder.kind === 'load' ? 'reopening Tally to load a company' : 'controlling the Tally screen';
  const who = holder.pid === process.pid ? 'Another request in this AI window' : 'Another AI window';
  return `${who} is ${what} (${holder.tool}, started ${holder.startedAt}).`;
}

/**
 * Runs fn holding the machine-wide lock, or throws MachineBusyError at once when another call holds it.
 * waitMs > 0 retries for that long first (used where a short wait beats an error, e.g. a GUI step that
 * lands just as another finishes). A holder that is only a passive probe is always waited out (up to
 * PROBE_LOCK_WAIT_MS): it is one IPC round-trip, and answering BUSY to it would make every status call
 * in another window able to fail a screen action.
 *
 * While fn runs the lock is refreshed every LOCK_REFRESH_MS. If it is nevertheless taken over (the
 * holder hung past LOCK_REFRESH_STALE_MS or lockMaxHoldMs), nested takes in the same call chain throw
 * MachineBusyError instead of running, so the original holder stops driving the screen alongside the
 * new one.
 */
export async function withMachineLock<T>(
  tool: string,
  kind: LockKind,
  fn: () => Promise<T>,
  opts: { env?: NodeJS.ProcessEnv; waitMs?: number; probe?: boolean } = {}
): Promise<T> {
  const outer = heldLock.getStore();
  if (outer) {
    if (outer.lost || !lockStillHeld(outer.file, outer.holder.token)) {
      outer.lost = true;
      const current = readJson(outer.file) as LockHolder | null;
      throw new MachineBusyError(current, retryAfterFor(current, Date.now()));
    }
    return fn();
  }
  const startMs = Date.now();
  const deadline = startMs + (opts.waitMs ?? 0);
  const probeDeadline = startMs + PROBE_LOCK_WAIT_MS;
  const file = lockFile(opts.env);
  for (;;) {
    const got = tryAcquireMachineLock(tool, kind, { env: opts.env, probe: opts.probe, refreshing: true });
    if (got.ok) {
      const state: HeldLock = { holder: got.holder, file, lost: false };
      const beat = setInterval(() => { if (!refreshMachineLock(file, got.holder)) state.lost = true; }, LOCK_REFRESH_MS);
      beat.unref?.();
      try { return await heldLock.run(state, fn); } finally { clearInterval(beat); got.release(); }
    }
    const nowMs = Date.now();
    const waitingOutProbe = got.holder?.probe === true && nowMs < probeDeadline;
    if (nowMs >= deadline && !waitingOutProbe) throw new MachineBusyError(got.holder, got.retryAfterSec);
    await new Promise(r => setTimeout(r, got.holder?.probe ? 100 : 250));
  }
}

/** True when the current async chain already holds the lock. */
export function holdsMachineLock(): boolean {
  return !!heldLock.getStore();
}

/**
 * XML writes do not take the lock (Tally serialises XML itself), but must not run while a company load
 * holds it: Tally is about to be killed. Waits up to waitMs for the load to finish; returns the holder
 * if it is still loading after that, or null when the write may go ahead.
 */
export async function waitOutCompanyLoad(
  opts: { env?: NodeJS.ProcessEnv; waitMs?: number; now?: () => number } = {}
): Promise<LockHolder | null> {
  if (heldLock.getStore()) return null; // our own load is doing this write
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const envWait = Number.parseFloat(env.XML_WRITE_LOAD_WAIT_SEC ?? '');
  const deadline = now() + (opts.waitMs ?? (Number.isFinite(envWait) && envWait >= 0 ? envWait * 1000 : 15_000));
  for (;;) {
    const file = lockFile(env);
    let st: fs.Stats | null = null;
    try { st = fs.statSync(file); } catch { return null; }
    const holder = readJson(file) as LockHolder | null;
    if (!holder || holder.kind !== 'load') return null;
    if (isLockStale(holder, st.mtimeMs, now(), lockStaleMs(env), isPidAlive, lockMaxHoldMs(env))) return null;
    if (now() >= deadline) return holder;
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── 3. Restart countdown (#25) ─────────────────────────────────────────────────────────────────────

export type RestartRequest = {
  schemaVersion: 1;
  requestId: string;
  tool: string;
  company: string;
  pid: number;
  requestedAt: string;
  /** When the restart goes ahead unless cancelled. The tray counts down to this. */
  deadline: string;
};

export type RestartResponse = { schemaVersion: 1; requestId: string; decision: 'cancel' | 'proceed'; at: string };

export function restartRequestFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), '_mcp_restart_request.json');
}
export function restartResponseFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), '_mcp_restart_response.json');
}

export function restartCountdownSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.RESTART_COUNTDOWN_SEC ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 120) : 10;
}

/**
 * How long past the deadline the server still reads the tray's answer. The tray's timer ticks every
 * 250 ms and closes the countdown on the first tick at or after the deadline, so a click can still be
 * accepted (and the person told "cancelled") slightly after it. The final read happens at deadline +
 * this grace, after the last moment the tray can accept an answer.
 */
export const RESTART_ANSWER_GRACE_MS = 500;

/**
 * 'cancelled': the person pressed Cancel. 'proceed': the person pressed "Restart now". 'elapsed': nobody
 * answered (no tray running, the countdown is off, or the request could not be posted). Only 'proceed'
 * is a fresh go-ahead from someone at the PC; on 'elapsed' the caller must check again that nobody has
 * started using the PC during the wait.
 */
export type RestartCountdownOutcome = 'cancelled' | 'proceed' | 'elapsed';

/**
 * Posts the countdown for the tray and waits for it. With no tray running nobody can cancel, so the wait
 * simply elapses: the caller already has the user's confirmation, and re-checks the keyboard after.
 */
export async function runRestartCountdown(
  tool: string,
  company: string,
  opts: { env?: NodeJS.ProcessEnv; seconds?: number; pollMs?: number } = {}
): Promise<RestartCountdownOutcome> {
  const env = opts.env ?? process.env;
  const seconds = opts.seconds ?? restartCountdownSec(env);
  if (seconds <= 0) return 'elapsed';
  const pollMs = opts.pollMs ?? 250;
  const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const req: RestartRequest = {
    schemaVersion: 1, requestId, tool, company, pid: process.pid,
    requestedAt: new Date(now).toISOString(), deadline: new Date(now + seconds * 1000).toISOString(),
  };
  const reqFile = restartRequestFile(env);
  const respFile = restartResponseFile(env);
  try {
    writeJsonAtomic(reqFile, req);
  } catch {
    // Nobody can see or cancel a countdown that was never posted, which is the no-tray case. Fail
    // toward that case, not toward an instant restart: still give the full countdown period, so the
    // caller's after-countdown keyboard check covers it like any other unanswered countdown.
    await new Promise(r => setTimeout(r, seconds * 1000));
    return 'elapsed';
  }
  try {
    const end = now + seconds * 1000 + RESTART_ANSWER_GRACE_MS;
    // Poll until the end itself, not until a sleep happens to overshoot it: the last read is always at
    // or after `end`, so an answer the tray wrote in the final poll interval is still seen.
    for (;;) {
      const resp = readJson(respFile) as RestartResponse | null;
      if (resp?.requestId === requestId) {
        try { fs.unlinkSync(respFile); } catch { /* ignore */ }
        if (resp.decision === 'cancel') return 'cancelled';
        if (resp.decision === 'proceed') return 'proceed';
      }
      const left = end - Date.now();
      if (left <= 0) return 'elapsed';
      await new Promise(r => setTimeout(r, Math.min(pollMs, left)));
    }
  } finally {
    const cur = readJson(reqFile) as RestartRequest | null;
    if (cur?.requestId === requestId) { try { fs.unlinkSync(reqFile); } catch { /* ignore */ } }
  }
}
