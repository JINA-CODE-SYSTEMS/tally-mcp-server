import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordSighting, sightingSlug, sightingDir } from './client-sighting.mjs';

// The tray decides "Claude really loaded Tally" from these files, so the properties that matter are:
// one file per client, rewritten (not appended) on each start, and a write that can never break
// the server it is reporting on.

test('client names become stable, file-safe slugs', () => {
  assert.equal(sightingSlug('claude-ai'), 'claude-ai');
  assert.equal(sightingSlug('Claude Desktop'), 'claude-desktop');
  assert.equal(sightingSlug('../../evil\\name'), 'evil-name');
  assert.equal(sightingSlug(''), 'unknown');
  assert.equal(sightingSlug(undefined), 'unknown');
});

test('a sighting lands under LOCALAPPDATA\\Claudally\\clients and is replaced on the next start', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sighting-'));
  const env = { LOCALAPPDATA: local };
  const first = recordSighting({ name: 'claude-ai', version: '1.0' }, { env, now: new Date('2026-11-23T10:00:00Z') });
  assert.equal(first, path.join(local, 'Claudally', 'clients', 'claude-ai.json'));
  recordSighting({ name: 'claude-ai', version: '1.1' }, { env, now: new Date('2026-11-23T11:00:00Z') });
  const data = JSON.parse(fs.readFileSync(first!, 'utf-8'));
  assert.equal(data.client, 'claude-ai');
  assert.equal(data.clientVersion, '1.1');
  assert.equal(data.seenAt, '2026-11-23T11:00:00.000Z');
  assert.deepEqual(fs.readdirSync(path.dirname(first!)), ['claude-ai.json'], 'no temp files or history left behind');
  fs.rmSync(local, { recursive: true, force: true });
});

test('no LOCALAPPDATA, opted out, or an unwritable folder: skipped silently, never thrown', () => {
  assert.equal(sightingDir({}), undefined);
  assert.equal(recordSighting({ name: 'x' }, { env: {} }), undefined);
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sighting-'));
  assert.equal(recordSighting({ name: 'x' }, { env: { LOCALAPPDATA: local, CLAUDALLY_NO_SIGHTING: '1' } }), undefined);
  const blocker = path.join(local, 'file');
  fs.writeFileSync(blocker, '');
  assert.equal(recordSighting({ name: 'x' }, { env: { LOCALAPPDATA: blocker } }), undefined);
  fs.rmSync(local, { recursive: true, force: true });
});
