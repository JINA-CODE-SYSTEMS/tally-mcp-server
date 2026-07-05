import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCompanyEnriched, type CompanyRegistry } from './mcp.mjs';

const folders = [
  { folder: '100000', name: 'Ross Computers Pvt. Ltd.' },
  { folder: '100001', name: 'Jina Code Systems' },
  { folder: '100002', name: 'Acme Traders' },
  { folder: '100003', name: 'Acme Traders' }, // duplicate name → ambiguous by name
];

const registry: CompanyRegistry = {
  schemaVersion: 1,
  companies: [
    { alias: 'ross', folderId: '100000', passwordEnc: 'ENCRYPTED', displayName: 'Ross Computers Pvt. Ltd.' },
    { alias: 'jina', extraAliases: ['jcs'], folderId: '100001' },
  ],
  legacyHints: { '100002': { requiresCredentials: true } },
};

const loaded = ['Ross Computers Pvt. Ltd.'];

test('resolves by folder id and enriches (loaded + protected + alias)', () => {
  const r = resolveCompanyEnriched('100000', folders, registry, loaded);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.company, {
    name: 'Ross Computers Pvt. Ltd.', folderId: '100000', alias: 'ross',
    isLoaded: true, isProtected: true, matchedBy: 'id',
  });
});

test('resolves by exact name (case-insensitive)', () => {
  const r = resolveCompanyEnriched('jina code systems', folders, registry, loaded);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.company.folderId, '100001');
  assert.equal(r.company.alias, 'jina');
  assert.equal(r.company.isLoaded, false);
  assert.equal(r.company.isProtected, false);
  assert.equal(r.company.matchedBy, 'name');
});

test('resolves by main alias and by extra alias', () => {
  const a = resolveCompanyEnriched('ross', folders, registry, loaded);
  assert.equal(a.kind === 'ok' && a.company.matchedBy, 'alias');
  const b = resolveCompanyEnriched('jcs', folders, registry, loaded);
  assert.equal(b.kind === 'ok' && b.company.folderId, '100001');
});

test('isProtected reflects a legacy requiresCredentials hint', () => {
  const r = resolveCompanyEnriched('100002', folders, registry, loaded);
  assert.equal(r.kind === 'ok' && r.company.isProtected, true);
});

test('duplicate names resolve as ambiguous with aliases listed', () => {
  const r = resolveCompanyEnriched('Acme Traders', folders, registry, loaded);
  assert.equal(r.kind, 'ambiguous');
  if (r.kind !== 'ambiguous') return;
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches.map(m => m.folderId).sort(), ['100002', '100003']);
});

test('unknown query is not-found and lists available candidates', () => {
  const r = resolveCompanyEnriched('does-not-exist', folders, registry, loaded);
  assert.equal(r.kind, 'not-found');
  if (r.kind !== 'not-found') return;
  assert.equal(r.available.length, folders.length);
  assert.ok(r.available.some(a => a.alias === 'ross'));
});
