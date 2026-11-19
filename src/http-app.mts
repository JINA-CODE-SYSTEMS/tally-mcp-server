import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { registerMcpServer, getHttpStatusReport, isStatusEndpointEnabled } from './mcp.mjs';
import { parseIntEnv } from './utility.mjs';
import * as store from './oauth-store.mjs';

// The Express application for remote (HTTP) mode: MCP transport + the OAuth endpoints in front of it.
// Building it is free of process-level side effects (no dotenv, no listen, no exit) so it can be
// constructed in tests; src/server.mts owns startup, binding and shutdown.

export interface HttpAppOptions {
  /** OAuth password a human types on the authorize page. Required. */
  password: string;
  /** Optional ADMIN_SECRET. */
  adminSecret?: string;
  /** Public base URL of this server (MCP_DOMAIN). */
  mcpDomain: string;
  /** Directory holding .oauth-clients.json / .oauth-tokens.json and authorize.html. */
  stateDir: string;
  /** Comma-separated CORS allow-list (CORS_ORIGINS); defaults to mcpDomain. */
  corsOrigins?: string;
}

export interface HttpApp {
  app: express.Express;
  /** Stops the periodic cleanup timer and closes any open MCP transports. */
  close: () => void;
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
const mcpDomain = options.mcpDomain;
const __dirname = options.stateDir;
const app = express();
app.set('trust proxy', 1); // Trust first proxy (nginx/caddy)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers — allow inline scripts for authorize.html
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  }
}));

// CORS — restrict to allowed origins
const allowedOrigins = options.corsOrigins ? options.corsOrigins.split(',').map(o => o.trim()) : [mcpDomain];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, MCP clients)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: Origin not allowed'));
    }
  },
  credentials: true
}));

// Rate limiting on auth endpoints
const authRateLimiter = rateLimit({
  windowMs: parseIntEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60000),
  max: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX, 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' }
});

const authPassword = options.password;

// Optional ADMIN_SECRET — if set, can be used to validate manual client registration
const adminSecret = options.adminSecret || '';

// Constant-time string comparison to prevent timing attacks
const safeCompare = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const clientsFilePath = path.join(__dirname, '.oauth-clients.json');
// Bearer + refresh secrets are persisted so a server restart / redeploy doesn't drop live sessions
// (which would force every connected client to re-authenticate). Same directory + trust level as
// .oauth-clients.json, which already persists client secrets.
const tokensFilePath = path.join(__dirname, '.oauth-tokens.json');

const registeredClients = store.loadClients(clientsFilePath);
console.log(`[oauth] Loaded ${registeredClients.size} persisted client(s)`);
const saveClients = () => store.saveClients(clientsFilePath, registeredClients);
const authorizationCodes = new Map<string, store.AuthorizationCode>();

// Persisted token store: access + refresh tokens survive a restart so existing sessions stay valid.
const { accessTokens, refreshTokens } = store.loadTokens(tokensFilePath);
const saveTokens = () => store.saveTokens(tokensFilePath, { accessTokens, refreshTokens });
console.log(`[oauth] Loaded ${accessTokens.size} access + ${refreshTokens.size} refresh token(s)`);

const transports = new Map<string, StreamableHTTPServerTransport>();

// Helper function to generate secure tokens
const generateSecureToken = (bytes: number = 32): string => {
  return crypto.randomBytes(bytes).toString('base64url');
};

// Helper function to verify PKCE
const verifyPKCE = (verifier: string, challenge: string, method: string): boolean => {
  if (method !== 'S256') return false;

  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
};

// Cleanup expired items periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();

  // Clean expired auth codes
  for (const [code, data] of authorizationCodes) {
    if (data.expires_at < now) {
      authorizationCodes.delete(code);
    }
  }

  // Clean expired access + refresh tokens, persisting the store if anything changed.
  let tokensChanged = false;
  for (const [token, data] of accessTokens) {
    if (data.expires_at < now) { accessTokens.delete(token); tokensChanged = true; }
  }
  for (const [token, data] of refreshTokens) {
    if (data.expires_at < now) { refreshTokens.delete(token); tokensChanged = true; }
  }
  if (tokensChanged) saveTokens();

}, parseIntEnv(process.env.TOKEN_CLEANUP_INTERVAL_MS, 60000)); // default every minute
cleanupTimer.unref(); // housekeeping only — the listening socket is what keeps the process alive

// Every MCP route authenticates through this one function, so the three verbs cannot drift apart.
const authenticate = (req: express.Request): store.AccessToken | undefined =>
  store.validateBearerToken(req.headers['authorization'], accessTokens);


// Handle POST requests for client-to-server communication
const handleMcpRequest = async (req: express.Request, res: express.Response) => {
  const handleUnauthorized = () => {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized: No valid authentication token provided',
      },
      id: null,
    });
  };

  if (!authenticate(req)) {
    handleUnauthorized();
    return;
  }

  // Check for existing session ID
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const existingTransport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
  let transport: StreamableHTTPServerTransport;

  if (existingTransport) {
    // Reuse existing transport
    transport = existingTransport;
  }
  else if (!sessionId && isInitializeRequest(req.body)) {
    // New initialization request
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Store the transport by session ID
        transports.set(sessionId, transport);
      },
      // DNS rebinding protection — allow the configured domain host (hostname + port).
      // The SDK compares against the raw Host header, which always includes the port for
      // non-default ports, so `.hostname` ('localhost') would never match 'localhost:3000'.
      enableDnsRebindingProtection: true,
      allowedHosts: [new URL(mcpDomain).host],
    });

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const mcpServer = await registerMcpServer(); // Register the MCP server
    await mcpServer.connect(transport); // Connect the MCP server to the transport

  }
  else {
    // Invalid request
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
    return;
  }

  // Handle the request
  await transport.handleRequest(req, res, req.body);
}

app.post('/mcp', handleMcpRequest);

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  // Validate bearer token (same as POST /mcp)
  if (!authenticate(req)) {
    res.status(401).json({ error: 'Unauthorized: No valid authentication token provided' });
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);

// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest);

const handleOAuthProtectedResource = (req: express.Request, res: express.Response) => {
  res.status(200).json({
    resource: `${mcpDomain}/mcp`,
    authorization_servers: [`${mcpDomain}`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['email']
  });
}

app.get('/.well-known/oauth-protected-resource', handleOAuthProtectedResource);
app.get('/.well-known/oauth-protected-resource/mcp', handleOAuthProtectedResource);

const handleOAuthAuthorizationServer = (req: express.Request, res: express.Response) => {
  res.status(200).json(
    {
      issuer: mcpDomain,
      authorization_endpoint: `${mcpDomain}/authorize`,
      token_endpoint: `${mcpDomain}/token`,
      registration_endpoint: `${mcpDomain}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256']
    }
  );
}

// Handle OAuth Authorization Server
app.get('/.well-known/oauth-authorization-server', handleOAuthAuthorizationServer);

// Opt-in, unauthenticated health endpoint for uptime monitors / support tooling
// (#25). Disabled by default; set STATUS_ENDPOINT_PUBLIC=1 to expose it. Returns
// the server's self-report (agent ping, Tally reachability, edition, build).
// 200 when healthy, 503 when Tally is unreachable so monitors read green/red.
app.get('/status', async (_req: express.Request, res: express.Response) => {
  if (!isStatusEndpointEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const report = await getHttpStatusReport();
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});


app.post('/register', authRateLimiter, (req, res) => {
  // Admin secret is optional — VS Code dynamic client registration (RFC 7591) sends no auth.
  // Rate limiting protects against abuse. Real security gate is PASSWORD on /authorize.
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const providedSecret = authHeader.split(' ')[1];
    if (!safeCompare(providedSecret, adminSecret)) {
      return res.status(403).json({ error: 'Invalid admin secret' });
    }
  }

  const clientId = generateSecureToken(16);
  const clientSecret = generateSecureToken(32);
  const clientName = req.body['client_name'] || 'Unnamed Client';
  const redirectUris = req.body['redirect_uris'] || [];

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return res.status(400).json({ error: 'redirect_uris must be a non-empty array' });
  }

  registeredClients.set(clientId, {
    client_id: clientId,
    client_name: clientName,
    client_secret: clientSecret,
    redirect_uris: redirectUris
  });
  saveClients();

  console.log(`[register] New client registered: ${clientId} (${clientName})`);
  res.status(200).json({
    client_id: clientId,
    client_name: clientName,
    client_secret: clientSecret,
    redirect_uris: redirectUris
  });
});

app.post('/authorize', authRateLimiter, (req, res) => {
  const clientId = req.body['client_id'];
  const redirectUri = req.body['redirect_uri'];
  const codeChallenge = req.body['code_challenge'];
  const codeChallengeMethod = req.body['code_challenge_method'];
  const password = req.body['password'];

  if (!clientId || !password) {
    console.log(`[authorize] Missing client_id or password. client_id=${clientId ? 'present' : 'missing'}, password=${password ? 'present' : 'missing'}`);
    return res.status(400).json({ error: 'Missing client_id or password' });
  }

  // Validate client credentials
  let isValidated = safeCompare(password, authPassword);
  console.log(`[authorize] client_id=${clientId}, password_match=${isValidated}`);

  if (isValidated) {
    // Generate authorization code
    const code = generateSecureToken(32);
    
    authorizationCodes.set(code, {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      expires_at: Date.now() + parseIntEnv(process.env.AUTH_CODE_EXPIRY_MS, 600000) // default 10 minutes
    });
    res.status(200).json({ status: isValidated, code });
    
  }
  else {
    res.status(401).json({ status: isValidated, code: undefined });
  }

});

app.get('/authorize', async (req, res) => {
  const clientId = req.query.client_id as string;
  const redirectUri = req.query.redirect_uri as string;
  const codeChallenge = req.query.code_challenge as string;
  const codeChallengeMethod = req.query.code_challenge_method as string;
  const responseType = req.query.response_type as string;
  const state = req.query.state as string;

  // Validate required parameters
  if (!clientId || !redirectUri || !codeChallenge || !responseType || !state) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters'
    });
  }

  if (responseType !== 'code') {
    return res.status(400).json({
      error: 'unsupported_response_type',
      error_description: 'Only "code" response type is supported'
    });
  }

  if (codeChallengeMethod !== 'S256') {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Only S256 code challenge method is supported'
    });
  }

  // Validate client
  const client = store.findClient(clientId, registeredClients);
  console.log(`[authorize GET] client_id=${clientId}, found=${!!client}`);
  if (!client) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown client_id'
    });
  }

  // Validate redirect URI
  if (!client.redirect_uris.includes(redirectUri)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri'
    });
  }

  res.status(200).header('Content-Type', 'text/html').sendFile(path.join(__dirname, 'authorize.html'));
});

app.post('/token', authRateLimiter, (req, res) => {

  const grantType = req.body['grant_type'];
  const code = req.body['code'];
  const redirectUri = req.body['redirect_uri'];
  let clientId = req.body['client_id'];
  let clientSecret_provided: string | undefined = req.body['client_secret'];
  const codeVerifier = req.body['code_verifier'];

  if(!clientId) {
    //check for client authentication in Authorization header
    const authHeader = req.headers['authorization'] as string | undefined;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'No client authentication provided'
      });
    }
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [authClientId, authClientSecret] = credentials.split(':');
    clientId = authClientId;
    clientSecret_provided = authClientSecret;
  }

  // Verify client_secret
  const registeredClient = store.findClient(clientId, registeredClients);
  if (!registeredClient) {
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Unknown client'
    });
  }
  if (clientSecret_provided && !safeCompare(clientSecret_provided, registeredClient.client_secret)) {
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Invalid client secret'
    });
  }

  // Refresh-token grant: mint a fresh access token from a valid, unexpired refresh token so the
  // client renews silently without re-auth. Rotates the refresh token (one-time use) for security.
  if (grantType === 'refresh_token') {
    const providedRefresh = req.body['refresh_token'];
    const stored = store.findRefreshToken(providedRefresh, refreshTokens);
    if (!stored || stored.client_id !== clientId) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired refresh token'
      });
    }
    refreshTokens.delete(stored.token); // rotate
    const newAccess = generateSecureToken(32);
    const newRefresh = generateSecureToken(32);
    const expiresIn = parseIntEnv(process.env.ACCESS_TOKEN_EXPIRY_SEC, 3600);
    const refreshExpiresIn = parseIntEnv(process.env.REFRESH_TOKEN_EXPIRY_SEC, 2592000); // default 30 days
    accessTokens.set(newAccess, { token: newAccess, client_id: clientId, expires_at: Date.now() + expiresIn * 1000 });
    refreshTokens.set(newRefresh, { token: newRefresh, client_id: clientId, expires_at: Date.now() + refreshExpiresIn * 1000 });
    saveTokens();
    return res.json({
      access_token: newAccess,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefresh
    });
  }

  // Validate grant type
  if (grantType !== 'authorization_code') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Supported grant types: authorization_code, refresh_token'
    });
  }

  // Validate required parameters
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Missing required parameters'
    });
  }

  // Validate authorization code
  const authCode = store.findAuthorizationCode(code, authorizationCodes);
  if (!authCode) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code'
    });
  }

  // Check expiration
  if (authCode.expires_at < Date.now()) {
    authorizationCodes.delete(authCode.code);
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code expired'
    });
  }

  // Validate client and redirect URI match
  if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code mismatch'
    });
  }

  // Verify PKCE
  if (!verifyPKCE(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid code verifier'
    });
  }

  // Delete the used authorization code
  authorizationCodes.delete(authCode.code);

  // Generate an access token + a long-lived refresh token so the client can renew silently, and
  // persist both so a server restart / redeploy doesn't drop the session.
  const accessToken = generateSecureToken(32);
  const refreshToken = generateSecureToken(32);
  const expiresIn = parseIntEnv(process.env.ACCESS_TOKEN_EXPIRY_SEC, 3600); // default 1 hour
  const refreshExpiresIn = parseIntEnv(process.env.REFRESH_TOKEN_EXPIRY_SEC, 2592000); // default 30 days

  accessTokens.set(accessToken, {
    token: accessToken,
    client_id: clientId,
    expires_at: Date.now() + (expiresIn * 1000)
  });
  refreshTokens.set(refreshToken, {
    token: refreshToken,
    client_id: clientId,
    expires_at: Date.now() + (refreshExpiresIn * 1000)
  });
  saveTokens();

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken
  });
});
const close = () => {
  clearInterval(cleanupTimer);
  for (const transport of transports.values()) {
    try { void transport.close(); } catch {}
  }
};

return { app, close };
}
