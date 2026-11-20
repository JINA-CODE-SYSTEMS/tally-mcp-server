import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHttpApp, type HttpAppOptions } from './http-app.mjs';
import * as store from './oauth-store.mjs';
import { FailedAttemptBackoff, parseTrustProxy } from './auth-backoff.mjs';

// Bearer tokens, refresh tokens, client ids and authorization codes are attacker-chosen strings.
// None of them may ever resolve to something that was not stored — in particular not to a member
// every JavaScript object inherits.
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype'];

const PASSWORD = 'correct horse battery staple';
const REDIRECT = 'http://127.0.0.1:53999/callback';

interface Harness { base: string; dir: string; app: import('express').Express; close: () => Promise<void>; }

// Starts the real Express app on an ephemeral port with its state in a throwaway directory.
// `seed` runs before the app loads its state files, so a test can plant a pre-existing store.
async function start(seed?: (dir: string) => void, options: Partial<HttpAppOptions> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-mcp-http-'));
  fs.copyFileSync(path.join(import.meta.dirname, '../authorize.html'), path.join(dir, 'authorize.html'));
  seed?.(dir);
  let handler: http.RequestListener = (_req, res) => { res.statusCode = 503; res.end(); };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  const { app, close } = createHttpApp({ password: PASSWORD, mcpDomain: base, stateDir: dir, ...options });
  handler = app;
  return {
    base, dir, app,
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

// ---- OAuth flow hardening ------------------------------------------------------------------------

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

test('redirect URI policy: https, loopback http and known app schemes only', () => {
  for (const ok of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://vscode.dev/redirect',
    'http://localhost:33418/callback',
    'http://127.0.0.1:33418/',
    'http://[::1]:8080/cb',
    'vscode://vscode.github-authentication/did-authenticate',
    'cursor://anysphere.cursor-retrieval/oauth/user-tally/callback',
  ]) assert.equal(store.isAllowedRedirectUri(ok), true, ok);

  for (const bad of [
    'javascript:alert(1)', 'JavaScript://x/%0aalert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y',
    'http://example.com/cb', 'http://localhost.example.com/cb', 'http://127.0.0.1.example.com/cb', 'http://192.168.1.10/cb',
    'https://user:pw@example.com/cb', 'https://example.com/cb#frag', 'myapp://cb', 'ftp://example.com/x',
    ' https://example.com/cb', 'https://exa mple.com/cb', '/relative', '', 'not a url', undefined, null, 5, {}, ['https://example.com/cb'],
  ]) assert.equal(store.isAllowedRedirectUri(bad), false, JSON.stringify(bad));

  // Operators can add an app scheme, but never a script-capable one.
  const schemes = store.parseRedirectSchemes('windsurf, javascript, data:, https, bad scheme');
  assert.equal(store.isAllowedRedirectUri('windsurf://callback', schemes), true);
  assert.equal(store.isAllowedRedirectUri('javascript:alert(1)', schemes), false);
  assert.equal(store.isAllowedRedirectUri('data:text/html,x', schemes), false);
  assert.equal(store.isAllowedRedirectUri('http://example.com/', schemes), false);
});

test('/register validates redirect_uris and still allows unauthenticated dynamic registration', async () => {
  const h = await start();
  try {
    for (const redirect_uris of [
      undefined, [], 'https://example.com/cb', ['javascript:alert(1)'], ['data:text/html,x'], ['http://example.com/cb'],
      ['https://example.com/ok', 'javascript:alert(1)'], [42], Array(11).fill('https://example.com/cb'),
    ]) {
      const res = await postJson(`${h.base}/register`, { client_name: 'x', redirect_uris });
      assert.equal(res.status, 400, JSON.stringify(redirect_uris));
      assert.equal((await res.json() as any).error, 'invalid_redirect_uri');
    }
    assert.equal(fs.existsSync(path.join(h.dir, '.oauth-clients.json')), false, 'a rejected registration stores nothing');

    // What Claude / VS Code send: no Authorization header at all.
    const ok = await postJson(`${h.base}/register`, {
      client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:33418/'],
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.ok(body.client_id && body.client_secret);
    assert.deepEqual(body.redirect_uris, ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:33418/']);

    // client_name is display-only: non-strings and control characters do not get stored.
    const odd = await (await postJson(`${h.base}/register`, { client_name: { a: 1 }, redirect_uris: [REDIRECT] })).json() as any;
    assert.equal(odd.client_name, 'Unnamed Client');
    const long = await (await postJson(`${h.base}/register`, { client_name: 'A\u0000B\n' + 'x'.repeat(500), redirect_uris: [REDIRECT] })).json() as any;
    assert.equal(long.client_name.length, 100);
    assert.doesNotMatch(long.client_name, /[\u0000-\u001f]/);
  } finally {
    await h.close();
  }
});

test('registration and ADMIN_SECRET: open by default, mandatory when configured so', async () => {
  const body = { client_name: 'c', redirect_uris: [REDIRECT] };
  const bearer = (s: string) => ({ Authorization: `Bearer ${s}` });

  const open = await start(undefined, { adminSecret: 'admin-secret' });
  try {
    assert.equal((await postJson(`${open.base}/register`, body)).status, 200, 'no header: dynamic registration');
    assert.equal((await postJson(`${open.base}/register`, body, bearer('admin-secret'))).status, 200);
    assert.equal((await postJson(`${open.base}/register`, body, bearer('wrong'))).status, 403, 'a wrong secret is never ignored');
  } finally {
    await open.close();
  }

  const strict = await start(undefined, { adminSecret: 'admin-secret', requireAdminSecretForRegistration: true });
  try {
    assert.equal((await postJson(`${strict.base}/register`, body)).status, 401);
    assert.equal((await postJson(`${strict.base}/register`, body, { Authorization: 'Basic admin-secret' })).status, 401);
    assert.equal((await postJson(`${strict.base}/register`, body, bearer('wrong'))).status, 403);
    assert.equal((await postJson(`${strict.base}/register`, body, bearer('admin-secret'))).status, 200);
  } finally {
    await strict.close();
  }

  // Required but no secret configured: registration is closed, not open.
  const closed = await start(undefined, { requireAdminSecretForRegistration: true });
  try {
    assert.equal((await postJson(`${closed.base}/register`, body)).status, 403);
    assert.equal((await postJson(`${closed.base}/register`, body, bearer(''))).status, 403);
    assert.equal((await postJson(`${closed.base}/register`, body, bearer('anything'))).status, 403);
  } finally {
    await closed.close();
  }
});

test('POST /authorize issues a code only for a registered client, its own redirect URI, and S256', async () => {
  const h = await start();
  try {
    const client = await (await postJson(`${h.base}/register`, { client_name: 'Test', redirect_uris: [REDIRECT] })).json() as any;
    const other = await (await postJson(`${h.base}/register`, { client_name: 'Other', redirect_uris: ['https://other.example/cb'] })).json() as any;
    const { challenge } = pkce();
    const good = { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', password: PASSWORD };

    // Every one of these carries the CORRECT password and must still be refused without a code.
    const refused: [string, Record<string, unknown>][] = [
      ['unknown client', { ...good, client_id: 'never-registered' }],
      ['inherited-name client', { ...good, client_id: '__proto__' }],
      ['non-string client', { ...good, client_id: ['x'] }],
      ['unregistered redirect', { ...good, redirect_uri: 'https://attacker.example/cb' }],
      ["another client's redirect", { ...good, redirect_uri: 'https://other.example/cb' }],
      ['redirect prefix trick', { ...good, redirect_uri: REDIRECT + '/../x' }],
      ['missing redirect', { ...good, redirect_uri: undefined }],
      ['plain PKCE', { ...good, code_challenge_method: 'plain' }],
      ['no PKCE method', { ...good, code_challenge_method: undefined }],
      ['no challenge', { ...good, code_challenge: undefined }],
      ['malformed challenge', { ...good, code_challenge: 'short' }],
    ];
    for (const [label, body] of refused) {
      const res = await postJson(`${h.base}/authorize`, body);
      assert.equal(res.status, 400, label);
      assert.equal((await res.json() as any).code, undefined, label);
    }
    assert.ok(other.client_id);

    const wrongPw = await postJson(`${h.base}/authorize`, { ...good, password: 'nope' });
    assert.equal(wrongPw.status, 401);
    assert.equal((await wrongPw.json() as any).code, undefined);
    assert.equal((await postJson(`${h.base}/authorize`, { ...good, password: { $ne: '' } })).status, 400);

    const ok = await postJson(`${h.base}/authorize`, good);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json() as any).code);
  } finally {
    await h.close();
  }
});

test('GET /authorize shows the client name and redirect host, escaped, and rejects bad requests', async () => {
  const h = await start();
  try {
    const name = '<img src=x onerror=alert(1)> & "Co"';
    const client = await (await postJson(`${h.base}/register`, { client_name: name, redirect_uris: [REDIRECT] })).json() as any;
    const { challenge } = pkce();
    const query = (over: Record<string, string> = {}) => new URLSearchParams({
      client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
      response_type: 'code', state: 'xyz', ...over,
    }).toString();

    const page = await fetch(`${h.base}/authorize?${query()}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;'), 'client name shown, HTML-escaped');
    assert.ok(!html.includes('<img src=x'), 'client name must not be injected as markup');
    assert.ok(html.includes('>127.0.0.1:53999<'), 'redirect host shown');
    assert.ok(!html.includes('%%'), 'no unfilled placeholder');

    const overrides: Record<string, string>[] = [
      { client_id: 'unknown' }, { client_id: 'constructor' }, { redirect_uri: 'https://attacker.example/cb' },
      { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { response_type: 'token' },
    ];
    for (const over of overrides) {
      const res = await fetch(`${h.base}/authorize?${query(over)}`);
      assert.equal(res.status, 400, JSON.stringify(over));
      assert.doesNotMatch(await res.text(), /<form/);
    }
  } finally {
    await h.close();
  }
});

test('authorize.html carries the consent placeholders the server fills in', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '../authorize.html'), 'utf-8');
  assert.match(html, /%%CLIENT_NAME%%/);
  assert.match(html, /%%REDIRECT_TARGET%%/);
  assert.equal(store.describeRedirectTarget('https://claude.ai/api/mcp/auth_callback'), 'claude.ai');
  assert.equal(store.describeRedirectTarget('cursor://anysphere.cursor-retrieval/oauth/callback'), 'cursor:// (application link)');
});

// ---- Rate limiting that cannot be sidestepped by choosing an address ---------------------------------

test('TRUST_PROXY parsing: loopback-only by default, never blanket trust', () => {
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy(''), 'loopback');
  for (const off of ['false', 'FALSE', '0', 'off', 'none']) assert.equal(parseTrustProxy(off), false, off);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('true'), 1);
  assert.equal(parseTrustProxy('10.0.0.5, 192.168.0.0/24'), '10.0.0.5,192.168.0.0/24');
  assert.equal(parseTrustProxy('loopback, uniquelocal'), 'loopback,uniquelocal');
  assert.equal(parseTrustProxy('not a proxy; rm -rf'), 'loopback');
});

test('by default X-Forwarded-For is believed only from a proxy on this machine', async () => {
  const h = await start();
  try {
    // Express compiles the setting into this predicate over the connecting peer's address.
    const trusts = (h.app.get('trust proxy fn') as (addr: string, hop: number) => boolean);
    assert.equal(trusts('127.0.0.1', 0), true);
    assert.equal(trusts('::1', 0), true);
    for (const direct of ['192.168.1.50', '10.0.0.7', '172.16.4.4', '203.0.113.9', 'fe80::1']) {
      assert.equal(trusts(direct, 0), false, `${direct} must not be able to set its own client address`);
    }
  } finally {
    await h.close();
  }
});

test('a direct client cannot evade the per-IP auth limiter by varying X-Forwarded-For', async () => {
  // TRUST_PROXY=false models direct serving (the test client is itself on loopback).
  const h = await start(undefined, { trustProxy: 'false', authRateLimitMax: 3 });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await postJson(`${h.base}/register`, { redirect_uris: [REDIRECT] }, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
  } finally {
    await h.close();
  }
});

test('FailedAttemptBackoff: free attempts, doubling lockout up to a cap, reset on success or quiet', () => {
  let now = 1_000_000;
  const b = new FailedAttemptBackoff({ freeAttempts: 3, baseMs: 1000, maxMs: 8000, resetAfterMs: 60_000, now: () => now });
  for (let i = 0; i < 3; i++) { assert.equal(b.retryAfterMs(), 0); b.recordFailure(); }
  assert.equal(b.retryAfterMs(), 0, 'the free attempts do not lock');
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    b.recordFailure();
    delays.push(b.retryAfterMs());
    now += b.retryAfterMs(); // wait the window out, then fail again
    assert.equal(b.retryAfterMs(), 0);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000, 8000]);

  b.recordSuccess();
  b.recordFailure();
  assert.equal(b.retryAfterMs(), 0, 'success clears the count');

  for (let i = 0; i < 5; i++) b.recordFailure();
  assert.ok(b.retryAfterMs() > 0);
  now += 60_000;
  assert.equal(b.retryAfterMs(), 0);
  b.recordFailure();
  assert.equal(b.retryAfterMs(), 0, 'a quiet period clears the count');
});

test('repeated wrong passwords lock /authorize for everyone, whatever address they claim', async () => {
  // Loopback proxy trusted (the default): every request below appears to come from a new address,
  // so the per-IP limiter never trips. Only the global backoff stands in the way.
  const h = await start(undefined, { authBackoff: { freeAttempts: 3, baseMs: 400, maxMs: 400 } });
  try {
    const client = await (await postJson(`${h.base}/register`, { redirect_uris: [REDIRECT] })).json() as any;
    const { challenge } = pkce();
    let n = 0;
    const attempt = (password: string) => postJson(`${h.base}/authorize`,
      { client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', password },
      { 'X-Forwarded-For': `198.51.100.${++n}` });

    for (let i = 0; i < 4; i++) assert.equal((await attempt(`guess-${i}`)).status, 401);

    // Locked: even the correct password is not evaluated, and no code is issued.
    const locked = await attempt(PASSWORD);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assert.equal((await locked.json() as any).code, undefined);
    assert.equal((await attempt('another-guess')).status, 429);

    await new Promise(resolve => setTimeout(resolve, 450));
    const ok = await attempt(PASSWORD);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json() as any).code);

    // Success cleared the count: a single typo afterwards does not lock.
    assert.equal((await attempt('typo')).status, 401);
    assert.equal((await attempt(PASSWORD)).status, 200);
  } finally {
    await h.close();
  }
});

test('wrong admin secrets on /register back off globally without blocking open registration', async () => {
  const h = await start(undefined, { adminSecret: 'admin-secret', authBackoff: { freeAttempts: 2, baseMs: 60_000, maxMs: 60_000 } });
  try {
    const body = { redirect_uris: [REDIRECT] };
    for (let i = 0; i < 3; i++) {
      assert.equal((await postJson(`${h.base}/register`, body, { Authorization: `Bearer wrong-${i}` })).status, 403);
    }
    assert.equal((await postJson(`${h.base}/register`, body, { Authorization: 'Bearer admin-secret' })).status, 429);
    assert.equal((await postJson(`${h.base}/register`, body)).status, 200, 'header-less dynamic registration is unaffected');
  } finally {
    await h.close();
  }
});

// ---- Client authentication at /token, and a bounded client registry ---------------------------------

// Registers a client and gets as far as an authorization code.
async function registerAndAuthorize(base: string, registration: Record<string, unknown> = {}) {
  const client = await (await postJson(`${base}/register`, { client_name: 'c', redirect_uris: [REDIRECT], ...registration })).json() as any;
  const { verifier, challenge } = pkce();
  const auth = await (await postJson(`${base}/authorize`, {
    client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', password: PASSWORD,
  })).json() as any;
  const exchange = { grant_type: 'authorization_code', code: auth.code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier };
  return { client, exchange };
}

test('a confidential client must present its secret at /token; a wrong or missing one is refused', async () => {
  const h = await start();
  try {
    const { client, exchange } = await registerAndAuthorize(h.base);
    assert.equal(client.token_endpoint_auth_method, 'client_secret_basic');
    assert.ok(client.client_secret);

    assert.equal((await postJson(`${h.base}/token`, exchange)).status, 401, 'no secret');
    assert.equal((await postJson(`${h.base}/token`, { ...exchange, client_secret: 'wrong' })).status, 401);
    assert.equal((await postJson(`${h.base}/token`, { ...exchange, client_secret: ['x'] })).status, 401);
    const badBasic = Buffer.from(`${client.client_id}:wrong`).toString('base64');
    assert.equal((await postJson(`${h.base}/token`, exchange, { Authorization: `Basic ${badBasic}` })).status, 401);
    const otherId = Buffer.from(`someone-else:${client.client_secret}`).toString('base64');
    assert.equal((await postJson(`${h.base}/token`, exchange, { Authorization: `Basic ${otherId}` })).status, 401, 'conflicting ids');

    // The code survived the refused attempts and is redeemable with the secret in a Basic header,
    // with client_id also present in the body (a combination real clients send).
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await postJson(`${h.base}/token`, exchange, { Authorization: `Basic ${basic}` });
    assert.equal(ok.status, 200);
    const tokens = await ok.json() as any;

    // Refresh needs the secret too.
    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token };
    assert.equal((await postJson(`${h.base}/token`, refresh)).status, 401);
    assert.equal((await postJson(`${h.base}/token`, { ...refresh, client_secret: client.client_secret })).status, 200);
  } finally {
    await h.close();
  }
});

test('a client registered as public gets no secret and authenticates with PKCE alone', async () => {
  const h = await start();
  try {
    const { client, exchange } = await registerAndAuthorize(h.base, { token_endpoint_auth_method: 'none' });
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.equal('client_secret' in client, false);

    assert.equal((await postJson(`${h.base}/token`, { ...exchange, code_verifier: 'not-the-verifier' })).status, 400, 'PKCE still enforced');
    const ok = await postJson(`${h.base}/token`, exchange);
    assert.equal(ok.status, 200);

    const bad = await postJson(`${h.base}/register`, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).error, 'invalid_client_metadata');

    const meta = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json() as any;
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['client_secret_basic', 'client_secret_post', 'none']);
  } finally {
    await h.close();
  }
});

test('a client record with no recorded auth method is confidential: the secret is required', () => {
  const legacy: store.RegisteredClient = { client_id: 'old', client_name: 'n', client_secret: 's3cret', redirect_uris: [REDIRECT] };
  assert.equal(store.isRegisteredClient(legacy), true);
  assert.equal(store.authenticateClient(legacy, undefined), false);
  assert.equal(store.authenticateClient(legacy, ''), false);
  assert.equal(store.authenticateClient(legacy, 's3cret'), true);
  assert.equal(store.authenticateClient(legacy, 'wrong'), false);

  const confidential = { ...legacy, token_endpoint_auth_method: 'client_secret_post' as const };
  assert.equal(store.authenticateClient(confidential, undefined), false);
  assert.equal(store.authenticateClient(confidential, ''), false);
  assert.equal(store.authenticateClient(confidential, 's3cret'), true);

  // A record cannot claim to be confidential with an empty secret, or carry an unknown method.
  assert.equal(store.isRegisteredClient({ ...legacy, client_secret: '' }), false);
  assert.equal(store.isRegisteredClient({ ...legacy, client_secret: '', token_endpoint_auth_method: 'none' }), true);
  assert.equal(store.isRegisteredClient({ ...legacy, token_endpoint_auth_method: 'whatever' }), false);
});

test('the client registry is bounded: idle clients are evicted first, signed-in clients are kept', async () => {
  const h = await start(undefined, { maxClients: 3 });
  try {
    const { client: signedIn, exchange } = await registerAndAuthorize(h.base);
    assert.equal((await postJson(`${h.base}/token`, { ...exchange, client_secret: signedIn.client_secret })).status, 200);

    // A flood of registrations that never sign in.
    const flood: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await postJson(`${h.base}/register`, { client_name: `flood-${i}`, redirect_uris: [REDIRECT] });
      assert.equal(res.status, 200);
      flood.push((await res.json() as any).client_id);
    }
    const stored = JSON.parse(fs.readFileSync(path.join(h.dir, '.oauth-clients.json'), 'utf-8'));
    assert.equal(Object.keys(stored).length, 3);
    assert.ok(stored[signedIn.client_id], 'the client holding tokens survives');
    assert.deepEqual(Object.keys(stored).filter(id => id !== signedIn.client_id), flood.slice(-2), 'the newest idle clients remain');
  } finally {
    await h.close();
  }

  // Full of in-use clients: refuse rather than evict someone who is signed in.
  const clients = new Map<string, store.RegisteredClient>(['a', 'b'].map(id =>
    [id, { client_id: id, client_name: id, client_secret: 's', redirect_uris: [REDIRECT] }]));
  assert.equal(store.makeRoomForClient(clients, 2, new Set(['a', 'b'])), false);
  assert.equal(clients.size, 2);
  assert.equal(store.makeRoomForClient(clients, 2, new Set(['b'])), true);
  assert.deepEqual([...clients.keys()], ['b']);
});

test('eviction spares a client that registered moments ago while an older idle client can go instead', () => {
  const now = 1_000_000_000;
  const MIN = 60_000;
  const mk = (id: string, registered_at?: number): [string, store.RegisteredClient] =>
    [id, { client_id: id, client_name: id, client_secret: 's', redirect_uris: [REDIRECT], registered_at }];

  // 'login' registered a minute ago (a user may be at the sign-in page) and is the OLDEST entry;
  // 'stale' and 'legacy' (no timestamp) are idle and old. The old ones go first.
  let clients = new Map([mk('login', now - MIN), mk('stale', now - 60 * MIN), mk('legacy'), mk('busy', now - 90 * MIN)]);
  assert.equal(store.makeRoomForClient(clients, 4, new Set(['busy']), now), true);
  assert.deepEqual([...clients.keys()], ['login', 'legacy', 'busy'], 'one old idle client is dropped, the recent one is kept');

  // Only as many as needed are dropped.
  clients = new Map([mk('stale1', now - 60 * MIN), mk('stale2', now - 50 * MIN), mk('login', now - MIN)]);
  assert.equal(store.makeRoomForClient(clients, 3, new Set(), now), true);
  assert.deepEqual([...clients.keys()], ['stale2', 'login']);

  // The window is a preference, not a protection: when every idle client is recent (a flood), the
  // oldest recent one goes, so registration is never blocked by clients that have not signed in.
  clients = new Map([mk('busy', now - 90 * MIN), mk('f1', now - 3 * MIN), mk('f2', now - 2 * MIN), mk('f3', now - MIN)]);
  assert.equal(store.makeRoomForClient(clients, 4, new Set(['busy']), now), true);
  assert.deepEqual([...clients.keys()], ['busy', 'f2', 'f3']);

  // A client just past the window counts as old; a client in use is never dropped in either pass.
  clients = new Map([mk('recent', now - 9 * MIN), mk('expired', now - 11 * MIN)]);
  assert.equal(store.makeRoomForClient(clients, 2, new Set(), now), true);
  assert.deepEqual([...clients.keys()], ['recent']);
  clients = new Map([mk('a', now - MIN), mk('b', now - 60 * MIN)]);
  assert.equal(store.makeRoomForClient(clients, 2, new Set(['a', 'b']), now), false);
  assert.equal(clients.size, 2);

  // The timestamp is validated on load and optional for older records.
  const record = { client_id: 'x', client_name: 'x', client_secret: 's', redirect_uris: [REDIRECT] };
  assert.equal(store.isRegisteredClient(record), true);
  assert.equal(store.isRegisteredClient({ ...record, registered_at: now }), true);
  assert.equal(store.isRegisteredClient({ ...record, registered_at: 'yesterday' }), false);
});

test('registration records when the client registered', async () => {
  const h = await start(undefined, { maxClients: 3 });
  try {
    const before = Date.now();
    const reg = await postJson(`${h.base}/register`, { client_name: 'fresh', redirect_uris: [REDIRECT] });
    const id = (await reg.json() as any).client_id;
    const stored = JSON.parse(fs.readFileSync(path.join(h.dir, '.oauth-clients.json'), 'utf-8'));
    assert.ok(stored[id].registered_at >= before && stored[id].registered_at <= Date.now());
  } finally {
    await h.close();
  }
});
