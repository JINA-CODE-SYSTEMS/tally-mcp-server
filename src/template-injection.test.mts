import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { findUnsafeTdlLiteralParam, renderPullRequest, renderTallyTemplate } from './tally.mjs';
import { utility } from './utility.mjs';

// Caller-supplied strings (ledger / item names, voucher type and number, reference, company) must
// reach the outgoing Tally XML as inert, escaped text. They must never become part of the template
// source that nunjucks evaluates.

const pullDir = path.join(import.meta.dirname, '..', 'pull');
const pushDir = path.join(import.meta.dirname, '..', 'push');
const pullConfig: { name: string; input: { name: string; datatype: string }[] }[] =
  JSON.parse(fs.readFileSync(path.join(pullDir, 'config.json'), 'utf-8')).reports;
const pushConfig: { name: string; input: { name: string; datatype: string }[] }[] =
  JSON.parse(fs.readFileSync(path.join(pushDir, 'config.json'), 'utf-8')).templates;
const pullTemplate = (name: string) => fs.readFileSync(path.join(pullDir, `${name}.xml`), 'utf-8');

// Template expressions a hostile value might carry. If any of these were evaluated the rendered
// output would contain the product, or the probe global would be set.
const EXPRESSION = '{{ 7*7 }}';
const CODE_PROBE = "{{ range.constructor('globalThis.__tdlProbe = 1')() }}";
// `{param}` placeholders are escaped by utility.String.escapeHTML, `{{ var | escape }}` by nunjucks;
// the two spell an apostrophe differently, so accept either rendering of the same literal text.
const nunjucksEscape = (v: string) => new nunjucks.Environment().getFilter('escape')(v).toString();
const appearsAsLiteral = (out: string, v: string) =>
  out.includes(utility.String.escapeHTML(v)) || out.includes(nunjucksEscape(v));
const hostileValues = [EXPRESSION, CODE_PROBE, '<nunjuck>if true</nunjuck>X<nunjuck>endif</nunjuck>'];

function paramsFor(report: { input: { name: string; datatype: string }[] }, stringValue: string): Map<string, any> {
  const params = new Map<string, any>();
  for (const input of report.input) {
    if (input.datatype === 'string') params.set(input.name, stringValue);
    else if (input.datatype === 'date') params.set(input.name, new Date(2025, 3, 1));
    else if (input.datatype === 'number') params.set(input.name, 42);
    else if (input.datatype === 'boolean') params.set(input.name, true);
  }
  return params;
}

test('template expressions in pull parameters are emitted as escaped text and never evaluated', () => {
  for (const report of pullConfig) {
    for (const hostile of hostileValues) {
      delete (globalThis as any).__tdlProbe;
      const params = paramsFor(report, hostile);
      params.set('targetCompany', hostile);
      const out = renderPullRequest(pullTemplate(report.name), params);

      assert.equal((globalThis as any).__tdlProbe, undefined, `${report.name}: expression was executed`);
      assert.ok(!out.includes('49'), `${report.name}: expression was evaluated`);
      const usesCallerText = /targetCompany/.test(pullTemplate(report.name)) || report.input.some(i => i.datatype === 'string');
      if (usesCallerText)
        assert.ok(appearsAsLiteral(out, hostile), `${report.name}: value must appear escaped, verbatim`);
      assert.ok(!out.includes('\u0001'), `${report.name}: placeholder marker leaked`);
    }
  }
});

test('the reported cases: ledger name, item name, voucher type/number and reference stay literal', () => {
  const cases: [string, string][] = [
    ['ledger-balance', 'ledgerName'], ['ledger-account', 'ledgerName'],
    ['stock-item-balance', 'itemName'], ['stock-item-account', 'itemName'],
    ['voucher-lookup', 'voucherType'], ['voucher-lookup', 'voucherNumber'],
    ['find-voucher-by-reference', 'reference'],
  ];
  for (const [reportName, param] of cases) {
    const report = pullConfig.find(r => r.name === reportName)!;
    assert.ok(report.input.some(i => i.name === param), `${reportName} must declare ${param}`);
    for (const hostile of [EXPRESSION, CODE_PROBE]) {
      delete (globalThis as any).__tdlProbe;
      const params = paramsFor(report, 'plain');
      params.set(param, hostile);
      const out = renderPullRequest(pullTemplate(reportName), params);
      assert.equal((globalThis as any).__tdlProbe, undefined);
      assert.ok(out.includes(`"${utility.String.escapeHTML(hostile)}"`), `${reportName}.${param} must be quoted literal text`);
      assert.ok(!/"49"|= 49/.test(out));
    }
  }
});

// The pre-fix pipeline, kept here only as the reference for "legitimate values render the same".
function legacyRender(tmpl: string, params: Map<string, any>): string {
  let msg = tmpl;
  params.forEach((v, k) => {
    const re = new RegExp(`\\{${k}\\}`, 'g');
    if (typeof v === 'string') msg = msg.replace(re, () => utility.String.escapeHTML(v));
    else if (typeof v === 'number') msg = msg.replace(re, v.toString());
    else if (v instanceof Date) msg = msg.replace(re, utility.Date.format(v, 'd-MMM-yyyy'));
    else if (typeof v === 'boolean') msg = msg.replace(re, v ? 'Yes' : 'No');
  });
  const ctx: any = {};
  params.forEach((v, k) => { if (!(k === 'targetCompany' && v === '##SVCurrentCompany')) ctx[k] = v; });
  return nunjucks.renderString(msg, ctx);
}

test('legitimate values render exactly as before in every pull template', () => {
  const names = [
    'Cash', 'A & B Traders', 'O\'Brien "Fast" Supplies', 'Stock <10kg>', 'Café Señor — नमस्ते',
    'Braces {inside} name', '{ lone', 'trailing }', '100% Cotton #5', 'Bank A/c (HDFC) [OD]',
    // legacy receivable/payable spellings are exercised through the `nature` cases below
  ];
  for (const report of pullConfig) {
    // legacy rendered `{nature}` inside a nunjucks tag; the template now reads the variable instead
    const legacyTemplate = pullTemplate(report.name).replace('regExp.test(nature)', "regExp.test('{nature}')");
    const stringValues = report.name === 'bills-outstanding' ? ['r', 'p', 'Receivable', 'PAYABLE']
      : report.name === 'list-master' ? ['ledger', 'stockitem']
      : report.name === 'party-details' ? ['all', 'debtors', 'creditors']
      : names;
    for (const value of stringValues) {
      for (const company of ['##SVCurrentCompany', 'A & B "Traders" {toDate} Pvt. Ltd.']) {
        const fresh = () => { const p = paramsFor(report, value); p.set('targetCompany', company); return p; };
        assert.equal(
          renderPullRequest(pullTemplate(report.name), fresh()),
          legacyRender(legacyTemplate, fresh()),
          `${report.name} with ${JSON.stringify(value)} / ${JSON.stringify(company)}`);
      }
    }
  }
});

test('bills-outstanding still selects the debtor / creditor filter from nature', () => {
  const tmpl = pullTemplate('bills-outstanding');
  const render = (nature: string) => renderPullRequest(tmpl, new Map<string, any>([['toDate', new Date(2025, 2, 31)], ['nature', nature]]));
  for (const n of ['r', 'R', 'Receivable', 'RECEIVABLE']) {
    assert.match(render(n), /"Sundry Debtors"/);
    assert.doesNotMatch(render(n), /"Sundry Creditors"/);
  }
  for (const n of ['p', 'P', 'Payable']) {
    assert.match(render(n), /"Sundry Creditors"/);
    assert.doesNotMatch(render(n), /"Sundry Debtors"/);
  }
});

test('a value is substituted once: no second placeholder pass, no replacement-pattern expansion', () => {
  const tmpl = '<A>{ledgerName}</A><B>{toDate}</B><C>{{targetCompany | escape}}</C>';
  const out = renderPullRequest(tmpl, new Map<string, any>([
    ['ledgerName', "{toDate} $& $' $` $1 $$"],
    ['toDate', new Date(2025, 0, 5)],
    ['targetCompany', '{ledgerName}'],
  ]));
  assert.equal(out, '<A>{toDate} $&amp; $&apos; $` $1 $$</A><B>5-Jan-2025</B><C>{ledgerName}</C>');
});

test('unknown brace groups and nunjucks variables in a template are left to nunjucks', () => {
  const out = renderPullRequest('{notAParam} {{ledgerName}} {ledgerName}', new Map<string, any>([['ledgerName', 'L&T']]));
  assert.equal(out, '{notAParam} L&amp;T L&amp;T');
});

test('no pull template places a {param} placeholder inside a nunjucks tag or expression', () => {
  for (const file of fs.readdirSync(pullDir).filter(f => f.endsWith('.xml'))) {
    const xml = fs.readFileSync(path.join(pullDir, file), 'utf-8');
    for (const tag of xml.match(/<nunjuck>[\s\S]*?<\/nunjuck>|\{\{[\s\S]*?\}\}/g) ?? []) {
      assert.doesNotMatch(tag.replace(/^\{\{|\}\}$/g, ''), /\{[A-Za-z_][A-Za-z0-9_]*\}/, `${file}: ${tag}`);
    }
  }
});

test('push templates: expressions in caller values are data, not template source', () => {
  for (const template of pushConfig) {
    const tmpl = fs.readFileSync(path.join(pushDir, `${template.name}.xml`), 'utf-8');
    for (const hostile of [EXPRESSION, CODE_PROBE]) {
      delete (globalThis as any).__tdlProbe;
      const vars = new Map<string, any>();
      for (const input of template.input) {
        if (input.datatype === 'string') vars.set(input.name, hostile);
        else if (input.datatype === 'number') vars.set(input.name, 42);
        else if (input.datatype === 'array') vars.set(input.name, [hostile]);
        else if (input.datatype === 'date') { vars.set(input.name, new Date(2025, 3, 1)); vars.set('tallyDate', '20250401'); }
      }
      vars.set('targetCompany', hostile);
      const out = renderTallyTemplate(tmpl, vars);
      assert.equal((globalThis as any).__tdlProbe, undefined, `${template.name}: expression was executed`);
      assert.ok(!/>49</.test(out), `${template.name}: expression was evaluated`);
      assert.ok(appearsAsLiteral(out, hostile), `${template.name}: value must appear as escaped literal text`);
    }
  }
});

test('every declared pull report and push template has its XML file', () => {
  for (const report of pullConfig) assert.ok(fs.existsSync(path.join(pullDir, `${report.name}.xml`)), `pull/${report.name}.xml`);
  for (const template of pushConfig) assert.ok(fs.existsSync(path.join(pushDir, `${template.name}.xml`)), `push/${template.name}.xml`);
});

// ---- TDL string literals -----------------------------------------------------------------------------
// XML-escaping is undone by Tally's XML parser before the formula is read, so a double quote in a
// value placed inside a TDL "…" literal would close the literal. Such values are refused.

test('a double quote or control character is refused where the value sits inside a TDL literal', () => {
  const literalParams: [string, string][] = [
    ['ledger-balance', 'ledgerName'], ['ledger-account', 'ledgerName'],
    ['stock-item-balance', 'itemName'], ['stock-item-account', 'itemName'],
    ['voucher-lookup', 'voucherType'], ['voucher-lookup', 'voucherNumber'],
    ['find-voucher-by-reference', 'reference'],
  ];
  for (const [reportName, param] of literalParams) {
    const report = pullConfig.find(r => r.name === reportName)!;
    for (const bad of ['Cash" OR $$IsLedger:"x', '"', 'line\nbreak', 'tab\there', 'nul\u0000']) {
      const params = paramsFor(report, 'plain');
      params.set(param, bad);
      assert.equal(findUnsafeTdlLiteralParam(pullTemplate(reportName), params), param, `${reportName}.${param} ${JSON.stringify(bad)}`);
    }
    for (const fine of ["O'Brien & Sons", 'A/c (HDFC) [OD] 100%', 'Café — नमस्ते', 'Braces {x} $1 <tag>']) {
      assert.equal(findUnsafeTdlLiteralParam(pullTemplate(reportName), paramsFor(report, fine)), undefined, `${reportName} ${fine}`);
    }
  }
});

test('quotes are still allowed where the value is XML text, not a TDL literal', () => {
  // targetCompany is rendered into <SVCURRENTCOMPANY>…</SVCURRENTCOMPANY>, an XML text node.
  for (const report of pullConfig) {
    const params = paramsFor(report, 'plain');
    params.set('targetCompany', 'A "Quoted" Company');
    assert.equal(findUnsafeTdlLiteralParam(pullTemplate(report.name), params), undefined, report.name);
  }
  assert.equal(findUnsafeTdlLiteralParam('<A B="c">{name}</A>', new Map([['name', 'say "hi"']])), undefined);
  assert.equal(findUnsafeTdlLiteralParam('<A B="c">$X = "{name}"</A>', new Map([['name', 'say "hi"']])), 'name');
});

test('every string placeholder inside a TDL formula is quoted, or restricted by a validation regex', () => {
  const config: { name: string; input: { name: string; datatype: string; validation_regex?: string }[] }[] =
    JSON.parse(fs.readFileSync(path.join(pullDir, 'config.json'), 'utf-8')).reports;
  for (const report of config) {
    const lines = pullTemplate(report.name).split('\n').filter(l => /<(SYSTEM|SET|FILTER|TYPE|CHILDOF)\b/.test(l));
    for (const input of report.input.filter(i => i.datatype === 'string' && !i.validation_regex)) {
      for (const line of lines) {
        for (const m of line.matchAll(new RegExp(`\\{${input.name}\\}`, 'g'))) {
          const quotesBefore = line.slice(0, m.index).split('"').length - 1;
          assert.equal(quotesBefore % 2, 1, `${report.name}: {${input.name}} must sit inside a quoted literal: ${line.trim()}`);
        }
      }
    }
  }
});
