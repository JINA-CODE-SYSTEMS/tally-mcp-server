import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';

// Render push/ templates the same way sendTally() does, to prove the master-create envelopes carry
// a <NAME> child element. Without it, Tally silently EXCEPTIONS the import (CREATED 0) — the root
// cause of every create-ledger/create-stock-item failure, confirmed by a live raw-XML probe.
const env = nunjucks.configure({
  tags: { blockStart: '<nunjuck>', blockEnd: '</nunjuck>', variableStart: '{{', variableEnd: '}}', commentStart: '<comment>begin</comment>', commentEnd: '<comment>end</comment>' },
});
const tmpl = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'push', `${name}.xml`), 'utf-8');

// push/config.json is the SAME source handlePush() reads. It projects the caller's params down to
// ONLY the template-declared inputs before rendering (see handlePush in tally.mts) — so a param the
// template references but config.json does NOT declare is silently dropped at runtime, even though
// a direct env.renderString() would happily render it. That gap hid #137: the render tests below
// passed while the live tool emitted no GST tags. renderViaConfig() reproduces handlePush's
// projection so these tests fail if a template's params ever fall out of config.json again.
const pushConfig = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'push', 'config.json'), 'utf-8')
) as { templates: Array<{ name: string; input: Array<{ name: string }> }> };

function renderViaConfig(name: string, callerParams: Record<string, any>): string {
  const t = pushConfig.templates.find(x => x.name === name);
  assert.ok(t, `push/config.json has no template "${name}"`);
  const declared = new Set(t!.input.map(i => i.name));
  const projected: Record<string, any> = {};
  // targetCompany is injected by handlePush itself, not declared as a template input.
  if (callerParams.targetCompany !== undefined) projected.targetCompany = callerParams.targetCompany;
  for (const [k, v] of Object.entries(callerParams)) {
    if (declared.has(k) && v !== undefined && v !== null && v !== '') projected[k] = v;
  }
  return env.renderString(tmpl(name), projected);
}

test('ledger master import carries a <NAME> child (not just the NAME attribute)', () => {
  const out = env.renderString(tmpl('ledger'), { name: 'Test Ledger', parentGroup: 'Bank Accounts', targetCompany: 'ROSS COMPUTERS PVT. LTD.' });
  assert.match(out, /<LEDGER NAME="Test Ledger" ACTION="Create">/);
  assert.match(out, /<NAME>Test Ledger<\/NAME>/); // the child element Tally requires
  assert.match(out, /<PARENT>Bank Accounts<\/PARENT>/);
  assert.match(out, /<SVCURRENTCOMPANY>ROSS COMPUTERS PVT\. LTD\.<\/SVCURRENTCOMPANY>/);
});

// #135: a GST TAX ledger (Duties & Taxes) must carry the duty head so gstr1/gstr2 can classify it.
test('ledger with gstDutyHead emits TAXTYPE=GST + GSTDUTYHEAD', () => {
  const out = env.renderString(tmpl('ledger'), { name: 'Output CGST', parentGroup: 'Duties & Taxes', gstDutyHead: 'CGST' });
  assert.match(out, /<TAXTYPE>GST<\/TAXTYPE>/);
  assert.match(out, /<GSTDUTYHEAD>CGST<\/GSTDUTYHEAD>/);
});

test('ledger without gstDutyHead emits no GST tax tags (non-GST ledgers unchanged)', () => {
  const out = env.renderString(tmpl('ledger'), { name: 'Cash', parentGroup: 'Cash-in-Hand' });
  assert.equal(/<GSTDUTYHEAD>/.test(out), false);
  assert.equal(/<TAXTYPE>/.test(out), false);
});

// #137 regression guard: this routes through the config.json projection, so it FAILS if gstDutyHead
// is ever dropped from the ledger template's declared inputs again (the runtime bug the direct-render
// test above could not catch).
test('#137: create-ledger gstDutyHead survives the config.json input projection', () => {
  const out = renderViaConfig('ledger', { name: 'Output CGST', parentGroup: 'Duties & Taxes', gstDutyHead: 'CGST' });
  assert.match(out, /<TAXTYPE>GST<\/TAXTYPE>/);
  assert.match(out, /<GSTDUTYHEAD>CGST<\/GSTDUTYHEAD>/);
});

// Proves the projection genuinely drops undeclared params — i.e. the exact failure mode of #137 —
// so the guard above is meaningful and not accidentally passing.
test('config projection drops params a template does not declare', () => {
  const out = renderViaConfig('ledger', { name: 'X', parentGroup: 'Sundry Debtors', bogusParam: 'should-vanish' });
  assert.equal(/should-vanish/.test(out), false);
});

// set-ledger-gst (#135): ALTER an existing tax ledger to stamp its GST duty head, routed through
// the config.json projection exactly as the live tool does.
test('ledger-gst ALTERs the ledger with TAXTYPE=GST + GSTDUTYHEAD', () => {
  const out = renderViaConfig('ledger-gst', { name: 'OUTPUT CGST', gstDutyHead: 'CGST', targetCompany: 'ROSS COMPUTERS PVT. LTD.' });
  assert.match(out, /<LEDGER NAME="OUTPUT CGST" ACTION="Alter">/);
  assert.match(out, /<NAME>OUTPUT CGST<\/NAME>/); // Tally requires the child element, not just the attr
  assert.match(out, /<TAXTYPE>GST<\/TAXTYPE>/);
  assert.match(out, /<GSTDUTYHEAD>CGST<\/GSTDUTYHEAD>/);
  assert.match(out, /<SVCURRENTCOMPANY>ROSS COMPUTERS PVT\. LTD\.<\/SVCURRENTCOMPANY>/);
  assert.equal(/ACTION="Create"/.test(out), false); // must never create — only alter
});

// Without gstDutyHead the ALTER carries no GST tags — a safe no-op merge that can't corrupt the ledger.
test('ledger-gst without gstDutyHead emits no GST tags', () => {
  const out = renderViaConfig('ledger-gst', { name: 'OUTPUT CGST' });
  assert.match(out, /<LEDGER NAME="OUTPUT CGST" ACTION="Alter">/);
  assert.equal(/<GSTDUTYHEAD>/.test(out), false);
  assert.equal(/<TAXTYPE>/.test(out), false);
});

test('stock-item master import carries a <NAME> child', () => {
  const out = env.renderString(tmpl('stock-item'), { name: 'Test Item', parentGroup: 'Primary', unit: 'Nos' });
  assert.match(out, /<STOCKITEM NAME="Test Item" ACTION="Create">/);
  assert.match(out, /<NAME>Test Item<\/NAME>/);
});
