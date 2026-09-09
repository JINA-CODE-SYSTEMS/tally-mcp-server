/**
 * Fails on Windows paths that have lost their separators.
 *
 * This is not a hypothetical. Paths in this repo are frequently written through layers that
 * treat a backslash as an escape introducer, and when one is eaten the result is a string
 * that still looks path-shaped:
 *
 *   "C:\Program Files\TallyMCP\scripts\verify-deployment.ps1"
 *     -> "C:Program FilesTallyMCPscripts\x0Berify-deployment.ps1"       collapsed-path-ok
 *
 * Note what happened to \v: it became a vertical tab and swallowed the letter after it. That
 * exact string shipped in docs/README.md as the command inviting customers to verify our
 * security claims for themselves. The same class of damage put a glued-together
 * %APPDATA% path into the tray, where it made a correctly connected install report
 * "Not connected".
 *
 * Three rules, all cheap:
 *   1. control characters other than tab/CR/LF - the \v, \f, \b, \a residue
 *   2. a drive letter with no separator after it   (C:Program)                  collapsed-path-ok
 *   3. a path token glued onto a preceding word    (Claudeclaude_desktop_config.json)  collapsed-path-ok
 *
 * Put `collapsed-path-ok` in a line's own comment to allow a deliberate example - as the
 * three lines above do, since this file has to contain the very thing it rejects.
 *
 * Usage: node scripts/check-collapsed-paths.mjs
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const ALLOW = 'collapsed-path-ok';

const TEXT = /\.(mts|ts|mjs|js|json|md|ps1|psm1|iss|yml|yaml|cs|html|txt)$/i;

const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

// A drive letter is a SINGLE UPPERCASE letter preceded by a non-word character. The non-word
// requirement exempts node:fs, $env:USERNAME, $script:Mode and confirm:true; the uppercase
// requirement exempts CSS pseudo-selectors such as "a:hover" and "p:last-child". A lowercase
// drive letter slips through, which is the price of not drowning in stylesheet false positives.
const DRIVE = /(^|[^\w$:])[A-Z]:(?![\\/])[A-Za-z]/;

// Path tokens that should never sit directly against a preceding word character.
const GLUED = new RegExp('[a-z0-9](?:' + [
  'claude_desktop_config', 'index\.mjs', 'node_modules', 'AppData', 'Roaming',
  'Program Files', 'TallyMCP', 'firstrun-config', 'uninstall-cleanup',
  'connect-client', 'verify-deployment', 'tally-gui-agent',
].join('|') + ')');

const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(f => f && TEXT.test(f) && fs.existsSync(f));

const problems = [];
for (const file of files) {
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) continue;
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    const why = [];
    if (CONTROL.test(line)) {
      const c = line.match(CONTROL)[0].codePointAt(0);
      why.push(`control character U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    if (DRIVE.test(line)) why.push('drive letter with no separator after it');
    if (GLUED.test(line)) why.push('path token glued onto the previous word');
    if (why.length) problems.push({ file, line: i + 1, why, text: line.trim().slice(0, 160) });
  });
}

for (const p of problems) {
  console.log(`::error file=${p.file},line=${p.line}::${p.why.join('; ')} - ${p.text}`);
  console.log(`${p.file}:${p.line}  [${p.why.join(', ')}]`);
  console.log(`    ${p.text}`);
}

console.log(`\nScanned ${files.length} text file(s).`);
if (problems.length) {
  console.log(`${problems.length} line(s) look like a path that lost its backslashes.`);
  console.log(`If one is a deliberate example, add "${ALLOW}" to that line's comment.`);
  process.exit(1);
}
console.log('No collapsed Windows paths.');
