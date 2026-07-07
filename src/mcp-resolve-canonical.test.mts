import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCompanyEnriched, type CompanyRegistry } from './mcp.mjs';

// A garbled/truncated folder scrape (what extractCompanyNameFromMetadataFile can produce).
const folders = [{ folder: '100000', name: 'ROSS COMPUT' }];

const registry: CompanyRegistry = {
  schemaVersion: 1,
  companies: [{ alias: 'ross', folderId: '100000', displayName: 'ROSS COMPUTERS PVT. LTD.' }]
};

// #90 H-4: prefer the deterministic canonical name over the heuristic scrape.
test('id-match returns registry displayName, not the garbled scrape', () => {
  const r = resolveCompanyEnriched('100000', folders, registry, []);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.company.name, 'ROSS COMPUTERS PVT. LTD.');
});

test('name-match (on the scraped name) still returns the clean displayName', () => {
  const r = resolveCompanyEnriched('ROSS COMPUT', folders, registry, []);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.company.name, 'ROSS COMPUTERS PVT. LTD.');
});

test('alias-match returns the clean displayName', () => {
  const r = resolveCompanyEnriched('ross', folders, registry, []);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.company.name, 'ROSS COMPUTERS PVT. LTD.');
    assert.equal(r.company.matchedBy, 'alias');
  }
});

test('live loaded Tally name wins over registry displayName (authoritative casing)', () => {
  // Scrape matches a loaded company; the live name should be used verbatim.
  const loadedFolders = [{ folder: '100000', name: 'ross computers pvt. ltd.' }];
  const reg: CompanyRegistry = {
    schemaVersion: 1,
    companies: [{ alias: 'ross', folderId: '100000', displayName: 'Stale Registry Name' }]
  };
  const r = resolveCompanyEnriched('100000', loadedFolders, reg, ['ROSS COMPUTERS PVT. LTD.']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.company.name, 'ROSS COMPUTERS PVT. LTD.'); // live > displayName
    assert.equal(r.company.isLoaded, true);
  }
});

// Report #2: use-company("ross") wrongly said "not resident" because the alias displayName
// ("Ross Computer Pvt Ltd") differs from the loaded name — isLoaded came back false.
test('alias with a mismatched displayName resolves to the exact loaded name AND isLoaded=true', () => {
  const f = [{ folder: '100000', name: '' }]; // empty/garbled scrape
  const reg: CompanyRegistry = { schemaVersion: 1, companies: [{ alias: 'ross', folderId: '100000', displayName: 'Ross Computer Pvt Ltd' }] };
  const r = resolveCompanyEnriched('ross', f, reg, ['ROSS COMPUTERS PVT. LTD.']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.company.name, 'ROSS COMPUTERS PVT. LTD.'); // fuzzy-matched displayName → exact loaded
    assert.equal(r.company.isLoaded, true);                    // so use-company sees it as resident
  }
});

test('falls back to the scrape when neither loaded nor a registry displayName exists', () => {
  const bareRegistry: CompanyRegistry = { schemaVersion: 1, companies: [] };
  const r = resolveCompanyEnriched('100000', folders, bareRegistry, []);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.company.name, 'ROSS COMPUT'); // last-resort scrape
});
