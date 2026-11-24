// In-flight XML writes (#26, review of #44).
//
// XML writes never take the machine-wide lock (Tally serialises XML itself, and posting must not queue
// behind a screen action), so the lock alone cannot tell a company load that a write is still on the
// wire. guardedWrite only checked the lock BEFORE writing: a load-company in another window could take
// the lock a moment later and force-kill Tally while that write was being processed, leaving its
// outcome unknown (and a retry without skipIfExists could then duplicate the voucher). With
// RESTART_COUNTDOWN_SEC=0 the kill follows the lock almost at once.
//
// So both sides announce themselves before they look at the other, and neither can miss the other:
//   - a writer drops a marker here FIRST, then checks the load lock; if a load holds it, the writer
//     removes its marker and backs off without writing.
//   - load-company takes the lock FIRST (no new write can pass the check after that), then waits for
//     every live marker to go away before it rewrites tally.ini and kills Tally.
//
// Deliberately separate from the activity records (_mcp_activity): those are a visual signal the tray
// reads, can be switched off with CLAUDALLY_NO_ACTIVITY=1, and are written by a heartbeat that may lag
// the real start of a write. Turning the orange frame off must not turn this safety check off.
//
//   <coordination dir>/_mcp_writes/<pid>-<token>.json   { schemaVersion, pid, host, tool, startedAt, token }
//
// One file per write (not per process): one server process runs several tool calls concurrently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coordinationDir, isPidAlive } from './coordination.mjs';

export type InflightWrite = { schemaVersion: 1; pid: number; host: string; tool: string; startedAt: string; token: string };

export function inflightWritesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(coordinationDir(env), '_mcp_writes');
}

/**
 * Longest one XML write can legitimately stay in flight: the pre-flight ping plus one request, each
 * bounded by its own timeout (TALLY_PING_TIMEOUT_MS / TALLY_REQUEST_TIMEOUT_MS), with a generous margin.
 * A marker older than this is a leftover (a crash between write and cleanup), never a live write.
 */
export function inflightWriteStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const req = Number.parseInt(env.TALLY_REQUEST_TIMEOUT_MS ?? '', 10);
  const ping = Number.parseInt(env.TALLY_PING_TIMEOUT_MS ?? '', 10);
  const total = (Number.isFinite(req) && req > 0 ? req : 30_000) + (Number.isFinite(ping) && ping > 0 ? ping : 3_000);
  return Math.max(60_000, 2 * total);
}

/**
 * Announces one XML write. Returns the function that removes the marker; call it when the write is
 * over, whatever its outcome. Never throws: if the marker cannot be written the write still goes ahead
 * (as it did before markers existed) rather than failing a tool call over housekeeping.
 */
export function beginInflightWrite(tool: string, opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): () => void {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const token = crypto.randomBytes(6).toString('hex');
  const file = path.join(inflightWritesDir(env), `${process.pid}-${token}.json`);
  const rec: InflightWrite = { schemaVersion: 1, pid: process.pid, host: os.hostname(), tool, startedAt: new Date(now()).toISOString(), token };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Exclusive create of a name nobody else can hold: no temp-and-rename needed, and a reader that
    // catches it half-written treats it as live (see isInflightWriteLive) rather than missing it.
    fs.writeFileSync(file, JSON.stringify(rec), { encoding: 'utf-8', flag: 'wx' });
  } catch {
    return () => { /* nothing was written */ };
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  };
}

/** Is this marker a write that may still be on the wire? Pure over its inputs, for the test. */
export function isInflightWriteLive(
  rec: InflightWrite | null,
  fileMtimeMs: number,
  nowMs: number,
  staleMs: number,
  alive: (pid: number) => boolean = isPidAlive,
  thisHost: string = os.hostname()
): boolean {
  // Unreadable: most likely caught mid-write. Count it as live until its file is clearly old.
  if (!rec) return nowMs - fileMtimeMs <= 5_000;
  const started = Date.parse(rec.startedAt);
  if (!Number.isFinite(started) || nowMs - started > staleMs) return false;
  // A writer on another machine (a shared data folder) cannot be pid-checked from here; age only.
  if (rec.host && rec.host !== thisHost) return true;
  return alive(rec.pid);
}

/** The writes still in flight, from every process (this one included). Removes dead markers it finds. */
export function liveInflightWrites(opts: { env?: NodeJS.ProcessEnv; now?: () => number; alive?: (pid: number) => boolean } = {}): InflightWrite[] {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const dir = inflightWritesDir(env);
  const staleMs = inflightWriteStaleMs(env);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const live: InflightWrite[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let mtime = 0;
    let rec: InflightWrite | null = null;
    try {
      mtime = fs.statSync(file).mtimeMs;
      const obj = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''));
      rec = obj && typeof obj === 'object' && obj.schemaVersion === 1 ? obj as InflightWrite : null;
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue; // finished while we looked
    }
    if (isInflightWriteLive(rec, mtime, now(), staleMs, opts.alive)) {
      live.push(rec ?? { schemaVersion: 1, pid: 0, host: '', tool: 'unknown', startedAt: new Date(mtime).toISOString(), token: name });
    } else {
      try { fs.unlinkSync(file); } catch { /* raced with its owner or another reader */ }
    }
  }
  return live;
}

/**
 * Waits up to maxWaitMs for every in-flight write to finish. Returns the writes still in flight at the
 * end ([] means none: safe to restart Tally). Call it only while holding the 'load' lock, so no new
 * write can start while this waits.
 */
export async function waitForInflightWrites(
  opts: { env?: NodeJS.ProcessEnv; maxWaitMs?: number; pollMs?: number; now?: () => number; alive?: (pid: number) => boolean } = {}
): Promise<InflightWrite[]> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxWaitMs ?? 30_000);
  for (;;) {
    const live = liveInflightWrites(opts);
    if (!live.length || now() >= deadline) return live;
    await new Promise(r => setTimeout(r, opts.pollMs ?? 250));
  }
}
