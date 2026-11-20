import crypto from 'node:crypto';
import fs from 'node:fs';

// OAuth state for the remote (HTTP) server. Everything here is keyed by a string that arrives from
// the network (bearer token, refresh token, client_id, authorization code), so the stores are Maps:
// a plain object would also answer for inherited property names, and a lookup that "finds" an
// inherited member must never be mistaken for a stored record. Each lookup additionally checks the
// record's shape, so a malformed entry in a hand-edited state file is treated as absent.

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  client_secret: string;
  redirect_uris: string[];
  // How the client authenticates at /token. 'none' is a public client (PKCE only, no secret).
  // A record without it is treated as confidential — see authenticateClient.
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
  // When the client registered (ms since epoch). Absent on older records, which count as old.
  registered_at?: number;
}

export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
const TOKEN_ENDPOINT_AUTH_METHODS: readonly string[] = ['none', 'client_secret_basic', 'client_secret_post'];

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

export interface AccessToken {
  token: string;
  client_id: string;
  expires_at: number;
}

export interface RefreshToken {
  token: string;
  client_id: string;
  expires_at: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function isRegisteredClient(v: unknown): v is RegisteredClient {
  return isRecord(v)
    && typeof v.client_id === 'string' && v.client_id.length > 0
    && typeof v.client_secret === 'string'
    && (v.client_secret.length > 0 || v.token_endpoint_auth_method === 'none')
    && (v.token_endpoint_auth_method === undefined || TOKEN_ENDPOINT_AUTH_METHODS.includes(v.token_endpoint_auth_method as string))
    && (v.registered_at === undefined || (typeof v.registered_at === 'number' && Number.isFinite(v.registered_at)))
    && Array.isArray(v.redirect_uris) && v.redirect_uris.every(u => typeof u === 'string');
}

// Shared by access and refresh tokens. expires_at must be a finite number: a record without one is
// not "never expires", it is invalid.
export function isTokenRecord(v: unknown): v is AccessToken {
  return isRecord(v)
    && typeof v.token === 'string' && v.token.length > 0
    && typeof v.client_id === 'string'
    && typeof v.expires_at === 'number' && Number.isFinite(v.expires_at);
}

export function isAuthorizationCode(v: unknown): v is AuthorizationCode {
  return isRecord(v)
    && typeof v.code === 'string'
    && typeof v.client_id === 'string'
    && typeof v.redirect_uri === 'string'
    && typeof v.code_challenge === 'string'
    && typeof v.code_challenge_method === 'string'
    && typeof v.expires_at === 'number' && Number.isFinite(v.expires_at);
}

// The on-disk format stays what it always was — a JSON object keyed by id — so existing
// .oauth-clients.json / .oauth-tokens.json files load unchanged. Entries that fail the shape check,
// or whose key does not match the id stored inside the record, are dropped.
export function recordsToMap<T>(raw: unknown, isValid: (v: unknown) => v is T, idOf: (v: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isValid(value) && idOf(value) === key) out.set(key, value);
  }
  return out;
}

export function mapToRecords<T>(map: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [key, value] of map) out[key] = value;
  return out;
}

export function loadClients(filePath: string): Map<string, RegisteredClient> {
  try {
    if (fs.existsSync(filePath)) {
      return recordsToMap(JSON.parse(fs.readFileSync(filePath, 'utf-8')), isRegisteredClient, c => c.client_id);
    }
  } catch (e) {
    console.error('[oauth] Failed to load clients file:', e);
  }
  return new Map();
}

export function saveClients(filePath: string, clients: Map<string, RegisteredClient>): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(mapToRecords(clients), null, 2), 'utf-8');
  } catch (e) {
    console.error('[oauth] Failed to save clients file:', e);
  }
}

export interface TokenStores {
  accessTokens: Map<string, AccessToken>;
  refreshTokens: Map<string, RefreshToken>;
}

export function loadTokens(filePath: string): TokenStores {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const obj = isRecord(parsed) ? parsed : {};
      return {
        accessTokens: recordsToMap(obj.accessTokens, isTokenRecord, t => t.token),
        refreshTokens: recordsToMap(obj.refreshTokens, isTokenRecord, t => t.token),
      };
    }
  } catch (e) {
    console.error('[oauth] Failed to load tokens file:', e);
  }
  return { accessTokens: new Map(), refreshTokens: new Map() };
}

export function saveTokens(filePath: string, stores: TokenStores): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      accessTokens: mapToRecords(stores.accessTokens),
      refreshTokens: mapToRecords(stores.refreshTokens),
    }, null, 2), 'utf-8');
  } catch (e) {
    console.error('[oauth] Failed to save tokens file:', e);
  }
}

// The single place a bearer credential is accepted. Returns the stored record only for a
// well-formed `Authorization: Bearer <token>` header naming a stored, well-formed, unexpired token.
export function validateBearerToken(
  authHeader: unknown,
  accessTokens: Map<string, AccessToken>,
  now: number = Date.now(),
): AccessToken | undefined {
  if (typeof authHeader !== 'string') return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authHeader);
  if (!match) return undefined;
  const record = accessTokens.get(match[1]);
  if (!isTokenRecord(record) || record.token !== match[1]) return undefined;
  if (record.expires_at <= now) return undefined;
  return record;
}

export function findRefreshToken(
  token: unknown,
  refreshTokens: Map<string, RefreshToken>,
  now: number = Date.now(),
): RefreshToken | undefined {
  if (typeof token !== 'string' || !token) return undefined;
  const record = refreshTokens.get(token);
  if (!isTokenRecord(record) || record.token !== token) return undefined;
  if (record.expires_at <= now) return undefined;
  return record;
}

export function findClient(clientId: unknown, clients: Map<string, RegisteredClient>): RegisteredClient | undefined {
  if (typeof clientId !== 'string' || !clientId) return undefined;
  const record = clients.get(clientId);
  return isRegisteredClient(record) && record.client_id === clientId ? record : undefined;
}

export function findAuthorizationCode(code: unknown, codes: Map<string, AuthorizationCode>): AuthorizationCode | undefined {
  if (typeof code !== 'string' || !code) return undefined;
  const record = codes.get(code);
  return isAuthorizationCode(record) && record.code === code ? record : undefined;
}

// ---- Redirect URI policy -------------------------------------------------------------------------
//
// The authorization code is delivered by sending the browser to the client's redirect URI, so what
// may be registered decides where a code can go. Accepted:
//   - https:// anything (hosted clients such as claude.ai, vscode.dev)
//   - http:// only to this machine's loopback (native clients listening on a local port)
//   - a short allow-list of private-use schemes that desktop MCP clients register as OS handlers
// Everything else is refused, and script-capable or local-content schemes are refused even if an
// operator adds them to the allow-list.

export const DEFAULT_REDIRECT_SCHEMES = ['vscode', 'vscode-insiders', 'cursor', 'claude'];
const FORBIDDEN_REDIRECT_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'view-source', 'ws', 'wss', 'ftp', 'mailto']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;

// OAUTH_REDIRECT_SCHEMES: comma-separated extra private-use schemes, e.g. "windsurf,myclient".
export function parseRedirectSchemes(extra: string | undefined): string[] {
  const out = new Set(DEFAULT_REDIRECT_SCHEMES);
  for (const raw of (extra || '').split(',')) {
    const scheme = raw.trim().toLowerCase().replace(/:$/, '');
    if (/^[a-z][a-z0-9+.-]*$/.test(scheme) && !FORBIDDEN_REDIRECT_SCHEMES.has(scheme) && scheme !== 'http' && scheme !== 'https') {
      out.add(scheme);
    }
  }
  return [...out];
}

export function isAllowedRedirectUri(uri: unknown, customSchemes: string[] = DEFAULT_REDIRECT_SCHEMES): uri is string {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  if (/[\u0000- \u007f]/.test(uri)) return false; // no whitespace or control characters anywhere
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || uri.includes('#')) return false; // RFC 6749 §3.1.2: no fragment
  if (url.username || url.password) return false;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (FORBIDDEN_REDIRECT_SCHEMES.has(scheme)) return false;
  if (scheme === 'https') return url.hostname.length > 0;
  if (scheme === 'http') return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  return customSchemes.includes(scheme);
}

// Short, human-readable destination for the consent page: the host for web redirects, the scheme
// for app handlers.
export function describeRedirectTarget(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host;
    return `${url.protocol}// (application link)`;
  } catch {
    return 'unknown destination';
  }
}

export interface RegistrationRequest {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
}

export function parseRegistration(body: unknown, customSchemes: string[] = DEFAULT_REDIRECT_SCHEMES): RegistrationRequest | { error: string; error_description: string } {
  const b = isRecord(body) ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { error: 'invalid_redirect_uri', error_description: `redirect_uris must be an array of 1 to ${MAX_REDIRECT_URIS} URIs` };
  }
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri, customSchemes)) {
      return {
        error: 'invalid_redirect_uri',
        error_description: 'Each redirect URI must be https, http on localhost/127.0.0.1, or a supported application scheme, with no fragment',
      };
    }
  }
  // Display only, and self-reported: strip control characters and bound the length.
  const rawName = typeof b.client_name === 'string' ? b.client_name : '';
  const client_name = rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || 'Unnamed Client';
  // RFC 7591: the default is client_secret_basic. A client that wants to be public says 'none'.
  const requested = b.token_endpoint_auth_method;
  if (requested !== undefined && (typeof requested !== 'string' || !TOKEN_ENDPOINT_AUTH_METHODS.includes(requested))) {
    return { error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method must be none, client_secret_basic or client_secret_post' };
  }
  const token_endpoint_auth_method = (requested as TokenEndpointAuthMethod | undefined) ?? 'client_secret_basic';
  return { client_name, redirect_uris: [...new Set(uris as string[])], token_endpoint_auth_method };
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/; // base64url SHA-256 is exactly 43; allow the RFC 7636 range

export interface AuthorizeParams {
  client: RegisteredClient;
  redirect_uri: string;
  code_challenge: string;
}

// Shared by GET /authorize (before showing the page) and POST /authorize (before the password is
// even looked at): the client must be registered, the redirect URI must be one it registered, and
// PKCE with S256 is mandatory.
export function validateAuthorizeParams(
  input: { client_id: unknown; redirect_uri: unknown; code_challenge: unknown; code_challenge_method: unknown },
  clients: Map<string, RegisteredClient>,
): AuthorizeParams | { error: string; error_description: string } {
  const client = findClient(input.client_id, clients);
  if (!client) return { error: 'invalid_client', error_description: 'Unknown client_id' };
  if (typeof input.redirect_uri !== 'string' || !client.redirect_uris.includes(input.redirect_uri)) {
    return { error: 'invalid_request', error_description: 'Invalid redirect_uri' };
  }
  if (input.code_challenge_method !== 'S256') {
    return { error: 'invalid_request', error_description: 'Only S256 code challenge method is supported' };
  }
  if (typeof input.code_challenge !== 'string' || !PKCE_CHALLENGE.test(input.code_challenge)) {
    return { error: 'invalid_request', error_description: 'Missing or malformed code_challenge' };
  }
  return { client, redirect_uri: input.redirect_uri, code_challenge: input.code_challenge };
}

// Decides whether /register accepts a request.
//   open (default): anyone may register (RFC 7591 dynamic registration, which Claude and VS Code
//     rely on and cannot authenticate). A bearer header, if sent, must still be the right secret.
//   required: every registration must carry `Authorization: Bearer <ADMIN_SECRET>`; with no
//     ADMIN_SECRET configured, registration is closed.
export function checkRegistrationAuth(
  authHeader: unknown,
  adminSecret: string,
  required: boolean,
): { ok: true } | { ok: false; status: number; error: string } {
  const match = typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/.exec(authHeader) : null;
  const provided = match ? match[1] : undefined;
  const matches = (): boolean => {
    if (!provided || !adminSecret) return false;
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(adminSecret, 'utf-8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (required) {
    if (!adminSecret) return { ok: false, status: 403, error: 'Client registration is disabled on this server' };
    if (provided === undefined) return { ok: false, status: 401, error: 'Client registration requires the admin secret' };
    return matches() ? { ok: true } : { ok: false, status: 403, error: 'Invalid admin secret' };
  }
  if (provided !== undefined && !matches()) return { ok: false, status: 403, error: 'Invalid admin secret' };
  return { ok: true };
}

export const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- Client authentication at /token -------------------------------------------------------------

// Reads the client's credentials from the request: client_secret_post (body) and/or
// client_secret_basic (Authorization header). If both name a client they must agree.
export function parseClientCredentials(
  body: unknown,
  authHeader: unknown,
): { clientId: string; clientSecret: string | undefined } | { error: string } {
  const b = isRecord(body) ? body : {};
  let clientId = typeof b.client_id === 'string' && b.client_id ? b.client_id : undefined;
  let clientSecret = typeof b.client_secret === 'string' && b.client_secret ? b.client_secret : undefined;
  if (b.client_secret !== undefined && typeof b.client_secret !== 'string') return { error: 'Malformed client_secret' };

  const basic = typeof authHeader === 'string' ? /^Basic ([A-Za-z0-9+/=_-]+)$/.exec(authHeader) : null;
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf-8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return { error: 'Malformed Basic credentials' };
    // RFC 6749 §2.3.1: both parts are form-urlencoded before being base64-encoded.
    const decode = (v: string) => { try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; } };
    const headerId = decode(decoded.slice(0, colon));
    const headerSecret = decode(decoded.slice(colon + 1));
    if (clientId !== undefined && clientId !== headerId) return { error: 'Conflicting client credentials' };
    if (clientSecret !== undefined && headerSecret && clientSecret !== headerSecret) return { error: 'Conflicting client credentials' };
    clientId = headerId;
    if (headerSecret) clientSecret = headerSecret;
  }
  if (!clientId) return { error: 'No client authentication provided' };
  return { clientId, clientSecret };
}

// Whether the presented secret authenticates this client.
//   public client ('none')          no secret exists; PKCE and the refresh token are its credentials.
//   confidential client             the secret is REQUIRED and must match.
//   record without the field        treated as confidential: the secret is required. (RFC 7591's
//                                   default method is client_secret_basic.)
export function authenticateClient(client: RegisteredClient, clientSecret: string | undefined): boolean {
  const matches = (): boolean => {
    if (!clientSecret || !client.client_secret) return false;
    const a = Buffer.from(clientSecret, 'utf-8');
    const b = Buffer.from(client.client_secret, 'utf-8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (client.token_endpoint_auth_method === 'none') return true;
  return matches();
}

// ---- Bounded client registry ---------------------------------------------------------------------

// Registration is open, so the registry must not grow without limit. When it is full, clients that
// hold nothing — no live access or refresh token, no pending authorization code — are dropped to
// make room, in the order that loses least:
//   1. idle clients registered longer ago than graceMs, oldest first;
//   2. only if that frees nothing, idle clients registered within graceMs, oldest first. A client
//      in that window may have a user at the sign-in page, who holds no code yet; it is spared
//      whenever an older idle client can go instead.
// A client in use is never dropped. Only someone who knows PASSWORD can make a client "in use", so
// a flood of throwaway registrations evicts itself and never a client that has signed in. The grace
// window is a preference and not a protection for the same reason: registering needs no password,
// so a hard rule would let a flood of fresh clients block every other registration.
// Returns false when the registry is full of in-use clients and nothing could be freed.
export const CLIENT_GRACE_MS = 10 * 60 * 1000; // matches the default authorization code lifetime

export function makeRoomForClient(
  clients: Map<string, RegisteredClient>,
  maxClients: number,
  inUse: Set<string>,
  now: number = Date.now(),
  graceMs: number = CLIENT_GRACE_MS,
): boolean {
  if (clients.size < maxClients) return true;
  const recent = (c: RegisteredClient) => c.registered_at !== undefined && now - c.registered_at < graceMs;
  for (const spareRecent of [true, false]) {
    for (const [id, client] of clients) { // Map iteration is insertion order: oldest first
      if (clients.size < maxClients) return true;
      if (inUse.has(id) || (spareRecent && recent(client))) continue;
      clients.delete(id);
    }
  }
  return clients.size < maxClients;
}
