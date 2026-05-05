import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTallyIniDataPath, parseTallyIniLoads, rewriteTallyIniLoads } from './mcp.mjs';

const sampleIni = `;;TallyPrime workstation specific parameters file
[TALLY]

Tally Gateway Server=TALLY-MCP-SERVE:9999
User TDL=Yes

Default Companies=Yes
Load=100000

Tally Gold License Server=
Data=C:\\Users\\Public\\TallyPrimeEditLog\\data
ServerPort=9000
`;

test('parseTallyIniLoads finds a single Load entry', () => {
  assert.deepEqual(parseTallyIniLoads(sampleIni), ['100000']);
});

test('parseTallyIniLoads finds multiple Load entries', () => {
  const ini = sampleIni + 'Load=200000\nLoad=300000\n';
  assert.deepEqual(parseTallyIniLoads(ini), ['100000', '200000', '300000']);
});

test('parseTallyIniLoads is case-insensitive on the key', () => {
  const ini = '[TALLY]\nload=100000\nLOAD=200000\nLoad=300000\n';
  assert.deepEqual(parseTallyIniLoads(ini), ['100000', '200000', '300000']);
});

test('parseTallyIniLoads tolerates whitespace', () => {
  const ini = '[TALLY]\n  Load = 100000  \n\tLoad\t=\t200000\n';
  assert.deepEqual(parseTallyIniLoads(ini), ['100000', '200000']);
});

test('parseTallyIniLoads returns empty when no Load lines exist', () => {
  const ini = '[TALLY]\nDefault Companies=Yes\n';
  assert.deepEqual(parseTallyIniLoads(ini), []);
});

test('rewriteTallyIniLoads inserts after Default Companies=', () => {
  const result = rewriteTallyIniLoads(sampleIni, ['100000', '200000']);
  const parsed = parseTallyIniLoads(result);
  assert.deepEqual(parsed, ['100000', '200000']);
  // Inserted right after Default Companies=
  const lines = result.split(/\r?\n/);
  const dcIdx = lines.findIndex(l => /Default Companies=/i.test(l));
  assert.equal(lines[dcIdx + 1], 'Load=100000');
  assert.equal(lines[dcIdx + 2], 'Load=200000');
});

test('rewriteTallyIniLoads removes existing Load lines before adding new', () => {
  const ini = sampleIni + 'Load=900000\nLoad=999999\n';
  const result = rewriteTallyIniLoads(ini, ['100000']);
  assert.deepEqual(parseTallyIniLoads(result), ['100000']);
  assert.ok(!result.includes('Load=900000'));
  assert.ok(!result.includes('Load=999999'));
});

test('rewriteTallyIniLoads with empty list strips all Load lines', () => {
  const result = rewriteTallyIniLoads(sampleIni, []);
  assert.deepEqual(parseTallyIniLoads(result), []);
});

test('rewriteTallyIniLoads preserves all non-Load content', () => {
  const result = rewriteTallyIniLoads(sampleIni, ['200000']);
  assert.ok(result.includes('Tally Gateway Server=TALLY-MCP-SERVE:9999'));
  assert.ok(result.includes('User TDL=Yes'));
  assert.ok(result.includes('Default Companies=Yes'));
  assert.ok(result.includes('ServerPort=9000'));
  assert.ok(result.includes('Data=C:\\Users\\Public\\TallyPrimeEditLog\\data'));
});

test('rewriteTallyIniLoads preserves CRLF line endings', () => {
  const crlf = sampleIni.replace(/\n/g, '\r\n');
  const result = rewriteTallyIniLoads(crlf, ['200000']);
  assert.ok(result.includes('\r\n'), 'expected CRLF preservation');
  assert.ok(!result.includes('\n\n\n'), 'no LF-only blocks should appear');
});

test('rewriteTallyIniLoads falls back to inserting after [TALLY] when no Default Companies=', () => {
  const ini = '[TALLY]\nUser TDL=Yes\nServerPort=9000\n';
  const result = rewriteTallyIniLoads(ini, ['100000']);
  const lines = result.split(/\r?\n/);
  assert.equal(lines[0], '[TALLY]');
  assert.equal(lines[1], 'Load=100000');
});

test('parseTallyIniDataPath extracts the Data= value', () => {
  assert.equal(parseTallyIniDataPath(sampleIni), 'C:\\Users\\Public\\TallyPrimeEditLog\\data');
});

test('parseTallyIniDataPath returns null when Data= is absent', () => {
  const ini = '[TALLY]\nDefault Companies=Yes\nLoad=100000\n';
  assert.equal(parseTallyIniDataPath(ini), null);
});

test('parseTallyIniDataPath tolerates whitespace around the value', () => {
  const ini = '[TALLY]\n  Data  =   D:\\TallyData   \n';
  assert.equal(parseTallyIniDataPath(ini), 'D:\\TallyData');
});

test('parseTallyIniDataPath is case-insensitive on the key', () => {
  const ini = '[TALLY]\nDATA=E:\\backup\\tally\n';
  assert.equal(parseTallyIniDataPath(ini), 'E:\\backup\\tally');
});

test('parseTallyIniDataPath does not confuse Data Path= or Data Files= with Data=', () => {
  const ini = '[TALLY]\nData Path 1=Z:\\elsewhere\nData Files=fake\n';
  assert.equal(parseTallyIniDataPath(ini), null);
});

test('parseTallyIniDataPath handles forward-slash paths', () => {
  const ini = '[TALLY]\nData=/var/lib/tally/data\n';
  assert.equal(parseTallyIniDataPath(ini), '/var/lib/tally/data');
});
