import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Under stdio, stdout IS the protocol channel: anything written there that is not a JSON-RPC frame
// corrupts the session. So every diagnostic on this path goes to stderr, which MCP clients capture
// into their own logs.
//
// This block is deliberately ABOVE the ./mcp.mjs import, and that import is dynamic. A static import
// is hoisted and its whole module graph is evaluated before any statement here runs — so handlers
// registered further down could never have caught the very failures worth reporting: a missing
// pull/config.json (read at tally.mts module load), a DuckDB native module that will not load, or an
// unreadable .env. Those all happen during graph evaluation. Local mode is the default deployment
// after #172, so this is the path most people hit when something is wrong, and "server disconnected"
// with nothing else anywhere is the worst possible answer.
function fail(stage: string, err: unknown): never {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[tally-mcp] failed during ${stage}: ${detail}\n`);
  process.exit(1);
}

process.on('uncaughtException', err => fail('run', err));
process.on('unhandledRejection', err => fail('run', err));

const { registerMcpServer, setGuiTransportMode } = await import('./mcp.mjs')
  .catch(err => fail('module load', err));

// Local (same-machine) deployment. The MCP client spawns this process, so it already runs in the
// user's interactive session where Tally is visible — Session 0 isolation, the only reason the
// file-IPC companion agent exists, does not apply here. Drive the GUI directly instead: no
// scheduled task to keep alive, no polling latency, and no decrypted password written to disk.
// GUI_TRANSPORT=ipc overrides this for anyone deliberately running the companion agent.
setGuiTransportMode('in-session');

const mcpServer = await registerMcpServer().catch(err => fail('startup', err));

try {
  const transport = new StdioServerTransport(); // receives on stdin, sends on stdout
  await mcpServer.connect(transport);
} catch (err) {
  fail('transport connect', err);
}
