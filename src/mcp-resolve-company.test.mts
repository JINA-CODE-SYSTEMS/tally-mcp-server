import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCompanyInput } from './mcp.mjs';

const folders = [
  { folder: '100000', name: 'Ross Industries' },
  { folder: '200000', name: 'Spectrum Pvt Ltd' },
  { folder: '300000', name: 'Ross Industries' },  // duplicate name, different folder
  { folder: '400000', name: '' }                  // unnamed folder (no Company.900)
];

test('resolves digit-only input to folder id when folder exists', () => {
  const r = resolveCompanyInput('100000', folders);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.folderId, '100000');
    assert.equal(r.matchedBy, 'id');
    assert.equal(r.companyName, 'Ross Industries');
  }
});

test('digit input that does not match any folder returns not-found', () => {
  const r = resolveCompanyInput('999999', folders);
  assert.equal(r.kind, 'not-found');
});

test('resolves unique name (case-insensitive) to folder id', () => {
  const r = resolveCompanyInput('spectrum pvt ltd', folders);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.folderId, '200000');
    assert.equal(r.matchedBy, 'name');
    assert.equal(r.companyName, 'Spectrum Pvt Ltd');
  }
});

test('returns ambiguous when name matches multiple folders', () => {
  const r = resolveCompanyInput('Ross Industries', folders);
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') {
    assert.equal(r.matches.length, 2);
    assert.deepEqual(r.matches.map(m => m.folder).sort(), ['100000', '300000']);
  }
});

test('user can disambiguate by folder id even when name collides', () => {
  const r = resolveCompanyInput('300000', folders);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.folderId, '300000');
});

test('unknown name returns not-found with full available list', () => {
  const r = resolveCompanyInput('Acme Corp', folders);
  assert.equal(r.kind, 'not-found');
  if (r.kind === 'not-found') assert.equal(r.available.length, folders.length);
});

test('empty input returns not-found', () => {
  const r = resolveCompanyInput('', folders);
  assert.equal(r.kind, 'not-found');
});

test('whitespace-only input returns not-found', () => {
  const r = resolveCompanyInput('   ', folders);
  assert.equal(r.kind, 'not-found');
});

test('unnamed folders (empty name) cannot be matched by name match against empty string', () => {
  // Edge case: an attacker/llm passing "" as a name shouldn't match all unnamed folders.
  const r = resolveCompanyInput('', folders);
  assert.equal(r.kind, 'not-found');
});

test('digit input still resolves even if folder has no parseable name', () => {
  const r = resolveCompanyInput('400000', folders);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.folderId, '400000');
    assert.equal(r.companyName, '');  // no name available; that's fine
  }
});

test('with empty folder list, any input is not-found', () => {
  const r = resolveCompanyInput('100000', []);
  assert.equal(r.kind, 'not-found');
  if (r.kind === 'not-found') assert.equal(r.available.length, 0);
});
