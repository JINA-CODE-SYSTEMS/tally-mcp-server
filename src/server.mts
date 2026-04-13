import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerMcpServer } from './mcp.mjs';


const mcpPort = parseInt(process.env.PORT || '3000');
const mcpDomain = process.env.MCP_DOMAIN || 'http://localhost:3000';
const __dirname = import.meta.dirname;

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
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : [mcpDomain];
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
  windowMs: 60 * 1000,   // 1 minute
  max: 10,                // 10 attempts per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' }
});

// Require PASSWORD env var — fail startup if missing
if (!process.env.PASSWORD) {
  console.error('[security] FATAL: PASSWORD environment variable is required. Set it in .env or system environment.');
  process.exit(1);
}
const authPassword = process.env.PASSWORD;

// Optional ADMIN_SECRET — if set, can be used to validate manual client registration
const adminSecret = process.env.ADMIN_SECRET || '';

// Constant-time string comparison to prevent timing attacks
const safeCompare = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

interface RegisteredClient {
  client_id: string;
  client_name: string;
  client_secret: string;
  redirect_uris: string[];
}

interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

interface AccessToken {
  token: string;
  client_id: string;
  expires_at: number;
}

const clientsFilePath = path.join(__dirname, '../.oauth-clients.json');

// Load persisted clients from file
function loadClients(): { [client_id: string]: RegisteredClient } {
  try {
    if (fs.existsSync(clientsFilePath)) {
      return JSON.parse(fs.readFileSync(clientsFilePath, 'utf-8'));
    }
  } catch (e) {
    console.error('[oauth] Failed to load clients file:', e);
  }
  return {};
}

// Save clients to file
function saveClients(): void {
  try {
    fs.writeFileSync(clientsFilePath, JSON.stringify(registeredClients, null, 2), 'utf-8');
  } catch (e) {
    console.error('[oauth] Failed to save clients file:', e);
  }
}

const registeredClients: { [client_id: string]: RegisteredClient } = loadClients();
console.log(`[oauth] Loaded ${Object.keys(registeredClients).length} persisted client(s)`);
const authorizationCodes: { [code: string]: AuthorizationCode } = {};
const accessTokens: { [token: string]: AccessToken } = {};

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

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
setInterval(() => {
  const now = Date.now();

  // Clean expired auth codes
  for (const [code, data] of Object.entries(authorizationCodes)) {
    if (data.expires_at < now) {
      delete authorizationCodes[code];
    }
  }

  // Clean expired access tokens
  for (const [token, data] of Object.entries(accessTokens)) {
    if (data.expires_at < now) {
      delete accessTokens[token];
    }
  }

}, 60000); // Run every minute


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

  // Check for authentication header Bearer
  const authHeader = req.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    handleUnauthorized()
    return;
  }

  // Extract and validate token
  const token = authHeader.split(' ')[1];
  const tokenData = accessTokens[token];

  if (!tokenData || tokenData.expires_at < Date.now()) {
    handleUnauthorized();
    return;
  }


  // Check for existing session ID
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport
    transport = transports[sessionId];
  }
  else if (!sessionId && isInitializeRequest(req.body)) {
    // New initialization request
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Store the transport by session ID
        transports[sessionId] = transport;
      },
      // DNS rebinding protection — allow the configured domain hostname
      enableDnsRebindingProtection: true,
      allowedHosts: [new URL(mcpDomain).hostname],
    });

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
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
  const authHeader = req.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No valid authentication token provided' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const tokenData = accessTokens[token];
  if (!tokenData || tokenData.expires_at < Date.now()) {
    res.status(401).json({ error: 'Unauthorized: Token expired or invalid' });
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  const transport = transports[sessionId];
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
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256']
    }
  );
}

// Handle OAuth Authorization Server
app.get('/.well-known/oauth-authorization-server', handleOAuthAuthorizationServer);


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

  registeredClients[clientId] = {
    client_id: clientId,
    client_name: clientName,
    client_secret: clientSecret,
    redirect_uris: redirectUris
  };
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
    
    authorizationCodes[code] = {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      expires_at: Date.now() + 600000 // 10 minutes
    };
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
  const client = registeredClients[clientId];
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

  res.status(200).header('Content-Type', 'text/html').sendFile(path.join(__dirname, '../authorize.html'));
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
  const registeredClient = registeredClients[clientId];
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

  // Validate grant type
  if (grantType !== 'authorization_code') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant type is supported'
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
  const authCode = authorizationCodes[code];
  if (!authCode) {
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code'
    });
  }

  // Check expiration
  if (authCode.expires_at < Date.now()) {
    delete authorizationCodes[code];
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
  delete authorizationCodes[code];

  // Generate access token and separate refresh token
  const accessToken = generateSecureToken(32);
  const expiresIn = 3600; // 1 hour

  accessTokens[accessToken] = {
    token: accessToken,
    client_id: clientId,
    expires_at: Date.now() + (expiresIn * 1000)
  };

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn
  });
});

// Bind to 127.0.0.1 — use reverse proxy for external access
const bindHost = process.env.BIND_HOST || '127.0.0.1';
app.listen(mcpPort, bindHost, () => console.log(`MCP Server started on ${bindHost}:${mcpPort}`));