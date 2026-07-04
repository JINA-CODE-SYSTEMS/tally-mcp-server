import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CompanyRegistry,
  loadCompaniesConfig,
  loadCompanyRegistry,
  saveCompanyRegistry,
  findCompanyByAlias,
  listConfiguredAliases,
} from './mcp.mjs';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcp-registry-test-'));
  return path.join(dir, '.tally-mcp-companies.json');
}

function writeJson(p: string, value: unknown): void {
  fs.writeFileSync(p, JSON.stringify(value), 'utf-8');
}

function cleanup(p: string): void {
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
}

// loadCompanyRegistry — handles missing files, malformed input, legacy migration, and new shape.
test('loadCompanyRegistry returns empty registry when file is missing', () => {
  const p = tempFile();
  cleanup(p);
  const r = loadCompanyRegistry(p);
  assert.equal(r.schemaVersion, 1);
  assert.deepEqual(r.companies, []);
  assert.equal(r.legacyHints, undefined);
});

test('loadCompanyRegistry returns empty registry on malformed JSON', () => {
  const p = tempFile();
  try {
    fs.writeFileSync(p, '{not json', 'utf-8');
    const r = loadCompanyRegistry(p);
    assert.equal(r.schemaVersion, 1);
    assert.deepEqual(r.companies, []);
  } finally {
    cleanup(p);
  }
});

test('loadCompanyRegistry migrates old flat-shape hints into legacyHints', () => {
  const p = tempFile();
  try {
    writeJson(p, {
      '100000': { requiresCredentials: true, knownUsername: 'admin', notes: 'old hint' },
      '200000': { requiresCredentials: false },
    });
    const r = loadCompanyRegistry(p);
    assert.equal(r.schemaVersion, 1);
    assert.deepEqual(r.companies, []);
    assert.ok(r.legacyHints, 'legacyHints should be populated after migration');
    assert.equal(r.legacyHints!['100000'].knownUsername, 'admin');
    assert.equal(r.legacyHints!['200000'].requiresCredentials, false);
  } finally {
    cleanup(p);
  }
});

test('loadCompanyRegistry preserves migration in-memory only (does not write back)', () => {
  const p = tempFile();
  try {
    const original = { '100000': { requiresCredentials: true } };
    writeJson(p, original);
    loadCompanyRegistry(p);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.deepEqual(onDisk, original, 'file should be untouched after read');
  } finally {
    cleanup(p);
  }
});

test('loadCompanyRegistry returns new-shape file as-is', () => {
  const p = tempFile();
  try {
    const reg: CompanyRegistry = {
      schemaVersion: 1,
      companies: [{ alias: 'main', folderId: '0001', displayName: 'ABC Traders' }],
    };
    writeJson(p, reg);
    const r = loadCompanyRegistry(p);
    assert.equal(r.companies.length, 1);
    assert.equal(r.companies[0].alias, 'main');
    assert.equal(r.companies[0].folderId, '0001');
  } finally {
    cleanup(p);
  }
});

// loadCompaniesConfig — back-compat path for existing callers.
test('loadCompaniesConfig returns flat hints from old-shape file unchanged', () => {
  const p = tempFile();
  try {
    writeJson(p, { '100000': { requiresCredentials: true, knownUsername: 'admin' } });
    const c = loadCompaniesConfig(p);
    assert.equal(c['100000'].requiresCredentials, true);
    assert.equal(c['100000'].knownUsername, 'admin');
  } finally {
    cleanup(p);
  }
});

test('loadCompaniesConfig returns legacyHints from new-shape file', () => {
  const p = tempFile();
  try {
    const reg: CompanyRegistry = {
      schemaVersion: 1,
      companies: [{ alias: 'main', folderId: '0001' }],
      legacyHints: { '0001': { requiresCredentials: false, notes: 'auto-loads' } },
    };
    writeJson(p, reg);
    const c = loadCompaniesConfig(p);
    assert.equal(c['0001'].requiresCredentials, false);
    assert.equal(c['0001'].notes, 'auto-loads');
  } finally {
    cleanup(p);
  }
});

test('loadCompaniesConfig returns {} for new-shape file without legacyHints', () => {
  const p = tempFile();
  try {
    writeJson(p, { schemaVersion: 1, companies: [{ alias: 'main', folderId: '0001' }] });
    const c = loadCompaniesConfig(p);
    assert.deepEqual(c, {});
  } finally {
    cleanup(p);
  }
});

// findCompanyByAlias — exact + case-insensitive lookup, alias + extraAliases.
test('findCompanyByAlias finds primary alias exact match', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'main', folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, 'main')?.folderId, '0001');
});

test('findCompanyByAlias is case-insensitive', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'Main', folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, 'MAIN')?.folderId, '0001');
  assert.equal(findCompanyByAlias(reg, 'main')?.folderId, '0001');
});

test('findCompanyByAlias trims whitespace before comparing', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'main', folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, '  main  ')?.folderId, '0001');
});

test('findCompanyByAlias matches extraAliases', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'main', extraAliases: ['primary', 'abc'], folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, 'primary')?.folderId, '0001');
  assert.equal(findCompanyByAlias(reg, 'ABC')?.folderId, '0001');
});

test('findCompanyByAlias returns null for unknown alias', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'main', folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, 'unknown'), null);
});

test('findCompanyByAlias returns null for empty/whitespace alias', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'main', folderId: '0001' }],
  };
  assert.equal(findCompanyByAlias(reg, ''), null);
  assert.equal(findCompanyByAlias(reg, '   '), null);
});

// listConfiguredAliases — dedup + ordering.
test('listConfiguredAliases returns alias + extraAliases in declaration order', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [
      { alias: 'main', extraAliases: ['primary'], folderId: '0001' },
      { alias: 'branch', folderId: '0007' },
    ],
  };
  assert.deepEqual(listConfiguredAliases(reg), ['main', 'primary', 'branch']);
});

test('listConfiguredAliases dedupes case-insensitively', () => {
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [
      { alias: 'main', extraAliases: ['MAIN', 'Main'], folderId: '0001' },
    ],
  };
  assert.deepEqual(listConfiguredAliases(reg), ['main']);
});

// saveCompanyRegistry round-trip.
test('saveCompanyRegistry writes file that loadCompanyRegistry reads back identically', () => {
  const p = tempFile();
  try {
    const reg: CompanyRegistry = {
      schemaVersion: 1,
      companies: [
        { alias: 'main', folderId: '0001', displayName: 'ABC' },
        { alias: 'branch', folderId: '0007', username: 'admin', passwordEnc: 'fake-blob' },
      ],
    };
    saveCompanyRegistry(p, reg);
    const r = loadCompanyRegistry(p);
    assert.deepEqual(r, reg);
  } finally {
    cleanup(p);
  }
});
