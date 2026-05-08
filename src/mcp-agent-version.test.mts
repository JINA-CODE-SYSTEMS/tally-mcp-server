import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentVersionAtLeast, REQUIRED_AGENT_VERSION } from './mcp.mjs';

test('REQUIRED_AGENT_VERSION is a parseable MAJOR.MINOR.PATCH string', () => {
  assert.match(REQUIRED_AGENT_VERSION, /^\d+\.\d+\.\d+$/);
});

test('exact equality satisfies the minimum', () => {
  assert.equal(isAgentVersionAtLeast('1.1.0', '1.1.0'), true);
});

test('higher patch satisfies the minimum', () => {
  assert.equal(isAgentVersionAtLeast('1.1.5', '1.1.0'), true);
});

test('higher minor satisfies the minimum', () => {
  assert.equal(isAgentVersionAtLeast('1.2.0', '1.1.0'), true);
});

test('higher major satisfies the minimum', () => {
  assert.equal(isAgentVersionAtLeast('2.0.0', '1.9.9'), true);
});

test('lower patch fails the minimum', () => {
  assert.equal(isAgentVersionAtLeast('1.0.9', '1.1.0'), false);
});

test('lower minor fails the minimum', () => {
  assert.equal(isAgentVersionAtLeast('1.0.99', '1.1.0'), false);
});

test('lower major fails the minimum', () => {
  assert.equal(isAgentVersionAtLeast('0.99.99', '1.0.0'), false);
});

test('null actual fails (agent did not report a version)', () => {
  assert.equal(isAgentVersionAtLeast(null, '1.1.0'), false);
});

test('undefined actual fails', () => {
  assert.equal(isAgentVersionAtLeast(undefined, '1.1.0'), false);
});

test('empty actual string fails', () => {
  assert.equal(isAgentVersionAtLeast('', '1.1.0'), false);
});

test('shorter version pads with zeros: "2" is treated as "2.0.0"', () => {
  assert.equal(isAgentVersionAtLeast('2', '1.9.9'), true);
  assert.equal(isAgentVersionAtLeast('1', '1.0.0'), true);
  assert.equal(isAgentVersionAtLeast('1', '1.0.1'), false);
});

test('non-numeric suffix is parsed by numeric prefix only', () => {
  // "1.1.0-rc1" should be treated as "1.1.0" — the prerelease tag is ignored.
  assert.equal(isAgentVersionAtLeast('1.1.0-rc1', '1.1.0'), true);
  assert.equal(isAgentVersionAtLeast('1.1.0-rc1', '1.1.1'), false);
});

test('extra segments beyond required are ignored when leading segments match', () => {
  assert.equal(isAgentVersionAtLeast('1.1.0.4', '1.1.0'), true);
});
