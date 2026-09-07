import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGuiTransportMode,
  guiTransportNeedsVersionHandshake,
  parseGuiAgentStdout,
  setGuiTransportMode,
  getGuiTransportMode,
  type GuiTransportMode
} from './mcp.mjs';

// --- transport selection ---------------------------------------------------------------------

test('the entrypoint default stands when GUI_TRANSPORT is unset', () => {
  assert.equal(resolveGuiTransportMode(undefined, 'ipc'), 'ipc');
  assert.equal(resolveGuiTransportMode(undefined, 'in-session'), 'in-session');
  assert.equal(resolveGuiTransportMode('', 'in-session'), 'in-session');
  assert.equal(resolveGuiTransportMode('   ', 'in-session'), 'in-session');
});

test('an explicit GUI_TRANSPORT overrides the entrypoint default', () => {
  assert.equal(resolveGuiTransportMode('ipc', 'in-session'), 'ipc');
  assert.equal(resolveGuiTransportMode('in-session', 'ipc'), 'in-session');
  assert.equal(resolveGuiTransportMode('IN-SESSION', 'ipc'), 'in-session');
  assert.equal(resolveGuiTransportMode('  Ipc  ', 'in-session'), 'ipc');
});

test('an unrecognised GUI_TRANSPORT falls back instead of throwing', () => {
  // A typo in a config file should not take the server down; it should behave as if unset.
  assert.equal(resolveGuiTransportMode('in_session', 'ipc'), 'ipc');
  assert.equal(resolveGuiTransportMode('file', 'in-session'), 'in-session');
});

test('setGuiTransportMode still lets the environment win', () => {
  const original = process.env.GUI_TRANSPORT;
  const restore = getGuiTransportMode();
  try {
    delete process.env.GUI_TRANSPORT;
    setGuiTransportMode('in-session');
    assert.equal(getGuiTransportMode(), 'in-session');

    // An operator who deliberately runs the companion agent must be able to force IPC even from
    // the stdio entrypoint, which asks for in-session.
    process.env.GUI_TRANSPORT = 'ipc';
    setGuiTransportMode('in-session');
    assert.equal(getGuiTransportMode(), 'ipc');
  } finally {
    if (original === undefined) delete process.env.GUI_TRANSPORT;
    else process.env.GUI_TRANSPORT = original;
    setGuiTransportMode(restore as GuiTransportMode);
  }
});

// --- version handshake -----------------------------------------------------------------------

test('only the IPC transport needs an agent version handshake', () => {
  // IPC talks to a separately launched, independently updated agent, so it can be paired with a
  // stale one. In-session runs the script shipped in this install.
  assert.equal(guiTransportNeedsVersionHandshake('ipc'), true);
  assert.equal(guiTransportNeedsVersionHandshake('in-session'), false);
});

// --- stdout parsing --------------------------------------------------------------------------

test('the result is found among PowerShell host chatter', () => {
  const stdout = [
    '=== Received command: ping ===',
    'Some incidental Write-Host output',
    '{"status":"success","message":"pong","agentVersion":"1.1.0"}',
    'trailing noise'
  ].join('\n');

  const parsed = parseGuiAgentStdout(stdout);
  assert.ok(parsed, 'expected a parsed result');
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.message, 'pong');
  assert.equal(parsed.agentVersion, '1.1.0');
});

test('a leading BOM does not defeat parsing', () => {
  // PowerShell's UTF8 encoding prepends a BOM; the IPC path strips one for the same reason.
  const parsed = parseGuiAgentStdout('﻿{"status":"success","message":"ok"}');
  assert.ok(parsed);
  assert.equal(parsed.status, 'success');
});

test('the LAST result wins when several are printed', () => {
  // A command that reports progress before its outcome must not be read as having finished early.
  const stdout = [
    '{"status":"pending","message":"working"}',
    '{"status":"error","message":"Tally window not found"}'
  ].join('\n');

  const parsed = parseGuiAgentStdout(stdout);
  assert.ok(parsed);
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.message, 'Tally window not found');
});

test('JSON without a status field is not mistaken for a result', () => {
  const parsed = parseGuiAgentStdout('{"unrelated":"object"}\n{"status":"success","message":"real"}');
  assert.ok(parsed);
  assert.equal(parsed.message, 'real');
});

test('no result at all returns null rather than a bogus success', () => {
  assert.equal(parseGuiAgentStdout(''), null);
  assert.equal(parseGuiAgentStdout('powershell exploded\nno json here'), null);
  assert.equal(parseGuiAgentStdout('{"unrelated":"object"}'), null);
  assert.equal(parseGuiAgentStdout('{ truncated'), null);
});

test('a missing agentVersion is reported as null, not the string "undefined"', () => {
  const parsed = parseGuiAgentStdout('{"status":"success","message":"ok"}');
  assert.ok(parsed);
  assert.equal(parsed.agentVersion, null);
});
