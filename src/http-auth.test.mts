import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpApp } from './http-app.mjs';
import * as store from './oauth-store.mjs';

// Bearer tokens, refresh tokens, client ids and authorization codes are attacker-chosen strings.
// None of them may ever resolve to something that was not stored — in particular not to a member
// every JavaScript object inherits.
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype'];

const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'http://127.0.0.1:53999/callback';

interface Harness { base: string; dir: string; close: () => Promise<void>; }

// Starts the real Express app on an ephemeral port with its state in a throwaway directory.
// `seed` runs before the app loads its state files, so a test can plant a pre-existing store.
async function start(seed?: (dir: string) => void): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcp-http-'));
  fs.copyFileSync(path.join(import.meta.dirname, '../authorize.html'), path.join(dir, 'authorize.html'));
  seed?.(dir);
  let handler: http.RequestListener = (_req, res) => { res.statusCode = 503; res.end(); };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  const { app, close } = createHttpApp({ password: PASSWORD, mcpDomain: base, stateDir: dir });
  handler = app;
  return {
    base, dir,
    close: async () => {
      close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

// Runs the whole flow a real client runs: register, authorize with the password, exchange the code.
async function obtainTokens(base: string) {
  const reg = await (await postJson(`${base}/register`, { client_name: 'Test Client', redirect_uris: [REDIRECT] })).json() as any;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const auth = await (await postJson(`${base}/authorize`, {
    client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', password: PASSWORD,
  })).json() as any;
  assert.equal(auth.status, true);
  const tokenRes = await postJson(`${base}/token`, {
    grant_type: 'authorization_code', code: auth.code, redirect_uri: REDIRECT,
    client_id: reg.client_id, client_secret: reg.client_secret, code_verifier: verifier,
  });
  assert.equal(tokenRes.status, 200);
  return { client: reg, tokens: await tokenRes.json() as any };
}

test('validateBearerToken accepts only a stored, well-formed, unexpired token', () => {
  const now = 1_000_000;
  const tokens = new Map<string, store.AccessToken>([
    ['good', { token: 'good', client_id: 'c', expires_at: now + 1000 }],
    ['old', { token: 'old', client_id: 'c', expires_at: now - 1 }],
    ['noexp', { token: 'noexp', client_id: 'c' } as any],
    ['strexp', { token: 'strexp', client_id: 'c', expires_at: '9999999999999' } as any],
    ['nanexp', { token: 'nanexp', client_id: 'c', expires_at: NaN }],
    ['alias', { token: 'good', client_id: 'c', expires_at: now + 1000 }],
  ]);
  assert.equal(store.validateBearerToken('Bearer good', tokens, now)?.client_id, 'c');
  for (const header of [
    undefined, '', 'Bearer', 'Bearer ', 'Basic good', 'bearer good', 'Bearer good extra', ['Bearer good'],
    'Bearer old', 'Bearer noexp', 'Bearer strexp', 'Bearer nanexp', 'Bearer alias', 'Bearer missing',
    ...INHERITED_NAMES.map(n => `Bearer ${n}`),
  ]) {
    assert.equal(store.validateBearerToken(header, tokens, now), undefined, `must reject ${JSON.stringify(header)}`);
  }
});

test('client, refresh-token and authorization-code lookups ignore inherited property names', () => {
  for (const name of INHERITED_NAMES) {
    assert.equal(store.findClient(name, new Map()), undefined, name);
    assert.equal(store.findRefreshToken(name, new Map()), undefined, name);
    assert.equal(store.findAuthorizationCode(name, new Map()), undefined, name);
  }
  for (const notAString of [undefined, null, 1, {}, [], ['x']]) {
    assert.equal(store.findClient(notAString, new Map()), undefined);
    assert.equal(store.findRefreshToken(notAString, new Map()), undefined);
    assert.equal(store.findAuthorizationCode(notAString, new Map()), undefined);
  }
});

test('state files keep the original JSON shape and malformed entries are dropped on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcp-store-'));
  try {
    const file = path.join(dir, '.oauth-tokens.json');
    const future = Date.now() + 60_000;
    // The format written by earlier versions: plain objects keyed by token.
    fs.writeFileSync(file, JSON.stringify({
      accessTokens: {
        a1: { token: 'a1', client_id: 'c', expires_at: future },
        noexp: { token: 'noexp', client_id: 'c' },
        mismatch: { token: 'other', client_id: 'c', expires_at: future },
        junk: 'not-a-record',
      },
      refreshTokens: { r1: { token: 'r1', client_id: 'c', expires_at: future } },
    }));
    const loaded = store.loadTokens(file);
    assert.deepEqual([...loaded.accessTokens.keys()], ['a1']);
    assert.deepEqual([...loaded.refreshTokens.keys()], ['r1']);

    store.saveTokens(file, loaded);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), {
      accessTokens: { a1: { token: 'a1', client_id: 'c', expires_at: future } },
      refreshTokens: { r1: { token: 'r1', client_id: 'c', expires_at: future } },
    });

    const clientsFile = path.join(dir, '.oauth-clients.json');
    const client = { client_id: 'id1', client_name: 'n', client_secret: 's', redirect_uris: ['http://localhost/cb'] };
    fs.writeFileSync(clientsFile, JSON.stringify({ id1: client, bad: { client_id: 'bad' } }));
    const clients = store.loadClients(clientsFile);
    assert.deepEqual([...clients.keys()], ['id1']);
    store.saveClients(clientsFile, clients);
    assert.deepEqual(JSON.parse(fs.readFileSync(clientsFile, 'utf-8')), { id1: client });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/mcp rejects bearer tokens that were never issued, on every verb', async () => {
  const h = await start();
  try {
    const bogus = [...INHERITED_NAMES, 'not-a-token', ''];
    for (const name of bogus) {
      const headers = { Authorization: `Bearer ${name}`, ...MCP_HEADERS };
      const post = await postJson(`${h.base}/mcp`, INITIALIZE, headers);
      assert.equal(post.status, 401, `POST with "${name}"`);
      await post.body?.cancel();
      for (const method of ['GET', 'DELETE']) {
        const res = await fetch(`${h.base}/mcp`, { method, headers: { ...headers, 'mcp-session-id': 'constructor' } });
        assert.equal(res.status, 401, `${method} with "${name}"`);
        await res.body?.cancel();
      }
    }
    const none = await postJson(`${h.base}/mcp`, INITIALIZE, MCP_HEADERS);
    assert.equal(none.status, 401);
  } finally {
    await h.close();
  }
});

test('a token issued through the real flow is accepted, and inherited names are not session ids', async () => {
  const h = await start();
  try {
    const { tokens } = await obtainTokens(h.base);
    const headers = { Authorization: `Bearer ${tokens.access_token}`, ...MCP_HEADERS };

    const init = await postJson(`${h.base}/mcp`, INITIALIZE, headers);
    assert.equal(init.status, 200);
    const sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize must open a session');
    await init.body?.cancel();

    // Authenticated, but the session id is not one we handed out.
    for (const name of INHERITED_NAMES) {
      const res = await fetch(`${h.base}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': name } });
      assert.equal(res.status, 400, `session id "${name}"`);
      const post = await postJson(`${h.base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...headers, 'mcp-session-id': name });
      assert.equal(post.status, 400, `POST session id "${name}"`);
    }

    const del = await fetch(`${h.base}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sessionId! } });
    assert.equal(del.status, 200);
  } finally {
    await h.close();
  }
});

test('tokens persisted by an earlier version still authenticate; expired or malformed ones do not', async () => {
  const future = Date.now() + 60_000;
  const h = await start(dir => {
    fs.writeFileSync(path.join(dir, '.oauth-tokens.json'), JSON.stringify({
      accessTokens: {
        live: { token: 'live', client_id: 'c', expires_at: future },
        expired: { token: 'expired', client_id: 'c', expires_at: Date.now() - 1000 },
        noexp: { token: 'noexp', client_id: 'c' },
      },
      refreshTokens: {},
    }));
  });
  try {
    const probe = async (token: string) => {
      const res = await fetch(`${h.base}/mcp`, { headers: { Authorization: `Bearer ${token}`, ...MCP_HEADERS } });
      await res.body?.cancel();
      return res.status;
    };
    assert.equal(await probe('live'), 400); // authenticated; rejected only for the missing session id
    assert.equal(await probe('expired'), 401);
    assert.equal(await probe('noexp'), 401);
  } finally {
    await h.close();
  }
});

test('/token rejects inherited names as client id, refresh token and authorization code', async () => {
  const h = await start();
  try {
    const { client, tokens } = await obtainTokens(h.base);
    for (const name of INHERITED_NAMES) {
      const asClient = await postJson(`${h.base}/token`, { grant_type: 'refresh_token', client_id: name, refresh_token: tokens.refresh_token });
      assert.equal(asClient.status, 401, `client_id "${name}"`);

      const basic = Buffer.from(`${name}:x`).toString('base64');
      const asBasic = await postJson(`${h.base}/token`, { grant_type: 'refresh_token', refresh_token: name }, { Authorization: `Basic ${basic}` });
      assert.equal(asBasic.status, 401, `basic client "${name}"`);

      const asRefresh = await postJson(`${h.base}/token`, {
        grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: name,
      });
      assert.equal(asRefresh.status, 400, `refresh_token "${name}"`);

      const asCode = await postJson(`${h.base}/token`, {
        grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret,
        code: name, redirect_uri: REDIRECT, code_verifier: 'x',
      });
      assert.equal(asCode.status, 400, `code "${name}"`);
    }

    // The genuine refresh token still rotates.
    const ok = await postJson(`${h.base}/token`, {
      grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token,
    });
    assert.equal(ok.status, 200);
    const again = await postJson(`${h.base}/token`, {
      grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token,
    });
    assert.equal(again.status, 400, 'a refresh token is single-use');
  } finally {
    await h.close();
  }
});
