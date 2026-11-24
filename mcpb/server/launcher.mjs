// Claude Desktop extension (.mcpb) entry point: a THIN LAUNCHER for the Claudally already
// installed on this PC (#40).
//
// WHY A LAUNCHER AND NOT A BUNDLED COPY. The MCP Bundle format runs an entry point INSIDE the
// bundle (manifest.json: server.entry_point, launched as `node ${__dirname}/server/launcher.mjs`),
// so the server itself could have been zipped in. It is not, because the server is not
// self-contained: it needs the install's .env (Tally host and port, mode, company settings), the
// DPAPI password vault, the GUI agent scripts, the pull/push XML templates and a native DuckDB
// module, all of which the installer lays down and keeps up to date. A bundled copy would be a
// second, separately-updated server with none of that. This file instead finds the installed
// server and runs it, which keeps the bundle a few kilobytes and, unlike the config-file route
// (src/client-config.mts), independent of where Claude Desktop keeps its config file, a location
// that has moved more than once on Windows.
//
// IN-PROCESS, NOT A CHILD. The installed dist/index.mjs is import()ed into this same process, so
// stdin/stdout stay the process Claude Desktop started and there is no second process to forward
// the protocol through or to orphan. dist/index.mjs resolves its .env, templates and node_modules
// from its own location (import.meta.dirname), not from the working directory, so running it from
// here behaves exactly like running it from the install.
//
// One consequence for upgrades: this process holds the install's native DuckDB module (duckdb.dll
// and its .node addon) loaded, yet neither its executable (Claude Desktop's Node.js) nor its
// command line (this file, in Claude Desktop's extensions folder) names the install. The installer
// therefore finds it by its loaded modules (scripts/installer/stop-install-processes.ps1), not by
// path, and stops it before replacing those files. Claude Desktop must then be restarted to start
// the new version, exactly as with the config-file route.
//
// stdout is the MCP protocol channel. Every diagnostic here goes to stderr, which Claude Desktop
// keeps in its MCP log for this extension.

import { pathToFileURL } from 'node:url';
import { findInstalledServer, notInstalledMessage } from './locate.mjs';

async function main() {
  const found = findInstalledServer(process.env);
  if (!found.entry) {
    process.stderr.write(notInstalledMessage(found.tried));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`[claudally-extension] starting ${found.entry}\n`);
  await import(pathToFileURL(found.entry).href);
}

main().catch(err => {
  process.stderr.write(`[claudally-extension] could not start the installed server: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
