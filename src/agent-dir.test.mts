import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentDir, resolveCompanyVaultPath } from './mcp.mjs';

// The GUI agent's IPC files and the company vault live in a folder of ours,
// %ProgramData%\Claudally\agent - never in Tally's data folder (#230 follow-up). The installer,
// the agent, the tray and verify-deployment.ps1 all derive the same path; these pin the server's side.

test('the agent folder is %ProgramData%\\Claudally\\agent', () => {
  assert.equal(resolveAgentDir({ ProgramData: 'C:\\ProgramData' }), 'C:\\ProgramData\\Claudally\\agent');
  assert.equal(resolveAgentDir({ ProgramData: 'D:\\PD' }), 'D:\\PD\\Claudally\\agent');
});

test('the agent folder falls back to C:\\ProgramData when the variable is missing', () => {
  assert.equal(resolveAgentDir({}), 'C:\\ProgramData\\Claudally\\agent');
});

test('the agent folder never follows TALLY_DATA_PATH', () => {
  const env = { ProgramData: 'C:\\ProgramData', TALLY_DATA_PATH: 'C:\\Users\\Public\\TallyPrimeEditLog\\data' };
  assert.equal(resolveAgentDir(env), 'C:\\ProgramData\\Claudally\\agent');
  assert.equal(resolveCompanyVaultPath(env), 'C:\\ProgramData\\Claudally\\agent\\.tally-mcp-companies.json');
});

test('TALLY_COMPANIES_CONFIG still overrides the vault path', () => {
  assert.equal(resolveCompanyVaultPath({ ProgramData: 'C:\\ProgramData', TALLY_COMPANIES_CONFIG: 'E:\\vault.json' }), 'E:\\vault.json');
});
