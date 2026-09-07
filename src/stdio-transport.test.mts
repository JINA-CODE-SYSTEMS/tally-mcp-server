import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveScriptPath } from './mcp.mjs';

// Under the stdio transport, stdout IS the JSON-RPC channel. Anything else written there —
// an audit line, a startup banner, a stray console.log — is injected into the byte stream the
// MCP client is parsing. These tests drive the real entrypoint and assert the channel stays clean.

const ENTRYPOINT = path.resolve(import.meta.dirname, 'index.mjs');

type Harness = { stdout: string; stderr: string };

// Boots dist/index.mjs, performs the MCP handshake, then invokes a tool that is guaranteed to be
// refused locally (non-SELECT SQL is rejected by validateSQL before Tally is ever contacted), which
// is what forces an audit record to be written without needing a live Tally.
function runStdioSession(timeoutMs = 20000): Promise<Harness> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRYPOINT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TALLY_HOST: '127.0.0.1', TALLY_PORT: '1' }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      err ? reject(err) : resolve({ stdout, stderr });
    };

    const timer = setTimeout(() => finish(new Error(`stdio session timed out\nstdout:${stdout}\nstderr:${stderr}`)), timeoutMs);

    child.stdout.on('data', d => {
      stdout += d.toString('utf-8');
      // The audit line lands only after the tool call is answered; that response is the last
      // thing we need, so settle as soon as it arrives.
      if (stdout.includes('"id":2')) setTimeout(() => finish(), 250);
    });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('error', finish);

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-purity-test', version: '1.0.0' }
      }
    });

    // Give the server a moment to answer initialize before completing the handshake and calling.
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'query-database', arguments: { sql: 'DROP TABLE something' } }
      });
    }, 1500);
  });
}

test('stdout carries only JSON-RPC frames — never audit or log output', async () => {
  const { stdout } = await runStdioSession();

  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, 'server produced no stdout at all');

  for (const line of lines) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `non-JSON written to the stdio transport, which corrupts the JSON-RPC stream: ${line}`
    );
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, '2.0', `stdout frame is not JSON-RPC: ${line}`);
  }

  assert.ok(!stdout.includes('[audit]'), 'audit output reached stdout — it must go to stderr');
});

test('audit records are still emitted, on stderr', async () => {
  const { stderr } = await runStdioSession();
  assert.ok(stderr.includes('[audit]'), 'audit logging disappeared entirely; it must still be written to stderr');
  assert.ok(stderr.includes('query-database'), 'the refused tool call was not audited');
});

test('bundled script paths resolve from the module, not the working directory', () => {
  const fromHere = resolveScriptPath('dpapi-helper.ps1');
  const original = process.cwd();
  try {
    process.chdir(path.resolve(import.meta.dirname, '..'));
    const fromElsewhere = resolveScriptPath('dpapi-helper.ps1');
    assert.equal(fromHere, fromElsewhere, 'script path changed with the working directory');
  } finally {
    process.chdir(original);
  }

  assert.ok(path.isAbsolute(fromHere), 'script path must be absolute');
  assert.ok(fromHere.includes('scripts'), 'script path must point into scripts/');
  assert.ok(!fromHere.includes('dist'), 'scripts/ is a sibling of dist/, not a child');
});
