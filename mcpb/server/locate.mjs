// Finds the installed Claudally for the extension's launcher (launcher.mjs). Kept apart from the
// launcher so the tests can import these functions without starting a server: the launcher runs
// unconditionally on load, rather than behind an "am I the main module" check that a host
// launching it some other way could defeat, leaving the extension silently doing nothing.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Folder names the installer has used under Program Files. scripts/installer/tally-mcp.iss sets
 * DefaultDirName={autopf}\TallyMCP; "Claudally" is the product name, checked second in case the
 * default folder is ever renamed to match.
 */
export const INSTALL_DIR_NAMES = ['TallyMCP', 'Claudally'];

/** The entry point inside an install, relative to its root. */
export const SERVER_ENTRY = ['dist', 'index.mjs'];

/**
 * Install folders to try, in order. No registry lookup: the user's own choice (the extension's
 * "Claudally install folder" setting, passed as CLAUDALLY_INSTALL_DIR) first, then each Program
 * Files root. A setting left empty can arrive as "" or as the unexpanded "${user_config...}"
 * placeholder; both mean "not set".
 */
export function candidateInstallDirs(env = process.env, p = path) {
  const dirs = [];
  const configured = (env.CLAUDALLY_INSTALL_DIR ?? '').trim();
  if (configured && !configured.startsWith('${')) dirs.push(configured);
  for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (!root) continue;
    for (const name of INSTALL_DIR_NAMES) dirs.push(p.join(root, name));
  }
  return [...new Set(dirs)];
}

/** The first candidate that holds the server, or null. */
export function findInstalledServer(env = process.env, exists = fs.existsSync, p = path) {
  const tried = candidateInstallDirs(env, p);
  for (const dir of tried) {
    const entry = p.join(dir, ...SERVER_ENTRY);
    if (exists(entry)) return { dir, entry, tried };
  }
  return { dir: null, entry: null, tried };
}

export function notInstalledMessage(tried) {
  return [
    '[claudally-extension] Claudally is not installed on this PC, so there is no Tally server to start.',
    'Install Claudally first (Claudally-Setup-<version>.exe from https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases),',
    'then restart Claude Desktop. If Claudally is installed in a different folder, enter that folder as',
    '"Claudally install folder" in this extension\'s settings in Claude Desktop.',
    `Looked for ${SERVER_ENTRY.join(path.sep)} in: ${tried.length ? tried.join('; ') : '(no Program Files folder is known)'}`,
    ''
  ].join('\n');
}

