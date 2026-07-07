import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVaultEntry, type CompanyRegistry } from './mcp.mjs';

const registry: CompanyRegistry = {
  schemaVersion: 1,
  companies: [
    { alias: 'ross', folderId: '100000', displayName: 'ROSS COMPUTERS PVT. LTD.', extraAliases: ['rc'], passwordEnc: 'blob' },
    { alias: 'spectrum', folderId: '200000', displayName: 'Spectrum Pvt Ltd' }, // no stored password
  ],
};

test('resolveVaultEntry matches by alias (case-insensitive) and extra alias', () => {
  assert.equal(resolveVaultEntry(registry, 'ROSS')?.folderId, '100000');
  assert.equal(resolveVaultEntry(registry, 'rc')?.folderId, '100000');
});

test('resolveVaultEntry matches by folder id and display name', () => {
  assert.equal(resolveVaultEntry(registry, '200000')?.alias, 'spectrum');
  assert.equal(resolveVaultEntry(registry, 'spectrum pvt ltd')?.folderId, '200000');
});

test('resolveVaultEntry returns null when nothing configured matches', () => {
  assert.equal(resolveVaultEntry(registry, 'nonexistent'), null);
  assert.equal(resolveVaultEntry(registry, ''), null);
});

test('a matched entry without passwordEnc signals the ask-the-user path', () => {
  const e = resolveVaultEntry(registry, 'spectrum');
  assert.ok(e);
  assert.equal(e!.passwordEnc, undefined); // handler returns { noStoredCredentials: true }
});
