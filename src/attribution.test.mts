import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for the AGPL-3.0 § 7(b) required attribution
// (see NOTICE for the canonical clause). These tests exist so that
// a future refactor that "tidies up" the banner / NOTICE / README
// fails CI rather than silently stripping the attribution.
//
// If you genuinely need to update the wording, change BOTH the
// strings below AND the corresponding source — the test enforces
// equivalence, not specific wording, so legitimate maintenance
// updates are easy. What it prevents is silent removal.

// dist/ layout: this file becomes dist/attribution.test.mjs at runtime, so the
// repo root is two levels up from the test file's directory.
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

const ENTITY = 'Jina Code Systems LLP';

test('package.json author is Jina Code Systems LLP', () => {
  const pkg = JSON.parse(readRepoFile('package.json'));
  assert.equal(pkg.author, ENTITY,
    `package.json "author" must be "${ENTITY}" (AGPL § 7(b) required attribution).`);
});

test('NOTICE contains the copyright line for Jina Code Systems LLP', () => {
  const notice = readRepoFile('NOTICE');
  assert.match(notice, /Copyright \(c\) 2026 Jina Code Systems LLP/,
    'NOTICE must include "Copyright (c) 2026 Jina Code Systems LLP".');
});

test('NOTICE invokes AGPL-3.0 § 7(b) additional terms for required attribution', () => {
  const notice = readRepoFile('NOTICE');
  // Section header is the canonical anchor; downstream may add their own §7(b) text alongside,
  // but ours must remain present and recognisable.
  assert.match(notice, /AGPL-3\.0 SECTION 7\(b\)/i,
    'NOTICE must include the "ADDITIONAL TERMS UNDER AGPL-3.0 SECTION 7(b)" section that fixes the attribution requirement.');
  assert.match(notice, /Jina Code Systems LLP/,
    'NOTICE § 7(b) clause must reference "Jina Code Systems LLP" by name.');
});

test('README has a Jina Code Systems LLP attribution within the first 30 lines', () => {
  const readme = readRepoFile('README.md');
  const head = readme.split('\n').slice(0, 30).join('\n');
  assert.match(head, /Jina Code Systems LLP/,
    'README.md must surface the "Jina Code Systems LLP" attribution prominently (within the first 30 lines).');
});

test('README references AGPL § 7(b) so forks know the attribution is non-removable', () => {
  const readme = readRepoFile('README.md');
  assert.match(readme, /§ ?7\(b\)|Section ?7\(b\)/,
    'README.md must reference AGPL § 7(b) so downstream forks understand the attribution requirement is enforceable.');
});

test('MAINTAINERS.md identifies Jina Code Systems LLP as the maintaining organisation', () => {
  const maint = readRepoFile('MAINTAINERS.md');
  assert.match(maint, /Jina Code Systems LLP/,
    'MAINTAINERS.md must identify "Jina Code Systems LLP" as the maintaining organisation.');
});

test('server.mts startup banner prints the Jina Code Systems LLP attribution', () => {
  // We assert against the source TS file (not the running banner) so the test is a true static
  // gate: the banner has to be IN THE SOURCE, not merely produced by some runtime conditional
  // that could be flipped off via env var. This is the AGPL §7(b)(b) requirement.
  const server = readRepoFile('src/server.mts');
  assert.match(server, /Jina Code Systems LLP/,
    'src/server.mts must print "Jina Code Systems LLP" in the startup banner. ' +
    'This is the §7(b)(b) location ("startup banner / About output").');
  assert.match(server, /AGPL-3\.0/,
    'src/server.mts startup banner must reference the AGPL-3.0 licence.');
});
