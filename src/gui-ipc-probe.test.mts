import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getHttpStatusReport, registerMcpServer, setGuiTransportMode } from './mcp.mjs';
import { lockFile, readLockHolder, type LockHolder } from './coordination.mjs';

// Under the IPC transport every GUI call shares _mcp_gui_command.json and _mcp_gui_result.json, and the
// agent runs one command at a time. These pin that a passive probe (ping / idle-status from status,
// get-context or the HTTP /status report) can no longer overwrite a running screen action's command or
// consume its result. The agent is faked: it is a PowerShell script that cannot run here.

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function inIpcDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-ipc-'));
  try {
    // Tally itself is unreachable (a closed local port), so only the agent side is exercised.
    return await withEnv({ TALLY_DATA_PATH: dir, GUI_TRANSPORT: undefined, TALLY_HOST: '127.0.0.1', TALLY_PORT: '1', CLAUDALLY_NO_ACTIVITY: '1' }, async () => {
      setGuiTransportMode('ipc');
      return fn(dir);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const commandFile = (dir: string) => path.join(dir, '_mcp_gui_command.json');
const resultFile = (dir: string) => path.join(dir, '_mcp_gui_result.json');

function screenActionHolder(): LockHolder {
  // A live process on this host (our parent), so the lock is not stale.
  return { pid: process.ppid, tool: 'gui:select-and-unlock-company', kind: 'gui', startedAt: new Date().toISOString(), host: os.hostname(), token: 'screen' };
}

test('while a screen action holds the lock, a status ping leaves its IPC command and result alone and reports the agent busy', async () => {
  await inIpcDir(async (dir) => {
    fs.writeFileSync(lockFile(), JSON.stringify(screenActionHolder()));
    const theirCommand = JSON.stringify({ action: 'select-and-unlock-company', commandId: 'theirs' });
    const theirResult = JSON.stringify({ status: 'success', commandId: 'theirs' });
    fs.writeFileSync(commandFile(dir), theirCommand);
    fs.writeFileSync(resultFile(dir), theirResult);
    const before = Date.now();
    const report = await getHttpStatusReport();
    assert.ok(Date.now() - before < 1500, 'answered at once, without waiting for the agent');
    assert.equal(report.agent.responding, true, 'busy is not dead');
    assert.equal(report.agent.busy, true);
    assert.equal(fs.readFileSync(commandFile(dir), 'utf-8'), theirCommand, 'pending command not overwritten');
    assert.equal(fs.readFileSync(resultFile(dir), 'utf-8'), theirResult, 'result not consumed');
    assert.equal(readLockHolder()?.token, 'screen');
  });
});

test('status and get-context say the screen is in use by another window, not that the helper is down', async () => {
  await inIpcDir(async () => {
    fs.writeFileSync(lockFile(), JSON.stringify(screenActionHolder()));
    const server = await registerMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'gui-ipc-probe-test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      for (const name of ['status', 'get-context']) {
        const r: any = await client.callTool({ name, arguments: {} });
        const body = JSON.parse(r.content[0].text);
        assert.equal(body.agentAlive, true, name);
        assert.equal(body.guiAvailable, false, name);
        assert.match(body.guiUnavailableReason, /Another AI window is using the Tally screen/, name);
        assert.equal(body.busy?.tool, 'gui:select-and-unlock-company', name);
      }
    } finally { await client.close(); await server.close(); }
  });
});

test('with the lock free, a ping holds it as a short probe for the round-trip and releases it', async () => {
  await inIpcDir(async (dir) => {
    const seen: { holder: LockHolder | null } = { holder: null };
    const agent = setInterval(() => {
      if (!fs.existsSync(commandFile(dir))) return;
      let cmd: any;
      try { cmd = JSON.parse(fs.readFileSync(commandFile(dir), 'utf-8')); } catch { return; }
      fs.unlinkSync(commandFile(dir));
      seen.holder = readLockHolder();
      fs.writeFileSync(resultFile(dir), JSON.stringify({ status: 'success', message: 'pong', agentVersion: '9.9.9', commandId: cmd.commandId }));
    }, 50);
    try {
      const report = await getHttpStatusReport();
      assert.equal(report.agent.responding, true);
      assert.equal(report.agent.version, '9.9.9');
      assert.equal(report.agent.busy, false);
    } finally { clearInterval(agent); }
    assert.equal(seen.holder?.probe, true, 'the ping held the lock as a probe');
    assert.equal(seen.holder?.tool, 'gui:ping');
    assert.equal(fs.existsSync(lockFile()), false, 'released');
  });
});

test('a ping never deletes a result that belongs to another command', async () => {
  await inIpcDir(async (dir) => {
    const otherResult = JSON.stringify({ status: 'success', commandId: 'someone-else' });
    fs.writeFileSync(resultFile(dir), otherResult);
    // No agent answers: the ping times out after its 2 s budget.
    const report = await getHttpStatusReport();
    assert.equal(report.agent.responding, false);
    assert.equal(fs.readFileSync(resultFile(dir), 'utf-8'), otherResult);
    assert.equal(fs.existsSync(commandFile(dir)), false, 'our own unanswered command is cleaned up');
  });
});
