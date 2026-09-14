import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListenerPid, parseTasklistCsvImage, parseTasklistCsvPids, describeTallyUnreachable, TALLY_CONNECTIVITY_STEPS } from './mcp.mjs';

// These parsers decide WHICH Tally process the GUI side is allowed to keystroke into. Getting it
// wrong is not a crash — it is keys landing in a different company's window on a machine with two
// Tally versions open. Hence the coverage on shapes that look superficially right.

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1004
  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       7420
  TCP    [::]:9000              [::]:0                 LISTENING       7420
  TCP    127.0.0.1:54112        127.0.0.1:9000         ESTABLISHED     9988
`;

test('the listening owner of the port is found', () => {
  assert.equal(parseListenerPid(NETSTAT, 9000), 7420);
});

test('a client connected TO the port is never mistaken for its owner', () => {
  // pid 9988 has 9000 as its FOREIGN port. Matching on that would hand the MCP server's own
  // outbound socket back as "the Tally instance", and we would then keystroke into ourselves.
  const onlyClient = `  TCP    127.0.0.1:54112        127.0.0.1:9000         ESTABLISHED     9988`;
  assert.equal(parseListenerPid(onlyClient, 9000), null);
});

test('a listening row wins over an established one on the same local port', () => {
  const mixed = [
    '  TCP    127.0.0.1:9000         127.0.0.1:60123        ESTABLISHED     5555',
    '  TCP    0.0.0.0:9000           0.0.0.0:0              LISTENING       7420'
  ].join('\n');
  assert.equal(parseListenerPid(mixed, 9000), 7420);
});

test('IPv6 local addresses parse', () => {
  assert.equal(parseListenerPid('  TCP    [::]:9000              [::]:0                 LISTENING       4242', 9000), 4242);
});

test('a port that merely shares a suffix does not match', () => {
  // :19000 and :90 must not answer for :9000 — a substring match here would target a completely
  // unrelated process.
  const near = [
    '  TCP    0.0.0.0:19000          0.0.0.0:0              LISTENING       111',
    '  TCP    0.0.0.0:90             0.0.0.0:0              LISTENING       222'
  ].join('\n');
  assert.equal(parseListenerPid(near, 9000), null);
});

test('a localised state word still resolves', () => {
  // Non-English Windows translates "LISTENING". Requiring that literal would silently drop us back
  // to guessing, which is what this module exists to prevent. The foreign ":0" carries the meaning.
  assert.equal(parseListenerPid('  TCP    0.0.0.0:9000           0.0.0.0:0              ABHOEREN        7420', 9000), 7420);
});

test('UDP rows are ignored', () => {
  assert.equal(parseListenerPid('  UDP    0.0.0.0:9000           *:*                                    3030', 9000), null);
});

test('noise and empty input yield null rather than a bogus pid', () => {
  assert.equal(parseListenerPid('', 9000), null);
  assert.equal(parseListenerPid('Active Connections\n\n  Proto  Local Address', 9000), null);
});

test('the image name is read off a tasklist CSV row', () => {
  assert.equal(parseTasklistCsvImage('"tally.exe","7420","Console","1","250,168 K"'), 'tally.exe');
});

test('a tasklist filter that matched nothing yields null, not a false name', () => {
  assert.equal(parseTasklistCsvImage('INFO: No tasks are running which match the specified criteria.'), null);
  assert.equal(parseTasklistCsvImage(''), null);
});

test('every running instance is counted, which is how ambiguity is detected', () => {
  const out = [
    '"tally.exe","7420","Console","1","250,168 K"',
    '"tally.exe","8150","Console","1","198,004 K"'
  ].join('\r\n');
  assert.deepEqual(parseTasklistCsvPids(out), [7420, 8150]);
});

test('no running instances counts as zero, not as one unnamed one', () => {
  assert.deepEqual(parseTasklistCsvPids('INFO: No tasks are running which match the specified criteria.'), []);
});

// --- what the user is actually told -------------------------------------------------------------
// These assertions look like they are testing prose. They are testing the only support channel a
// non-technical user has: whatever Claude relays back. The three causes need three different
// answers, and the click-path must survive any future edit to the wording.

test('a closed Tally is named as closed, and still gets the first-time setup step', () => {
  const d = describeTallyUnreachable({ ok: false, reason: 'Tally is not running.', remedy: 'Start Tally Prime, then retry.' });
  assert.match(d.message, /not open/i);
  assert.match(d.remedy, /Start Tally Prime/);
  assert.match(d.remedy, /Connectivity/);
});

test('a RUNNING Tally that will not answer gets the connectivity path, not "is Tally running?"', () => {
  // The failure a first-time install actually produces: Tally is plainly open on screen, so telling
  // the user to start it reads as the product being broken.
  const d = describeTallyUnreachable({ ok: true, pid: 7420, image: 'tally.exe', via: 'port' });
  assert.match(d.message, /running/i);
  assert.match(d.remedy, /F1 \(Help\) > Settings > Connectivity > Client\/Server Configuration/);
  assert.match(d.remedy, /Server/);
  assert.match(d.remedy, /9000/);
  // The second cause is invisible from this side and is otherwise unguessable.
  assert.match(d.remedy, /dialog/i);
});

test('an ambiguous machine keeps its own specific explanation instead of generic advice', () => {
  const d = describeTallyUnreachable({
    ok: false,
    reason: '2 Tally instances are running (pids 1, 2) and none is serving port 9000, so there is no way to tell which one you mean.',
    remedy: 'Turn the XML server on in the instance you want.'
  });
  assert.match(d.message, /2 Tally instances/);
  assert.doesNotMatch(d.message, /not open/i);
});

test('the connectivity steps name the menu, the role and the port', () => {
  // Everything above interpolates this one string; if it loses a step, every message loses it.
  assert.match(TALLY_CONNECTIVITY_STEPS, /F1/);
  assert.match(TALLY_CONNECTIVITY_STEPS, /Connectivity/);
  assert.match(TALLY_CONNECTIVITY_STEPS, /Server/);
  assert.match(TALLY_CONNECTIVITY_STEPS, /9000/);
  assert.match(TALLY_CONNECTIVITY_STEPS, /Ctrl\+A/);
});
