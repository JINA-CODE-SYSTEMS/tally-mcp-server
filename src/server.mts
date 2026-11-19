import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createHttpApp } from './http-app.mjs';
import { parseIntEnv } from './utility.mjs';

// Load .env from the install directory by ABSOLUTE path (next to dist/), independent of the process
// working directory. mcp.mts already runs dotenv.config() but resolves it against process.cwd();
// under NSSM the service cwd normally equals AppDirectory, but if NSSM's cwd or AppEnvironmentExtra
// handoff is ever wrong (issue #23), a cwd-relative load silently misses PASSWORD and the server
// exits(1) into an NSSM respawn loop with no port bound. Anchoring to __dirname/../.env makes the
// service read exactly the same file the "works when run manually" invocation does. override:true
// mirrors mcp.mts so a mangled NSSM-provided value never wins over the on-disk .env.
dotenv.config({ path: path.join(import.meta.dirname, '../.env'), override: true, quiet: true });

const mcpPort = parseIntEnv(process.env.PORT, 3000);
const mcpDomain = process.env.MCP_DOMAIN || 'http://localhost:3000';
const __dirname = import.meta.dirname;

// Cleanup old rotated log files on startup — keep only the 10 most recent
try {
  const logsDir = path.join(__dirname, '../logs');
  if (fs.existsSync(logsDir)) {
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => /^service-\d{8}T\d{6}\.\d+\.log$/.test(f))
      .sort()
      .reverse();
    const maxKeep = parseIntEnv(process.env.LOG_RETAIN_COUNT, 10);
    for (const f of logFiles.slice(maxKeep)) {
      fs.unlinkSync(path.join(logsDir, f));
    }
    if (logFiles.length > maxKeep) {
      console.log(`[startup] Cleaned up ${logFiles.length - maxKeep} old log files`);
    }
  }
} catch {}

// Require PASSWORD env var — fail startup if missing. Name the .env path we loaded so a service
// that respawns here (issue #23) leaves an actionable line in logs/service.log instead of a silent
// exit that reads as "Running but no port bound".
if (!process.env.PASSWORD) {
  const envPath = path.join(import.meta.dirname, '../.env');
  console.error(`[security] FATAL: PASSWORD is not set. Expected it in ${envPath} (or the service environment). ` +
    `The server cannot start without it. If running as the TallyMCP service, re-run the setup wizard to rewrite .env.`);
  process.exit(1);
}
const authPassword = process.env.PASSWORD;

// The Express app (MCP transport + OAuth endpoints) lives in http-app.mts.
const { app } = createHttpApp({
  password: authPassword,
  adminSecret: process.env.ADMIN_SECRET || '',
  mcpDomain,
  stateDir: path.join(__dirname, '..'),
  corsOrigins: process.env.CORS_ORIGINS,
  requireAdminSecretForRegistration: /^(1|true)$/i.test((process.env.REQUIRE_ADMIN_SECRET_FOR_REGISTRATION || '').trim()),
  redirectSchemes: process.env.OAUTH_REDIRECT_SCHEMES,
  trustProxy: process.env.TRUST_PROXY,
  authBackoff: {
    freeAttempts: parseIntEnv(process.env.AUTH_BACKOFF_FREE_ATTEMPTS, 5),
    baseMs: parseIntEnv(process.env.AUTH_BACKOFF_BASE_MS, 1000),
    maxMs: parseIntEnv(process.env.AUTH_BACKOFF_MAX_MS, 60000),
  },
});

// Bind to 127.0.0.1 — use reverse proxy for external access
const bindHost = process.env.BIND_HOST || '127.0.0.1';
const httpServer = app.listen(mcpPort, bindHost, () => {
  // Required attribution under AGPL-3.0 § 7(b) (see NOTICE file). Forks must keep this banner;
  // see scripts/check-attribution.* for the regression check.
  console.log('Claudally (Tally Prime MCP Server)  -  A Jina Code Systems LLP project');
  console.log('Copyright (c) 2026 Jina Code Systems LLP. Licensed under AGPL-3.0-or-later.');
  console.log(`MCP Server started on ${bindHost}:${mcpPort}`);
});

// Make a bind failure loud in logs/service.log instead of an unhandled exception. Under NSSM the
// classic symptom (issue #23) is "service Running, port empty" — often a stale node.exe still
// holding the port after a hung stop. Name the cause so the log is actionable.
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  const detail = err.code === 'EADDRINUSE'
    ? `${bindHost}:${mcpPort} is already in use — a stale node.exe is likely still holding the port. Stop it (taskkill /F /IM node.exe) and restart the service.`
    : `${err.code || ''} ${err.message}`.trim();
  console.error(`[startup] FATAL: could not bind ${bindHost}:${mcpPort} — ${detail}`);
  process.exit(1);
});

// Graceful shutdown — without this, NSSM/systemd hang in StopPending until force-killed.
// On Windows, NSSM stops the service by sending a console Ctrl-C (delivered to Node as SIGINT) and
// can escalate to Ctrl-Break (SIGBREAK); SIGTERM is not a real Windows signal but is handled for
// systemd parity. MCP streamable-HTTP connections are long-lived, so httpServer.close() alone can
// wait indefinitely for them to drain — closeAllConnections() drops them immediately so close()
// resolves in well under a second, and a bounded force-exit guarantees Stop-Service returns even if
// something wedges. Re-entrancy guard: NSSM may deliver more than one stop signal.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal}, closing server`);
  const force = setTimeout(() => { console.error('[shutdown] forced exit after 5s'); process.exit(0); }, 5000);
  force.unref();
  httpServer.close(() => { clearTimeout(force); process.exit(0); });
  // Drop keep-alive / long-lived MCP connections so the close() callback can fire promptly.
  httpServer.closeAllConnections?.();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
