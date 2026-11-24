/**
 * Builds the Claude Desktop extension: zips mcpb/ into dist-mcpb/claudally-<version>.mcpb (#40).
 *
 * An .mcpb is a ZIP archive with manifest.json at its root. The ZIP is written here with Node
 * built-ins only (zlib's raw DEFLATE plus a table CRC-32) instead of a zip package or the mcpb CLI:
 * the supply-chain policy is no new dependency for something this small, and this script runs in
 * the release job that also builds the installer.
 *
 * The output is reproducible: entries are sorted and every timestamp is fixed, so the same source
 * always gives the same bytes, and the published SHA-256 can be checked by rebuilding.
 *
 * The icon is not committed under mcpb/: it is taken from scripts/tray/assets/claudally-logo.png
 * at build time, the same way pages.yml stages the logo for the site.
 *
 * Usage: node scripts/build-mcpb.mjs [--out DIR]     (default DIR: dist-mcpb)
 * Prints the path of the file it wrote. Exits 1 when the manifest and package.json disagree on the
 * version, or the manifest names an entry point or icon the bundle does not contain.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(repoRoot, 'mcpb');
const ICON_SOURCE = path.join(repoRoot, 'scripts', 'tray', 'assets', 'claudally-logo.png');

// --- CRC-32 (IEEE 802.3, the one ZIP uses). zlib.crc32 only exists from Node 22.2. ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00, the earliest DOS date: fixed so the archive is reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

/**
 * A ZIP archive of `entries` ({ name: 'a/b.txt', data: Buffer }), as one Buffer. DEFLATE when it
 * helps, STORE otherwise. No ZIP64: an extension is a few kilobytes.
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed to extract (2.0)
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by (2.0, MS-DOS attributes)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // 30 extra length, 32 comment length, 34 disk number, 36 internal attrs, 38 external attrs: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Every file under `dir`, as sorted forward-slash paths relative to it. */
export function listFiles(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out.sort();
}

export function buildMcpb(outDir = path.join(repoRoot, 'dist-mcpb')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'manifest.json'), 'utf-8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`mcpb/manifest.json version ${manifest.version} does not match package.json ${pkg.version}; update the manifest`);
  }
  const files = new Map(listFiles(SOURCE).map(rel => [rel, fs.readFileSync(path.join(SOURCE, ...rel.split('/')))]));
  if (manifest.icon && !files.has(manifest.icon)) files.set(manifest.icon, fs.readFileSync(ICON_SOURCE));
  const entryPoint = manifest.server?.entry_point;
  if (!entryPoint || !files.has(entryPoint)) throw new Error(`manifest server.entry_point "${entryPoint}" is not in the bundle`);

  const names = [...files.keys()].sort();
  const zip = buildZip(names.map(name => ({ name, data: files.get(name) })));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `claudally-${pkg.version}.mcpb`);
  fs.writeFileSync(outFile, zip);
  return { file: outFile, entries: names };
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    let outDir;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('-')) outDir = path.resolve(args[++i]);
      else throw new Error(`unknown argument: ${args[i]}\nusage: node scripts/build-mcpb.mjs [--out DIR]`);
    }
    const { file, entries } = buildMcpb(outDir);
    process.stderr.write(`wrote ${entries.length} entries: ${entries.join(', ')}\n`);
    process.stdout.write(`${file}\n`);
  } catch (e) {
    process.stderr.write(`build-mcpb: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
