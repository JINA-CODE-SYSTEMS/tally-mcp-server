import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuiAgentCommandId, getOpenCompanyGuiTimeoutSeconds, isMatchingGuiAgentCommand } from './mcp.mjs';

test('uses default timeout when env value is missing', () => {
  assert.equal(getOpenCompanyGuiTimeoutSeconds(undefined), 180);
});

test('uses configured timeout when valid and >= 90', () => {
  assert.equal(getOpenCompanyGuiTimeoutSeconds('240'), 240);
});

test('falls back to default timeout when value is below minimum', () => {
  assert.equal(getOpenCompanyGuiTimeoutSeconds('89'), 180);
});

test('falls back to default timeout when value is invalid', () => {
  assert.equal(getOpenCompanyGuiTimeoutSeconds('not-a-number'), 180);
});

test('creates command IDs with prefix', () => {
  const commandId = createGuiAgentCommandId('open-company');
  assert.ok(commandId.startsWith('open-company-'));
});

test('matches responses only for expected command ID', () => {
  assert.equal(isMatchingGuiAgentCommand({ commandId: 'abc' }, 'abc'), true);
  assert.equal(isMatchingGuiAgentCommand({ commandId: 'other' }, 'abc'), false);
  assert.equal(isMatchingGuiAgentCommand({}, 'abc'), false);
});
