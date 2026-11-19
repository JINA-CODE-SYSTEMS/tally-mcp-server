import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { guiControlGate, isReadOnlyTallyRequest, rawXmlProbeGate, registerMcpServer } from './mcp.mjs';

// READONLY_MODE is the operator's promise that nothing reachable through this server can change the
// books. These pin the paths that used to slip past it: free-form GUI keystrokes, raw XML envelopes
// whose verb was not recognised as a write, and the master-name repair.

const envelope = (verb: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>${verb}</TALLYREQUEST></HEADER><BODY/></ENVELOPE>`;

test('only a single plain Export request is a read', () => {
  for (const xml of [
    envelope('Export'), envelope('export'), envelope('  EXPORT  '), envelope('Export Data'), envelope('Export  Data'),
    '<ENVELOPE><HEADER><TALLYREQUEST TYPE="x">Export</TALLYREQUEST></HEADER></ENVELOPE>',
  ]) assert.equal(isReadOnlyTallyRequest(xml), true, xml);

  for (const xml of [
    envelope('Import'), envelope('Import Data'), envelope('IMPORT DATA'), envelope('Alter'), envelope('Delete'),
    envelope('Execute'), envelope('Export Import'), envelope('ExportX'), envelope(''), envelope('&#73;mport Data'),
    envelope('<![CDATA[Import Data]]>'),
    '<ENVELOPE><BODY/></ENVELOPE>',                                   // no verb at all
    envelope('Export') + envelope('Import Data'),                     // two requests
    `<!-- ${envelope('Export')} -->` + envelope('Import Data'),       // decoy in a comment
    '<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><tallyrequest>Import Data</tallyrequest></HEADER></ENVELOPE>',
    '<ENVELOPE><HEADER><TALLYREQUEST>Export<X/></TALLYREQUEST></HEADER></ENVELOPE>',
    '',
  ]) assert.equal(isReadOnlyTallyRequest(xml), false, xml);
});

test('raw XML probe: writes need allowWrite, and READONLY_MODE refuses the probe entirely', () => {
  const debug = { TALLY_DEBUG_XML: '1' };
  const readonly = { TALLY_DEBUG_XML: '1', READONLY_MODE: 'true' };

  assert.deepEqual(rawXmlProbeGate(envelope('Export'), undefined, debug), { allowed: true, write: false });
  // Even an Export: inline TDL in a raw envelope cannot be shown to be side-effect free.
  for (const xml of [envelope('Export'), envelope('Export Data')]) {
    for (const allowWrite of [undefined, true]) {
      const gate = rawXmlProbeGate(xml, allowWrite, readonly);
      assert.equal(gate.allowed, false);
      assert.equal((gate as any).code, 'READONLY');
    }
  }
  assert.deepEqual(rawXmlProbeGate(envelope('Import Data'), true, debug), { allowed: true, write: true });

  for (const xml of [envelope('Import Data'), envelope('Import'), envelope('Alter'), envelope('Delete'), envelope('Mystery'), '<ENVELOPE/>']) {
    const withoutOptIn = rawXmlProbeGate(xml, undefined, debug);
    assert.equal(withoutOptIn.allowed, false, xml);
    assert.equal((withoutOptIn as any).code, 'PRECONDITION_FAILED');
    for (const allowWrite of [undefined, false, true]) {
      const inReadonly = rawXmlProbeGate(xml, allowWrite, readonly);
      assert.equal(inReadonly.allowed, false, `${xml} allowWrite=${allowWrite}`);
      assert.equal((inReadonly as any).code, 'READONLY');
    }
  }

  // Still off entirely unless the debug switch is set.
  assert.equal(rawXmlProbeGate(envelope('Export'), true, {}).allowed, false);
});

test('GUI control: keystrokes are refused in READONLY_MODE, the screenshot is not', () => {
  const on = { ENABLE_GUI_CONTROL: 'true' };
  const readonly = { ENABLE_GUI_CONTROL: 'true', READONLY_MODE: 'true' };
  assert.deepEqual(guiControlGate('gui-send-keys', on), { allowed: true });
  assert.deepEqual(guiControlGate('gui-screenshot', on), { allowed: true });
  assert.deepEqual(guiControlGate('gui-screenshot', readonly), { allowed: true });
  const keys = guiControlGate('gui-send-keys', readonly);
  assert.equal(keys.allowed, false);
  assert.equal((keys as any).code, 'READONLY');
  // ENABLE_GUI_CONTROL still gates both.
  assert.equal((guiControlGate('gui-send-keys', {}) as any).code, 'PRECONDITION_FAILED');
  assert.equal((guiControlGate('gui-screenshot', { READONLY_MODE: 'true' }) as any).code, 'PRECONDITION_FAILED');
});

// End to end through the registered tools, so the gates above are proven to be the ones in use.
test('the registered tools enforce READONLY_MODE', async () => {
  const saved = { ...process.env };
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'readonly-test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args }) as any;
    const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
    return { isError: res.isError === true, text };
  };
  try {
    Object.assign(process.env, {
      READONLY_MODE: 'true', ENABLE_GUI_CONTROL: 'true', TALLY_DEBUG_XML: '1',
      TALLY_HOST: '127.0.0.1', TALLY_PORT: '1', // nothing listens: a request that gets past a gate fails fast
    });

    const keys = await call('gui-send-keys', { keys: [{ action: 'combo', value: 'alt+d' }] });
    assert.equal(keys.isError, true);
    assert.match(keys.text, /"code":\s*"READONLY"/);

    for (const xml of [envelope('Import Data'), envelope('Delete'), '<ENVELOPE/>']) {
      const probe = await call('tally-raw-xml-probe', { xml, allowWrite: true });
      assert.equal(probe.isError, true);
      assert.match(probe.text, /"code":\s*"READONLY"/, xml);
    }

    const exportInReadonly = await call('tally-raw-xml-probe', { xml: envelope('Export') });
    assert.match(exportInReadonly.text, /"code":\s*"READONLY"/);

    const order = await call('set-entry-order', { order: 'credit-first', voucherType: 'Receipt' });
    assert.equal(order.isError, true);
    assert.match(order.text, /"code":\s*"READONLY"/);

    const repair = await call('repair-master-names', { confirm: true });
    assert.equal(repair.isError, true);
    assert.match(repair.text, /"code":\s*"READONLY"/);

    // Outside read-only mode the probe's own default still applies.
    process.env.READONLY_MODE = 'false';
    const noOptIn = await call('tally-raw-xml-probe', { xml: envelope('Import Data') });
    assert.match(noOptIn.text, /"code":\s*"PRECONDITION_FAILED"/);
    // ...and a plain Export passes the gate (then fails only because no Tally is listening).
    const read = await call('tally-raw-xml-probe', { xml: envelope('Export') });
    assert.doesNotMatch(read.text, /"code":\s*"(READONLY|PRECONDITION_FAILED)"/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await client.close();
    await server.close();
  }
});
