import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  agentErrorResult, busyGuiResponse, companyIdMatches, decideRestartGate, describeGuiAvailability, describeOutOfPeriod,
  executeVoucher, financialYearLabel, guiUserIdleSec, interpretPingResponse, isPersonActive, isRemoteTallyHost,
  parseCompanyIdentity, parseIdleStatusResponse, pickVoucherToShow, registerMcpServer, restartUserIdleSec,
  showAfterPostBlockedReason, wantsShowAfterPost,
} from './mcp.mjs';
import { pushXml } from './tally.mjs';
import { lockFile } from './coordination.mjs';

// Server side of epic #44: concurrency, data safety and visibility. The PowerShell halves (tray, GUI
// agent) cannot run here; these pin the server's decisions and the contracts it shares with them.

const codeOf = (r: any) => r?.structuredContent?.code;

// ── #37 Tally on another computer ──

test('isRemoteTallyHost: loopback and this machine are local; anything else is remote', () => {
  for (const h of [undefined, '', 'localhost', 'LOCALHOST', '127.0.0.1', '127.0.1.1', '::1', '[::1]', '0.0.0.0', 'TALLY-PC', 'tally-pc.corp.local']) {
    assert.equal(isRemoteTallyHost(h, 'TALLY-PC'), false, String(h));
  }
  for (const h of ['192.168.1.20', 'ACCOUNTS-SERVER', 'tally.example.com']) {
    assert.equal(isRemoteTallyHost(h, 'TALLY-PC'), true, h);
  }
});

async function connect() {
  const server = await registerMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'epic44-test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('with Tally on another computer, screen and load tools refuse with NOT_AVAILABLE_REMOTE_TALLY', async () => {
  await withEnv({ TALLY_HOST: '10.250.250.250', ENABLE_GUI_CONTROL: 'true' }, async () => {
    const { client, close } = await connect();
    try {
      for (const [name, args] of [['gui-screenshot', {}], ['load-company', { company: '100000' }], ['switch-company', { company: 'x' }], ['list-available-companies', {}]] as const) {
        const r: any = await client.callTool({ name, arguments: args as any });
        assert.equal(r.isError, true, name);
        assert.equal(codeOf(r), 'NOT_AVAILABLE_REMOTE_TALLY', name);
      }
    } finally { await close(); }
  });
});

// ── #25 restart gate ──

test('load-company never restarts without confirmRestart, and refuses when someone used the PC in the last minute', () => {
  const none = decideRestartGate({ idleMs: 999_999, minIdleSec: 60, company: 'Ross Industries' });
  assert.equal(none.proceed, false);
  if (!none.proceed) {
    assert.equal(none.code, 'RESTART_NEEDS_CONFIRMATION');
    assert.match(none.message, /close and reopen to load "Ross Industries"/);
    assert.match(none.message, /lose unsaved work/);
  }
  assert.equal(decideRestartGate({ confirmRestart: false, idleMs: null, minIdleSec: 60, company: 'X' }).proceed, false);
  const active = decideRestartGate({ confirmRestart: true, idleMs: 12_000, minIdleSec: 60, company: 'X' });
  assert.equal(active.proceed, false);
  if (!active.proceed) assert.equal(active.code, 'USER_ACTIVE');
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 61_000, minIdleSec: 60, company: 'X' }).proceed, true);
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: null, minIdleSec: 60, company: 'X' }).proceed, true, 'unknown idle time does not block');
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 1, minIdleSec: 0, company: 'X' }).proceed, true, '0 disables the idle check');
});

// The agent's own keystrokes reset GetLastInputInfo too. After any AI screen action, idleMs is a few
// seconds although nobody touched the PC: that must not refuse a confirmed restart as USER_ACTIVE.
test('the restart gate ignores the agent\'s own keystrokes and trusts the agent\'s userActive verdict', () => {
  // An agent that reports userActive (judged against the userIdleSec we sent, its own keys excluded).
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 5000, userActive: false, lastInputWasAgent: true, minIdleSec: 60, company: 'X' }).proceed, true);
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 5000, userActive: false, lastInputWasAgent: false, minIdleSec: 60, company: 'X' }).proceed, true, 'the agent has the final say when it reports');
  const human = decideRestartGate({ confirmRestart: true, idleMs: 12_000, userActive: true, lastInputWasAgent: false, minIdleSec: 60, company: 'X' });
  assert.equal(human.proceed, false);
  if (!human.proceed) {
    assert.equal(human.code, 'USER_ACTIVE');
    assert.match(human.message, /12s ago/);
    assert.equal(human.idleMs, 12_000);
  }
  // userActive with the last input the agent's: idleMs is not the person's, so it is not quoted.
  const masked = decideRestartGate({ confirmRestart: true, idleMs: 3000, userActive: true, lastInputWasAgent: true, minIdleSec: 60, company: 'X' });
  assert.equal(masked.proceed, false);
  if (!masked.proceed) {
    assert.match(masked.message, /in the last 60s/);
    assert.equal(masked.idleMs, undefined);
  }
  // An older agent with no userActive: idleMs, unless the last input was the agent's.
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 5000, lastInputWasAgent: true, minIdleSec: 60, company: 'X' }).proceed, true);
  assert.equal(decideRestartGate({ confirmRestart: true, idleMs: 5000, lastInputWasAgent: null, minIdleSec: 60, company: 'X' }).proceed, false);
  assert.equal(isPersonActive({ idleMs: 1, userActive: true, minIdleSec: 0 }), false, '0 disables the check');
});

test('idle-status answers are read with the agent\'s own-input fields, and a busy screen is not an answer', () => {
  const ok = { status: 'success', message: '', agentVersion: '2.0.0', raw: { status: 'success', idleMs: 81234, lastInputWasAgent: true, userActive: false, session: { state: 'active', user: 'PC\\a', sessionId: 1 } } };
  assert.deepEqual(parseIdleStatusResponse(ok), { idleMs: 81234, userActive: false, lastInputWasAgent: true, session: { state: 'active', user: 'PC\\a', sessionId: 1 } });
  assert.deepEqual(parseIdleStatusResponse({ ...ok, raw: { status: 'success', idleMs: null } }), { idleMs: null, userActive: null, lastInputWasAgent: null, session: null }, 'old agent / no native input info');
  assert.deepEqual(parseIdleStatusResponse(null), { idleMs: null, userActive: null, lastInputWasAgent: null, session: null });
  const holder = { pid: 1, tool: 'gui:sendkeys', kind: 'gui' as const, startedAt: new Date().toISOString(), host: os.hostname(), token: 't' };
  const busy = parseIdleStatusResponse(busyGuiResponse(holder, 4));
  assert.equal(busy.idleMs, null);
  assert.equal(busy.busy?.holderTool, 'gui:sendkeys');
  assert.equal(busy.busy?.retryAfterSec, 4);
});

// A ping that found the screen in use was deliberately not sent (it would have shared the IPC files with
// the running screen action). The agent is working, not dead.
test('a ping skipped because the screen is in use reports the agent alive and busy, not dead', () => {
  const holder = { pid: 1, tool: 'load-company', kind: 'load' as const, startedAt: new Date().toISOString(), host: os.hostname(), token: 't' };
  const busy = interpretPingResponse(busyGuiResponse(holder, 30), true, '9.9.9');
  assert.equal(busy.alive, true);
  assert.equal(busy.agentVersion, '9.9.9', 'the version this process last saw');
  assert.equal(busy.versionOk, true);
  assert.equal(busy.busy?.holderTool, 'load-company');
  assert.equal(busy.busy?.retryAfterSec, 30);
  assert.equal(interpretPingResponse(busyGuiResponse(holder, 30), true, null).agentVersion, null);
  assert.equal(interpretPingResponse(busyGuiResponse(holder, 30), true, null).versionOk, true, 'busy with no version seen yet is not "too old"');
  assert.deepEqual(interpretPingResponse(null, true, '9.9.9'), { alive: false, agentVersion: null, versionOk: false });
  assert.deepEqual(interpretPingResponse({ status: 'success', message: '', agentVersion: '0.0.1', raw: {} }, true, null), { alive: true, agentVersion: '0.0.1', versionOk: false });
  assert.equal(describeGuiAvailability(true, null, false, 'load-company').guiAvailable, false);
  assert.match(describeGuiAvailability(true, null, false, 'load-company').guiUnavailableReason!, /Another AI window.*load-company/);
});

test('idle thresholds come from the environment with sane defaults', () => {
  assert.equal(guiUserIdleSec(undefined), 5);
  assert.equal(guiUserIdleSec('8'), 8);
  assert.equal(guiUserIdleSec('junk'), 5);
  assert.equal(restartUserIdleSec(undefined), 60);
  assert.equal(restartUserIdleSec('30'), 30);
});

test('the tools advertise the new arguments', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    const props = (n: string) => Object.keys((byName.get(n)!.inputSchema as any).properties ?? {});
    assert.ok(props('load-company').includes('confirmRestart'));
    for (const n of ['create-voucher', 'create-vouchers', 'alter-voucher', 'delete-voucher', 'create-ledger']) {
      assert.ok(props(n).includes('expectedCompanyId'), `${n} takes expectedCompanyId`);
      assert.ok(props(n).includes('expectedMachine'), `${n} takes expectedMachine`);
    }
    for (const n of ['create-voucher', 'create-vouchers', 'alter-voucher']) assert.ok(props(n).includes('show'), `${n} takes show`);
    assert.ok(!props('list-master').includes('expectedCompanyId'), 'reads are not guarded');
    assert.match(byName.get('load-company')!.description!, /RESTART_NEEDS_CONFIRMATION/);
  } finally { await close(); }
});

// ── #24 / #35 / #26 agent refusals ──

test('the agent\'s typed refusals become typed tool errors; other failures are left to the call site', () => {
  const mk = (raw: any, message = 'm') => ({ status: 'error', message, agentVersion: '1.9.0', raw });
  const active = agentErrorResult(mk({ errorCode: 'USER_ACTIVE', idleMs: 800 }, 'Someone is using the keyboard'));
  assert.equal(codeOf(active), 'USER_ACTIVE');
  assert.equal((active as any).structuredContent.retryable, true);
  assert.equal((active as any).structuredContent.idleMs, 800);
  assert.match((active as any).structuredContent.remedy, /Ask them to stop for a moment/);
  assert.equal(codeOf(agentErrorResult(mk({ errorCode: 'SESSION_LOCKED' }))), 'SESSION_LOCKED');
  assert.equal(codeOf(agentErrorResult(mk({ errorCode: 'SESSION_DISCONNECTED' }))), 'SESSION_DISCONNECTED');
  assert.equal(codeOf(agentErrorResult(mk({ errorCode: 'WRONG_USER' }))), 'WRONG_USER');
  assert.equal(agentErrorResult(mk({ errorCode: 'SOMETHING_ELSE' })), null);
  assert.equal(agentErrorResult(mk({})), null);
  assert.equal(agentErrorResult(null), null);
});

test('BUSY carries retryAfterSec and the holder\'s tool name', () => {
  const holder = { pid: 1, tool: 'gui:sendkeys', kind: 'gui' as const, startedAt: new Date().toISOString(), host: os.hostname(), token: 't' };
  const r: any = agentErrorResult(busyGuiResponse(holder, 7));
  assert.equal(codeOf(r), 'BUSY');
  assert.equal(r.structuredContent.retryable, true);
  assert.equal(r.structuredContent.retryAfterSec, 7);
  assert.equal(r.structuredContent.holderTool, 'gui:sendkeys');
});

test('describeGuiAvailability explains why the screen cannot be driven', () => {
  assert.deepEqual(describeGuiAvailability(true, { state: 'active' }, false), { guiAvailable: true });
  assert.deepEqual(describeGuiAvailability(true, null, false), { guiAvailable: true }, 'unknown session state does not block');
  assert.match(describeGuiAvailability(true, { state: 'locked' }, false).guiUnavailableReason!, /locked/);
  assert.match(describeGuiAvailability(true, { state: 'disconnected' }, false).guiUnavailableReason!, /disconnected/);
  assert.match(describeGuiAvailability(true, { state: 'wrong-user', user: 'PC\\accounts' }, false).guiUnavailableReason!, /PC\\accounts/);
  assert.equal(describeGuiAvailability(false, null, false).guiAvailable, false);
  assert.match(describeGuiAvailability(true, null, true).guiUnavailableReason!, /another computer/);
});

// ── #26 XML writes wait out a company load ──

test('an XML write during another window\'s company load writes nothing and reports busy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic44-'));
  try {
    await withEnv({ TALLY_DATA_PATH: dir, XML_WRITE_LOAD_WAIT_SEC: '0' }, async () => {
      // A live process (our parent) holding a load lock.
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, tool: 'load-company', kind: 'load', startedAt: new Date().toISOString(), host: os.hostname(), token: 'other' }));
      const r = await pushXml('<ENVELOPE/>');
      assert.equal(r.success, false);
      assert.equal(r.busy?.tool, 'load-company');
      assert.match(r.error!, /reopening Tally/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── #29 identity ──

test('parseCompanyIdentity reads GUID and company number, preferring the named company', () => {
  const xml = '<DATA><ROW><F01>Other Co</F01><F02>g-1</F02><F03>10001</F03></ROW><ROW><F01>Ross &amp; Sons</F01><F02>g-2</F02><F03>10002</F03></ROW></DATA>';
  const id = parseCompanyIdentity(xml, 'ross & sons', 'PC-A');
  assert.deepEqual(id, { machine: 'PC-A', company: 'Ross & Sons', companyGuid: 'g-2', companyNumber: '10002', companyId: 'g-2' });
  const noGuid = parseCompanyIdentity('<ROW><F01>A</F01><F02></F02><F03>10009</F03></ROW>', null, 'PC-A');
  assert.equal(noGuid.companyId, '10009', 'falls back to the company number');
  assert.equal(parseCompanyIdentity('', null, 'PC-A').companyId, null);
});

test('companyIdMatches accepts the GUID case-insensitively; a company number only where no GUID can be read and the machine is confirmed', () => {
  const id = { machine: 'PC', company: 'A', companyGuid: 'ABC-123', companyNumber: '10002', companyId: 'ABC-123' };
  assert.equal(companyIdMatches('abc-123', id), true);
  assert.equal(companyIdMatches('10002', id), false, 'numbers repeat across installs; with a GUID readable the GUID decides');
  assert.equal(companyIdMatches('10002', { ...id, companyGuid: null, companyId: '10002' }, { machineConfirmed: true }), true);
  assert.equal(companyIdMatches('10003', id), false);
  assert.equal(companyIdMatches('x', { ...id, companyGuid: null, companyNumber: null, companyId: null }), false, 'unreadable id fails closed');
});

// A minimal Tally XML server: enough for company resolution and the identity report.
async function fakeTally(identity: { name: string; guid: string; number: string }) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', d => { chunks.push(d); });
    req.on('end', () => {
      // Tally speaks UTF-16LE in both directions.
      const body = Buffer.concat(chunks).toString('utf16le');
      const reply = (xml: string) => { res.setHeader('content-type', 'text/xml;charset=utf-16'); res.end(Buffer.from(xml, 'utf16le')); };
      if (body.includes('MCPCompanyIdReport')) {
        reply(`<ENVELOPE><DATA><ROW><F01>${identity.name}</F01><F02>${identity.guid}</F02><F03>${identity.number}</F03></ROW></DATA></ENVELOPE>`);
      } else if (body.includes('MCPLoadedCompaniesList')) {
        reply(`<ENVELOPE><COLLECTION><COMPANY NAME="${identity.name}" RESERVEDNAME=""/></COLLECTION></ENVELOPE>`);
      } else {
        reply('<ENVELOPE></ENVELOPE>');
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  return { port, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('a write with the wrong expectedCompanyId is refused with COMPANY_MISMATCH and names both books', async () => {
  const tally = await fakeTally({ name: 'Ross Industries', guid: 'guid-pc-b', number: '10001' });
  try {
    await withEnv({ TALLY_HOST: '127.0.0.1', TALLY_PORT: String(tally.port) }, async () => {
      const { client, close } = await connect();
      try {
        const args = { voucherType: 'Journal', date: '2026-10-10', entries: [{ ledger: 'Rent', drCr: 'dr', amount: 1 }, { ledger: 'Cash', drCr: 'cr', amount: 1 }], targetCompany: 'Ross Industries' };
        const r: any = await client.callTool({ name: 'create-voucher', arguments: { ...args, expectedCompanyId: 'guid-pc-a' } });
        assert.equal(codeOf(r), 'COMPANY_MISMATCH');
        assert.match(r.structuredContent.message, /guid-pc-a/);
        assert.match(r.structuredContent.message, /guid-pc-b/);
        assert.equal(r.structuredContent.companyId, 'guid-pc-b');
        const ok: any = await client.callTool({ name: 'create-voucher', arguments: { ...args, expectedCompanyId: 'guid-pc-b', dryRun: true } });
        assert.notEqual(codeOf(ok), 'COMPANY_MISMATCH', 'the GUID identifies the books');
        const num: any = await client.callTool({ name: 'create-voucher', arguments: { ...args, expectedCompanyId: '10001', dryRun: true } });
        assert.equal(codeOf(num), 'COMPANY_MISMATCH', 'a company number alone does not, while the GUID is readable');
      } finally { await close(); }
    });
  } finally { await tally.close(); }
});

// ── #36 period errors ──

test('financialYearLabel follows the company\'s FY start', () => {
  assert.equal(financialYearLabel('2025-03-31', '2025-04-01'), 'FY 2024-25');
  assert.equal(financialYearLabel('2025-04-01', '2025-04-01'), 'FY 2025-26');
  assert.equal(financialYearLabel('2025-06-01', null), 'FY 2025-26', 'Indian April-March by default');
  assert.equal(financialYearLabel('2025-06-01', '2025-01-01'), 'FY 2025', 'calendar-year companies');
  assert.equal(financialYearLabel('bad', null), null);
});

test('OUT_OF_PERIOD names the open period, the year the date is in, and the fix', async () => {
  const d = describeOutOfPeriod('2025-02-10', { fyFrom: '2025-04-01', fyTo: '2026-03-31', booksFrom: null });
  assert.match(d.message, /2025-04-01 to 2026-03-31/);
  assert.match(d.message, /in FY 2024-25; the company is open for FY 2025-26/);
  assert.match(d.remedy, /F2/);
  const before = describeOutOfPeriod('2025-05-01', { fyFrom: '2025-04-01', fyTo: '2026-03-31', booksFrom: '2025-09-01' });
  assert.match(before.message, /Books begin on 2025-09-01/);
  assert.match(before.remedy, /before the company's books begin/);

  const r: any = await executeVoucher(
    { voucherType: 'Journal', date: '2025-02-10', entries: [{ ledger: 'Rent', drCr: 'dr', amount: 1 }, { ledger: 'Cash', drCr: 'cr', amount: 1 }] },
    { period: { fyFrom: '2025-04-01', fyTo: '2026-03-31', booksFrom: null } }
  );
  assert.equal(codeOf(r), 'OUT_OF_PERIOD');
  assert.match(r.structuredContent.remedy, /F2/);
  assert.deepEqual(r.structuredContent.openPeriod, { booksFrom: null, fyFrom: '2025-04-01', fyTo: '2026-03-31' });
});

// ── #23 show after post ──

test('show-after-post is opt-in, per call or by setting, and never for a dry run', () => {
  assert.equal(wantsShowAfterPost({}, {}), false);
  assert.equal(wantsShowAfterPost({}, { SHOW_AFTER_POST: 'true' }), true);
  assert.equal(wantsShowAfterPost({ show: false }, { SHOW_AFTER_POST: 'true' }), false);
  assert.equal(wantsShowAfterPost({ show: true }, {}), true);
  assert.equal(wantsShowAfterPost({ show: true, dryRun: true }, {}), false);
});

// A per-call show: true must not get past the operator's opt-out of screen control.
test('show-after-post is skipped when GUI control is disabled', () => {
  assert.equal(showAfterPostBlockedReason({ ENABLE_GUI_CONTROL: 'true' }), null);
  assert.match(showAfterPostBlockedReason({ ENABLE_GUI_CONTROL: 'false' })!, /GUI control is disabled/);
  assert.match(showAfterPostBlockedReason({})!, /GUI control is disabled/);
});

test('pickVoucherToShow: the posted voucher, or only the last posted row of a batch', () => {
  assert.deepEqual(
    pickVoucherToShow('create-voucher', { voucherType: 'Sales', date: '2026-10-10', voucherNumber: '7' }, { success: true, masterId: 123 }),
    { masterId: '123', voucherType: 'Sales', voucherNumber: '7', date: '2026-10-10' });
  const batchArgs = { vouchers: [{ voucherType: 'Sales', date: '2026-10-01' }, { voucherType: 'Receipt', date: '2026-10-02' }, { voucherType: 'Payment', date: '2026-10-03' }] };
  const body = { results: [{ index: 0, status: 'success', masterId: 1 }, { index: 1, status: 'success', masterId: 2 }, { index: 2, status: 'error' }] };
  assert.deepEqual(pickVoucherToShow('create-vouchers', batchArgs, body), { masterId: '2', voucherType: 'Receipt', voucherNumber: undefined, date: '2026-10-02' });
  assert.equal(pickVoucherToShow('create-vouchers', batchArgs, { results: [{ index: 0, status: 'error' }] }), null);
  assert.equal(pickVoucherToShow('create-voucher', {}, { dryRun: true }), null);
});

test('isRemoteTallyHost treats the NetBIOS computer name as this PC, like the tray', () => {
  assert.equal(isRemoteTallyHost('ACCTS-PC-01', 'accts-pc-01-long-dns-name', 'ACCTS-PC-01'), false);
  assert.equal(isRemoteTallyHost('OTHER-PC', 'accts-pc-01-long-dns-name', 'ACCTS-PC-01'), true);
  assert.equal(isRemoteTallyHost('accts-pc-01-long-dns-name.corp.local', 'accts-pc-01-long-dns-name', undefined), false);
});
