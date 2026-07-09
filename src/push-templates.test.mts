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

test('stock-item master import carries a <NAME> child', () => {
  const out = env.renderString(tmpl('stock-item'), { name: 'Test Item', parentGroup: 'Primary', unit: 'Nos' });
  assert.match(out, /<STOCKITEM NAME="Test Item" ACTION="Create">/);
  assert.match(out, /<NAME>Test Item<\/NAME>/);
});
