import assert from 'node:assert/strict';
import test from 'node:test';
import { getTallyEdition } from './mcp.mjs';

test('getTallyEdition defaults to silver when env is unset', () => {
  assert.equal(getTallyEdition(undefined), 'silver');
});

test('getTallyEdition returns silver for empty string', () => {
  assert.equal(getTallyEdition(''), 'silver');
});

test('getTallyEdition returns gold when explicitly set to gold', () => {
  assert.equal(getTallyEdition('gold'), 'gold');
});

test('getTallyEdition is case-insensitive on gold', () => {
  assert.equal(getTallyEdition('GOLD'), 'gold');
  assert.equal(getTallyEdition('Gold'), 'gold');
  assert.equal(getTallyEdition('  gOlD  '), 'gold');
});

test('getTallyEdition treats unknown values as silver (safer default)', () => {
  assert.equal(getTallyEdition('platinum'), 'silver');
  assert.equal(getTallyEdition('multi-user'), 'silver');
  assert.equal(getTallyEdition('1'), 'silver');
});

test('getTallyEdition treats explicit silver as silver', () => {
  assert.equal(getTallyEdition('silver'), 'silver');
  assert.equal(getTallyEdition('SILVER'), 'silver');
});
