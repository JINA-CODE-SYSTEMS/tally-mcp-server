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
}

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
    && typeof v.client_secret === 'string' && v.client_secret.length > 0
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
