import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLIENT_TARGETS, targetById, localLaunchSpec, parseClientConfig, serializeClientConfig,
  statusOfEntry, entryIdentity, mergeEntry, applyEntryToText, removeEntryFromText, parseCliArgs,
  applyToFile, removeFromFile, backupConfigFile,
  stripJsonComments, stripTrailingCommas, type EditOutcome, type ClientTarget, entryPointsInside, envForAppdata } from './client-config.mjs';

// --- #172 B1: the client-config merge engine ---
//
// These files belong to the USER, not to us: they hold every other MCP server they have configured.
// So the properties under test are the destructive ones — merge instead of overwrite, refuse
// instead of "repair", never touch an entry that is not ours — plus the byte-level ones (BOM,
// idempotency) that decide whether the client can still load its own config afterwards.
//
// Windows paths are written with DOUBLED backslashes because these are TS string literals; a single
// backslash would make 'C:\Program Files' parse as 'C:Program Files' and every assertion below  (collapsed-path-ok: that is the bug being described)
// would be testing nonsense. path.win32 is injected explicitly so the assertions mean the same
// thing on a posix CI runner as on the Windows box.

const CD = targetById('claude-desktop')!;
const VSC = targetById('vscode')!;

const INSTALL = 'C:\\Program Files\\Tally MCP Server';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const launch = localLaunchSpec(INSTALL, NODE, path.win32);
const cdEntry = CD.buildEntry(launch);
const vscEntry = VSC.buildEntry(launch);

const ok = (r: EditOutcome) => {
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`);
  return r as Extract<EditOutcome, { ok: true }>;
};
const parseOk = (text: string) => {
  const p = parseClientConfig(text);
  assert.equal(p.ok, true, p.ok ? '' : `refused: ${p.reason}`);
  return (p as Extract<typeof p, { ok: true }>);
};

// --- launch spec / entry shapes ---

test('localLaunchSpec points node at dist/index.mjs inside the install root', () => {
  assert.deepEqual(launch, { command: NODE, args: ['C:\\Program Files\\Tally MCP Server\\dist\\index.mjs'] });
});

test('Claude Desktop entries carry no "type" key; VS Code entries require type=stdio', () => {
  assert.deepEqual(Object.keys(cdEntry), ['command', 'args']);
  assert.equal(vscEntry.type, 'stdio');
});

test('the target list is data, and each target names the key it merges into', () => {
  assert.deepEqual(CLIENT_TARGETS.map(t => [t.id, t.serversKey]), [
    ['claude-desktop', 'mcpServers'],
    ['cursor', 'mcpServers'],
    ['vscode', 'servers']
  ]);
});

test('buildEntry copies the args array rather than aliasing the caller\'s', () => {
  const spec = localLaunchSpec(INSTALL, NODE, path.win32);
  const entry = CD.buildEntry(spec) as { args: string[] };
  entry.args.push('--rogue');
  assert.equal(spec.args.length, 1);
});

// --- config path resolution (data, not branching) ---

test('Claude Desktop resolves under %APPDATA% on Windows', () => {
  const r = CD.resolvePath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ca\\AppData\\Roaming' }, p: path.win32 });
  assert.deepEqual(r, { ok: true, file: 'C:\\Users\\ca\\AppData\\Roaming\\Claude\\claude_desktop_config.json' });
});

// --- the packaged (MSIX) Windows build of Claude Desktop ---
// It reads a private copy of Roaming under %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache, and never
// the real %APPDATA% file. Writing only the real file is how an install reported "connected" while
// Claude showed no Tally tools.

const LOCAL = 'C:\\Users\\ca\\AppData\\Local';
const pkgCtx = (names: string[], dataNames: string[] = []) => ({
  platform: 'win32' as const, p: path.win32,
  env: { APPDATA: 'C:\\Users\\ca\\AppData\\Roaming', LOCALAPPDATA: LOCAL },
  listDir: (dir: string) => (dir === LOCAL + '\\Packages' ? names : dir === LOCAL + '\\Claude-Data' ? dataNames : []),
});

test('packaged Claude Desktop: its private config is an extra path, the real one stays primary', () => {
  const ctx = pkgCtx(['Microsoft.WindowsStore_8wekyb3d8bbwe', 'Claude_pzs8sxrjxfjjc']);
  assert.deepEqual(CD.resolvePath(ctx), { ok: true, file: 'C:\\Users\\ca\\AppData\\Roaming\\Claude\\claude_desktop_config.json' });
  assert.deepEqual(CD.extraPaths!(ctx), [
    'C:\\Users\\ca\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
  ]);
});

test('packaged Claude Desktop: the newer Claude-Data folder is covered too', () => {
  const ctx = pkgCtx(['Claude_pzs8sxrjxfjjc'], ['claude_pzs8sxrjxfjjc', 'claude-backup', 'other']);
  assert.deepEqual(CD.extraPaths!(ctx), [
    'C:\\Users\\ca\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json',
    'C:\\Users\\ca\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json',
  ]);
});

test('packaged Claude Desktop: classic installs and other packages add nothing', () => {
  assert.deepEqual(CD.extraPaths!(pkgCtx([])), []);
  assert.deepEqual(CD.extraPaths!(pkgCtx(['ClaudeHelper_abc.extra', 'NotClaude_x', 'claude'])), []);
});

test('packaged Claude Desktop: never looked for off Windows or without LOCALAPPDATA', () => {
  assert.deepEqual(CD.extraPaths!({ ...pkgCtx(['Claude_x']), platform: 'darwin' }), []);
  assert.deepEqual(CD.extraPaths!({ ...pkgCtx(['Claude_x']), env: { APPDATA: 'C:\\x' } }), []);
});

test('--appdata for another user moves LOCALAPPDATA to that same profile', () => {
  const env = envForAppdata('C:\\Users\\asha\\AppData\\Roaming', { LOCALAPPDATA: 'C:\\Users\\admin\\AppData\\Local' }, path.win32);
  assert.equal(env.APPDATA, 'C:\\Users\\asha\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\asha\\AppData\\Local', 'never the caller\'s own packaged config');
});

test('Claude Desktop falls back to the profile when APPDATA is missing from a stripped environment', () => {
  const r = CD.resolvePath({ platform: 'win32', env: {}, home: 'C:\\Users\\ca', p: path.win32 });
  assert.deepEqual(r, { ok: true, file: 'C:\\Users\\ca\\AppData\\Roaming\\Claude\\claude_desktop_config.json' });
});

test('Claude Desktop refuses to guess when neither APPDATA nor a profile is known', () => {
  const r = CD.resolvePath({ platform: 'win32', env: {}, p: path.win32 });
  assert.equal(r.ok, false);
});

test('Claude Desktop resolves the macOS and Linux paths too (#178 runs off-Windows)', () => {
  assert.deepEqual(CD.resolvePath({ platform: 'darwin', env: {}, home: '/Users/ca', p: path.posix }),
    { ok: true, file: '/Users/ca/Library/Application Support/Claude/claude_desktop_config.json' });
  assert.deepEqual(CD.resolvePath({ platform: 'linux', env: {}, home: '/home/ca', p: path.posix }),
    { ok: true, file: '/home/ca/.config/Claude/claude_desktop_config.json' });
  assert.deepEqual(CD.resolvePath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/ca/cfg' }, home: '/home/ca', p: path.posix }),
    { ok: true, file: '/home/ca/cfg/Claude/claude_desktop_config.json' });
});

test('VS Code is workspace-scoped and skips itself rather than guessing a project folder', () => {
  const none = VSC.resolvePath({ p: path.win32 });
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.reason, /workspace/);
  assert.deepEqual(VSC.resolvePath({ workspace: 'D:\\books\\acme', p: path.win32 }),
    { ok: true, file: 'D:\\books\\acme\\.vscode\\mcp.json' });
});

// --- parsing: BOM, JSONC, refusal ---

test('a UTF-8 BOM is tolerated on read and never emitted on write', () => {
  const raw = '\uFEFF{\n  "mcpServers": {}\n}\n';
  const p = parseOk(raw);
  assert.equal(p.format.hadBom, true);
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  // Claude Desktop is Electron: a leading U+FEFF makes its own JSON.parse throw.
  assert.notEqual(r.content.charCodeAt(0), 0xfeff);
  assert.doesNotThrow(() => JSON.parse(r.content));
});

test('an empty or whitespace-only file is not garbage — clients create the file before filling it', () => {
  assert.deepEqual(parseOk('').data, {});
  assert.deepEqual(parseOk('\uFEFF   \n').data, {});
  const r = ok(applyEntryToText('', CD, cdEntry));
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.content), { mcpServers: { 'Tally Prime': cdEntry } });
});

test('REFUSES an unparseable file instead of replacing it', () => {
  const garbage = '{ "mcpServers": { "filesystem": ';
  const p = parseClientConfig(garbage);
  assert.equal(p.ok, false);
  const r = applyEntryToText(garbage, CD, cdEntry);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /not valid JSON/);
});

test('REFUSES a top-level value that is not an object', () => {
  assert.equal(applyEntryToText('[1,2]', CD, cdEntry).ok, false);
  assert.equal(applyEntryToText('"hello"', CD, cdEntry).ok, false);
  assert.equal(applyEntryToText('null', CD, cdEntry).ok, false);
});

test('REFUSES when the servers key holds something that is not a map', () => {
  const r = applyEntryToText('{"mcpServers": "nope"}', CD, cdEntry);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /expected an object/);
});

test('stripJsonComments blanks both comment forms and reports that it saw them', () => {
  const out = stripJsonComments('{ // hi\n  "a": 1, /* two\nlines */ "b": 2 }');
  assert.equal(out.hadComments, true);
  assert.deepEqual(JSON.parse(out.text), { a: 1, b: 2 });
  // Offsets are preserved so a JSON.parse error position still points into the user's own file.
  assert.equal(out.text.length, '{ // hi\n  "a": 1, /* two\nlines */ "b": 2 }'.length);
});

test('a "//" inside a string value is not a comment', () => {
  const raw = '{\n  "servers": {\n    "remote": { "url": "https://books.example/mcp" }\n  }\n}\n';
  const p = parseOk(raw);
  assert.equal(p.format.hadComments, false);
  assert.deepEqual((p.data.servers as any).remote.url, 'https://books.example/mcp');
});

test('JSONC trailing commas parse (VS Code writes them; JSON.parse rejects them)', () => {
  assert.deepEqual(parseOk('{ "servers": { "a": 1, }, }').data, { servers: { a: 1 } });
  // A comma inside a string must survive.
  assert.deepEqual(parseOk('{ "a": "x, }" }').data, { a: 'x, }' });
  assert.equal(stripTrailingCommas('[1, 2 , ]'), '[1, 2   ]');
});

// --- merge: siblings, order, formatting ---

test('merges alongside other MCP servers, preserving every sibling and its order', () => {
  const raw = [
    '{',
    '  "mcpServers": {',
    '    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\books"] },',
    '    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }',
    '  },',
    '  "globalShortcut": "Alt+Space"',
    '}',
    ''
  ].join('\n');
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  const merged = JSON.parse(r.content);
  assert.deepEqual(Object.keys(merged), ['mcpServers', 'globalShortcut'], 'unrelated top-level keys keep their place');
  assert.deepEqual(Object.keys(merged.mcpServers), ['filesystem', 'memory', 'Tally Prime']);
  assert.deepEqual(merged.mcpServers.filesystem.args[2], 'D:\\books', 'a sibling\'s Windows path survives the round-trip');
  assert.deepEqual(merged.mcpServers['Tally Prime'], cdEntry);
});

test('creates the whole document when the file does not exist yet', () => {
  const r = ok(applyEntryToText(null, VSC, vscEntry));
  assert.equal(r.changed, true);
  assert.equal(r.status.state, 'absent');
  assert.equal(r.content, '{\n  "servers": {\n    "tally-prime": {\n      "type": "stdio",\n      "command": "'
    + NODE.replace(/\\/g, '\\\\') + '",\n      "args": [\n        "'
    + launch.args[0].replace(/\\/g, '\\\\') + '"\n      ]\n    }\n  }\n}\n');
});

test('keeps the user\'s indent unit and line endings when it does rewrite', () => {
  const raw = '{\r\n    "mcpServers": {\r\n        "memory": { "command": "npx" }\r\n    }\r\n}\r\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  assert.match(r.content, /^\{\r\n    "mcpServers": \{\r\n        "memory"/);
  assert.equal(/(?<!\r)\n/.test(r.content), false, 'no bare LF may survive in a CRLF file');
  assert.equal(r.content.endsWith('\r\n'), true);
});

test('serializeClientConfig always ends the file with exactly one newline', () => {
  const out = serializeClientConfig({ a: 1 });
  assert.equal(out, '{\n  "a": 1\n}\n');
});

// --- idempotency ---

test('applying twice is byte-identical, and the second apply writes nothing at all', () => {
  const first = ok(applyEntryToText('{\n  "mcpServers": {\n    "memory": { "command": "npx" }\n  }\n}\n', CD, cdEntry));
  assert.equal(first.changed, true);
  const second = ok(applyEntryToText(first.content, CD, cdEntry));
  assert.equal(second.changed, false, 'a deep-equal entry must be a zero-byte no-op');
  assert.equal(second.status.state, 'ours');
  assert.equal(second.status.current, true);
  assert.equal(second.content, first.content);
  const third = ok(applyEntryToText(second.content, CD, cdEntry));
  assert.equal(third.content, first.content);
});

test('an already-correct entry is NOT rewritten merely to reformat the file', () => {
  // Same entry, but the file is formatted nothing like ours: 4-space indent, keys in another order.
  const raw = '{\n    "mcpServers": {\n        "Tally Prime": {\n            "command": '
    + JSON.stringify(NODE) + ',\n            "args": [' + JSON.stringify(launch.args[0]) + ']\n        }\n    }\n}\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, false);
  assert.equal(r.content, raw, 'the original bytes must come back untouched');
});

// --- ownership: ours / stale / hijacked ---

test('status reports absent when our key is not there', () => {
  const s = statusOfEntry({ mcpServers: { memory: {} } }, CD, cdEntry);
  assert.deepEqual(s, { state: 'absent', current: false, existing: null, merged: cdEntry });
});

test('an entry launching the same script from a MOVED install is ours-but-stale, and gets updated', () => {
  // Reinstall to another directory, or a Node upgrade: identity is the launched script, not the
  // node.exe path, so this must not read as a hijack.
  const old = { command: 'C:\\nvm\\v20.11.0\\node.exe', args: ['D:\\Apps\\TallyMCP\\dist\\index.mjs'] };
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': old } }, null, 2) + '\n';
  const s = statusOfEntry(JSON.parse(raw), CD, cdEntry);
  assert.equal(s.state, 'ours');
  assert.equal(s.current, false);
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.content).mcpServers['Tally Prime'], cdEntry);
});

test('HIJACKED: our key pointing at somebody else\'s server is never overwritten', () => {
  const raw = JSON.stringify({
    mcpServers: {
      'Tally Prime': { command: 'npx', args: ['-y', '@someone/other-server'] },
      memory: { command: 'npx' }
    }
  }, null, 2) + '\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.status.state, 'hijacked');
  assert.equal(r.changed, false);
  assert.equal(r.content, raw);
  assert.match(r.note ?? '', /points elsewhere/);
});

test('HIJACKED: a remote (url) entry under our key is not clobbered by a local apply', () => {
  // #178 writes a url-shaped entry under the same name; a local-mode apply must report the clash
  // rather than silently converting the user's remote connector into a stdio one.
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': { url: 'https://books.example/mcp' } } }, null, 2) + '\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.status.state, 'hijacked');
  assert.equal(r.changed, false);
});

test('entryIdentity: url entries compare by url, script entries by the last two path segments', () => {
  assert.deepEqual(entryIdentity({ url: 'https://Books.example/mcp/' }), { kind: 'url', url: 'https://books.example/mcp' });
  assert.deepEqual(entryIdentity({ command: 'node', args: ['C:\\X\\dist\\index.mjs'] }), { kind: 'script', tail: 'dist/index.mjs' });
  assert.deepEqual(entryIdentity({ command: 'node', args: ['/opt/x/dist/index.mjs'] }), { kind: 'script', tail: 'dist/index.mjs' });
  // No script argument at all: fall back to the command so launcher entries still compare.
  assert.deepEqual(entryIdentity({ command: 'C:\\Apps\\Tally MCP\\tally-mcp.exe' }), { kind: 'script', tail: 'tally mcp/tally-mcp.exe' });
  assert.deepEqual(entryIdentity({ note: 'not a server' }), { kind: 'unknown' });
  assert.deepEqual(entryIdentity('nonsense'), { kind: 'unknown' });
});

test('an unidentifiable entry under our key counts as hijacked, not as ours', () => {
  const raw = '{"mcpServers": {"Tally Prime": {"disabled": true}}}';
  assert.equal(ok(applyEntryToText(raw, CD, cdEntry)).status.state, 'hijacked');
});

// --- an update must not eat what the user put INSIDE our own entry ---

test('updating our entry keeps keys the user added to it (env, disabled) and its key order', () => {
  // The realistic case: Tally runs on another machine, so the accountant hand-added an env block —
  // or they switched the server off with disabled:true. An upgrade that silently reverts either of
  // those is the same class of data loss as clobbering a sibling server.
  const stale = {
    command: 'C:\\nvm\\v20.11.0\\node.exe',
    args: ['D:\\Old Install\\dist\\index.mjs'],
    env: { TALLY_HOST: '192.168.1.5', TALLY_PORT: '9000' },
    disabled: true
  };
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': stale } }, null, 2) + '\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  const after = JSON.parse(r.content).mcpServers['Tally Prime'];
  assert.equal(after.command, NODE, 'the launch line IS ours, so it is updated');
  assert.deepEqual(after.args, launch.args);
  assert.deepEqual(after.env, { TALLY_HOST: '192.168.1.5', TALLY_PORT: '9000' }, 'the user\'s env must survive the upgrade');
  assert.equal(after.disabled, true, 'an upgrade must not silently re-enable a server the user switched off');
  assert.deepEqual(Object.keys(after), ['command', 'args', 'env', 'disabled'], 'existing keys keep their position');
});

test('preserving those extra keys stays idempotent — it must not rewrite forever', () => {
  // The trap in the fix: if `current` were judged against the canonical entry rather than against
  // what we would actually write, an entry carrying the user's env would read as stale on every
  // single run and we would re-write (and re-back-up) identical bytes for ever.
  const raw = JSON.stringify({
    mcpServers: { 'Tally Prime': { ...cdEntry, env: { TALLY_HOST: '192.168.1.5' } } }
  }, null, 2) + '\n';
  const r = ok(applyEntryToText(raw, CD, cdEntry));
  assert.equal(r.changed, false, 'nothing left to do: the file already holds what we would write');
  assert.equal(r.content, raw);
  assert.equal(r.status.state, 'ours');
  assert.equal(r.status.current, true);
});

test('mergeEntry lays our keys over the user\'s and never inherits from a non-object', () => {
  assert.deepEqual(mergeEntry({ args: ['old'], keep: 1 }, { command: 'n', args: ['new'] }),
    { args: ['new'], keep: 1, command: 'n' });
  assert.deepEqual(mergeEntry('nonsense', cdEntry), cdEntry);
  assert.notEqual(mergeEntry('nonsense', cdEntry), cdEntry, 'must be a copy, not the caller\'s object');
});

// --- a BOM is a broken client, not a formatting preference ---

test('a BOM is stripped even when the entry is already correct, because the client cannot load it', () => {
  // Without this the installer reports "up to date", exits 0, and Claude Desktop still cannot read
  // its own config: Electron's JSON.parse throws on a leading U+FEFF.
  const good = ok(applyEntryToText(null, CD, cdEntry)).content;
  const r = ok(applyEntryToText('\uFEFF' + good, CD, cdEntry));
  assert.equal(r.changed, true, 'a BOM alone is reason enough to rewrite');
  assert.equal(r.bomStripped, true);
  assert.notEqual(r.content.charCodeAt(0), 0xfeff);
  assert.doesNotThrow(() => JSON.parse(r.content));
  // ...and stripping it is still idempotent: the rewrite emits no BOM, so the next run is a no-op.
  const again = ok(applyEntryToText(r.content, CD, cdEntry));
  assert.equal(again.changed, false);
  assert.equal(again.bomStripped, false);
  assert.equal(again.content, r.content);
});

// --- refusal beats the comment gate: report the real problem ---

test('an un-mergeable servers key is REFUSED even when the file also has comments', () => {
  // Otherwise the user is told "we would delete your comments" (a choice we made) when the truth is
  // that the file cannot be merged at all (something they must fix) — and the CLI exits 2, not 1.
  const r = applyEntryToText('{ // note\n  "servers": "nope"\n}', VSC, vscEntry);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.reason, /expected an object/);
});

test('for a client that cannot parse comments at all, the note says so instead of offering to keep them', () => {
  const r = ok(applyEntryToText('{ // hand-edited\n  "mcpServers": {}\n}', CD, cdEntry));
  assert.equal(r.changed, false);
  assert.match(r.note ?? '', /already unreadable by the client/);
  // The JSONC target keeps the other wording, because there the comments are legal.
  const v = ok(applyEntryToText('{ // hand-edited\n  "servers": {}\n}', VSC, vscEntry));
  assert.match(v.note ?? '', /a rewrite would delete/);
  assert.equal(/already unreadable/.test(v.note ?? ''), false);
});

// --- JSONC comments on write: refuse, do not destroy silently ---

const COMMENTED = [
  '{',
  '  // our books workspace — do not commit secrets here',
  '  "servers": {',
  '    "memory": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }',
  '  }',
  '}',
  ''
].join('\n');

test('a commented mcp.json is NOT silently rewritten; the loss is surfaced instead', () => {
  const r = ok(applyEntryToText(COMMENTED, VSC, vscEntry));
  assert.equal(r.changed, false);
  assert.equal(r.content, COMMENTED);
  assert.equal(r.commentsDropped, false);
  assert.match(r.note ?? '', /comments/);
});

test('with the loss accepted explicitly, the merge proceeds and says the comments went', () => {
  const r = ok(applyEntryToText(COMMENTED, VSC, vscEntry, { allowCommentLoss: true }));
  assert.equal(r.changed, true);
  assert.equal(r.commentsDropped, true);
  assert.equal(r.content.includes('do not commit secrets'), false);
  const merged = JSON.parse(r.content);
  assert.deepEqual(Object.keys(merged.servers), ['memory', 'tally-prime']);
});

test('a commented file that needs no change keeps its comments, because nothing is written', () => {
  const withUs = ok(applyEntryToText(COMMENTED, VSC, vscEntry, { allowCommentLoss: true })).content;
  const recommented = '// hand-added note\n' + withUs;
  const r = ok(applyEntryToText(recommented, VSC, vscEntry));
  assert.equal(r.changed, false);
  assert.equal(r.content, recommented);
  assert.equal(r.note, undefined, 'no change was needed, so there is nothing to warn about');
});

// --- removal is gated on the entry still being ours ---

test('remove takes out our entry and leaves every sibling alone', () => {
  const raw = JSON.stringify({
    mcpServers: { memory: { command: 'npx' }, 'Tally Prime': cdEntry },
    globalShortcut: 'Alt+Space'
  }, null, 2) + '\n';
  const r = ok(removeEntryFromText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  const after = JSON.parse(r.content);
  assert.deepEqual(Object.keys(after.mcpServers), ['memory']);
  assert.equal(after.globalShortcut, 'Alt+Space');
});

test('remove still fires when the entry is ours but stale (uninstalling a moved install)', () => {
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': { command: 'node', args: ['D:\\old\\dist\\index.mjs'] } } }, null, 2) + '\n';
  const r = ok(removeEntryFromText(raw, CD, cdEntry));
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.content).mcpServers, {});
});

test('remove REFUSES to delete an entry someone else changed', () => {
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': { command: 'npx', args: ['-y', '@someone/other-server'] } } }, null, 2) + '\n';
  const r = ok(removeEntryFromText(raw, CD, cdEntry));
  assert.equal(r.status.state, 'hijacked');
  assert.equal(r.changed, false);
  assert.equal(r.content, raw);
  assert.match(r.note ?? '', /leaving it alone/);
});

test('remove on a config that never had us is a no-op, not an error', () => {
  const raw = '{\n  "mcpServers": {\n    "memory": { "command": "npx" }\n  }\n}\n';
  const r = ok(removeEntryFromText(raw, CD, cdEntry));
  assert.equal(r.status.state, 'absent');
  assert.equal(r.changed, false);
  assert.equal(r.content, raw);
});

test('remove leaves an empty servers map in place rather than deleting a key we never created', () => {
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': cdEntry } }, null, 2) + '\n';
  const after = JSON.parse(ok(removeEntryFromText(raw, CD, cdEntry)).content);
  assert.deepEqual(after, { mcpServers: {} });
});

test('remove refuses an unparseable file too', () => {
  assert.equal(removeEntryFromText('{ oops', CD, cdEntry).ok, false);
});

test('remove on a missing file is a no-op', () => {
  const r = ok(removeEntryFromText(null, CD, cdEntry));
  assert.equal(r.changed, false);
  assert.equal(r.status.state, 'absent');
});

// --- CLI argument parsing (the CLI itself only does file IO) ---

test('a bare invocation defaults to the read-only command', () => {
  const o = parseCliArgs([]);
  assert.equal(o.command, 'status');
  assert.equal(o.dryRun, false);
  assert.deepEqual(o.targets, ['claude-desktop', 'cursor', 'vscode']);
});

test('flags parse, and --target all expands to every target', () => {
  const o = parseCliArgs(['apply', '--target', 'all', '--workspace', 'D:\\books\\acme', '--install-root', INSTALL, '--node', NODE, '--json', '--allow-comment-loss']);
  assert.equal(o.command, 'apply');
  assert.deepEqual(o.targets, CLIENT_TARGETS.map(t => t.id));
  assert.equal(o.workspace, 'D:\\books\\acme');
  assert.equal(o.installRoot, INSTALL);
  assert.equal(o.nodeExe, NODE);
  assert.equal(o.json, true);
  assert.equal(o.allowCommentLoss, true);
});

test('a leading flag is not mistaken for a command', () => {
  const o = parseCliArgs(['--target', 'vscode']);
  assert.equal(o.command, 'status');
  assert.deepEqual(o.targets, ['vscode']);
});

test('a MISTYPED flag is rejected, not ignored — ignoring it silently widens the blast radius', () => {
  // `--targett vscode` used to parse as "no target given", and the default for that is EVERY
  // target: a typo turned "write this workspace's mcp.json" into "also write the user's real
  // Claude Desktop config".
  assert.throws(() => parseCliArgs(['apply', '--targett', 'vscode']), /unknown option: --targett/);
  assert.throws(() => parseCliArgs(['apply', 'extra']), /unexpected argument: extra/);
  assert.throws(() => parseCliArgs(['apply', '--target', 'emacs']), /unknown target: emacs/);
});

test('a flag with no value is rejected instead of crashing inside path.join', () => {
  assert.throws(() => parseCliArgs(['apply', '--install-root']), /--install-root needs a value/);
  // The next flag is a missing value, not a value: "--json/.vscode/mcp.json" is not a real path.
  assert.throws(() => parseCliArgs(['apply', '--workspace', '--json']), /--workspace needs a value/);
});

// --- both targets behave the same way, because the targets are data ---

for (const target of CLIENT_TARGETS) {
  const entry = (target as ClientTarget).buildEntry(launch);
  test(`${target.id}: create → idempotent re-apply → gated removal`, () => {
    const created = ok(applyEntryToText(null, target, entry));
    assert.equal(created.changed, true);
    const again = ok(applyEntryToText(created.content, target, entry));
    assert.equal(again.changed, false);
    assert.equal(again.content, created.content);
    const removed = ok(removeEntryFromText(created.content, target, entry));
    assert.equal(removed.changed, true);
    assert.deepEqual(JSON.parse(removed.content)[target.serversKey], {});
  });
}

// --- the thin IO layer: backup, atomic write, no-write on no-change ---

test('applyToFile creates the file and its parent directory, with no BOM on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cc-'));
  const file = path.join(dir, '.vscode', 'mcp.json');
  const res = applyToFile(VSC, file, vscEntry);
  assert.equal(res.wrote, true);
  assert.equal(res.backup, null, 'nothing to back up when we created the file');
  const bytes = fs.readFileSync(file);
  assert.notEqual(bytes[0], 0xef, 'a UTF-8 BOM starts EF BB BF and breaks the client that reads this');
  assert.deepEqual(JSON.parse(bytes.toString('utf-8')).servers['tally-prime'], vscEntry);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyToFile backs the file up before changing it, and writes nothing on a re-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cc-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  const before = '{\n  "mcpServers": {\n    "memory": { "command": "npx" }\n  }\n}\n';
  fs.writeFileSync(file, before, 'utf-8');

  const first = applyToFile(CD, file, cdEntry);
  assert.equal(first.wrote, true);
  assert.equal(fs.readFileSync(first.backup!, 'utf-8'), before, 'the backup must hold the user\'s pre-merge file');
  const written = fs.readFileSync(file, 'utf-8');

  const second = applyToFile(CD, file, cdEntry);
  assert.equal(second.wrote, false, 'an unchanged config must not be rewritten');
  assert.equal(second.backup, null, 'and must not spawn another backup on every re-run');
  assert.equal(fs.readFileSync(file, 'utf-8'), written);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.bak')).length, 1);

  // No .tmp.* orphans left behind by the atomic write.
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp.')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two backups in the same instant do not overwrite each other', () => {
  // The user's ONLY copy of their other MCP servers lives in that first .bak. A second-resolution
  // timestamp let an apply and an immediate reconfigure collide on the name and destroy it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cc-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  fs.writeFileSync(file, '{"mcpServers":{"memory":{"command":"npx"}}}\n', 'utf-8');
  const frozen = new Date('2026-09-09T10:15:00.123Z');
  const a = backupConfigFile(file, frozen);
  fs.writeFileSync(file, '{"mcpServers":{}}\n', 'utf-8');
  const b = backupConfigFile(file, frozen);
  assert.notEqual(a, b, 'the same instant must not yield the same backup name');
  assert.match(fs.readFileSync(a, 'utf-8'), /memory/, 'the first backup must still hold the pre-merge file');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.bak')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a BOM\'d but otherwise correct file on disk is repaired, then left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cc-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  const good = ok(applyEntryToText(null, CD, cdEntry)).content;
  fs.writeFileSync(file, String.fromCharCode(0xfeff) + good, 'utf-8'); // built from a code point, not a literal BOM: an invisible char in source is unreviewable
  const first = applyToFile(CD, file, cdEntry);
  assert.equal(first.wrote, true, 'a config the client cannot parse must not be reported as up to date');
  assert.deepEqual(Array.from(fs.readFileSync(file).subarray(0, 3)), [0x7b, 0x0a, 0x20], 'file must start with "{\\n "');
  assert.equal(applyToFile(CD, file, cdEntry).wrote, false, 'and the repair must not repeat every run');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeFromFile leaves a hijacked entry — and the file\'s bytes — alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cc-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  const raw = JSON.stringify({ mcpServers: { 'Tally Prime': { command: 'npx', args: ['-y', '@someone/other'] } } }, null, 4) + '\n';
  fs.writeFileSync(file, raw, 'utf-8');
  const res = removeFromFile(CD, file, cdEntry);
  assert.equal(res.wrote, false);
  assert.equal(fs.readFileSync(file, 'utf-8'), raw);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the CLI's exit-code contract, exercised as a real process ---
//
// The installer step (#172 B2) branches on these codes, and nothing else in this file proves them:
// runCli is only reachable in-process by importing the module, and the point of the guard at the
// foot of client-config.mts is that importing must NOT run the CLI. So this spawns the built
// module. Every case pins --target vscode with a temp --workspace, because a stray claude-desktop
// target would resolve to the developer's own %APPDATA% config and write to it.

const CLI = fileURLToPath(new URL('./client-config.mjs', import.meta.url));

function cli(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--target', 'vscode', '--install-root', INSTALL, '--node', NODE], { encoding: 'utf-8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cli-'));
const mcpJson = (ws: string) => path.join(ws, '.vscode', 'mcp.json');

test('CLI: apply writes and exits 0; a second apply is a no-op that still exits 0', () => {
  const ws = workspace();
  assert.equal(cli(['apply', '--workspace', ws]).code, 0);
  const written = fs.readFileSync(mcpJson(ws), 'utf-8');
  // Build the expectation with the REAL path module, exactly as runCli does. The shared fixture
  // above is pinned to path.win32 so the pure-function tests assert Windows semantics on any host -
  // but the CLI resolves with whatever platform it is running on. Comparing the two passed on
  // Windows and failed on the Linux CI runner, where path.join yields
  // 'C:\Program Files\...\dist/index.mjs': a mixed separator that is wrong on both platforms and
  // only ever appeared because the test asserted a Windows shape from a POSIX run.
  const cliEntry = VSC.buildEntry(localLaunchSpec(INSTALL, NODE));
  assert.deepEqual(JSON.parse(written).servers['tally-prime'], cliEntry);

  const second = cli(['apply', '--workspace', ws]);
  assert.equal(second.code, 0);
  assert.match(second.out, /up to date/);
  assert.equal(fs.readFileSync(mcpJson(ws), 'utf-8'), written, 're-running must not touch the bytes');
  assert.deepEqual(fs.readdirSync(path.join(ws, '.vscode')).filter(f => f.endsWith('.bak')), [], 'nor spawn a backup');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: status is read-only — it never creates the file it reports on', () => {
  const ws = workspace();
  const r = cli(['status', '--workspace', ws]);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(mcpJson(ws)), false, 'status must not create anything');
  assert.equal(fs.existsSync(path.join(ws, '.vscode')), false, 'not even the directory');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: exit 2 is "we deliberately did nothing" — a hijacked entry, left byte-identical', () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws, '.vscode'));
  const raw = JSON.stringify({ servers: { 'tally-prime': { type: 'stdio', command: 'npx', args: ['-y', '@someone/other'] } } }, null, 2) + '\n';
  fs.writeFileSync(mcpJson(ws), raw, 'utf-8');
  const r = cli(['apply', '--workspace', ws]);
  assert.equal(r.code, 2, 'a hijack must be distinguishable from both success and failure');
  assert.match(r.out, /points elsewhere/);
  assert.equal(fs.readFileSync(mcpJson(ws), 'utf-8'), raw);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: exit 1 is "a human must look at this" — an unparseable file, left untouched', () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws, '.vscode'));
  const raw = '{ "servers": { "memory": ';
  fs.writeFileSync(mcpJson(ws), raw, 'utf-8');
  const r = cli(['apply', '--workspace', ws]);
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(mcpJson(ws), 'utf-8'), raw, 'the file we could not read is the file we must not write');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: a bad command line exits 1 with a message, not a stack trace, and writes nothing', () => {
  const ws = workspace();
  const r = cli(['apply', '--workspace', ws, '--allow-comments']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option: --allow-comments/);
  assert.equal(/at .*client-config\.mjs:\d+/.test(r.err), false, 'a wizard shows this to an accountant');
  assert.equal(fs.existsSync(mcpJson(ws)), false, 'a rejected command line must never reach the write path');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('CLI: remove is gated the same way, and reports the same codes', () => {
  const ws = workspace();
  assert.equal(cli(['apply', '--workspace', ws]).code, 0);
  assert.equal(cli(['remove', '--workspace', ws]).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(mcpJson(ws), 'utf-8')).servers, {});
  assert.equal(cli(['remove', '--workspace', ws]).code, 0, 'removing twice is not an error');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('importing the module from another script does NOT run the CLI', () => {
  // The guard at the foot of client-config.mts. If it regressed, merely importing this module from
  // an installer script — or from #178's bridge — would read, and could write, the user's real
  // config, and process.exit out of the middle of the caller.
  //
  // The importer is a real FILE, not `node -e`, on purpose: under -e process.argv[1] is undefined,
  // so a guard weakened to a bare `process.argv[1] !== undefined` would still look correct there.
  // Importing from a script is the shape that actually occurs and the shape that catches it.
  //
  // This assertion is only observable because the module sets process.exitCode instead of calling
  // process.exit(): with process.exit() a misfiring guard killed its importer — including this test
  // file, mid-import — and node:test then reported one passing file with zero tests inside, so the
  // regression came out GREEN. Do not put process.exit() back at the foot of that module.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-imp-'));
  const importer = path.join(dir, 'importer.mjs');
  fs.writeFileSync(importer, `import { runCli } from ${JSON.stringify(pathToFileURL(CLI).href)};\nconsole.log('loaded', typeof runCli);\n`, 'utf-8');
  const r = spawnSync(process.execPath, [importer], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'loaded function', 'the CLI must produce no output when merely imported');
  assert.equal(r.stderr, '', 'no CLI output of any kind on import');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- #172 E1: strict ownership for the uninstaller's sweep across other profiles ---
//
// entryIdentity compares only the script TAIL, so an entry survives a legitimate move of the
// install directory. That tolerance is right for our own user and WRONG when deciding whether to
// delete something out of a colleague's profile: their fork at D:\\my-fork\\dist\\index.mjs has the
// same tail as ours. entryPointsInside is the stricter question the uninstaller asks instead.

const ROOT = 'C:\\Program Files\\TallyMCP';

test('entryPointsInside accepts an entry whose script is inside the install root', () => {
  const entry = { command: 'node', args: [ROOT + '\\dist\\index.mjs'] };
  assert.equal(entryPointsInside(entry, ROOT, path.win32), true);
});

test('entryPointsInside REJECTS a fork with an identical script tail', () => {
  // The exact case that would have deleted a colleague's entry: same tail, different install.
  const fork = { command: 'node', args: ['D:\\my-fork\\dist\\index.mjs'] };
  assert.equal(entryPointsInside(fork, ROOT, path.win32), false);
  // ...while the tolerant identity check cannot tell them apart, which is why this exists.
  assert.deepEqual(entryIdentity(fork), entryIdentity({ command: 'node', args: [ROOT + '\\dist\\index.mjs'] }));
});

test('entryPointsInside is case-insensitive on Windows paths', () => {
  const entry = { command: 'node', args: ['c:\\program files\\tallymcp\\dist\\index.mjs'] };
  assert.equal(entryPointsInside(entry, ROOT, path.win32), true);
});

test('entryPointsInside refuses a sibling directory that merely shares the prefix', () => {
  const entry = { command: 'node', args: ['C:\\Program Files\\TallyMCP-old\\dist\\index.mjs'] };
  assert.equal(entryPointsInside(entry, ROOT, path.win32), false);
});

test('entryPointsInside also considers the command, for launcher-style entries', () => {
  const entry = { command: ROOT + '\\bin\\tally-mcp.exe', args: [] };
  assert.equal(entryPointsInside(entry, ROOT, path.win32), true);
});

test('entryPointsInside says no when there is no install root to compare against', () => {
  assert.equal(entryPointsInside({ command: 'node', args: ['x.mjs'] }, '', path.win32), false);
});

// --- connection details for clients with no target (custom agents, other AI apps) ---

const showModule = await import('./client-config.mjs');

test('connectionDetails: the stdio block is the generic mcpServers shape, with Windows paths intact', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'local' });
  assert.deepEqual(d.stdio, { command: NODE, args: ['C:\\Program Files\\Tally MCP Server\\dist\\index.mjs'] });
  assert.deepEqual(d.mcpServers, { mcpServers: { 'tally-prime': d.stdio } });
  // What gets pasted must be valid JSON that round-trips to the same paths (backslashes escaped once).
  const text = showModule.formatConnectionDetails(d);
  const block = text.slice(text.indexOf('{'), text.lastIndexOf('}\n') + 1);
  assert.deepEqual(JSON.parse(block), d.mcpServers);
  assert.match(text, /Command   : C:\\Program Files\\nodejs\\node\.exe/);
  assert.equal(/[^\x00-\x7f]/.test(text), false, 'plain ASCII: it goes through a Windows console and the clipboard');
});

test('connectionDetails: local mode offers no URL, and says why', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  // MCP_DOMAIN is present in every .env copied from .env.example; local mode must still win.
  const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'local', MCP_DOMAIN: 'http://localhost:3000' });
  assert.equal(d.http, null);
  assert.match(d.httpUnavailable!, /local mode/);
  const text = showModule.formatConnectionDetails(d);
  assert.match(text, /Not available\. This install is in local mode/);
  assert.doesNotMatch(text, /URL       :/);
});

test('connectionDetails: a remote install gives the /mcp URL; no address means no URL', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  for (const [domain, url] of [
    ['https://tally.example.com', 'https://tally.example.com/mcp'],
    ['https://tally.example.com/', 'https://tally.example.com/mcp'],
    ['  http://localhost:3000  ', 'http://localhost:3000/mcp'],
  ]) {
    for (const mode of ['remote', '', undefined]) { // an install predating the key is a remote one
      const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: mode, MCP_DOMAIN: domain });
      assert.equal(d.http!.url, url, `${domain} / ${mode}`);
      assert.equal(d.http!.transport, 'streamable-http');
      assert.equal(d.http!.auth, 'oauth2.1');
      assert.match(showModule.formatConnectionDetails(d), new RegExp(`URL       : ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\n`));
    }
  }
  for (const domain of [undefined, '', 'tally.example.com', 'ftp://x']) {
    const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'remote', MCP_DOMAIN: domain });
    assert.equal(d.http, null, String(domain));
    assert.match(d.httpUnavailable!, /MCP_DOMAIN/);
  }
});

test('CLI: show prints the details from the install .env, writes nothing, and needs no target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-show-'));
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, 'show', '--install-root', root, '--node', NODE, ...args], { encoding: 'utf-8' });

  // No .env at all: still prints the stdio half.
  let r = run(['--json']);
  assert.equal(r.status, 0);
  let out = JSON.parse(r.stdout);
  assert.equal(out.command, 'show');
  assert.deepEqual(out.stdio, { command: NODE, args: [path.join(root, 'dist', 'index.mjs')] });
  assert.equal(out.http, null);

  fs.writeFileSync(path.join(root, '.env'), 'DEPLOYMENT_MODE=remote\nMCP_DOMAIN="https://books.example.com"  # public address\n');
  out = JSON.parse(run(['--json']).stdout);
  assert.equal(out.http.url, 'https://books.example.com/mcp');

  r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Claudally connection details/);
  assert.match(r.stdout, /URL       : https:\/\/books\.example\.com\/mcp/);

  fs.writeFileSync(path.join(root, '.env'), 'DEPLOYMENT_MODE=local\nMCP_DOMAIN=http://localhost:3000\n');
  assert.equal(JSON.parse(run(['--json']).stdout).http, null);

  assert.deepEqual(fs.readdirSync(root), ['.env'], 'show must not create anything in the install');
  fs.rmSync(root, { recursive: true, force: true });
});

test('cloud assistants: a public https address lists each product with the URL filled in', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'remote', MCP_DOMAIN: 'https://books.example.com' });
  assert.equal(d.http!.cloudUnreachable, null);
  assert.equal(d.http!.nonStandardPort, false);
  const text = showModule.formatConnectionDetails(d);
  assert.match(text, /3\. CLOUD ASSISTANTS/);
  for (const a of showModule.CLOUD_ASSISTANTS) {
    assert.ok(text.includes(a.label), a.label);
    assert.ok(text.includes(a.docs), a.docs);
    assert.equal(a.steps.filter((step: string) => step.includes('{url}')).length, 1, `${a.id}: exactly one step carries the URL`);
    assert.match(a.docs, /^https:\/\//);
  }
  assert.equal(text.includes('{url}'), false, 'no unfilled placeholder');
  assert.equal(text.split('https://books.example.com/mcp').length - 1, 1 + showModule.CLOUD_ASSISTANTS.length);
  assert.equal(/[^\x00-\x7f]/.test(text), false, 'plain ASCII');
  assert.deepEqual(showModule.CLOUD_ASSISTANTS.map((a: { id: string }) => a.id), ['claude', 'chatgpt', 'copilot-studio', 'gemini', 'le-chat']);
});

test('cloud assistants: an address they cannot reach gets an explanation, not instructions', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  const unreachable: [string, RegExp][] = [
    ['http://books.example.com', /not https/],
    ['https://localhost:3000', /this PC or the local network/],
    ['https://127.0.0.1', /this PC or the local network/],
    ['https://192.168.1.20', /this PC or the local network/],
    ['https://10.0.0.5:8443', /this PC or the local network/],
    ['https://172.20.1.1', /this PC or the local network/],
    ['https://[::1]:3000', /this PC or the local network/],
    ['https://tally-pc', /local network name/],
    ['https://tally-pc.local', /local network name/],
  ];
  for (const [domain, why] of unreachable) {
    const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'remote', MCP_DOMAIN: domain });
    assert.match(d.http!.cloudUnreachable!, why, domain);
    const text = showModule.formatConnectionDetails(d);
    assert.match(text, /URL       : /, 'the URL is still shown: an agent on this PC or LAN can use it');
    assert.match(text, /Not available with this address/);
    assert.equal(text.includes('ChatGPT'), false, domain);
  }
  for (const domain of ['https://172.32.0.1', 'https://books.example.com', 'https://x.trycloudflare.com']) {
    assert.equal(showModule.cloudUnreachableReason(`${domain}/mcp`), null, domain);
  }
  // A non-standard port is reachable in general, but Claude will not use it.
  const d = showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'remote', MCP_DOMAIN: 'https://books.example.com:8443' });
  assert.equal(d.http!.cloudUnreachable, null);
  assert.equal(d.http!.nonStandardPort, true);
  assert.match(showModule.formatConnectionDetails(d), /standard https port \(443\)/);
  assert.equal(showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'remote', MCP_DOMAIN: 'https://books.example.com:443' }).http!.nonStandardPort, false);
});

test('command-line tools: each gets its documented add command with the launch line quoted', () => {
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  const node = '"C:\\Program Files\\nodejs\\node.exe"';
  const entry = '"C:\\Program Files\\Tally MCP Server\\dist\\index.mjs"';
  const byId = (id: string) => showModule.CLI_TOOLS.find((t: { id: string }) => t.id === id)!;
  assert.equal(showModule.cliToolCommand(byId('claude-code'), launch), `claude mcp add --scope user --transport stdio tally-prime -- ${node} ${entry}`);
  assert.equal(showModule.cliToolCommand(byId('codex'), launch), `codex mcp add tally-prime -- ${node} ${entry}`);
  assert.equal(showModule.cliToolCommand(byId('gemini-cli'), launch), `gemini mcp add -s user tally-prime ${node} ${entry}`);

  const text = showModule.formatConnectionDetails(showModule.connectionDetails(launch, { DEPLOYMENT_MODE: 'local' }));
  for (const t of showModule.CLI_TOOLS) {
    assert.ok(text.includes(showModule.cliToolCommand(t, launch)), t.id);
    assert.ok(text.includes(t.docs), t.docs);
  }
  // Available in local mode too: these are local stdio clients and need no URL.
  assert.match(text, /Not available\. This install is in local mode/);
  assert.equal(/[^\x00-\x7f]/.test(text), false, 'plain ASCII');
  // The name must satisfy every tool's rule: no spaces (Claude Code, Codex), no underscores (Gemini).
  assert.match(showModule.GENERIC_SERVER_NAME, /^[A-Za-z0-9-]+$/);
});

test('shellQuote: bare when safe, quoted when it has spaces, with shell metacharacters escaped', () => {
  assert.equal(showModule.shellQuote('C:\\node\\node.exe'), 'C:\\node\\node.exe');
  assert.equal(showModule.shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(showModule.shellQuote('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
  // POSIX words are single-quoted, so $ ` " and a trailing backslash-free path need no escaping.
  assert.equal(showModule.shellQuote('/opt/my $app/`x`/"q"'), `'/opt/my $app/\`x\`/"q"'`);
  assert.equal(showModule.shellQuote("/opt/it's here"), `'/opt/it'\\''s here'`);
  // A Windows path keeps its backslashes exactly, including a trailing one.
  assert.equal(showModule.shellQuote('C:\\My Apps\\'), '"C:\\My Apps\\"');
  assert.equal(showModule.shellQuote('C:\\a b\\$x"y`z%P%'), '"C:\\a b\\xyzP"');
  assert.equal(showModule.shellQuote(''), "''");
});

// --- Cursor: a per-user app that is connected only when it is actually installed ---

const CURSOR = targetById('cursor')!;

test('Cursor: the global mcp.json under the home folder, with the entry shape its docs give', () => {
  assert.deepEqual(CURSOR.resolvePath({ home: 'C:\\Users\\asha', p: path.win32 }), { ok: true, file: 'C:\\Users\\asha\\.cursor\\mcp.json' });
  assert.deepEqual(CURSOR.resolvePath({ home: '/home/asha', p: path.posix }), { ok: true, file: '/home/asha/.cursor/mcp.json' });
  assert.equal(CURSOR.appFolder!({ home: 'C:\\Users\\asha', p: path.win32 }), 'C:\\Users\\asha\\.cursor');
  const launch = localLaunchSpec(INSTALL, NODE, path.win32);
  assert.deepEqual(CURSOR.buildEntry(launch), { type: 'stdio', command: NODE, args: [...launch.args] });
  assert.equal(CURSOR.serverName, 'tally-prime');
  assert.equal(CURSOR.jsonc, false);
  // Claude Desktop is pre-written on purpose, so it must NOT have an app-folder gate.
  assert.equal(CD.appFolder, undefined);
});

test('--target apps expands to the per-user apps and leaves the workspace-scoped target out', () => {
  assert.deepEqual(parseCliArgs(['apply', '--target', 'apps']).targets, ['claude-desktop', 'cursor']);
  assert.deepEqual(parseCliArgs(['apply', '--target', 'apps', '--target', 'vscode']).targets, ['claude-desktop', 'cursor', 'vscode']);
  assert.deepEqual(parseCliArgs(['apply', '--target', 'cursor', '--target', 'apps']).targets, ['cursor', 'claude-desktop']);
  assert.equal(parseCliArgs(['remove', '--target', 'cursor', '--home', 'C:\\Users\\asha']).home, 'C:\\Users\\asha');
  assert.throws(() => parseCliArgs(['apply', '--home']), /--home needs a value/);
});

test('CLI: Cursor is skipped when it is not installed, connected when it is, and cleaned up on remove', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cursor-'));
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--target', 'cursor', '--home', home, '--install-root', INSTALL, '--node', NODE, '--json'], { encoding: 'utf-8' });
    return { code: r.status, result: JSON.parse(r.stdout).results[0] };
  };
  const cursorDir = path.join(home, '.cursor');
  const file = path.join(cursorDir, 'mcp.json');

  // Not installed: nothing is created, and it is not an error.
  for (const command of ['apply', 'status']) {
    const r = run([command]);
    assert.equal(r.code, 0, command);
    assert.equal(r.result.notInstalled, true);
    assert.match(r.result.skipped, /does not appear to be installed/);
  }
  assert.deepEqual(fs.readdirSync(home), [], 'no .cursor folder is created for an app that is not there');
  assert.deepEqual(run(['detect']).result, { target: 'cursor', file, exists: false, installed: false });

  // Installed, with another server already configured: ours is merged in beside it.
  fs.mkdirSync(cursorDir);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['-y', 'x'] } } }, null, 2));
  const applied = run(['apply']);
  assert.equal(applied.code, 0);
  assert.equal(applied.result.wrote, true);
  const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(written.mcpServers.other, { command: 'npx', args: ['-y', 'x'] });
  assert.deepEqual(written.mcpServers['tally-prime'], CURSOR.buildEntry(localLaunchSpec(INSTALL, NODE)));
  assert.equal(run(['apply']).result.wrote, false, 'a second apply changes nothing');

  // Installed but no mcp.json yet: the file is created.
  fs.rmSync(file);
  assert.equal(run(['apply']).result.wrote, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers), ['tally-prime']);

  // Remove takes ours out.
  assert.equal(run(['remove']).result.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers?.['tally-prime'], undefined);
  fs.rmSync(home, { recursive: true, force: true });
});
