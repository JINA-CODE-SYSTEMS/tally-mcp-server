import assert from 'node:assert/strict';
import test from 'node:test';
import { planUseCompany } from './mcp.mjs';

const rec = (over: Partial<{ name: string; folderId: string; alias: string | null; isLoaded: boolean; isProtected: boolean }> = {}) => ({
  name: 'Ross', folderId: '100000', alias: null, isLoaded: false, isProtected: false, matchedBy: 'id' as const, ...over,
});

// #87 H-1: deterministic routing.
test('already loaded → set-active (fast path)', () => {
  const p = planUseCompany({ kind: 'ok', company: rec({ isLoaded: true }) });
  assert.equal(p.action, 'set-active');
});

test('configured (has alias) but not loaded → load-vault', () => {
  const p = planUseCompany({ kind: 'ok', company: rec({ alias: 'ross', isLoaded: false }) });
  assert.equal(p.action, 'load-vault');
});

test('not loaded, no vault entry → load-restart', () => {
  const p = planUseCompany({ kind: 'ok', company: rec({ alias: null, isLoaded: false }) });
  assert.equal(p.action, 'load-restart');
});

test('ambiguous → typed AMBIGUOUS error', () => {
  const p = planUseCompany({ kind: 'ambiguous', matches: [{ folderId: '1', name: 'A', alias: null }, { folderId: '2', name: 'A', alias: null }] });
  assert.deepEqual(p, { action: 'error', code: 'AMBIGUOUS' });
});

test('not-found → typed COMPANY_NOT_FOUND error', () => {
  const p = planUseCompany({ kind: 'not-found', available: [] });
  assert.deepEqual(p, { action: 'error', code: 'COMPANY_NOT_FOUND' });
});
