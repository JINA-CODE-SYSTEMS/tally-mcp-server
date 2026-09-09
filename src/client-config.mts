// Client-config merge engine — writes our MCP server entry into the *client's* config file.
//
// #172 makes local (stdio) the default deployment, and local mode's whole job is that the user
// never hand-pastes JSON: today docs/README.md:188-216 asks them to paste an mcpServers block into
// claude_desktop_config.json or .vscode/mcp.json by hand, and nothing in this repo has ever written
// those files. #178 reuses this same module from its remote connector, which is why the pure core
// below is content-string in / content-string out and knows nothing about installers.
//
// WHY TypeScript and not a PowerShell step in the installer (this was considered and rejected):
//   - #178's bridge runs on a remote machine with no installer, possibly not Windows at all;
//   - PS 5.1's ConvertFrom-Json cannot parse the JSONC (line and block comments) that VS Code
//     legitimately writes into .vscode/mcp.json, and dies on the whole file;
//   - Set-Content/Out-File under 5.1 emit a UTF-8 BOM, which Electron's JSON.parse throws on, so a
//     "successful" install would leave Claude Desktop unable to read its own config;
//   - ConvertTo-Json defaults to -Depth 2 and silently truncates deeper structure to the literal
//     string "System.Collections.Hashtable" — an mcpServers entry is 3 deep (root, mcpServers,
//     name, args), so the merge would corrupt every sibling server the user already had.
// Every one of those failure modes destroys a user file we do not own, so the engine lives here.
//
// DESIGN — pure core, thin CLI. Everything above the "File IO" banner takes strings and returns
// strings, so the tests exercise merge/idempotency/hijack/refusal without touching a disk; the CLI
// at the bottom is the only part that reads, backs up and writes.
//
// WHAT WE PRESERVE — the merge is two levels deep, not one. Sibling top-level keys and sibling
// SERVERS survive, and so do keys the user added inside OUR OWN entry (`env` pointing at a Tally on
// another machine, VS Code's `envFile`, a client's `disabled: true`). Only the keys we actually
// write — command/args/type — are ours to replace. See mergeEntry.
//
// WHAT WE REPAIR — exactly one thing: a leading UTF-8 BOM. It is not cosmetic (Electron's
// JSON.parse throws on it), so a BOM'd file counts as "not what we would write" even when its JSON
// is already perfect; otherwise we would report success on a config the client cannot load.
//
// COMMENTS IN JSONC (.vscode/mcp.json) — deliberate, documented limitation. We parse comments fine,
// but we cannot round-trip them: the merge goes through JSON.parse/JSON.stringify, so a rewrite
// would delete every comment in the user's file. Silently eating a user's comments is a defect, so
// instead a file that HAS comments and NEEDS a change is refused, with the reason reported in
// `note`, and the caller must opt in explicitly (CLI: --allow-comment-loss) to accept the loss —
// which is then reported back as `commentsDropped`. A commented file that needs no change is never
// touched at all, so the common re-run case keeps them.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Minimal path interface so path handling can be unit-tested under both win32 and posix semantics
// on whatever OS CI happens to run. Mirrors the PathLike in mcp.mts:420 (kept local rather than
// imported — see the atomicWriteFile note below for why this module must not import mcp.mjs).
export type PathLike = { join: (...s: string[]) => string; resolve: (...s: string[]) => string; sep: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// JSONC-tolerant parsing
// ---------------------------------------------------------------------------

/**
 * Blanks out line and block comments so JSON.parse can read VS Code's JSONC. Comment bytes are
 * replaced with spaces (newlines preserved) rather than removed, so byte offsets — and therefore
 * the "position N" in any JSON.parse error we surface to the user — still point at the right place
 * in their original file. String literals are tracked so a URL like "https://x/y" inside a value is
 * not mistaken for a line comment.
 */
export function stripJsonComments(text: string): { text: string; hadComments: boolean } {
  let out = '';
  let hadComments = false;
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; } // escape: copy the pair verbatim
      if (c === '"') inString = false;
      out += c; i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      hadComments = true;
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      hadComments = true;
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2; // unterminated block: the rest of the file is comment
      for (; i < stop; i++) out += (text[i] === '\n' ? '\n' : ' ');
      continue;
    }
    out += c; i++;
  }
  return { text: out, hadComments };
}

/**
 * Blanks trailing commas before } or ], which JSONC allows and JSON.parse rejects. Run AFTER
 * stripJsonComments so a comment sitting between the comma and the brace (legal, and VS Code's own
 * "add a server here" scaffolding does exactly that) is already whitespace by the time we look.
 */
export function stripTrailingCommas(text: string): string {
  const chars = text.split(''); // UTF-16 units, so indices line up with the source string
  let inString = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c !== ',') continue;
    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j++;
    if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
  }
  return chars.join('');
}

/** Formatting of the file we read, so a rewrite looks like the user's file and not like ours. */
export interface FileFormat {
  indent: string;
  eol: '\n' | '\r\n';
  hadBom: boolean;
  hadComments: boolean;
}

export const DEFAULT_FORMAT: FileFormat = { indent: '  ', eol: '\n', hadBom: false, hadComments: false };

// First indented key wins. In a well-formed config that is a top-level key, so this reproduces the
// user's indent unit (VS Code writes 4 spaces or a tab as often as 2).
function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : DEFAULT_FORMAT.indent;
}

export type ParseResult =
  | { ok: true; data: Record<string, unknown>; format: FileFormat }
  | { ok: false; reason: string };

/**
 * Parses a client config. BOM-safe (Notepad, PS 5.1 and VS Code all produce BOMs), JSONC-tolerant.
 *
 * REFUSES rather than repairs: a file we cannot parse is a file we must not write, because the only
 * "fix" available to us is replacing content the user cannot get back. An empty (or BOM/whitespace-
 * only) file is NOT garbage — clients create the file before writing it — so it parses as {}.
 */
export function parseClientConfig(raw: string): ParseResult {
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const withoutBom = hadBom ? raw.slice(1) : raw;
  const stripped = stripJsonComments(withoutBom);
  const format: FileFormat = {
    indent: detectIndent(withoutBom),
    eol: withoutBom.includes('\r\n') ? '\r\n' : '\n',
    hadBom,
    hadComments: stripped.hadComments
  };
  const body = stripTrailingCommas(stripped.text);
  if (body.trim() === '') return { ok: true, data: {}, format };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { ok: false, reason: `not valid JSON/JSONC: ${e instanceof Error ? e.message : String(e)}` };
  }
  // A top-level array/string/number/null is not something we can merge into, and replacing it would
  // destroy whatever it was. Same refusal path as unparseable.
  if (!isPlainObject(parsed)) {
    const kind = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : `a ${typeof parsed}`;
    return { ok: false, reason: `top-level value is ${kind}, expected a JSON object` };
  }
  return { ok: true, data: parsed, format };
}

/**
 * Serializes back out. Emits NO BOM even when the file we read had one: Claude Desktop is Electron
 * and JSON.parse throws on a leading U+FEFF, so re-emitting a BOM we merely tolerated on read would
 * hand the user a config their client can no longer load.
 */
export function serializeClientConfig(data: Record<string, unknown>, format: FileFormat = DEFAULT_FORMAT): string {
  const json = JSON.stringify(data, null, format.indent) + '\n';
  return format.eol === '\r\n' ? json.replace(/\n/g, '\r\n') : json;
}

// ---------------------------------------------------------------------------
// Targets (data, not branching)
// ---------------------------------------------------------------------------

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface TargetContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Workspace folder, for workspace-scoped targets (VS Code). */
  workspace?: string;
  p?: PathLike;
}

export type PathResult = { ok: true; file: string } | { ok: false; reason: string };

export interface ClientTarget {
  id: string;
  label: string;
  /** Key holding the map of servers: Claude Desktop says "mcpServers", VS Code says "servers". */
  serversKey: string;
  /**
   * The key WE own inside that map. The two targets differ on purpose: these are the names
   * docs/README.md:188-216 has been telling users to paste for as long as local mode has existed,
   * so an install now recognises (and updates, rather than duplicating) a hand-pasted entry.
   */
  serverName: string;
  /** Comments are legal in this file, so a rewrite would destroy them. See the header. */
  jsonc: boolean;
  buildEntry(launch: LaunchSpec): Record<string, unknown>;
  resolvePath(ctx: TargetContext): PathResult;
}

export const CLIENT_TARGETS: ClientTarget[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    serversKey: 'mcpServers',
    serverName: 'Tally Prime',
    jsonc: false,
    // Claude Desktop infers stdio and has no "type" field, so the entry is exactly what the client
    // documents and nothing more.
    buildEntry: (launch) => ({
      command: launch.command,
      args: [...launch.args],
      ...(launch.env ? { env: { ...launch.env } } : {})
    }),
    resolvePath: (ctx) => {
      const p = ctx.p ?? path;
      const env = ctx.env ?? process.env;
      const platform = ctx.platform ?? process.platform;
      if (platform === 'win32') {
        // APPDATA is the Roaming path Claude Desktop actually uses; the home-relative form is only
        // a fallback for a stripped environment (a service account with no profile vars, say).
        const appData = env.APPDATA;
        if (appData) return { ok: true, file: p.join(appData, 'Claude', 'claude_desktop_config.json') };
        if (ctx.home) return { ok: true, file: p.join(ctx.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json') };
        return { ok: false, reason: 'cannot locate %APPDATA% for the Claude Desktop config' };
      }
      // #178's bridge is not necessarily Windows, so the other platforms are real cases here.
      const home = ctx.home ?? os.homedir();
      if (!home) return { ok: false, reason: 'cannot locate the home directory for the Claude Desktop config' };
      if (platform === 'darwin') return { ok: true, file: p.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') };
      return { ok: true, file: p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Claude', 'claude_desktop_config.json') };
    }
  },
  {
    id: 'vscode',
    label: 'VS Code (workspace)',
    serversKey: 'servers',
    serverName: 'tally-prime',
    jsonc: true,
    // VS Code REQUIRES "type" and validates the entry against its schema; omitting it leaves the
    // server inert with no error the user can act on.
    buildEntry: (launch) => ({
      type: 'stdio',
      command: launch.command,
      args: [...launch.args],
      ...(launch.env ? { env: { ...launch.env } } : {})
    }),
    resolvePath: (ctx) => {
      const p = ctx.p ?? path;
      // Workspace-scoped by design: .vscode/mcp.json belongs to a project folder, and we have no
      // business guessing which of a user's repos should get an entry. The caller (wizard or CLI
      // flag) supplies it, and this target is simply skipped when it cannot.
      if (!ctx.workspace) return { ok: false, reason: 'no workspace folder given (.vscode/mcp.json is per-project; pass --workspace)' };
      return { ok: true, file: p.join(ctx.workspace, '.vscode', 'mcp.json') };
    }
  }
];

export function targetById(id: string): ClientTarget | undefined {
  return CLIENT_TARGETS.find(t => t.id === id);
}

/** The stdio launch line for a local install: `node <installRoot>/dist/index.mjs` (see src/index.mts). */
export function localLaunchSpec(installRoot: string, nodeExe: string = process.execPath, p: PathLike = path): LaunchSpec {
  return { command: nodeExe, args: [p.join(installRoot, 'dist', 'index.mjs')] };
}

// ---------------------------------------------------------------------------
// Ownership / status
// ---------------------------------------------------------------------------

export type EntryState = 'absent' | 'ours' | 'hijacked';

export interface EntryStatus {
  state: EntryState;
  /** The entry on disk is already deep-equal to `merged` — applying changes no JSON at all. */
  current: boolean;
  existing: unknown | null;
  /**
   * Exactly what apply would put under our key: our canonical keys laid over whatever the user
   * added to the entry. Meaningless (and never written) when the state is `hijacked`.
   */
  merged: Record<string, unknown>;
}

/**
 * Our keys win; every OTHER key the entry already carried survives.
 *
 * This is the same promise as "preserve every sibling key", one level down, and it is not
 * theoretical: `env` (a non-default TALLY_HOST for a Tally on another machine), VS Code's `envFile`
 * and `dev`, and a client's own `disabled: true` all live INSIDE our entry. Replacing the entry
 * wholesale on every upgrade would silently throw those away — and `disabled: true` in particular
 * would mean an upgrade re-enables a server the user deliberately switched off.
 *
 * Shallow on purpose: a key we DO write (`env`, when a caller supplies one) is replaced whole
 * rather than deep-merged, because a half-merged environment is worse than either alternative.
 */
export function mergeEntry(existing: unknown, desired: Record<string, unknown>): Record<string, unknown> {
  // Spread order: `existing` first, so keys present in both keep the POSITION they already had and
  // only their value is updated. That is what keeps a rewrite a minimal diff.
  return isPlainObject(existing) ? { ...existing, ...desired } : { ...desired };
}

type Identity = { kind: 'script'; tail: string } | { kind: 'url'; url: string } | { kind: 'unknown' };

// Last two path segments, separator- and case-normalised: "C:\Program Files\Tally MCP\dist\index.mjs"
// and "D:/apps/tally/dist/index.mjs" both reduce to "dist/index.mjs". That tolerance is the point —
// an upgrade, or a reinstall into a different directory, must read as OUR entry needing an update,
// not as a stranger's entry we must not touch. Case-folding is correct on Windows and merely
// generous on posix, which is the safe direction: the worst case there is that we update an entry
// we ourselves planted.
function scriptTail(raw: string): string {
  const segments = raw.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
  return segments.slice(-2).join('/').toLowerCase();
}

/**
 * What an entry points at, for the ownership test. Script entries are identified by the launched
 * script (`args`), NOT by `command`: `command` is an absolute node.exe path that legitimately
 * changes under the user's feet (nvm, a Node upgrade, a bundled runtime) and so is not identity.
 */
export function entryIdentity(entry: unknown): Identity {
  if (!isPlainObject(entry)) return { kind: 'unknown' };
  if (typeof entry.url === 'string') return { kind: 'url', url: entry.url.trim().replace(/\/+$/, '').toLowerCase() };
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  const script = args.find(a => /\.(mjs|cjs|js)$/i.test(a));
  if (script) return { kind: 'script', tail: scriptTail(script) };
  // No script argument: a launcher-style entry ("tally-mcp.exe", "npx some-server"). Fall back to
  // the command so those still compare against each other instead of collapsing into "unknown".
  if (typeof entry.command === 'string' && entry.command.trim() !== '') return { kind: 'script', tail: scriptTail(entry.command) };
  return { kind: 'unknown' };
}

/**
 * Does this entry point at a script inside `installRoot`?
 *
 * entryIdentity() deliberately compares only the script TAIL ("dist/index.mjs"), so an entry
 * survives a legitimate move of the install directory. That tolerance is right when we are
 * managing OUR OWN user's entry - and wrong when deciding whether to delete an entry out of
 * somebody else's profile, because a user running their own fork from D:\my-fork\dist\index.mjs
 * has exactly the same tail. Mass removal (#172 E1) needs the stricter question, and this is it.
 */
export function entryPointsInside(entry: unknown, installRoot: string, p: PathLike = path): boolean {
  if (!isPlainObject(entry) || !installRoot) return false;
  const root = p.resolve(installRoot);
  const rootWithSep = root.endsWith(p.sep) ? root : root + p.sep;
  const fold = (v: string) => (p.sep === String.fromCharCode(92) ? v.toLowerCase() : v);
  const candidates: string[] = [];
  if (Array.isArray(entry.args)) for (const a of entry.args) if (typeof a === "string") candidates.push(a);
  if (typeof entry.command === "string") candidates.push(entry.command);
  return candidates.some(c => {
    const resolved = fold(p.resolve(c));
    return resolved === fold(root) || resolved.startsWith(fold(rootWithSep));
  });
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.kind === 'script' && b.kind === 'script') return a.tail === b.tail;
  if (a.kind === 'url' && b.kind === 'url') return a.url === b.url;
  // 'unknown' never matches, not even another 'unknown': we do not claim what we cannot identify.
  return false;
}

/**
 * absent / present-and-ours / present-but-HIJACKED.
 *
 * HIJACKED means our reserved key holds an entry pointing somewhere else — a user who repurposed
 * the name, or another server that took it. We neither overwrite nor delete those: the config file
 * is the user's, and an entry under that key that is not ours is not ours to spend.
 */
export function statusOfEntry(data: Record<string, unknown>, target: ClientTarget, desired: Record<string, unknown>): EntryStatus {
  const servers = data[target.serversKey];
  const existing = isPlainObject(servers) ? servers[target.serverName] : undefined;
  const asWritten = { ...desired };
  if (existing === undefined) return { state: 'absent', current: false, existing: null, merged: asWritten };
  // Byte-for-byte our entry: short-circuit before the identity test, so an exact match is `ours`
  // even for a caller whose desired entry is not identifiable on its own.
  if (isDeepStrictEqual(existing, desired)) return { state: 'ours', current: true, existing, merged: asWritten };
  if (!sameIdentity(entryIdentity(existing), entryIdentity(desired))) {
    return { state: 'hijacked', current: false, existing, merged: asWritten };
  }
  // Ours, but not identical — a moved install, a Node upgrade, or user keys we must keep. `current`
  // compares against what we would ACTUALLY write, not against `desired`: otherwise an entry
  // carrying the user's own `env` would read as stale on every single run and we would rewrite
  // (and back up) the same bytes forever.
  const merged = mergeEntry(existing, desired);
  return { state: 'ours', current: isDeepStrictEqual(existing, merged), existing, merged };
}

// ---------------------------------------------------------------------------
// Pure merge core: content string in, content string out
// ---------------------------------------------------------------------------

export interface EditOptions {
  /** Rewrite a JSONC file even though every comment in it will be lost. Off by default. */
  allowCommentLoss?: boolean;
}

export interface EditResult {
  ok: true;
  /** The content to write. Byte-identical to the input when `changed` is false. */
  content: string;
  /** false => write nothing at all: no backup, no rename, no mtime churn — not "write the same bytes back". */
  changed: boolean;
  /** Status BEFORE the edit. */
  status: EntryStatus;
  /** true when the content we just produced dropped the file's comments (only ever with allowCommentLoss). */
  commentsDropped: boolean;
  /** true when this rewrite removed a leading U+FEFF the file had. Report it; it is a repair. */
  bomStripped: boolean;
  /** Set when we deliberately declined to change something. Surface this; do not swallow it. */
  note?: string;
}

export type EditOutcome = EditResult | { ok: false; reason: string };

function loadForEdit(raw: string | null): ParseResult {
  // null = the file does not exist yet. Creating it is not a merge hazard: there is nothing to lose.
  if (raw === null) return { ok: true, data: {}, format: { ...DEFAULT_FORMAT } };
  return parseClientConfig(raw);
}

// Refusing to merge into a servers key that is not a map has to be decided BEFORE the comment gate:
// otherwise a commented file with `"servers": "nope"` reports "we would delete your comments"
// (ok:true, CLI exit 2 — "we chose not to act") when the truth is that the file cannot be merged at
// all (ok:false, exit 1 — "a human must look at this"). Same non-action either way; different thing
// to tell the user.
function serversMapOrRefusal(data: Record<string, unknown>, target: ClientTarget): { ok: false; reason: string } | null {
  const servers = data[target.serversKey];
  if (servers === undefined || isPlainObject(servers)) return null;
  return { ok: false, reason: `"${target.serversKey}" is ${Array.isArray(servers) ? 'an array' : typeof servers}, expected an object` };
}

// A file that legally contains comments cannot be told apart from one whose comments are a bug:
// in .vscode/mcp.json they are the user's own notes, in claude_desktop_config.json they mean the
// file is ALREADY unparseable by the client. Same refusal either way — we never destroy them
// without being asked — but the advice differs, so the wording does too.
function commentGate(format: FileFormat, target: ClientTarget, opts: EditOptions, verb: string): string | null {
  if (!format.hadComments || opts.allowCommentLoss) return null;
  return !target.jsonc
    // Comments are not legal here, so the file is ALREADY unreadable by this client; saying "we
    // would delete your comments" would be advice for the wrong problem.
    ? `${target.label} config contains comments, which ${target.label} itself cannot parse — that file is already unreadable by the client. Re-run with --allow-comment-loss to rewrite it as strict JSON (the comments go), or fix it by hand`
    : `${target.label} config contains comments that a rewrite would delete; re-run with --allow-comment-loss to accept that, or ${verb} the entry by hand`;
}

/**
 * Merges our entry into `raw`, preserving every sibling key and its order (JSON.parse/stringify
 * round-trips insertion order for string keys, and assigning to a key that already exists keeps its
 * position). Never overwrites the file wholesale.
 *
 * Idempotent by construction: when the file already holds exactly what we would write we return the
 * ORIGINAL bytes with changed=false, so a second apply reformats nothing and writes nothing.
 *
 * KNOWN, ACCEPTED round-trip losses (JSON.parse/stringify, unavoidable without a text splice):
 *   - a duplicate top-level key collapses to its last value — which is the value the client itself
 *     sees, JSON.parse having made the same choice, so nothing the user relies on changes;
 *   - a key that is a pure integer string ("2024") sorts ahead of its siblings, because that is how
 *     JS orders array-index-like own keys. Only reachable via an MCP server literally named "2024".
 */
export function applyEntryToText(raw: string | null, target: ClientTarget, entry: Record<string, unknown>, opts: EditOptions = {}): EditOutcome {
  const parsed = loadForEdit(raw);
  if (!parsed.ok) return parsed;
  const { data, format } = parsed;
  const status = statusOfEntry(data, target, entry);
  const unchanged = (note?: string): EditResult =>
    ({ ok: true, content: raw ?? '', changed: false, status, commentsDropped: false, bomStripped: false, ...(note ? { note } : {}) });

  // `!format.hadBom` is the one repair this module makes, and it is why "already correct" is not
  // enough to stop here. A leading U+FEFF is not cosmetic: Claude Desktop is Electron and its
  // JSON.parse throws on it, so a BOM'd config is one the client cannot load AT ALL. Without this
  // clause a file holding exactly the right entry — but written by Notepad or PS 5.1's Set-Content,
  // which both emit a BOM — reports "ours (up to date)", the installer exits 0, and nothing works.
  // Still idempotent: the rewrite emits no BOM, so the next run finds nothing to do.
  if (status.current && !format.hadBom) return unchanged();
  if (status.state === 'hijacked') {
    return unchanged(`"${target.serverName}" in ${target.serversKey} already exists and points elsewhere; refusing to overwrite someone else's entry`);
  }
  const refusal = serversMapOrRefusal(data, target);
  if (refusal) return refusal;
  const blocked = commentGate(format, target, opts, 'add');
  if (blocked) return unchanged(blocked);

  const servers = data[target.serversKey] as Record<string, unknown> | undefined;
  const merged: Record<string, unknown> = { ...(servers ?? {}) };
  merged[target.serverName] = status.merged; // our keys over the user's own — see mergeEntry
  data[target.serversKey] = merged; // assign in place: keeps this key where it already sat among its siblings
  return { ok: true, content: serializeClientConfig(data, format), changed: true, status, commentsDropped: format.hadComments, bomStripped: format.hadBom };
}

/**
 * Removes our entry — GATED on it still being ours. Uninstall must remove "the entries it added"
 * (#172 acceptance), which is not the same as "whatever now sits under that name".
 */
export function removeEntryFromText(raw: string | null, target: ClientTarget, entry: Record<string, unknown>, opts: EditOptions = {}): EditOutcome {
  const parsed = loadForEdit(raw);
  if (!parsed.ok) return parsed;
  const { data, format } = parsed;
  const status = statusOfEntry(data, target, entry);
  const unchanged = (note?: string): EditResult =>
    ({ ok: true, content: raw ?? '', changed: false, status, commentsDropped: false, bomStripped: false, ...(note ? { note } : {}) });

  // Unlike apply, a BOM is NOT reason enough to rewrite here: uninstall has no business touching a
  // file it has nothing to remove from.
  if (status.state === 'absent') return unchanged();
  if (status.state === 'hijacked') {
    return unchanged(`"${target.serverName}" in ${target.serversKey} no longer points at this install; leaving it alone`);
  }
  const blocked = commentGate(format, target, opts, 'remove');
  if (blocked) return unchanged(blocked);
  // Safe cast: a non-absent status means servers was a plain object holding our name.
  const kept: Record<string, unknown> = { ...(data[target.serversKey] as Record<string, unknown>) };
  delete kept[target.serverName];
  // A now-empty servers map stays: it may well predate us, and deleting a key we did not create is
  // exactly the class of collateral damage this module exists to avoid.
  data[target.serversKey] = kept;
  return { ok: true, content: serializeClientConfig(data, format), changed: true, status, commentsDropped: format.hadComments, bomStripped: format.hadBom };
}

// ---------------------------------------------------------------------------
// File IO (thin; everything above is pure)
// ---------------------------------------------------------------------------

// Local copy of the temp-file + rename pattern from mcp.mts:556 (not exported there, and not
// imported here deliberately): mcp.mjs runs dotenv.config() and pulls in the MCP SDK, DuckDB's
// native addon and the whole Tally stack at module load. This module is run by the installer, on a
// machine where those may be the very things that are missing or broken, so it stays on node
// builtins only.
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8'); // 'utf-8', never a BOM encoding: see serializeClientConfig
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Don't leave a .tmp.* orphan next to the user's config if the rename loses (target open by the
    // client, or an AV scan holding it).
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/** Reads a config file, or null when it does not exist. Content comes back raw, BOM and all. */
export function readConfigFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Timestamped copy beside the original, e.g. claude_desktop_config.json.20260909T101500Z.bak.
 * Timestamped rather than a single .bak so a second run cannot destroy the pre-install state the
 * first run saved — that file is the user's only copy of their other MCP servers.
 */
export function backupConfigFile(file: string, now: Date = new Date()): string {
  // Milliseconds, not seconds, and then COPYFILE_EXCL with a counter: an apply and a reconfigure
  // inside the same second used to land on the same name, and the second copyFileSync would
  // silently overwrite the only record of the user's other MCP servers. A backup that can be
  // destroyed by the next run is not a backup.
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  for (let n = 0; ; n++) {
    const backup = `${file}.${stamp}${n === 0 ? '' : `-${n}`}.bak`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || n > 50) throw e;
    }
  }
}

export interface ApplyFileResult {
  target: ClientTarget;
  file: string;
  outcome: EditOutcome;
  wrote: boolean;
  backup: string | null;
}

function editFile(target: ClientTarget, file: string, edit: (raw: string | null) => EditOutcome, opts: { dryRun?: boolean } = {}): ApplyFileResult {
  const raw = readConfigFile(file);
  const outcome = edit(raw);
  if (!outcome.ok || !outcome.changed || opts.dryRun) return { target, file, outcome, wrote: false, backup: null };
  const backup = raw === null ? null : backupConfigFile(file); // nothing to back up when we are creating it
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, outcome.content);
  return { target, file, outcome, wrote: true, backup };
}

export function applyToFile(target: ClientTarget, file: string, entry: Record<string, unknown>, opts: EditOptions & { dryRun?: boolean } = {}): ApplyFileResult {
  return editFile(target, file, raw => applyEntryToText(raw, target, entry, opts), opts);
}

export function removeFromFile(target: ClientTarget, file: string, entry: Record<string, unknown>, opts: EditOptions & { dryRun?: boolean } = {}): ApplyFileResult {
  return editFile(target, file, raw => removeEntryFromText(raw, target, entry, opts), opts);
}

// ---------------------------------------------------------------------------
// CLI: detect | status | apply | remove
// ---------------------------------------------------------------------------
//
// Exit codes are the contract for the installer step that will call this (#172, later step):
//   0  nothing to do, or done
//   1  refused: a file we could not parse, or an IO failure — a human must look at it
//   2  blocked but harmless: a hijacked entry, or comments we will not silently drop
// 2 is separate from 1 on purpose: it is the "we deliberately did nothing" case, which an installer
// should report to the user without failing the install.

export interface CliOptions {
  command: string;
  targets: string[];
  installRoot: string;
  nodeExe: string;
  workspace?: string;
  /**
   * Override for %APPDATA%, so a caller can act on ANOTHER user's Claude Desktop config.
   *
   * Exists for the uninstaller (#172 E1): our entry may have been added by several Windows
   * users via the Start Menu item, and after uninstall each stale entry points Claude at files
   * that no longer exist. Cleaning them means resolving a path in someone else's profile.
   * Routing that through the same resolvePath/remove code as everything else keeps the
   * ownership gate - we still refuse to delete an entry that no longer points at this install -
   * which hand-rolled JSON editing in PowerShell would have thrown away.
   */
  appdata?: string;
  /**
   * Refuse to remove an entry unless it actually points INSIDE --install-root.
   *
   * Off by default, because the normal single-user remove SHOULD still clean up an entry left
   * behind by an install that has since moved. The uninstaller turns it on for the sweep across
   * other profiles, where the same tolerance would delete a colleague's fork.
   */
  requireInstallRoot: boolean;
  json: boolean;
  dryRun: boolean;
  allowCommentLoss: boolean;
}

/**
 * THROWS on anything it does not recognise, rather than ignoring it. That is the whole point of
 * this function being strict: `--targett vscode` used to parse as "no --target given", which the
 * default below expands to EVERY target — so a typo in the wizard's command line silently turned
 * "write the workspace's mcp.json" into "write the user's real Claude Desktop config too". A flag
 * with a missing value was worse still: `--install-root` at the end of the line made
 * `installRoot` undefined and path.join threw an unhandled TypeError with a stack trace.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const opts: CliOptions = {
    command: hasCommand ? argv[0] : 'status', // read-only default: a bare invocation must not write
    targets: [],
    // Default install root is the parent of dist/, i.e. this install — the same anchor mcp.mts uses
    // for MCP_INSTALL_ROOT and its .env load.
    installRoot: path.resolve(import.meta.dirname, '..'),
    nodeExe: process.execPath,
    json: false,
    dryRun: false,
    allowCommentLoss: false,
    requireInstallRoot: false
  };
  let i = hasCommand ? 1 : 0;
  const value = (flag: string): string => {
    const v = argv[++i];
    // A following flag is a missing value, not a value: `--workspace --json` is a typo, and taking
    // "--json" as the workspace path would create a directory called "--json/.vscode".
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--allow-comment-loss') opts.allowCommentLoss = true;
    else if (a === '--target') opts.targets.push(value(a));
    else if (a === '--workspace') opts.workspace = value(a);
    else if (a === '--appdata') opts.appdata = value(a);
    else if (a === '--require-install-root') opts.requireInstallRoot = true;
    else if (a === '--install-root') opts.installRoot = value(a);
    else if (a === '--node') opts.nodeExe = value(a);
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else throw new Error(`unexpected argument: ${a}`);
  }
  const unknown = opts.targets.filter(t => t !== 'all' && !targetById(t));
  if (unknown.length > 0) throw new Error(`unknown target: ${unknown.join(', ')}`);
  if (opts.targets.length === 0 || opts.targets.includes('all')) opts.targets = CLIENT_TARGETS.map(t => t.id);
  return opts;
}

const CLI_COMMANDS = ['detect', 'status', 'apply', 'remove'];

const USAGE = 'usage: node dist/client-config.mjs <detect|status|apply|remove> [--target claude-desktop|vscode|all]'
  + ' [--workspace DIR] [--appdata DIR] [--require-install-root] [--install-root DIR] [--node PATH] [--json] [--dry-run] [--allow-comment-loss]\n';

export function runCli(argv: string[]): number {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (e) {
    // A bad command line must not reach the write path, and must not surface as a Node stack trace
    // to a wizard that will show it to an accountant.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 1;
  }
  if (!CLI_COMMANDS.includes(opts.command)) {
    process.stderr.write(`unknown command: ${opts.command}\n${USAGE}`);
    return 1;
  }
  const launch = localLaunchSpec(opts.installRoot, opts.nodeExe);
  const report: Record<string, unknown>[] = [];
  let exit = 0;
  for (const id of opts.targets) {
    const target = targetById(id);
    if (!target) { process.stderr.write(`unknown target: ${id}\n`); exit = Math.max(exit, 1); continue; }
    const resolved = target.resolvePath({
      workspace: opts.workspace,
      // Only override when asked: an empty --appdata must not blank out the real one.
      env: opts.appdata ? { ...process.env, APPDATA: opts.appdata } : undefined,
    });
    if (!resolved.ok) { report.push({ target: id, skipped: resolved.reason }); continue; }
    const file = resolved.file;
    const entry = target.buildEntry(launch);
    try {
      if (opts.command === 'detect') {
        report.push({ target: id, file, exists: fs.existsSync(file) });
        continue;
      }
      // `status` is `apply --dry-run`: same parse, same ownership test, no write. One code path, so
      // what status reports is exactly what apply would do.
      // Strict gate, checked BEFORE the remove runs so nothing is written on refusal.
      if (opts.command === 'remove' && opts.requireInstallRoot) {
        let existing: unknown;
        try {
          const parsed = parseClientConfig(fs.readFileSync(file, 'utf-8'));
          if (parsed.ok) {
            const bucket = parsed.data[target.serversKey];
            if (isPlainObject(bucket)) existing = bucket[target.serverName];
          }
        } catch { /* unreadable: fall through and let the normal path report it */ }
        if (existing !== undefined && !entryPointsInside(existing, opts.installRoot)) {
          report.push({ target: id, file, state: 'foreign', changed: false, wrote: false, backup: null,
            note: `left untouched: the entry under "${target.serverName}" does not point inside ${opts.installRoot}, so it is not ours to delete` });
          exit = Math.max(exit, 2);
          continue;
        }
      }
      const run = opts.command === 'remove' ? removeFromFile : applyToFile;
      const res = run(target, file, entry, { ...opts, dryRun: opts.dryRun || opts.command === 'status' });
      if (!res.outcome.ok) {
        report.push({ target: id, file, error: res.outcome.reason });
        exit = Math.max(exit, 1);
        continue;
      }
      const { status, changed, note, commentsDropped, bomStripped } = res.outcome;
      report.push({ target: id, file, state: status.state, current: status.current, changed, wrote: res.wrote, backup: res.backup, commentsDropped, bomStripped, ...(note ? { note } : {}) });
      if (note) exit = Math.max(exit, 2);
    } catch (e) {
      report.push({ target: id, file, error: e instanceof Error ? e.message : String(e) });
      exit = Math.max(exit, 1);
    }
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ command: opts.command, results: report }, null, 2) + '\n');
    return exit;
  }
  for (const r of report) {
    if (r.skipped) { process.stdout.write(`- ${r.target}: skipped (${r.skipped})\n`); continue; }
    if (r.error) { process.stdout.write(`! ${r.target}: ${r.file}\n    ${r.error}\n`); continue; }
    const what = r.exists !== undefined
      ? (r.exists ? 'config file present' : 'no config file yet')
      : `${r.state}${r.current ? ' (up to date)' : ''}${r.wrote ? ' — written' : r.changed ? ' — would change' : ''}`;
    process.stdout.write(`- ${r.target}: ${r.file}\n    ${what}\n`);
    if (r.backup) process.stdout.write(`    backup: ${r.backup}\n`);
    // Both of these are silent file surgery otherwise, and the user is entitled to know.
    if (r.bomStripped) process.stdout.write(`    removed a UTF-8 BOM the client could not parse\n`);
    if (r.commentsDropped) process.stdout.write(`    comments in the original file were dropped (--allow-comment-loss)\n`);
    if (r.note) process.stdout.write(`    NOTE: ${r.note}\n`);
  }
  return exit;
}

// Only when run as a program. The tests (and #178) import this module, and importing must never
// touch anyone's config file.
//
// process.exitCode, NOT process.exit(), for two reasons:
//   - process.exit() tears the process down before a piped stdout has necessarily flushed, and on
//     Windows that truncates exactly the `--json` report the installer step means to read;
//   - it makes this guard survivable. If it ever misfires, an importer (#178's bridge, a test,
//     an installer script) gets some stray output and a set exit code instead of being killed
//     mid-import — which is both a much smaller blast radius and something a test can actually
//     observe. runCli is fully synchronous, so the code still lands before the process ends.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
