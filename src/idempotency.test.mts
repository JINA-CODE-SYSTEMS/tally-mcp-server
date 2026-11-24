import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDEMPOTENCY_DIR_NAME, LEGACY_IDEMPOTENCY_FILE_NAME, idempotencyKeyFileName, makeIdempotencyStore } from './idempotency.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idem-store-'));
const DAY = 24 * 60 * 60 * 1000;

test('one file per key, named by the key hash, holding the plain key', () => {
  const dir = tmpDir();
  try {
    const store = makeIdempotencyStore(dir);
    store.put('batch:abc/../x', { ok: 1 }, '2026-11-23T00:00:00Z');
    const file = path.join(dir, IDEMPOTENCY_DIR_NAME, idempotencyKeyFileName('batch:abc/../x'));
    assert.ok(fs.existsSync(file), 'a hostile-looking key still lands in one hashed file');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).key, 'batch:abc/../x');
    assert.deepEqual(store.get('batch:abc/../x')?.result, { ok: 1 });
    assert.equal(store.get('other'), null);
    assert.equal(store.get(''), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record whose stored key differs (hash collision / tampering) is never replayed', () => {
  const dir = tmpDir();
  try {
    const store = makeIdempotencyStore(dir);
    store.put('K', { ok: 1 }, '2026-11-23T00:00:00Z');
    const file = path.join(dir, IDEMPOTENCY_DIR_NAME, idempotencyKeyFileName('K'));
    fs.writeFileSync(file, JSON.stringify({ key: 'NOT-K', result: { ok: 2 }, at: '2026-11-23T00:00:00Z' }));
    assert.equal(store.get('K'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The bug (#27): several server processes share one store. With a single read-modify-write file, a
// put from one process could overwrite the record another process had just added.
test('concurrent puts from several processes never lose a record', async () => {
  const dir = tmpDir();
  try {
    const modUrl = new URL('./idempotency.mjs', import.meta.url).href;
    const PROCS = 6, KEYS = 40;
    const script = (p: number) => `
      const { makeIdempotencyStore } = await import(${JSON.stringify(modUrl)});
      const store = makeIdempotencyStore(${JSON.stringify(dir)});
      for (let i = 0; i < ${KEYS}; i++) store.put('p${p}-k' + i, { p: ${p}, i }, new Date().toISOString());
      process.stdout.write('done');
    `;
    const run = (p: number) => new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script(p)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.on('error', reject);
      c.on('close', () => resolve(out));
    });
    const outs = await Promise.all(Array.from({ length: PROCS }, (_, p) => run(p)));
    assert.deepEqual(outs, Array(PROCS).fill('done'));
    const store = makeIdempotencyStore(dir);
    for (let p = 0; p < PROCS; p++) {
      for (let i = 0; i < KEYS; i++) {
        assert.deepEqual(store.get(`p${p}-k${i}`)?.result, { p, i }, `p${p}-k${i}`);
      }
    }
    const leftovers = fs.readdirSync(path.join(dir, IDEMPOTENCY_DIR_NAME)).filter(n => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp files left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the legacy single file is migrated on first use and renamed aside', () => {
  const dir = tmpDir();
  try {
    const legacy = path.join(dir, LEGACY_IDEMPOTENCY_FILE_NAME);
    const recent = new Date().toISOString();
    fs.writeFileSync(legacy, JSON.stringify({
      old1: { key: 'old1', result: { lastVchId: 1 }, at: recent },
      'batch:old2': { key: 'batch:old2', result: { posted: 3 }, at: recent },
    }));
    const store = makeIdempotencyStore(dir);
    assert.deepEqual(store.get('old1')?.result, { lastVchId: 1 });
    assert.deepEqual(store.get('batch:old2')?.result, { posted: 3 });
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(`${legacy}.migrated`), true);
    // A second store (another process) still sees the migrated keys.
    assert.deepEqual(makeIdempotencyStore(dir).get('old1')?.result, { lastVchId: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration never overwrites a newer per-key record', () => {
  const dir = tmpDir();
  try {
    const recent = new Date().toISOString();
    makeIdempotencyStore(dir).put('k', { v: 'new' }, recent);
    fs.writeFileSync(path.join(dir, LEGACY_IDEMPOTENCY_FILE_NAME), JSON.stringify({ k: { key: 'k', result: { v: 'old' }, at: recent } }));
    assert.deepEqual(makeIdempotencyStore(dir).get('k')?.result, { v: 'new' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expired records are swept at start and are never replayed', () => {
  const dir = tmpDir();
  try {
    const now = Date.parse('2026-11-23T00:00:00Z');
    const writer = makeIdempotencyStore(dir, { now: () => now });
    writer.put('fresh', 1, new Date(now - 2 * DAY).toISOString());
    writer.put('stale', 2, new Date(now - 31 * DAY).toISOString());
    // The writer itself already refuses to replay the stale one.
    assert.equal(writer.get('stale'), null);
    const staleFile = path.join(dir, IDEMPOTENCY_DIR_NAME, idempotencyKeyFileName('stale'));
    assert.equal(fs.existsSync(staleFile), true, 'not swept yet: this store swept before the put');
    // A fresh process start sweeps it away.
    const reader = makeIdempotencyStore(dir, { now: () => now });
    assert.equal(reader.get('fresh')?.result, 1);
    assert.equal(fs.existsSync(staleFile), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sweep also runs every N puts, and survives garbage in the folder', () => {
  const dir = tmpDir();
  try {
    let now = Date.parse('2026-11-23T00:00:00Z');
    const store = makeIdempotencyStore(dir, { now: () => now, sweepEveryPuts: 3 });
    store.put('a', 1, new Date(now).toISOString());
    fs.writeFileSync(path.join(dir, IDEMPOTENCY_DIR_NAME, 'junk.json'), 'not json');
    now += 40 * DAY;
    store.put('b', 2, new Date(now).toISOString());
    store.put('c', 3, new Date(now).toISOString()); // third put → sweep
    assert.equal(fs.existsSync(path.join(dir, IDEMPOTENCY_DIR_NAME, idempotencyKeyFileName('a'))), false);
    assert.equal(store.get('b')?.result, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
