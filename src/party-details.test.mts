import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';

// Render pull/party-details.xml the same way sendTally() does, and check it stays in step with the
// output fields pull/config.json declares (extractReport maps the F-tags back to column names).
const env = nunjucks.configure({
  tags: { blockStart: '<nunjuck>', blockEnd: '</nunjuck>', variableStart: '{{', variableEnd: '}}', commentStart: '<comment>begin</comment>', commentEnd: '<comment>end</comment>' },
});
const tmpl = fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'party-details.xml'), 'utf-8');
const pullConfig = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'pull', 'config.json'), 'utf-8')
) as { reports: Array<{ name: string; input: Array<{ name: string; validation_regex?: string }>; output: { fields: Array<{ identifier: string; name: string }> } }> };
const report = pullConfig.reports.find(r => r.name === 'party-details')!;

const filters = (xml: string) => [...xml.matchAll(/NAME="McpPartyFilter">([^<]+)</g)].map(m => m[1]);

test('party-details is declared in pull/config.json with a partyType input', () => {
  assert.ok(report, 'pull/config.json has no party-details report');
  const input = report.input.find(i => i.name === 'partyType');
  assert.ok(input);
  const re = new RegExp(input!.validation_regex!, 'i');
  for (const v of ['all', 'debtors', 'creditors']) assert.ok(re.test(v), v);
  assert.equal(re.test('receivable'), false);
});

test('every declared output field has exactly one matching XMLTAG in the template, and vice versa', () => {
  const tags = [...tmpl.matchAll(/<XMLTAG>(F\d\d)<\/XMLTAG>/g)].map(m => m[1]);
  assert.deepEqual([...tags].sort(), report.output.fields.map(f => f.identifier).sort());
  assert.equal(new Set(tags).size, tags.length);
});

test('partyType selects exactly one filter formula', () => {
  assert.deepEqual(filters(env.renderString(tmpl, { partyType: 'debtors' })), ['$$IsBelongsTo:$$GroupSundryDebtors']);
  assert.deepEqual(filters(env.renderString(tmpl, { partyType: 'creditors' })), ['$$IsBelongsTo:$$GroupSundryCreditors']);
  assert.deepEqual(filters(env.renderString(tmpl, { partyType: 'all' })), ['$$IsBelongsTo:$$GroupSundryDebtors OR $$IsBelongsTo:$$GroupSundryCreditors']);
});

test('targetCompany is routed through SVCURRENTCOMPANY and escaped', () => {
  const out = env.renderString(tmpl, { partyType: 'all', targetCompany: 'A & B Traders' });
  assert.match(out, /<SVCURRENTCOMPANY>A &amp; B Traders<\/SVCURRENTCOMPANY>/);
  assert.equal(/<SVCURRENTCOMPANY>/.test(env.renderString(tmpl, { partyType: 'all' })), false);
});
