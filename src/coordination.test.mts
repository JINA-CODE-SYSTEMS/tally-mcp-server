import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACTIVITY_BANNERS, LOCK_REFRESH_STALE_MS, MachineBusyError, RESTART_ANSWER_GRACE_MS, activityFile, coordinationDir,
  holdsMachineLock, isLockStale, lockFile, lockMaxHoldMs, pickActiveRecord, readActivityRecords, readLockHolder,
  recordActivity, refreshMachineLock, removeIfUnchanged, restartRequestFile, restartResponseFile, retryAfterFor,
  runRestartCountdown, tryAcquireMachineLock, waitOutCompanyLoad, withActivity, withMachineLock, writeJsonAtomic,
  type ActivityRecord, type LockHolder,
} from './coordination.mjs';

const tmpEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  return { env: { TALLY_DATA_PATH: dir } as NodeJS.ProcessEnv, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('the coordination folder is TALLY_DATA_PATH, shared by every process', () => {
  assert.equal(coordinationDir({ TALLY_DATA_PATH: 'D:\\Tally\\data' }), 'D:\\Tally\\data');
  assert.ok(coordinationDir({}).length > 0);
});

// ── activity (#22) ──

test('recordActivity writes one file per process that the tray can read back', () => {
  const t = tmpEnv();
  try {
    const file = recordActivity('posting', 'create-voucher', { env: t.env, now: new Date('2026-11-23T10:00:00Z') });
    assert.equal(file, activityFile(process.pid, t.env));
    const recs = readActivityRecords(t.env);
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0], { schemaVersion: 1, kind: 'posting', tool: 'create-voucher', at: '2026-11-23T10:00:00.000Z', pid: process.pid });
  } finally { t.done(); }
});

test('recordActivity never throws, even when the folder cannot be written', () => {
  const t = tmpEnv();
  try {
    const blocker = path.join(t.dir, 'file');
    fs.writeFileSync(blocker, '');
    assert.equal(recordActivity('posting', 'x', { env: { TALLY_DATA_PATH: blocker } }), undefined);
    assert.equal(recordActivity('posting', 'x', { env: { ...t.env, CLAUDALLY_NO_ACTIVITY: '1' } }), undefined);
  } finally { t.done(); }
});

test('withActivity refreshes the record at the end, so the frame fades after the action, not after it started', async () => {
  const t = tmpEnv();
  try {
    const before = Date.now();
    await withActivity('loading', 'load-company', async () => { await new Promise(r => setTimeout(r, 30)); return 1; }, t.env);
    const rec = readActivityRecords(t.env)[0]!;
    assert.equal(rec.kind, 'loading');
    assert.ok(Date.parse(rec.at) >= before + 25);
  } finally { t.done(); }
});

// One record file per process, but concurrent handlers: a post's heartbeat must not wipe a screenshot's
// "hide the frame" request, or the frame ends up in the image the model sees.
test('a screenshot\'s hide request survives other activity in the same process, and ends with the capture', async () => {
  const t = tmpEnv();
  try {
    let during: ActivityRecord | undefined;
    await withActivity('posting', 'tally-write', async () => {
      await withActivity('controlling', 'screenshot', async () => {
        // What the posting heartbeat writes every second.
        recordActivity('posting', 'tally-write', { env: t.env });
        during = readActivityRecords(t.env)[0];
      }, t.env, { hideForScreenshot: true });
      const after = readActivityRecords(t.env)[0]!;
      assert.equal(after.hideForScreenshot, undefined, 'hide request gone once the capture is done');
    }, t.env);
    assert.equal(during?.hideForScreenshot, true);
    assert.equal(during?.kind, 'controlling', 'the stronger kind still running wins over the posting heartbeat');
  } finally { t.done(); }
});

test('the hide request is refreshed while the capture waits, so the tray never judges it stale', async () => {
  const t = tmpEnv();
  try {
    const stamps: string[] = [];
    await withActivity('controlling', 'screenshot', async () => {
      stamps.push(readActivityRecords(t.env)[0]!.at);
      await new Promise(r => setTimeout(r, 1150));
      const rec = readActivityRecords(t.env)[0]!;
      stamps.push(rec.at);
      assert.equal(rec.hideForScreenshot, true);
    }, t.env, { hideForScreenshot: true });
    assert.ok(Date.parse(stamps[1]!) > Date.parse(stamps[0]!), 'heartbeat rewrote the hide record');
  } finally { t.done(); }
});

test('a company load\'s "loading" banner is not flipped to "controlling" by its own screen steps', async () => {
  const t = tmpEnv();
  try {
    await withActivity('loading', 'load-company', async () => {
      await withActivity('controlling', 'start-tally', async () => {
        assert.equal(readActivityRecords(t.env)[0]!.kind, 'loading');
      }, t.env);
    }, t.env);
  } finally { t.done(); }
});

test('pickActiveRecord: only fresh records count, and the stronger warning wins', () => {
  const now = Date.parse('2026-11-23T10:00:10Z');
  const rec = (kind: ActivityRecord['kind'], at: string, pid = 1): ActivityRecord => ({ schemaVersion: 1, kind, tool: 't', at, pid });
  assert.equal(pickActiveRecord([], now), null);
  assert.equal(pickActiveRecord([rec('posting', '2026-11-23T10:00:00Z')], now), null, '10 s old is stale');
  assert.equal(pickActiveRecord([rec('posting', '2026-11-23T10:00:08Z')], now)?.kind, 'posting');
  assert.equal(pickActiveRecord([rec('posting', '2026-11-23T10:00:09Z'), rec('controlling', '2026-11-23T10:00:07Z', 2)], now)?.kind, 'controlling');
  assert.equal(pickActiveRecord([rec('controlling', '2026-11-23T10:00:09Z'), rec('loading', '2026-11-23T10:00:07Z', 2)], now)?.kind, 'loading');
  assert.equal(pickActiveRecord([{ ...rec('posting', 'garbage') }], now), null);
});

test('the three banners match the tray wording', () => {
  assert.equal(ACTIVITY_BANNERS.posting, 'Your AI assistant is posting to Tally');
  assert.match(ACTIVITY_BANNERS.controlling, /don't use the keyboard or mouse/);
  assert.equal(ACTIVITY_BANNERS.loading, 'Your AI assistant is reopening Tally');
});

// ── machine lock (#26) ──

test('a second caller gets BUSY at once, with the holder named, and the lock frees on release', () => {
  const t = tmpEnv();
  try {
    const a = tryAcquireMachineLock('gui-send-keys', 'gui', { env: t.env });
    assert.ok(a.ok);
    const b = tryAcquireMachineLock('gui-screenshot', 'gui', { env: t.env });
    assert.equal(b.ok, false);
    if (!b.ok) {
      assert.equal(b.holder?.tool, 'gui-send-keys');
      assert.ok(b.retryAfterSec >= 2);
    }
    if (a.ok) a.release();
    const c = tryAcquireMachineLock('gui-screenshot', 'gui', { env: t.env });
    assert.ok(c.ok);
    if (c.ok) c.release();
    assert.equal(fs.existsSync(lockFile(t.env)), false);
  } finally { t.done(); }
});

test('a lock left by a dead process is taken over', () => {
  const t = tmpEnv();
  try {
    const dead: LockHolder = { pid: 2 ** 22 + 12345, tool: 'load-company', kind: 'load', startedAt: new Date().toISOString(), host: os.hostname(), token: 'x' };
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(lockFile(t.env), JSON.stringify(dead));
    const got = tryAcquireMachineLock('gui-send-keys', 'gui', { env: t.env });
    assert.ok(got.ok, 'dead holder is stale');
    if (got.ok) got.release();
  } finally { t.done(); }
});

test('isLockStale: dead pid, too old, half-written; a live young holder is not stale', () => {
  const now = Date.parse('2026-11-23T10:10:00Z');
  const h = (startedAt: string, pid = process.pid): LockHolder => ({ pid, tool: 't', kind: 'gui', startedAt, host: os.hostname(), token: 'k' });
  assert.equal(isLockStale(h('2026-11-23T10:09:50Z'), now, now, 300_000, () => true), false);
  assert.equal(isLockStale(h('2026-11-23T10:09:50Z'), now, now, 300_000, () => false), true, 'dead pid');
  assert.equal(isLockStale(h('2026-11-23T10:00:00Z'), now, now, 300_000, () => true), true, 'older than the limit');
  assert.equal(isLockStale(null, now - 1000, now, 300_000), false, 'just-created file being written');
  assert.equal(isLockStale(null, now - 60_000, now, 300_000), true, 'unreadable and old');
  assert.equal(isLockStale({ ...h('2026-11-23T10:09:50Z', 1), host: 'OTHER-PC' }, now, now, 300_000, () => false), false, 'other host: age only');
});

// A long but live load-company refreshes the lock, so it is judged by its last refresh, not by when it
// started; a hung holder still expires at the hard ceiling.
test('isLockStale: a refreshing holder is judged by its last refresh, with a hard ceiling', () => {
  const now = Date.parse('2026-11-23T10:10:00Z');
  const base: LockHolder = { pid: process.pid, tool: 'load-company', kind: 'load', startedAt: '2026-11-23T10:03:00Z', host: os.hostname(), token: 'k' };
  const max = 900_000;
  assert.equal(isLockStale({ ...base, refreshedAt: '2026-11-23T10:09:57Z' }, now, now, 300_000, () => true, max), false, '7 min old, refreshed 3 s ago');
  assert.equal(isLockStale(base, now, now, 300_000, () => true, max), true, 'the same age without refreshes is stale');
  assert.equal(isLockStale({ ...base, refreshedAt: new Date(now - LOCK_REFRESH_STALE_MS - 1000).toISOString() }, now, now, 300_000, () => true, max), true, 'refreshes stopped');
  assert.equal(isLockStale({ ...base, startedAt: '2026-11-23T09:50:00Z', refreshedAt: '2026-11-23T10:09:59Z' }, now, now, 300_000, () => true, max), true, 'past the hard ceiling');
  assert.equal(isLockStale({ ...base, refreshedAt: '2026-11-23T10:09:57Z' }, now, now, 300_000, () => false, max), true, 'dead pid');
  assert.ok(lockMaxHoldMs({}) >= 900_000);
  assert.equal(lockMaxHoldMs({ MACHINE_LOCK_MAX_HOLD_SEC: '60', MACHINE_LOCK_STALE_SEC: '300' }), 300_000, 'never below the plain stale age');
});

test('refreshMachineLock refreshes only a lock that is still ours', () => {
  const t = tmpEnv();
  try {
    const got = tryAcquireMachineLock('load-company', 'load', { env: t.env, refreshing: true });
    assert.ok(got.ok);
    if (!got.ok) return;
    assert.equal(readLockHolder(t.env)?.refreshedAt, got.holder.startedAt);
    assert.equal(refreshMachineLock(lockFile(t.env), got.holder, Date.parse('2030-01-01T00:00:00Z')), true);
    assert.equal(readLockHolder(t.env)?.refreshedAt, '2030-01-01T00:00:00.000Z');
    assert.equal(readLockHolder(t.env)?.token, got.holder.token);
    // Someone else took it over: no refresh, and the holder learns it lost the lock.
    const other = { ...got.holder, token: 'someone-else', refreshedAt: undefined };
    fs.writeFileSync(lockFile(t.env), JSON.stringify(other));
    assert.equal(refreshMachineLock(lockFile(t.env), got.holder), false);
    assert.equal(readLockHolder(t.env)?.token, 'someone-else');
    assert.equal(readLockHolder(t.env)?.refreshedAt, undefined);
    got.release();
    assert.equal(readLockHolder(t.env)?.token, 'someone-else', 'release leaves a lock that is not ours');
  } finally { t.done(); }
});

test('after its lock is taken over, a holder\'s nested screen steps are refused, not run alongside the new holder', async () => {
  const t = tmpEnv();
  try {
    let inner = false;
    await assert.rejects(withMachineLock('load-company', 'load', async () => {
      const mine = readLockHolder(t.env)!;
      fs.writeFileSync(lockFile(t.env), JSON.stringify({ ...mine, pid: process.ppid, tool: 'gui:sendkeys', token: 'taker' }));
      await withMachineLock('gui:select-and-unlock-company', 'gui', async () => { inner = true; }, { env: t.env });
    }, { env: t.env }), (e: unknown) => e instanceof MachineBusyError && /gui:sendkeys/.test((e as Error).message));
    assert.equal(inner, false);
    assert.equal(readLockHolder(t.env)?.token, 'taker', 'the new holder\'s lock is left alone');
  } finally { t.done(); }
});

// The judged lock is moved aside before it is checked, so a fresh lock created after the judgement is
// never deleted by a takeover.
test('removeIfUnchanged removes only the lock that was judged, and puts back a newer one', () => {
  const t = tmpEnv();
  try {
    const file = lockFile(t.env);
    fs.mkdirSync(t.dir, { recursive: true });
    const judged = JSON.stringify({ pid: 1, tool: 'old', kind: 'gui', startedAt: '', host: os.hostname(), token: 'old' });
    fs.writeFileSync(file, JSON.stringify({ pid: 2, tool: 'fresh', kind: 'gui', startedAt: '', host: os.hostname(), token: 'fresh' }));
    assert.equal(removeIfUnchanged(file, judged, 'stale-me'), false);
    assert.equal(readLockHolder(t.env)?.token, 'fresh', 'the fresh lock is back in place');
    fs.writeFileSync(file, judged);
    assert.equal(removeIfUnchanged(file, judged, 'stale-me'), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(removeIfUnchanged(file, judged, 'stale-me'), true, 'already gone counts as free');
    assert.deepEqual(fs.readdirSync(t.dir), [], 'no moved-aside copies left');
  } finally { t.done(); }
});

test('a takeover clears a crashed guard, but never deletes a guard another process just created', () => {
  const t = tmpEnv();
  try {
    const file = lockFile(t.env);
    const dead: LockHolder = { pid: 2 ** 22 + 12345, tool: 'load-company', kind: 'load', startedAt: new Date().toISOString(), host: os.hostname(), token: 'x' };
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(dead));
    // A fresh guard: someone else is mid-takeover. We back off, and their guard stays.
    fs.writeFileSync(`${file}.takeover`, 'their-token');
    assert.equal(tryAcquireMachineLock('gui-send-keys', 'gui', { env: t.env }).ok, false);
    assert.equal(fs.readFileSync(`${file}.takeover`, 'utf-8'), 'their-token');
    // The same guard, left behind 20 s ago by a crash: cleared, and the takeover goes ahead.
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(`${file}.takeover`, old, old);
    const got = tryAcquireMachineLock('gui-send-keys', 'gui', { env: t.env });
    assert.ok(got.ok);
    if (got.ok) got.release();
    assert.deepEqual(fs.readdirSync(t.dir), [], 'guard and lock both gone');
  } finally { t.done(); }
});

// status/get-context in another window takes the lock for one ping. A screen action that lands then
// waits that out instead of failing BUSY; a real holder still gets BUSY at once.
test('a passive probe\'s hold is waited out; a screen action\'s hold is not', async () => {
  const t = tmpEnv();
  try {
    const probe = tryAcquireMachineLock('gui:ping', 'gui', { env: t.env, probe: true });
    assert.ok(probe.ok);
    setTimeout(() => { if (probe.ok) probe.release(); }, 300);
    const before = Date.now();
    assert.equal(await withMachineLock('gui:sendkeys', 'gui', async () => holdsMachineLock(), { env: t.env }), true);
    assert.ok(Date.now() - before >= 250);

    const screen = tryAcquireMachineLock('gui:sendkeys', 'gui', { env: t.env });
    assert.ok(screen.ok);
    await assert.rejects(withMachineLock('gui:ping', 'gui', async () => 1, { env: t.env, probe: true }), MachineBusyError);
    if (screen.ok) screen.release();
    assert.equal(retryAfterFor({ ...(probe.ok ? probe.holder : ({} as LockHolder)) }, Date.now()), 2);
  } finally { t.done(); }
});

test('retryAfterFor suggests a longer wait for a company load than for a screen action', () => {
  const now = Date.parse('2026-11-23T10:00:00Z');
  const base = { pid: 1, tool: 't', host: 'h', token: 'k', startedAt: '2026-11-23T10:00:00Z' };
  assert.ok(retryAfterFor({ ...base, kind: 'load' }, now) > retryAfterFor({ ...base, kind: 'gui' }, now));
  assert.equal(retryAfterFor(null, now), 2);
});

test('withMachineLock is re-entrant within one call chain (load-company driving the GUI agent)', async () => {
  const t = tmpEnv();
  try {
    let inner = false;
    await withMachineLock('load-company', 'load', async () => {
      await withMachineLock('select-and-unlock', 'gui', async () => { inner = true; }, { env: t.env });
    }, { env: t.env });
    assert.ok(inner);
    assert.equal(fs.existsSync(lockFile(t.env)), false);
  } finally { t.done(); }
});

test('two concurrent tool calls in one process: one runs, the other is BUSY', async () => {
  const t = tmpEnv();
  try {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = withMachineLock('gui-send-keys', 'gui', () => gate, { env: t.env });
    await new Promise(r => setTimeout(r, 10));
    await assert.rejects(withMachineLock('gui-screenshot', 'gui', async () => 1, { env: t.env }), (e: unknown) => e instanceof MachineBusyError && /gui-send-keys/.test((e as Error).message));
    release();
    await first;
    assert.equal(await withMachineLock('gui-screenshot', 'gui', async () => 2, { env: t.env }), 2);
  } finally { t.done(); }
});

test('two processes contending for the lock: exactly one wins each round', async () => {
  const t = tmpEnv();
  try {
    const modUrl = new URL('./coordination.mjs', import.meta.url).href;
    const script = `
      const { tryAcquireMachineLock } = await import(${JSON.stringify(modUrl)});
      const env = { TALLY_DATA_PATH: ${JSON.stringify(t.dir)} };
      const got = tryAcquireMachineLock('child', 'gui', { env });
      process.stdout.write(got.ok ? 'WON' : 'BUSY');
      await new Promise(r => setTimeout(r, 400));
      if (got.ok) got.release();
    `;
    const run = () => new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.on('error', reject);
      c.on('close', () => resolve(out));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter(r => r === 'WON').length, 1, `results: ${results.join(',')}`);
    assert.equal(results.filter(r => r === 'BUSY').length, 2);
    assert.equal(fs.existsSync(lockFile(t.env)), false, 'winner released');
  } finally { t.done(); }
});

test('XML writes wait out a company load, and go straight through otherwise', async () => {
  const t = tmpEnv();
  try {
    assert.equal(await waitOutCompanyLoad({ env: t.env, waitMs: 0 }), null, 'no lock');
    const gui = tryAcquireMachineLock('gui-send-keys', 'gui', { env: t.env });
    assert.equal(await waitOutCompanyLoad({ env: t.env, waitMs: 0 }), null, 'a screen action does not block XML writes');
    if (gui.ok) gui.release();
    const load = tryAcquireMachineLock('load-company', 'load', { env: t.env });
    const holder = await waitOutCompanyLoad({ env: t.env, waitMs: 0 });
    assert.equal(holder?.tool, 'load-company');
    setTimeout(() => { if (load.ok) load.release(); }, 100);
    assert.equal(await waitOutCompanyLoad({ env: t.env, waitMs: 3000 }), null, 'released during the wait');
  } finally { t.done(); }
});

// ── restart countdown (#25) ──

test('restart countdown: a Cancel from the tray is reported, and the request is cleaned up', async () => {
  const t = tmpEnv();
  try {
    const pending = runRestartCountdown('load-company', 'Ross Industries', { env: t.env, seconds: 5, pollMs: 20 });
    await new Promise(r => setTimeout(r, 60));
    const req = JSON.parse(fs.readFileSync(restartRequestFile(t.env), 'utf-8'));
    assert.equal(req.company, 'Ross Industries');
    assert.ok(Date.parse(req.deadline) > Date.parse(req.requestedAt));
    fs.writeFileSync(restartResponseFile(t.env), JSON.stringify({ schemaVersion: 1, requestId: req.requestId, decision: 'cancel', at: new Date().toISOString() }));
    assert.equal(await pending, 'cancelled');
    assert.equal(fs.existsSync(restartRequestFile(t.env)), false);
  } finally { t.done(); }
});

test('restart countdown: no answer means it elapsed; an answer for another request is ignored; 0 s skips it', async () => {
  const t = tmpEnv();
  try {
    fs.writeFileSync(restartResponseFile(t.env), JSON.stringify({ schemaVersion: 1, requestId: 'old', decision: 'cancel', at: '' }));
    assert.equal(await runRestartCountdown('load-company', 'X', { env: t.env, seconds: 0.2 as any, pollMs: 20 }), 'elapsed');
    assert.equal(await runRestartCountdown('load-company', 'X', { env: t.env, seconds: 0 }), 'elapsed');
  } finally { t.done(); }
});

// "Restart now" and "nobody answered" are different: only the first is a go-ahead from someone at the
// PC, so load-company re-checks the keyboard after the second only.
test('restart countdown: "Restart now" from the tray is reported as proceed, distinct from elapsed', async () => {
  const t = tmpEnv();
  try {
    const pending = runRestartCountdown('load-company', 'X', { env: t.env, seconds: 5, pollMs: 20 });
    await new Promise(r => setTimeout(r, 60));
    const req = JSON.parse(fs.readFileSync(restartRequestFile(t.env), 'utf-8'));
    fs.writeFileSync(restartResponseFile(t.env), JSON.stringify({ schemaVersion: 1, requestId: req.requestId, decision: 'proceed', at: '' }));
    assert.equal(await pending, 'proceed');
  } finally { t.done(); }
});

// A Cancel clicked in the last poll interval, or on the tray tick just after the deadline, must still
// stop the restart: the tray has already told the person "Tally restart cancelled".
test('restart countdown: a Cancel in the last moments, or just past the deadline, is still honoured', async () => {
  for (const atMs of [250, 300 + Math.floor(RESTART_ANSWER_GRACE_MS / 2)]) {
    const t = tmpEnv();
    try {
      // A long poll interval: the old loop slept past the deadline and returned without reading again.
      const pending = runRestartCountdown('load-company', 'X', { env: t.env, seconds: 0.3 as any, pollMs: 1000 });
      await new Promise(r => setTimeout(r, 20));
      const req = JSON.parse(fs.readFileSync(restartRequestFile(t.env), 'utf-8'));
      setTimeout(() => fs.writeFileSync(restartResponseFile(t.env), JSON.stringify({ schemaVersion: 1, requestId: req.requestId, decision: 'cancel', at: '' })), atMs - 20);
      assert.equal(await pending, 'cancelled', `cancel at ${atMs} ms of a 300 ms countdown`);
      assert.equal(fs.existsSync(restartResponseFile(t.env)), false, 'the honoured answer is consumed');
    } finally { t.done(); }
  }
});

// A countdown the tray never saw cannot be cancelled. Treat that like "no tray running" (wait the full
// period, then the caller re-checks the keyboard), never as an instant restart.
test('restart countdown: when the request cannot be posted, it still waits the full period', async () => {
  const t = tmpEnv();
  try {
    // A non-empty directory where the request file should go makes the rename fail.
    fs.mkdirSync(path.join(restartRequestFile(t.env), 'x'), { recursive: true });
    const before = Date.now();
    assert.equal(await runRestartCountdown('load-company', 'X', { env: t.env, seconds: 0.3 as any, pollMs: 20 }), 'elapsed');
    assert.ok(Date.now() - before >= 290, 'waited out the countdown');
    assert.deepEqual(fs.readdirSync(t.dir).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
  } finally { t.done(); }
});

// ── atomic writes ──

test('writeJsonAtomic removes its temp file when the rename fails', () => {
  const t = tmpEnv();
  try {
    const target = path.join(t.dir, 'busy.json');
    fs.mkdirSync(path.join(target, 'x'), { recursive: true });
    assert.throws(() => writeJsonAtomic(target, { a: 1 }));
    assert.deepEqual(fs.readdirSync(t.dir).filter(n => n.endsWith('.tmp')), []);
  } finally { t.done(); }
});

test('writeJsonAtomic retries a rename a reader is briefly blocking (Windows EPERM), and gives up on other errors', () => {
  const t = tmpEnv();
  try {
    const target = path.join(t.dir, 'a.json');
    let calls = 0;
    writeJsonAtomic(target, { ok: true }, (from, to) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      fs.renameSync(from, to);
    });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { ok: true });

    calls = 0;
    assert.throws(() => writeJsonAtomic(target, { ok: false }, () => { calls++; throw Object.assign(new Error('no'), { code: 'EPERM' }); }));
    assert.ok(calls > 1 && calls < 20, 'bounded retries');
    calls = 0;
    assert.throws(() => writeJsonAtomic(target, { ok: false }, () => { calls++; throw Object.assign(new Error('no'), { code: 'ENOSPC' }); }));
    assert.equal(calls, 1, 'not retried');
    assert.deepEqual(fs.readdirSync(t.dir).filter(n => n.endsWith('.tmp')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { ok: true }, 'the previous content is intact');
  } finally { t.done(); }
});
