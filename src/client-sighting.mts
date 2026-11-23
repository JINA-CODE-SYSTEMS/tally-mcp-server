// Proof that an app actually started this server, not just that its config file names us.
//
// Writing an entry into a client's config only says where we PUT it. Whether the app READS that
// file is outside our control: the packaged (MSIX) Windows build of Claude Desktop, for one, reads
// a private copy of %APPDATA% and never saw the file the installer wrote, while the installer
// reported "connected". The only reliable signal is the app launching us and completing the MCP
// handshake, so that is what gets recorded here: one small file per client name, rewritten on
// every start. The tray compares it with when the app itself started; an app that has been running
// for a while without a sighting is reading its settings from somewhere we do not know about.
//
// Local and best-effort by design: nothing leaves the machine, no tool output depends on it, and a
// failure to write is swallowed. Stdout is never touched (under stdio it is the JSON-RPC channel).

import fs from 'node:fs';
import path from 'node:path';

export interface Sighting {
  schemaVersion: 1;
  client: string;
  clientVersion: string;
  seenAt: string;
  pid: number;
  ppid: number;
}

/** File-name-safe form of a client name. Empty or odd names collapse to "unknown". */
export function sightingSlug(clientName: string | undefined): string {
  const slug = (clientName ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return slug || 'unknown';
}

/**
 * Where sightings go, or undefined where there is no per-user local app-data folder (not Windows).
 * Under a packaged client Windows may redirect this write into that package's private
 * LocalCache\Local; the tray looks in both places, and which one it lands in is itself diagnostic.
 */
export function sightingDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const local = env.LOCALAPPDATA;
  return local ? path.join(local, 'Claudally', 'clients') : undefined;
}

export function buildSighting(client: { name?: string; version?: string } | undefined, now: Date = new Date()): Sighting {
  return {
    schemaVersion: 1,
    client: client?.name ?? 'unknown',
    clientVersion: client?.version ?? '',
    seenAt: now.toISOString(),
    pid: process.pid,
    ppid: process.ppid,
  };
}

/** Records the sighting. Returns the file written, or undefined when it was skipped or failed. */
export function recordSighting(
  client: { name?: string; version?: string } | undefined,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}
): string | undefined {
  try {
    if ((opts.env ?? process.env).CLAUDALLY_NO_SIGHTING === '1') return undefined;
    const dir = sightingDir(opts.env);
    if (!dir) return undefined;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sightingSlug(client?.name)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(buildSighting(client, opts.now), null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return undefined;
  }
}
