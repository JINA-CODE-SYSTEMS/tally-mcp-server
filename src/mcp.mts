import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dotenv from 'dotenv';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cacheTable, executeSQL, validateSQL } from './database.mjs';
import { handlePull, handlePush, jsonToTSV, pingTally, postTallyXML, pushXml, resolveGSTLedgers } from './tally.mjs';
import { buildVoucherXml, buildCancelVoucherXml, voucherBalance, isDateInOpenPeriod, findMissingMasters, referencedLedgers, type VoucherEntry, type VoucherInput } from './voucher.mjs';
import { makeIdempotencyStore, type IdempotencyStore } from './idempotency.mjs';

dotenv.config({ override: true, quiet: true });

// Audit logging — logs every tool invocation
function auditLog(toolName: string, args: Record<string, any>, status: 'success' | 'error' | 'denied' | 'dryrun', durationMs?: number): void {
  const entry = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    args: Object.fromEntries(
      Object.entries(args).filter(([k]) => !['password', 'secret', 'token', 'username', 'user', 'apikey', 'api_key'].includes(k.toLowerCase()))
    ),
    status,
    durationMs
  };
  console.log(`[audit] ${JSON.stringify(entry)}`);
}

export function getOpenCompanyGuiTimeoutSeconds(rawValue: string | undefined = process.env.OPEN_COMPANY_GUI_TIMEOUT_SEC): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 180;
  if (parsed < 90) return 180;
  return Math.floor(parsed);
}

export function getOpenCompanyGuiMaxSteps(rawValue: string | undefined = process.env.OPEN_COMPANY_GUI_MAX_STEPS): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 25;
  if (parsed < 12) return 12;
  return Math.floor(parsed);
}

export function createGuiAgentCommandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isMatchingGuiAgentCommand(result: any, commandId: string): boolean {
  return !!result && typeof result.commandId === 'string' && result.commandId === commandId;
}

// Tracks the last company successfully opened via open-company within this server session.
let activeCompany: string | null = null;

// Verifies that a company is currently loaded in Tally by probing SVCURRENTCOMPANY.
// Tally echoes the current company name back; a match confirms the company is accessible.
async function verifyCompanyLoaded(targetName: string): Promise<boolean> {
  try {
    const escaped = targetName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPVerifyCompanyReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escaped}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPVerifyCompanyReport"><FORMS>MCPVerifyForm</FORMS></REPORT><FORM NAME="MCPVerifyForm"><PARTS>MCPVerifyPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPVerifyPart"><LINES>MCPVerifyLine</LINES></PART><LINE NAME="MCPVerifyLine"><FIELDS>MCPVerifyField</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPVerifyField"><SET>##SVCurrentCompany</SET><XMLTAG>NAME</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    const resp = await postTallyXML(xml);
    return resp.toLowerCase().includes(`<name>${targetName.toLowerCase()}`);
  } catch {
    return false;
  }
}

// Returns the names of companies currently loaded in Tally's UI.
//
// Uses Tally's raw Collection query (TYPE=Collection) rather than the
// list-master TDL template. Empirically, the template projection (`$Name` on
// the Company collection) returns empty rows in several Tally Prime / Edit Log
// configurations, while the raw Collection query reliably returns each loaded
// company as `<COMPANY NAME="..." RESERVEDNAME="" />` — with the company name
// as an XML attribute. We pull the names with a regex rather than instantiating
// a new XML parser since attribute-form is the only thing we need.
async function listLoadedCompanies(): Promise<string[]> {
  const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MCPLoadedCompaniesList</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="MCPLoadedCompaniesList"><TYPE>Company</TYPE></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  try {
    const resp = await postTallyXML(xml);
    const names: string[] = [];
    const re = /<COMPANY[^>]*\sNAME\s*=\s*"([^"]+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(resp)) !== null) {
      const name = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

// ── get-period (#82) ───────────────────────────────────────────────────────
// The active company's period, so callers never infer valid dates or risk posting
// a voucher outside the open financial year.
export type CompanyPeriod = {
  company: string | null;
  fyFrom: string | null;       // financial-year start ($StartingFrom), ISO YYYY-MM-DD
  fyTo: string | null;         // financial-year end, ISO YYYY-MM-DD
  booksFrom: string | null;    // books-beginning date ($BooksFrom); earliest valid voucher date when a
                               // company started keeping books partway through the FY (distinct from fyFrom)
  currentDate: string | null;  // Tally's working/current date
  lastEntryDate: string | null;// date of the most recent voucher
  fyToInferred: boolean;       // true when fyTo was computed from fyFrom (Tally left $EndingAt empty)
};

const TALLY_MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

// Normalizes a Tally date to ISO YYYY-MM-DD. Tally emits dates as `d-MMM-yyyy` (e.g. "1-Apr-2026");
// also tolerates `d-MMM-yy` and already-ISO input. Returns null for empty/unparseable values.
export function normalizeTallyDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const mon = TALLY_MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    let year = m[3];
    if (year.length === 2) year = (Number(year) >= 70 ? '19' : '20') + year;
    return `${year}-${mon}-${day}`;
  }
  return null;
}

// Pure parser for the get-period Tally XML response. Picks the row matching `preferCompany`
// (case-insensitive) or the first row, mapping F01..F05 → the period contract. When Tally leaves
// $EndingAt (F03) empty for an ongoing year, fyTo is inferred as fyFrom + 1 year − 1 day (the Indian
// FY convention: 1-Apr-2026 → 31-Mar-2027) and fyToInferred is set. Kept pure so it's unit-testable
// without a live Tally.
export function parseCompanyPeriod(xml: string, preferCompany?: string | null): CompanyPeriod {
  const empty: CompanyPeriod = { company: null, fyFrom: null, fyTo: null, booksFrom: null, currentDate: null, lastEntryDate: null, fyToInferred: false };
  if (!xml) return empty;
  const rows = xml.match(/<ROW>[\s\S]*?<\/ROW>/gi) || [];
  if (rows.length === 0) return empty;
  const field = (row: string, tag: string): string | null => {
    const m = row.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) return null;
    const v = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    return v || null;
  };
  const first = rows[0];
  if (first === undefined) return empty;
  let chosen: string = first;
  if (preferCompany) {
    const want = preferCompany.trim().toLowerCase();
    const match = rows.find(r => (field(r, 'F01') || '').toLowerCase() === want);
    if (match) chosen = match;
  }
  const fyFrom = normalizeTallyDate(field(chosen, 'F02'));
  let fyTo = normalizeTallyDate(field(chosen, 'F03'));
  let fyToInferred = false;
  if (!fyTo && fyFrom) {
    const m = fyFrom.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]) + 1, Number(m[2]) - 1, Number(m[3])));
      d.setUTCDate(d.getUTCDate() - 1);
      fyTo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      fyToInferred = true;
    }
  }
  return {
    company: field(chosen, 'F01'),
    fyFrom,
    fyTo,
    booksFrom: normalizeTallyDate(field(chosen, 'F06')),
    currentDate: normalizeTallyDate(field(chosen, 'F04')),
    lastEntryDate: normalizeTallyDate(field(chosen, 'F05')),
    fyToInferred
  };
}

// Builds the period report envelope, posts it, and parses. Injects SVCURRENTCOMPANY only when a
// company is given; omitting it lets Tally use its current company (repo convention).
async function fetchCompanyPeriod(companyName: string | null): Promise<CompanyPeriod> {
  const svCompany = companyName
    ? `<SVCURRENTCOMPANY>${companyName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</SVCURRENTCOMPANY>`
    : '';
  const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPPeriodReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany}</STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPPeriodReport"><FORMS>MCPPeriodForm</FORMS></REPORT><FORM NAME="MCPPeriodForm"><PARTS>MCPPeriodPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPPeriodPart"><LINES>MCPPeriodLine</LINES><REPEAT>MCPPeriodLine : MCPPeriodColl</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MCPPeriodLine"><FIELDS>FCname,FCfrom,FCto,FCcur,FClast,FCbooks</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="FCname"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD><FIELD NAME="FCfrom"><SET>$StartingFrom</SET><XMLTAG>F02</XMLTAG></FIELD><FIELD NAME="FCto"><SET>$EndingAt</SET><XMLTAG>F03</XMLTAG></FIELD><FIELD NAME="FCcur"><SET>##SVCurrentDate</SET><XMLTAG>F04</XMLTAG></FIELD><FIELD NAME="FClast"><SET>$LastVoucherDate</SET><XMLTAG>F05</XMLTAG></FIELD><FIELD NAME="FCbooks"><SET>$BooksFrom</SET><XMLTAG>F06</XMLTAG></FIELD><COLLECTION NAME="MCPPeriodColl"><TYPE>Company</TYPE></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const resp = await postTallyXML(xml);
  return parseCompanyPeriod(resp, companyName);
}

// ── read-surface helpers (#92 H-6, #93 H-7) ────────────────────────────────
// Explicit row count so an empty-but-successful read (count:0) is distinguishable from a failure
// (which routes through errorResult). Non-arrays → 0.
export function rowCount(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

// The display name of a master row, defensively: prefer a `name` field, else the first column value.
function masterRowName(row: unknown): string {
  if (row && typeof row === 'object') {
    const r = row as Record<string, unknown>;
    if ('name' in r) return String(r.name ?? '');
    const vals = Object.values(r);
    return vals.length ? String(vals[0] ?? '') : '';
  }
  return String(row ?? '');
}

// Dumb, deterministic filter for search-master (#93): case-insensitive substring or prefix match on
// the row name only. NO ranking, NO fuzzy scoring, NO reordering — matches are returned in source
// order. Empty/blank query returns all rows unchanged (behaves like list-master).
export function filterMasterRows<T>(rows: T[], query: string, mode: 'substring' | 'prefix' = 'substring'): T[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(row => {
    const name = masterRowName(row).toLowerCase();
    return mode === 'prefix' ? name.startsWith(q) : name.includes(q);
  });
}

// Normalize a company name for fuzzy comparison: lowercase, drop everything
// except letters and digits. Lets us match "Ross Computer Pvt Ltd" against
// "ROSS COMPUTERS PVT. LTD." despite differing punctuation, case, and plurals
// (well, almost — plurals still differ; substring match below handles that).
function normalizeCompanyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Standard Levenshtein distance — number of single-character edits (insertions,
// deletions, substitutions) to transform `a` into `b`. O(n*m) memory and time;
// fine for short strings like company names. Used as the last fuzzy-match tier
// to catch typos and plural mismatches (e.g. "Computer" vs "Computers").
// Defense-in-depth cap on the O(n*m) DP matrix. Callers should bound their inputs
// (e.g. set-active-company caps companyName at 256), but this guard makes the
// function self-safe: a pathological multi-KB string can't allocate a huge matrix.
// Beyond this length no realistic company name matches anyway, so returning the
// length delta (a lower bound on the true distance, always > any sane maxDist)
// safely reports "no fuzzy match" without touching the matrix.
const LEVENSHTEIN_MAX_LEN = 256;

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > LEVENSHTEIN_MAX_LEN || b.length > LEVENSHTEIN_MAX_LEN) {
    return Math.abs(a.length - b.length) || Math.max(a.length, b.length);
  }
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    dp.push(new Array(b.length + 1).fill(0));
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Finds the loaded company that best matches `target`. Returns the EXACT
// Tally-side name (preserving case + punctuation) so the caller can use it
// in subsequent queries. Returns null when nothing matches.
//
// Match tiers (first one that hits wins):
//   1. Case-insensitive exact match
//   2. Normalized exact match (strip case + punctuation + whitespace)
//   3. Normalized substring match — either direction, so "Ross" matches
//      "Ross Computers Pvt. Ltd." and vice versa
//   4. Levenshtein distance ≤ 15% of longer name length (min 2) — catches
//      single-char typos and plural mismatches like "Computer" vs "Computers"
export function findMatchingLoadedCompany(target: string, loaded: string[]): string | null {
  if (!loaded || loaded.length === 0 || !target) return null;
  const t = target.toLowerCase();
  for (const c of loaded) {
    if (c.toLowerCase() === t) return c;
  }
  const tn = normalizeCompanyName(target);
  if (!tn) return null;
  for (const c of loaded) {
    if (normalizeCompanyName(c) === tn) return c;
  }
  for (const c of loaded) {
    const cn = normalizeCompanyName(c);
    if (cn.includes(tn) || tn.includes(cn)) return c;
  }
  let best: { name: string; dist: number } | null = null;
  for (const c of loaded) {
    const cn = normalizeCompanyName(c);
    const dist = levenshteinDistance(tn, cn);
    const maxDist = Math.max(2, Math.floor(Math.max(tn.length, cn.length) * 0.15));
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { name: c, dist };
    }
  }
  return best ? best.name : null;
}

// Runs an async boolean probe up to `attempts` times with a small backoff and
// returns true as soon as any attempt succeeds — used by the `status` tool to
// absorb a single transient Tally/agent blip so the reported state doesn't flap
// between calls. A throwing probe counts as a miss. `sleep` is injectable so the
// retry logic can be unit-tested without real delays.
export async function probeWithRetry(
  probe: () => Promise<boolean>,
  attempts = 3,
  backoffMs = 150,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms))
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await probe()) return true;
    } catch {
      // treat an error as a miss and keep retrying
    }
    if (i < attempts - 1) await sleep(backoffMs);
  }
  return false;
}

// Like probeWithRetry but returns the produced value: retries an operation up to `attempts` times
// until `isSuccess` holds, with backoff. Used for the self-healing unlock loop (#89 H-3) — on a
// keystroke miss the whole select-and-unlock is re-dispatched (the agent re-keys + re-verifies each
// attempt) before the host surrenders PASSWORD_REQUIRED. Returns the last value + the attempt count.
export async function retryForResult<T>(
  attempt: () => Promise<T | null>,
  isSuccess: (r: T | null) => boolean,
  attempts = 3,
  backoffMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms))
): Promise<{ result: T | null; attempts: number }> {
  let last: T | null = null;
  for (let i = 0; i < attempts; i++) {
    try { last = await attempt(); } catch { last = null; }
    if (isSuccess(last)) return { result: last, attempts: i + 1 };
    if (i < attempts - 1) await sleep(backoffMs);
  }
  return { result: last, attempts };
}

// open-company strategy renames (#24): the old tdl-* names implied a TDL *load*
// primitive, but these strategies only verify (no XML/TDL load primitive exists).
// Old names stay accepted as deprecated aliases for one release.
const OPEN_COMPANY_STRATEGY_ALIASES: Record<string, string> = {
  'tdl-load': 'verify-svcurrentcompany',
  'tdl-connect': 'verify-in-loaded-list',
};
export function normalizeOpenCompanyStrategy(s: string): { strategy: string; deprecatedAlias: string | null } {
  const alias = OPEN_COMPANY_STRATEGY_ALIASES[s];
  return alias ? { strategy: alias, deprecatedAlias: s } : { strategy: s, deprecatedAlias: null };
}

// Extracts the <TALLYREQUEST> verb from a raw Tally XML envelope (e.g. "Export",
// "Import", "Alter", "Delete"), lowercased, or null if none is present. Used to
// keep the raw-XML debug probe read-only by default: only "export" reads data;
// Import/Alter/Delete mutate it. Tolerates attributes and surrounding whitespace.
export function parseTallyRequestVerb(xml: string): string | null {
  const m = /<TALLYREQUEST\b[^>]*>\s*([^<\s]+)\s*<\/TALLYREQUEST>/i.exec(xml);
  return m ? m[1].toLowerCase() : null;
}

// Minimal path interface so the containment check can be unit-tested against
// both posix and win32 semantics regardless of the host OS.
type PathLike = { resolve: (...segments: string[]) => string; sep: string };

// Returns true when `candidate` resolves to `root` itself or a path strictly
// inside it. Canonicalizes both sides and compares on a separator boundary so
// "/data/../etc" or a sibling like "/data-evil" cannot pass as "/data".
export function isPathWithinRoots(candidate: string, roots: string[], p: PathLike = path): { ok: boolean; resolved: string } {
  const resolved = p.resolve(candidate);
  for (const root of roots) {
    if (!root) continue;
    const r = p.resolve(root);
    const rWithSep = r.endsWith(p.sep) ? r : r + p.sep;
    if (resolved === r || resolved.startsWith(rWithSep)) return { ok: true, resolved };
  }
  return { ok: false, resolved };
}

// Parses tally.ini content and returns the list of company IDs in `Load=` directives under [TALLY].
// Tally Prime auto-loads each Load=<id> entry on startup when Default Companies=Yes.
export function parseTallyIniLoads(iniContent: string): string[] {
  const matches = iniContent.matchAll(/^[ \t]*Load[ \t]*=[ \t]*([^\r\n;]+?)[ \t]*$/gim);
  return Array.from(matches, m => m[1].trim()).filter(s => s.length > 0);
}

// Returns the value of the `Data=<path>` directive from tally.ini, or null if absent.
// This is Tally Prime's canonical setting for where company folders live — preferred over
// any external assumption about paths.
export function parseTallyIniDataPath(iniContent: string): string | null {
  const m = iniContent.match(/^[ \t]*Data[ \t]*=[ \t]*([^\r\n;]+?)[ \t]*$/im);
  return m ? m[1].trim() : null;
}

// Returns a new tally.ini string with the Load= lines replaced by exactly `companyIds`.
// Preserves all other content; inserts new lines after `Default Companies=` (or [TALLY] header) to keep grouping clean.
// Preserves the original line ending style (CRLF vs LF).
export function rewriteTallyIniLoads(iniContent: string, companyIds: string[]): string {
  const eol = iniContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = iniContent.split(/\r?\n/);
  const filtered = lines.filter(l => !/^[ \t]*Load[ \t]*=/i.test(l));
  const dcIdx = filtered.findIndex(l => /^[ \t]*Default Companies[ \t]*=/i.test(l));
  let insertAt: number;
  if (dcIdx >= 0) {
    insertAt = dcIdx + 1;
  } else {
    const tallyIdx = filtered.findIndex(l => /^[ \t]*\[TALLY\][ \t]*$/i.test(l));
    insertAt = tallyIdx >= 0 ? tallyIdx + 1 : filtered.length;
  }
  filtered.splice(insertAt, 0, ...companyIds.map(id => `Load=${id}`));
  return filtered.join(eol);
}

// Atomically writes content to filePath using a temp-file + rename pattern (no torn writes if the
// process dies mid-write). Also important for the GUI-agent IPC files (_mcp_gui_command.json): the
// rename replaces the target with a freshly created inode, so it re-inherits the directory ACL every
// write. An in-place fs.writeFileSync would preserve a stale/narrower ACL on an existing file, which
// is how the agent (running under a UAC-filtered "Limited" token that drops Administrators) ends up
// with "Access is denied" reading commands the SYSTEM service wrote.
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Don't leak the temp file if the rename loses (e.g. target briefly open by the agent's
    // ReadAllText, or an AV scan) — otherwise .tmp.* orphans accumulate on this high-frequency path.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Scans a Tally data directory and returns one entry per digit-named folder, with the company name extracted from Company.900 when present.
// Returns [] if dataPath does not exist. Folders without a parseable Company.900 still appear with name=''.
export function scanCompanyFolders(dataPath: string): Array<{ folder: string; name: string }> {
  if (!fs.existsSync(dataPath)) return [];
  const entries = fs.readdirSync(dataPath, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
    .map(e => {
      // Use the shared BFS finder so nested Edit Log layouts (Company.1800 one
      // level deeper) resolve a name too, instead of leaving it blank.
      const found = findCompanyMetadataFile(path.join(dataPath, e.name), 3);
      const name = found ? extractCompanyNameFromMetadataFile(found.metaPath) : '';
      return { folder: e.name, name };
    });
}

// Reads a company name from a Tally Company.* metadata file (Company.900 for stock layouts,
// Company.1800 for Tally Prime Edit Log). The files are UTF-16LE blobs with a leading binary
// header followed by the human-readable company name. We strip non-printable bytes and
// extract the longest run of letters/spaces/punctuation that looks like a company name.
// Returns '' if the file cannot be read or no name is recoverable.
export function extractCompanyNameFromMetadataFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const buf = fs.readFileSync(filePath);
    const text = buf.toString('utf16le').replace(/[^\x20-\x7Eऀ-ॿ]/g, ' ').trim();
    const match = text.match(/[A-Za-zऀ-ॿ][\w\sऀ-ॿ.&(),-]{2,}/);
    return match ? match[0].trim() : '';
  } catch {
    return '';
  }
}

// Finds the first Company.900 (flat layout) or Company.1800 (Edit Log nested layout)
// under `root`, BFS to maxDepth. Returns the metadata path + a layout marker
// (depth 0 = flat, depth >= 1 = nested). Shared by scanAvailableCompanies,
// scanCompanyFolders, and list-companies so every folder-scanning path recovers
// names the same robust way (fixes blank names for nested-layout folders).
export function findCompanyMetadataFile(root: string, maxDepth = 3): { metaPath: string; layout: 'flat' | 'nested' } | null {
  type Frame = { dir: string; depth: number };
  const queue: Frame[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^Company\.(900|1800)$/i.test(entry.name)) {
        return { metaPath: path.join(dir, entry.name), layout: depth === 0 ? 'flat' : 'nested' };
      }
    }
    if (depth < maxDepth) {
      for (const entry of entries) {
        if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

// Describes a discovered company and its load-readiness — the structured shape returned by
// list-available-companies. A caller (LLM or human) gets enough context here to:
//   - decide which company to load (folderId / displayName)
//   - know whether data files are present (hasData) before risking a load
//   - know whether to prompt the human for credentials (requiresCredentials)
//   - deal with both layouts: traditional <data>/<id>/Company.900 and Edit Log's <data>/<id>/<id>/Company.1800
export type AvailableCompany = {
  folderId: string;
  folderPath: string;
  displayName: string;
  hasData: boolean;
  dataFilePath: string | null;
  requiresCredentials: boolean | null;  // null = unknown; only true/false when the credential-hint config is present
  knownUsername: string | null;
  notes: string;
};

// Optional credential-hint config. Mapping of folder id → known credential metadata.
// Allows callers to know up-front whether to ask the human for credentials (issue #16, piece C).
// We never store passwords here — only the hint that one is needed.
export type CompaniesConfig = {
  [folderId: string]: {
    requiresCredentials?: boolean;
    knownUsername?: string;
    notes?: string;
  };
};

// Company registry entry — one configured alias the user can refer to from an LLM ("load main").
// Passwords live in `passwordEnc` as a DPAPI-encrypted base64 blob; plaintext never touches disk.
export type CompanyEntry = {
  alias: string;
  extraAliases?: string[];
  folderId: string;
  displayName?: string;
  username?: string;
  passwordEnc?: string;
  notes?: string;
};

// The on-disk shape of .tally-mcp-companies.json after the registry feature.
// Old-shape files (a flat { folderId: hints } map) are migrated into `legacyHints` on read;
// `companies` starts empty and is populated via the Manage Companies dashboard.
// Path: <dataPath>/.tally-mcp-companies.json by default, or override via TALLY_COMPANIES_CONFIG env var.
export type CompanyRegistry = {
  schemaVersion: 1;
  companies: CompanyEntry[];
  legacyHints?: CompaniesConfig;
};

export const EMPTY_COMPANY_REGISTRY: CompanyRegistry = {
  schemaVersion: 1,
  companies: [],
};

function isNewRegistryShape(parsed: any): parsed is CompanyRegistry {
  return !!parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.schemaVersion === 1
    && Array.isArray(parsed.companies);
}

// Back-compat reader — returns just the flat hints. Used by scanAvailableCompanies and any other
// caller that only cares about "does this folderId need a credential prompt." New code should
// prefer loadCompanyRegistry instead.
export function loadCompaniesConfig(configPath: string): CompaniesConfig {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (isNewRegistryShape(parsed)) return parsed.legacyHints ?? {};
    return parsed as CompaniesConfig;
  } catch {
    return {};
  }
}

// Reads the full registry. Migrates old-shape files in-memory only — does NOT write back.
// Persistence happens through saveCompanyRegistry, called from the Manage Companies dashboard.
export function loadCompanyRegistry(configPath: string): CompanyRegistry {
  try {
    if (!fs.existsSync(configPath)) return { schemaVersion: 1, companies: [] };
    const raw = fs.readFileSync(configPath, 'utf-8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { schemaVersion: 1, companies: [] };
    }
    if (isNewRegistryShape(parsed)) return parsed;
    return {
      schemaVersion: 1,
      companies: [],
      legacyHints: parsed as CompaniesConfig,
    };
  } catch {
    return { schemaVersion: 1, companies: [] };
  }
}

// Atomic write of the registry. Used by the Manage Companies dashboard on save.
// Caller is responsible for ensuring passwordEnc fields are already DPAPI-encrypted —
// this function never sees plaintext and never transforms entries.
export function saveCompanyRegistry(configPath: string, registry: CompanyRegistry): void {
  atomicWriteFile(configPath, JSON.stringify(registry, null, 2) + '\n');
}

// Case-insensitive exact-match lookup against alias + extraAliases. Returns null if no match —
// callers should surface the list of valid aliases in the error so the LLM can recover.
export function findCompanyByAlias(registry: CompanyRegistry, alias: string): CompanyEntry | null {
  const target = alias.trim().toLowerCase();
  if (!target) return null;
  for (const c of registry.companies) {
    if (c.alias.trim().toLowerCase() === target) return c;
    if (c.extraAliases?.some(a => a.trim().toLowerCase() === target)) return c;
  }
  return null;
}

// Returns every alias the user could legitimately type — main alias + extra aliases, deduped,
// in declaration order. Used in error messages when an unknown alias is requested.
export function listConfiguredAliases(registry: CompanyRegistry): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of registry.companies) {
    for (const a of [c.alias, ...(c.extraAliases ?? [])]) {
      const key = a.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(a);
      }
    }
  }
  return out;
}

// Path to the PowerShell helper that performs the actual DPAPI Protect/Unprotect.
// Compiled output lives in dist/, so the helper resolves to ../scripts/dpapi-helper.ps1.
function dpapiHelperPath(): string {
  return path.resolve(import.meta.dirname, '..', 'scripts', 'dpapi-helper.ps1');
}

// Spawns the DPAPI helper with input on stdin (never command-line args, so secrets don't
// appear in process listings). Returns the helper's stdout as a string. Throws if the helper
// exits non-zero, returns empty output, or cannot be spawned.
function runDpapiHelper(action: 'encrypt' | 'decrypt', input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', dpapiHelperPath(), '-Action', action],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`dpapi-helper ${action} exited ${code}: ${stderr.trim() || 'unknown error'}`));
        return;
      }
      if (!stdout) {
        reject(new Error(`dpapi-helper ${action} returned empty output`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input, 'utf-8');
  });
}

// Encrypts a password using Windows DPAPI (LocalMachine scope). Returns a base64 blob suitable
// for storage in CompanyEntry.passwordEnc. The plaintext is passed via stdin to the helper
// process — it never appears on the command line or in any log.
export async function encryptPasswordViaDpapi(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error('encryptPasswordViaDpapi: plaintext is empty');
  return runDpapiHelper('encrypt', plaintext);
}

// Decrypts a DPAPI blob previously produced by encryptPasswordViaDpapi. Throws if the blob was
// encrypted on a different machine, with a different scope, or has been tampered with.
export async function decryptPasswordViaDpapi(blob: string): Promise<string> {
  if (!blob) throw new Error('decryptPasswordViaDpapi: blob is empty');
  return runDpapiHelper('decrypt', blob);
}

// Recursively scans a Tally data directory for company folders and extracts everything we can
// without touching Tally itself. Handles both layouts:
//   - Stock Tally Prime: <data>/<id>/Company.900
//   - Tally Prime Edit Log: <data>/<id>/<id>/Company.1800   (data files one level deeper)
//
// Returns one entry per top-level digit-named folder (the canonical "company id"), with a
// `dataFilePath` pointing at the first .900/.1800 found anywhere in the tree (we walk depth-first
// up to maxDepth=3 to bound cost on pathological filesystems). hasData=false means the folder
// exists but no Company.* metadata file was found — usually indicates an empty placeholder.
//
// If `configPath` is supplied, credential-hint metadata from that JSON file is merged into the
// output so callers can short-circuit credential prompting for known-clean companies.
export function scanAvailableCompanies(
  dataPath: string,
  configPath?: string
): AvailableCompany[] {
  if (!fs.existsSync(dataPath)) return [];

  const config = configPath ? loadCompaniesConfig(configPath) : {};

  const entries = fs.readdirSync(dataPath, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
    .map(e => {
      const folderPath = path.join(dataPath, e.name);
      const found = findCompanyMetadataFile(folderPath, 3);
      const displayName = found ? extractCompanyNameFromMetadataFile(found.metaPath) : '';

      const hint = config[e.name] || {};
      const requiresCredentials = typeof hint.requiresCredentials === 'boolean' ? hint.requiresCredentials : null;
      const knownUsername = typeof hint.knownUsername === 'string' && hint.knownUsername.length > 0 ? hint.knownUsername : null;

      const notesPieces: string[] = [];
      if (found?.layout === 'nested') notesPieces.push('Edit Log nested layout (data one level deep)');
      if (typeof hint.notes === 'string' && hint.notes.length > 0) notesPieces.push(hint.notes);
      if (!found) notesPieces.push('No Company.900/.1800 found — likely empty/placeholder folder');

      return {
        folderId: e.name,
        folderPath,
        displayName,
        hasData: !!found,
        dataFilePath: found ? found.metaPath : null,
        requiresCredentials,
        knownUsername,
        notes: notesPieces.join('; ')
      };
    });
}

// Resolves a user-supplied company identifier (folder id like "100000", or company name like "Ross Industries") to a unique folder id.
// Pure function — no filesystem access. Caller passes the folder list from scanCompanyFolders().
//
// Match rules:
//   - If input is digit-only, treat it as a folder id; success only if a folder with that id exists in `folders`.
//   - Otherwise, do a case-insensitive name match against folders[].name.
//   - 0 matches → not-found.
//   - 1 match → ok.
//   - 2+ matches by name → ambiguous (caller must surface the folder ids and ask the user to disambiguate).
export type ResolveCompanyResult =
  | { kind: 'ok'; folderId: string; companyName: string; matchedBy: 'id' | 'name' }
  | { kind: 'ambiguous'; matches: Array<{ folder: string; name: string }> }
  | { kind: 'not-found'; available: Array<{ folder: string; name: string }> };

export function resolveCompanyInput(input: string, folders: Array<{ folder: string; name: string }>): ResolveCompanyResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'not-found', available: folders };
  if (/^\d+$/.test(trimmed)) {
    const found = folders.find(f => f.folder === trimmed);
    if (found) return { kind: 'ok', folderId: found.folder, companyName: found.name, matchedBy: 'id' };
    return { kind: 'not-found', available: folders };
  }
  const lc = trimmed.toLowerCase();
  const nameMatches = folders.filter(f => f.name.length > 0 && f.name.toLowerCase() === lc);
  if (nameMatches.length === 1) {
    return { kind: 'ok', folderId: nameMatches[0].folder, companyName: nameMatches[0].name, matchedBy: 'name' };
  }
  if (nameMatches.length > 1) return { kind: 'ambiguous', matches: nameMatches };
  return { kind: 'not-found', available: folders };
}

// Enriched, client-facing resolution result for the resolve-company tool (#59):
// one canonical record per match, joined against the alias registry (alias,
// isProtected) and the loaded list (isLoaded). Union-typed like the internal
// resolver so callers can branch on ok / ambiguous / not-found.
export type ResolvedCompanyRecord = {
  name: string;
  folderId: string;
  alias: string | null;
  isLoaded: boolean;
  isProtected: boolean;
  matchedBy: 'id' | 'name' | 'alias';
};
export type ResolveCompanyEnriched =
  | { kind: 'ok'; company: ResolvedCompanyRecord }
  | { kind: 'ambiguous'; matches: Array<{ folderId: string; name: string; alias: string | null }> }
  | { kind: 'not-found'; available: Array<{ folderId: string; name: string; alias: string | null }> };

// Pure resolver used by the resolve-company tool. Resolves a folder id, an exact
// company name, OR a configured alias to a single enriched record. No I/O — the
// caller supplies the folder list, the registry, and the loaded-company names.
export function resolveCompanyEnriched(
  query: string,
  folders: Array<{ folder: string; name: string }>,
  registry: CompanyRegistry,
  loadedNames: string[]
): ResolveCompanyEnriched {
  const aliasFor = (folderId: string): string | null =>
    registry.companies.find(c => c.folderId === folderId)?.alias ?? null;
  const isProtectedFor = (folderId: string): boolean => {
    const entry = registry.companies.find(c => c.folderId === folderId);
    if (entry && typeof entry.passwordEnc === 'string' && entry.passwordEnc.length > 0) return true;
    return registry.legacyHints?.[folderId]?.requiresCredentials === true;
  };
  const isLoadedName = (name: string): boolean => {
    const n = name.trim().toLowerCase();
    return n.length > 0 && loadedNames.some(l => l.trim().toLowerCase() === n);
  };
  // Resolve the real canonical display name by DETERMINISTIC precedence (#90 H-4), instead of
  // trusting the heuristic byte-scrape of the binary Company.900/1800 metadata (which can truncate
  // or garble the name):
  //   1. the live Tally-reported name if this company is loaded (authoritative exact casing),
  //   2. else the registry-configured displayName for this folderId (deterministic, user-set),
  //   3. else fall back to the scraped folder name.
  const canonicalName = (folderId: string, scrapedName: string): string => {
    const n = scrapedName.trim().toLowerCase();
    if (n) {
      const live = loadedNames.find(l => l.trim().toLowerCase() === n);
      if (live) return live;
    }
    const disp = registry.companies.find(c => c.folderId === folderId)?.displayName;
    if (disp && disp.trim()) return disp;
    return scrapedName;
  };
  const record = (folderId: string, name: string, matchedBy: 'id' | 'name' | 'alias'): ResolvedCompanyRecord => {
    const canonical = canonicalName(folderId, name);
    return {
      name: canonical,
      folderId,
      alias: aliasFor(folderId),
      isLoaded: isLoadedName(canonical),
      isProtected: isProtectedFor(folderId),
      matchedBy,
    };
  };
  const withAlias = (list: Array<{ folder: string; name: string }>) =>
    list.map(f => ({ folderId: f.folder, name: f.name, alias: aliasFor(f.folder) }));

  const base = resolveCompanyInput(query, folders);
  if (base.kind === 'ok') {
    return { kind: 'ok', company: record(base.folderId, base.companyName, base.matchedBy) };
  }
  if (base.kind === 'ambiguous') {
    return { kind: 'ambiguous', matches: withAlias(base.matches) };
  }
  // not-found by id/name — try the alias registry before giving up.
  const entry = findCompanyByAlias(registry, query);
  if (entry) {
    // Pass the SCRAPED name; record()/canonicalName apply the deterministic precedence
    // (live Tally name → registry displayName → scrape), so a garbled scrape can't win over
    // the configured displayName (#90 H-4).
    const scraped = folders.find(f => f.folder === entry.folderId)?.name || '';
    return { kind: 'ok', company: record(entry.folderId, scraped, 'alias') };
  }
  return { kind: 'not-found', available: withAlias(base.available) };
}

// ── use-company orchestration (#87 H-1) ────────────────────────────────────
export type UseCompanyPlan =
  | { action: 'set-active'; company: ResolvedCompanyRecord }
  | { action: 'load-vault'; company: ResolvedCompanyRecord }    // configured registry entry → vault select-and-unlock
  | { action: 'load-restart'; company: ResolvedCompanyRecord }  // not resident, no vault entry → tally.ini restart
  | { action: 'error'; code: 'AMBIGUOUS' | 'COMPANY_NOT_FOUND' };

// Pure routing for use-company: given a resolved company, decide the single deterministic next action.
//   already loaded            → set-active (fast path: no restart, no keystrokes)
//   configured (has alias/vault) → load-vault (stored-credential select-and-unlock)
//   otherwise                 → load-restart (tally.ini rewrite + Tally restart)
export function planUseCompany(resolved: ResolveCompanyEnriched): UseCompanyPlan {
  if (resolved.kind === 'ambiguous') return { action: 'error', code: 'AMBIGUOUS' };
  if (resolved.kind === 'not-found') return { action: 'error', code: 'COMPANY_NOT_FOUND' };
  const c = resolved.company;
  if (c.isLoaded) return { action: 'set-active', company: c };
  if (c.alias) return { action: 'load-vault', company: c };
  return { action: 'load-restart', company: c };
}

// Resolves the configured Tally edition from env var. Defaults to "silver" — safer assumption since
// Silver is more restrictive (single company resident); Gold treated as Silver still works, just slower than necessary.
// Anything other than "gold" (case-insensitive) is treated as Silver.
export function getTallyEdition(rawValue: string | undefined = process.env.TALLY_EDITION): 'silver' | 'gold' {
  return String(rawValue || '').trim().toLowerCase() === 'gold' ? 'gold' : 'silver';
}

// Minimum GUI-agent version this server is willing to talk to. Bumped whenever load-company
// or open-company-debug start to depend on a new IPC field/action that older agents won't
// recognize. The agent reports its version on every response (see Write-Result in
// tally-gui-agent-v2.ps1). If a deploy ships a server expecting a newer agent than is running,
// we fail fast with a clear message instead of letting the agent silently no-op on unknown
// fields. (issue #15 - version handshake, option D).
export const REQUIRED_AGENT_VERSION = '1.1.0';

// Compares two MAJOR.MINOR.PATCH version strings. Returns true if `actual` is at least `required`.
// Missing/unparseable segments are treated as 0 — so "1" >= "1.0.0", "1.2" >= "1.1.99", etc.
// Non-numeric suffixes like "1.1.0-rc1" compare by their numeric prefix only ("1.1.0").
export function isAgentVersionAtLeast(actual: string | null | undefined, required: string): boolean {
  if (!actual) return false;
  const parse = (v: string) => v.split('.').map(s => {
    const m = s.match(/^\d+/);
    return m ? Number(m[0]) : 0;
  });
  const a = parse(actual);
  const r = parse(required);
  const len = Math.max(a.length, r.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const ri = r[i] ?? 0;
    if (ai > ri) return true;
    if (ai < ri) return false;
  }
  return true;
}

// Result returned from callGuiAgent. Includes the agent-reported version when present, so callers
// can do version-handshake checks (load-company refuses if too old, open-company-debug surfaces it).
export type GuiAgentResponse = {
  status: string;
  message: string;
  agentVersion: string | null;
  raw: Record<string, any>;
};

// Sends a command to the GUI agent (running in the user's desktop session) via the JSON file IPC pattern,
// and waits for a matching response. Returns the agent's response or null on timeout.
// Used to bridge Session 0 isolation — the MCP service can't spawn GUI apps directly when running as a service.
async function callGuiAgent(
  action: string,
  payload: Record<string, any>,
  timeoutSec: number,
  dataPath: string,
  logs: string[]
): Promise<GuiAgentResponse | null> {
  const commandFile = path.join(dataPath, '_mcp_gui_command.json');
  const resultFile = path.join(dataPath, '_mcp_gui_result.json');
  const commandId = createGuiAgentCommandId(action);

  try { fs.unlinkSync(resultFile); } catch {}
  const command = JSON.stringify({ action, ...payload, commandId, timestamp: new Date().toISOString() });
  atomicWriteFile(commandFile, command);
  logs.push(`  [gui-agent] sent action=${action} commandId=${commandId}, waiting up to ${timeoutSec}s`);

  try {
    for (let i = 0; i < timeoutSec; i++) {
      await sleep(1000);
      if (!fs.existsSync(resultFile)) continue;
      try {
        // Strip leading BOM defensively — PowerShell's [Encoding]::UTF8 emits a BOM that breaks JSON.parse.
        const resultText = fs.readFileSync(resultFile, 'utf-8').replace(/^﻿/, '');
        const result = JSON.parse(resultText);
        if (!isMatchingGuiAgentCommand(result, commandId)) {
          logs.push(`  [gui-agent] ignoring stale response for commandId ${result?.commandId || 'unknown'}`);
          try { fs.unlinkSync(resultFile); } catch {}
          continue;
        }
        const versionStr = typeof result.agentVersion === 'string' ? result.agentVersion : null;
        logs.push(`  [gui-agent] response: status=${result.status} message=${result.message}${versionStr ? ` agentVersion=${versionStr}` : ''}`);
        try { fs.unlinkSync(resultFile); } catch {}
        return {
          status: String(result.status || ''),
          message: String(result.message || ''),
          agentVersion: versionStr,
          raw: result
        };
      } catch {
        try { fs.unlinkSync(resultFile); } catch {}
      }
    }
    logs.push(`  [gui-agent] no response within ${timeoutSec}s`);
    return null;
  } finally {
    // The command file may carry a decrypted password. Never leave it on disk after
    // we're done — on the agent-down/timeout path nothing else removes it. On success
    // the agent has already consumed it, so this unlink is a harmless no-op.
    try { fs.unlinkSync(commandFile); } catch {}
  }
}

// Result of a GUI-agent ping: alive + version + whether version meets the server's required minimum.
// `versionOk=false` when alive=true means the agent is running but too old — load-company refuses
// in that case rather than risk silent no-ops on unrecognized IPC fields.
export type GuiAgentPingResult = {
  alive: boolean;
  agentVersion: string | null;
  versionOk: boolean;
};

// Lightweight ping to confirm the GUI agent is alive. Returns its version if reachable.
// Used as a pre-flight in load-company so we never kill Tally without confirming we can bring it back.
async function pingGuiAgent(dataPath: string, timeoutSec = 4, logs: string[] = []): Promise<GuiAgentPingResult> {
  const resp = await callGuiAgent('ping', {}, timeoutSec, dataPath, logs);
  if (!resp || resp.status !== 'success') {
    return { alive: false, agentVersion: null, versionOk: false };
  }
  const versionOk = isAgentVersionAtLeast(resp.agentVersion, REQUIRED_AGENT_VERSION);
  return { alive: true, agentVersion: resp.agentVersion, versionOk };
}

// Polls the Tally XML server until it responds successfully, or timeout elapses.
async function waitForTallyReady(timeoutMs: number, logs: string[]): Promise<boolean> {
  const ping = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>';
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      await postTallyXML(ping);
      logs.push(`  Tally XML server ready after ${Math.round((Date.now() - start) / 1000)}s (attempt ${attempt})`);
      return true;
    } catch {}
    await sleep(2000);
  }
  logs.push(`  Tally XML server did not respond within ${Math.round(timeoutMs / 1000)}s (${attempt} attempts)`);
  return false;
}

// Wraps handlePull — injects activeCompany as targetCompany fallback when the caller did not specify one.
async function pull(reportName: string, inputParams: Map<string, any>) {
  // Default to activeCompany if caller didn't specify one. activeCompany was
  // resolved by set-active-company (which does fuzzy + user-confirmation), so
  // it's always an exact Tally name by the time it lands here. We do NOT
  // silently fuzzy-resolve a user-supplied targetCompany — that would risk
  // running the report against the wrong company. If targetCompany is
  // imprecise, Tally returns empty data; the user is expected to first call
  // set-active-company which guides them through the fuzzy-match confirmation.
  if (!inputParams.has('targetCompany') && activeCompany) {
    inputParams.set('targetCompany', activeCompany);
  }
  return handlePull(reportName, inputParams);
}

// Wraps handlePush — injects activeCompany as targetCompany fallback when the caller did not specify one.
async function push(templateName: string, inputParams: Map<string, any>) {
  if (!inputParams.has('targetCompany') && activeCompany) {
    inputParams.set('targetCompany', activeCompany);
  }
  return handlePush(templateName, inputParams);
}

// Static list of external preconditions surfaced by get-context so a fresh agent
// can learn what must be running before it loads a company — without hitting walls.
export function getTallyRequirements(): { requirement: string; why: string }[] {
  return [
    { requirement: 'Tally Prime running with its XML/HTTP server enabled (default port 9000)', why: 'Every data read (ledgers, vouchers, GST, balance sheet) goes through Tally\'s XML server.' },
    { requirement: 'GUI automation agent (tally-gui-agent-v2.ps1) running in the interactive desktop session', why: 'Required to load/switch companies and to unlock password-protected companies. Not needed for read-only queries against an already-loaded company.' },
    { requirement: 'Credentials for password-protected companies', why: 'load-company / load-company-by-alias need userName+password for protected companies; list-available-companies flags which folders require them.' },
    { requirement: 'Edition awareness (Silver vs Gold)', why: 'Silver keeps only one company resident at a time — loading another replaces it; Gold allows several.' },
  ];
}

// Server-level tool-selection guidance delivered to the MCP client (like GitHub's MCP does).
const TALLY_MCP_INSTRUCTIONS = `Tally Prime MCP server — exposes a local Tally Prime ERP as typed tools (GST returns, balance sheet, vouchers, ledgers, masters).

Getting started:
- Call \`status\` first: is Tally reachable, is the GUI agent alive, what is the active company, edition (silver/gold), and readonly mode. \`get-context\` returns the same plus the list of external requirements.
- Find a company with \`list-available-companies\` (flags which need credentials) or \`list-companies\`; switch an already-loaded one with \`set-active-company\`.
- Cold-load with \`load-company\` / \`load-company-by-alias\` (edition-aware; supply userName+password for protected companies). \`open-company\`'s verify-* strategies only check — they do not load.
- Once a company is active, all query tools target it unless you pass targetCompany.

Hard preconditions (discover via \`status\`/\`get-context\`, don't hit walls):
- The Tally XML server must be running for any data read.
- The GUI automation agent must be running to load/switch companies or unlock protected ones.
- On Silver only one company is resident at a time; loading another replaces it.
- Write tools are refused when readonly is true (READONLY_MODE).`;

// Shared liveness probe used by both `status` and `get-context`. Retries each
// probe so a single transient blip doesn't flip the reported state.
async function probeLiveness(): Promise<{ tallyReachable: boolean; agentAlive: boolean }> {
  const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
  const tallyReachable = await probeWithRetry(() => pingTally());
  const agentAlive = await probeWithRetry(async () => (await pingGuiAgent(tallyDataPath, 2)).alive, 2);
  return { tallyReachable, agentAlive };
}

// Server version, read from package.json (single source of truth). Falls back to
// 0.0.0 if the file can't be read.
export function getServerVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// The HTTP /status endpoint (#25) is opt-in: disabled unless STATUS_ENDPOINT_PUBLIC
// is "1" or "true". Pure so the gating can be unit-tested.
export function isStatusEndpointEnabled(raw: string | undefined = process.env.STATUS_ENDPOINT_PUBLIC): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

// Builds the health report served by the HTTP GET /status endpoint. Richer than the
// MCP `status` tool's stable contract: includes version, agent version handshake,
// loaded companies, and optional build info. Reuses the retried Tally probe.
export async function getHttpStatusReport(): Promise<{
  ok: boolean;
  version: string;
  edition: 'silver' | 'gold';
  readonly: boolean;
  activeCompany: string | null;
  agent: { responding: boolean; version: string | null; versionOk: boolean };
  tally: { reachable: boolean; loadedCompanies: string[] };
  build: { commit: string | null; builtAt: string | null };
}> {
  const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
  const tallyReachable = await probeWithRetry(() => pingTally());
  const agentPing = await pingGuiAgent(tallyDataPath, 2);
  let loadedCompanies: string[] = [];
  if (tallyReachable) {
    try { loadedCompanies = await listLoadedCompanies(); } catch { /* leave empty */ }
  }
  return {
    ok: tallyReachable,
    version: getServerVersion(),
    edition: getTallyEdition(),
    readonly: process.env.READONLY_MODE === 'true',
    activeCompany: activeCompany || null,
    agent: { responding: agentPing.alive, version: agentPing.agentVersion ?? null, versionOk: agentPing.versionOk },
    tally: { reachable: tallyReachable, loadedCompanies },
    build: { commit: process.env.GIT_COMMIT ?? null, builtAt: process.env.BUILD_TIME ?? null },
  };
}

// ── Typed, machine-readable tool errors (#61) ──────────────────────────────
// Tool failures used to be free-text log dumps the model had to read "like prose"
// to decide what to do next. A ToolError gives a machine-readable `code` plus
// `retryable` and a concrete `remedy`, so callers can branch deterministically;
// the raw transcript is demoted to a `logs` field instead of being the payload.
// The spec's fixed code enum (H-14): 10 codes the session can branch on deterministically.
// The first block is the 10 spec codes; the second is documented HOST EXTENSIONS that predate the
// spec and stay for backward-compat (they are NOT part of the spec-10):
//   - AGENT_TOO_OLD    — version-handshake failure (a specific AGENT_UNREACHABLE sub-case)
//   - COMPANY_NOT_FOUND— company-scoped not-found (distinct from master-scoped MASTER_NOT_FOUND)
//   - AMBIGUOUS        — company-match ambiguity (distinct from the general, host-deterministic AMBIGUOUS_INPUT)
//   - UNKNOWN          — unclassified fallback; every use is a candidate to reclassify onto a typed code
export type ToolErrorCode =
  // ── spec-10 (H-14) ──
  | 'AGENT_UNREACHABLE'
  | 'TALLY_DOWN'
  | 'PASSWORD_REQUIRED'
  | 'OUT_OF_PERIOD'
  | 'MASTER_NOT_FOUND'
  | 'AMBIGUOUS_INPUT'
  | 'UNBALANCED'
  | 'DUPLICATE'
  | 'READONLY'
  | 'PRECONDITION_FAILED'
  // ── host extensions (not in the spec-10) ──
  | 'AGENT_TOO_OLD'
  | 'COMPANY_NOT_FOUND'
  | 'AMBIGUOUS'
  | 'UNKNOWN';

export type ToolErrorEnvelope = {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  remedy?: string;
  logs?: string;
};

// Sensible default message / retryable / remedy per code so call sites stay terse.
const TOOL_ERROR_DEFAULTS: Record<ToolErrorCode, { retryable: boolean; message: string; remedy?: string }> = {
  PASSWORD_REQUIRED: { retryable: true, message: 'The company appears to be password-protected.', remedy: 'Retry with userName and password arguments.' },
  AGENT_UNREACHABLE: { retryable: true, message: 'The Tally GUI automation agent is not responding.', remedy: 'Start tally-gui-agent-v2.ps1 in the interactive desktop session (Task Scheduler "At logon"), then retry.' },
  TALLY_DOWN: { retryable: true, message: 'Tally Prime is not reachable on its XML port.', remedy: 'Ensure Tally Prime is running with the XML/HTTP server enabled, then retry.' },
  AGENT_TOO_OLD: { retryable: true, message: 'The GUI agent is older than the required version.', remedy: 'Restart the agent to pick up the on-disk update (schtasks /End /TN TallyMCPAgent; schtasks /Run /TN TallyMCPAgent).' },
  COMPANY_NOT_FOUND: { retryable: false, message: 'No company matched the given identifier.', remedy: 'Use resolve-company or list-available-companies to find the exact id, name, or alias.' },
  AMBIGUOUS: { retryable: false, message: 'The identifier matched more than one company.', remedy: 'Re-call with the exact folder id or a configured alias.' },
  PRECONDITION_FAILED: { retryable: true, message: 'A required precondition is not met.' },
  READONLY: { retryable: false, message: 'Write operations are disabled (READONLY_MODE=true).', remedy: 'Unset READONLY_MODE on the server to allow writes.' },
  // spec-10 deterministic-invariant codes (H-14 / H-9)
  OUT_OF_PERIOD: { retryable: false, message: 'The voucher date is outside the company\'s open period.', remedy: 'Use get-period and date the voucher within booksFrom..fyTo.' },
  MASTER_NOT_FOUND: { retryable: false, message: 'A referenced ledger or stock item does not exist.', remedy: 'Create the master first (create-ledger / create-stock-item) or correct the exact name via search-master.' },
  AMBIGUOUS_INPUT: { retryable: false, message: 'The input matched more than one master on an exact key.', remedy: 'Disambiguate with the exact, fully-qualified name.' },
  UNBALANCED: { retryable: false, message: 'Voucher entries do not balance (total debits != total credits).', remedy: 'Adjust the entries so debits equal credits before retrying.' },
  DUPLICATE: { retryable: false, message: 'A voucher or master with the same deterministic key already exists.', remedy: 'Use a different voucher number / master name, or reverse-voucher to cancel the existing one.' },
  UNKNOWN: { retryable: false, message: 'An unexpected error occurred.' },
};

// Pure builder — returns the envelope object (tested directly).
export function buildToolError(
  code: ToolErrorCode,
  opts?: { message?: string; retryable?: boolean; remedy?: string; logs?: string }
): ToolErrorEnvelope {
  const d = TOOL_ERROR_DEFAULTS[code];
  const remedy = opts?.remedy ?? d.remedy;
  const env: ToolErrorEnvelope = {
    code,
    message: opts?.message ?? d.message,
    retryable: opts?.retryable ?? d.retryable,
  };
  if (remedy) env.remedy = remedy;
  if (opts?.logs) env.logs = opts.logs;
  return env;
}

// The single helper all classified failures route through: emits the envelope as
// JSON text (machine-parseable) and as structuredContent, with isError set.
export function errorResult(
  code: ToolErrorCode,
  opts?: { message?: string; retryable?: boolean; remedy?: string; logs?: string }
) {
  const env = buildToolError(code, opts);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(env, null, 2) }],
    structuredContent: env,
  };
}

// ── voucher schemas + shared executor (#94 H-8, #97 H-11) ──────────────────
const voucherEntrySchema = z.object({
  ledger: z.string().describe('exact ledger name (already resolved — no fuzzy matching host-side)'),
  drCr: z.enum(['dr', 'cr']).describe('dr = debit, cr = credit'),
  amount: z.number().positive().describe('positive amount; the sign is derived from drCr'),
  billwise: z.array(z.object({
    name: z.string(),
    billType: z.enum(['New Ref', 'Agst Ref', 'Advance', 'On Account']).optional(),
    amount: z.number()
  })).optional().describe('bill-wise allocations for a receivable/payable line'),
  costCentres: z.array(z.object({ category: z.string(), centre: z.string(), amount: z.number() })).optional()
});
const inventoryLineSchema = z.object({
  stockItem: z.string(),
  quantity: z.number(),
  rate: z.number().optional(),
  amount: z.number().optional(),
  unit: z.string().optional(),
  godown: z.string().optional(),
  batch: z.string().optional(),
  accountingLedger: z.string().optional().describe('sales/purchase ledger this stock value posts to')
});
const gstBlockSchema = z.object({
  placeOfSupply: z.string().optional(),
  isReverseCharge: z.boolean().optional(),
  registrationType: z.string().optional()
});
// The full voucher shape, shared by create-voucher and create-vouchers.
const voucherInputShape = {
  voucherType: z.enum(['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Journal', 'Debit Note', 'Credit Note']),
  date: z.string().describe('voucher date in YYYY-MM-DD format'),
  entries: z.array(voucherEntrySchema).optional().describe('fully-resolved ledger lines; MUST balance (sum of dr amounts == sum of cr amounts). Preferred over the deprecated debitLedger/creditLedger/amount form.'),
  debitLedger: z.string().optional().describe('DEPRECATED shim — use entries[]. Kept for back-compat: forms a 2-line voucher with creditLedger + amount.'),
  creditLedger: z.string().optional().describe('DEPRECATED shim — use entries[].'),
  amount: z.number().optional().describe('DEPRECATED shim — use entries[]. Amount for the debit/credit shim.'),
  narration: z.string().optional(),
  voucherNumber: z.string().optional().describe('optional; blank for auto-numbering'),
  reference: z.string().optional(),
  partyLedger: z.string().optional().describe('party ledger for GST/invoice vouchers (PARTYLEDGERNAME)'),
  inventory: z.array(inventoryLineSchema).optional(),
  gst: gstBlockSchema.optional()
};
type VoucherArgs = {
  voucherType: string; date: string;
  entries?: VoucherEntry[];
  debitLedger?: string; creditLedger?: string; amount?: number;
  narration?: string; voucherNumber?: string; reference?: string; partyLedger?: string;
  inventory?: VoucherInput['inventory']; gst?: VoucherInput['gst'];
};

// Normalizes a voucher's ledger lines: prefer entries[]; else fold the deprecated
// debitLedger/creditLedger/amount shim into a 2-line balanced entry set. Returns a typed error
// string when neither form is usable. Pure — no I/O.
export function normalizeVoucherEntries(args: VoucherArgs): { entries: VoucherEntry[] } | { error: string } {
  if (args.entries && args.entries.length > 0) return { entries: args.entries };
  if (args.debitLedger && args.creditLedger && typeof args.amount === 'number') {
    return { entries: [
      { ledger: args.debitLedger, drCr: 'dr', amount: args.amount },
      { ledger: args.creditLedger, drCr: 'cr', amount: args.amount },
    ] };
  }
  return { error: 'Provide entries[] (preferred) or the debitLedger + creditLedger + amount shim.' };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: any };

// Assembles + posts a single voucher, applying the deterministic host invariants (#94/#95). Shared by
// create-voucher, create-vouchers (#97), and the dryRun path (#96). With opts.dryRun it echoes the
// exact posting (voucher + rendered XML) and does NOT call Tally. #95 extends the invariant set
// (date-in-period, master-existence, idempotency) via optional opts.
export type VoucherExecOpts = {
  dryRun?: boolean;
  // Active company's open period for the OUT_OF_PERIOD check (fetched by the handler via get-period).
  period?: { fyFrom: string | null; fyTo: string | null; booksFrom?: string | null } | null;
  // Exact known master names for the MASTER_NOT_FOUND check. Empty/omitted → skip (don't block on an
  // unavailable list). Fetched by the handler via list-master.
  knownLedgers?: string[];
  knownStockItems?: string[];
  // Idempotency: replay the stored result for a repeated key instead of re-posting (#95/#97).
  idempotency?: { store: IdempotencyStore; now: string };
};

export async function executeVoucher(
  args: VoucherArgs & { targetCompany?: string; idempotencyKey?: string },
  opts: VoucherExecOpts = {}
): Promise<ToolResult> {
  // Idempotent replay: a repeated key returns the prior result, posts nothing.
  if (args.idempotencyKey && opts.idempotency) {
    const prior = opts.idempotency.store.get(args.idempotencyKey);
    if (prior) {
      return { content: [{ type: 'text', text: JSON.stringify({ idempotentReplay: true, result: prior.result }) }] };
    }
  }
  const norm = normalizeVoucherEntries(args);
  if ('error' in norm) return errorResult('PRECONDITION_FAILED', { message: norm.error, retryable: false });
  const entries = norm.entries;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return errorResult('PRECONDITION_FAILED', { message: 'Date must be in YYYY-MM-DD format.', retryable: false });
  }
  if (entries.some(e => !(e.amount > 0))) {
    return errorResult('PRECONDITION_FAILED', { message: 'Every entry amount must be greater than 0.', retryable: false });
  }
  // (a) balance invariant (#94 H-8): total debits must equal total credits.
  const bal = voucherBalance(entries);
  if (!bal.balanced) {
    return errorResult('UNBALANCED', { message: `Voucher does not balance: debits ${bal.debit} != credits ${bal.credit}.` });
  }
  const company = args.targetCompany || activeCompany || undefined;
  const voucher: VoucherInput = {
    voucherType: args.voucherType, date: args.date, entries,
    narration: args.narration, voucherNumber: args.voucherNumber, reference: args.reference,
    partyLedger: args.partyLedger, inventory: args.inventory, gst: args.gst,
  };
  // (b) date within the open period (#95 H-9 → OUT_OF_PERIOD).
  if (opts.period && !isDateInOpenPeriod(args.date, opts.period)) {
    const lo = opts.period.booksFrom || opts.period.fyFrom;
    return errorResult('OUT_OF_PERIOD', { message: `Voucher date ${args.date} is outside the open period (${lo}..${opts.period.fyTo}).` });
  }
  // (c) referenced masters exist (#95 H-9 → MASTER_NOT_FOUND). Exact-name only; skipped when the
  // known list is unavailable so a fetch failure never blocks a legitimate write.
  if (opts.knownLedgers?.length) {
    const missing = findMissingMasters(referencedLedgers(voucher), opts.knownLedgers);
    if (missing.length) return errorResult('MASTER_NOT_FOUND', { message: `Unknown ledger(s): ${missing.join(', ')}.` });
  }
  if (opts.knownStockItems?.length && voucher.inventory?.length) {
    const missing = findMissingMasters(voucher.inventory.map(i => i.stockItem), opts.knownStockItems);
    if (missing.length) return errorResult('MASTER_NOT_FOUND', { message: `Unknown stock item(s): ${missing.join(', ')}.` });
  }
  const xml = buildVoucherXml(voucher, company);
  if (opts.dryRun) {
    // Echo exactly what would be posted; mutate nothing (#96 H-10).
    return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldPost: true, balance: bal, voucher, xml }, null, 2) }] };
  }
  const resp = await pushXml(xml);
  if (!resp.success) {
    // Re-map Tally's duplicate-voucher signal to the typed DUPLICATE code (#95/#99).
    if (/duplicat/i.test(resp.error || '')) return errorResult('DUPLICATE', { message: resp.error });
    return errorResult('UNKNOWN', { message: resp.error || 'Failed to create voucher.' });
  }
  const result = { success: true, created: resp.created, lastVchId: resp.lastVchId };
  // (d) record the idempotency key so a replay short-circuits (#95/#97).
  if (args.idempotencyKey && opts.idempotency) {
    try { opts.idempotency.store.put(args.idempotencyKey, result, opts.idempotency.now); } catch {}
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// File-backed idempotency store singleton (lives in TALLY_DATA_PATH when set, else next to dist/).
let _idempotencyStore: IdempotencyStore | null = null;
function getIdempotencyStore(): IdempotencyStore {
  if (!_idempotencyStore) {
    const dir = process.env.TALLY_DATA_PATH || path.join(import.meta.dirname, '..');
    _idempotencyStore = makeIdempotencyStore(path.join(dir, '.tally-mcp-idempotency.json'));
  }
  return _idempotencyStore;
}

// Fetches exact master names for the MASTER_NOT_FOUND check. Tolerant: any failure → [] (skip).
async function fetchMasterNames(collection: string, company?: string): Promise<string[]> {
  try {
    const p = new Map<string, any>([['collection', collection]]);
    if (company) p.set('targetCompany', company);
    const resp = await pull('list-master', p);
    if (resp.error || !Array.isArray(resp.data)) return [];
    return resp.data.map((r: any) => String(r?.name ?? '')).filter((s: string) => s.length > 0);
  } catch { return []; }
}

// Fetches the active/target company's open period for the OUT_OF_PERIOD check. Tolerant: null on error.
async function fetchPeriodForWrite(company?: string): Promise<{ fyFrom: string | null; fyTo: string | null; booksFrom: string | null } | null> {
  try {
    const p = await fetchCompanyPeriod(company ?? activeCompany ?? null);
    return { fyFrom: p.fyFrom, fyTo: p.fyTo, booksFrom: p.booksFrom };
  } catch { return null; }
}

// Assembles the deterministic write-invariant context (#95 H-9) for a voucher write: open period +
// known ledger names (+ stock item names only when inventory is present). All fetches are tolerant.
async function buildVoucherExecOpts(args: { targetCompany?: string; inventory?: unknown[]; idempotencyKey?: string }): Promise<VoucherExecOpts> {
  const company = args.targetCompany || activeCompany || undefined;
  const [period, knownLedgers, knownStockItems] = await Promise.all([
    fetchPeriodForWrite(company),
    fetchMasterNames('ledger', company),
    (args.inventory && (args.inventory as unknown[]).length) ? fetchMasterNames('stockitem', company) : Promise.resolve<string[]>([]),
  ]);
  return { period, knownLedgers, knownStockItems, idempotency: { store: getIdempotencyStore(), now: new Date().toISOString() } };
}

// Echoes the exact posting a write WOULD make, without calling Tally (#96 H-10). Used by
// create-ledger / create-stock-item / create-gst-voucher after their invariants pass.
function dryRunEcho(template: string, inputParams: Map<string, any>, extra?: object): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldPost: true, template, posting: Object.fromEntries(inputParams), ...(extra || {}) }, null, 2) }] };
}

// ── batch voucher execution (#97 H-11) ─────────────────────────────────────
type BatchRow = { index: number; status: 'success' | 'error'; code?: string; message?: string; retryable?: boolean; created?: number; lastVchId?: number };

// Flattens a single executeVoucher result into a per-row batch entry.
function rowResult(index: number, r: ToolResult): BatchRow {
  if (r.isError) {
    const e: any = r.structuredContent || {};
    return { index, status: 'error', code: e.code ?? 'UNKNOWN', message: e.message, retryable: e.retryable };
  }
  const body = JSON.parse(r.content[0]!.text) as { created?: number; lastVchId?: number };
  return { index, status: 'success', created: body.created, lastVchId: body.lastVchId };
}

export type BatchResult = { atomic: boolean; aborted: boolean; posted: number; results: BatchRow[] };

// Executes a batch of vouchers. atomic=true: validate ALL rows first (via the deterministic dryRun
// path); if any fails, abort and post NOTHING. Otherwise post each and report per row (best-effort).
// Reuses the shared per-voucher invariants (executeVoucher). Note: Tally has no cross-voucher
// rollback, so an atomic batch guarantees "don't start posting unless all rows pass deterministic
// validation" — a mid-batch WRITE failure (Tally-side) can still leave earlier rows posted; that is
// surfaced in the per-row results.
export async function executeVoucherBatch(
  vouchers: Array<VoucherArgs & { targetCompany?: string }>,
  opts: { atomic?: boolean } & VoucherExecOpts
): Promise<BatchResult> {
  const { atomic, dryRun, ...baseOpts } = opts;
  if (atomic) {
    const checks: BatchRow[] = [];
    for (let i = 0; i < vouchers.length; i++) {
      checks.push(rowResult(i, await executeVoucher(vouchers[i]!, { ...baseOpts, dryRun: true })));
    }
    if (checks.some(c => c.status === 'error')) {
      return { atomic: true, aborted: true, posted: 0, results: checks };
    }
    if (dryRun) return { atomic: true, aborted: false, posted: 0, results: checks };
    const results: BatchRow[] = [];
    for (let i = 0; i < vouchers.length; i++) {
      results.push(rowResult(i, await executeVoucher(vouchers[i]!, baseOpts)));
    }
    return { atomic: true, aborted: false, posted: results.filter(r => r.status === 'success').length, results };
  }
  const results: BatchRow[] = [];
  for (let i = 0; i < vouchers.length; i++) {
    results.push(rowResult(i, await executeVoucher(vouchers[i]!, { ...baseOpts, dryRun })));
  }
  return { atomic: false, aborted: false, posted: results.filter(r => r.status === 'success').length, results };
}

export async function registerMcpServer(): Promise<McpServer> {
  const mcpServer = new McpServer({
    name: 'Tally Prime MCP Server',
    title: 'Tally Prime',
    version: '1.0.0'
  }, {
    instructions: TALLY_MCP_INSTRUCTIONS
  });

  mcpServer.registerTool(
    'query-database',
    {
      title: 'Query Database',
      description: `executes sql query on DuckDB in-memory database for querying cached Tally Prime report data in table generated as output by other tools (in tableID property from tool output response). These tables are temporary and will be dropped after 15 minutes automatically. Use this tool to run complex analytical queries to aggregate, filter, sort results. Returns output in tab separated format`,
      inputSchema: {
        sql: z.string().describe('SQL query to execute on DuckDB in-memory database')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      // Validate SQL before execution — only SELECT allowed
      const sqlError = validateSQL(args.sql);
      if (sqlError) {
        auditLog('query-database', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: `SQL rejected: ${sqlError}`, retryable: false });
      }
      try {
        const resp = await executeSQL(args.sql);
        // resp is header-line + one line per row (header-only on empty). count = data rows so a
        // zero-row query is distinguishable from a failure (#92).
        const trimmed = resp.replace(/\n+$/, '');
        const count = trimmed.includes('\n') ? trimmed.split('\n').length - 1 : 0;
        auditLog('query-database', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: JSON.stringify({ count, rows: resp }) }]
        };
      } catch (err) {
        auditLog('query-database', args, 'error', Date.now() - start);
        throw err;
      }
    }
  );

  mcpServer.registerTool(
    'list-companies',
    {
      title: 'List Companies',
      description: `lists all company data folders found in the Tally Prime data directory. Does NOT require any company to be open. Returns folder numbers. Use open-company tool to load a company before querying it.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        if (!tallyDataPath) {
          auditLog('list-companies', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: 'TALLY_DATA_PATH environment variable is not configured.', remedy: 'Set it to the Tally Prime data directory (e.g. C:\\Users\\Public\\TallyPrimeEditLog\\data).', retryable: false });
        }
        if (!fs.existsSync(tallyDataPath)) {
          auditLog('list-companies', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `Data directory not found: ${tallyDataPath}`, retryable: false });
        }
        // Delegate to scanCompanyFolders so names are recovered the same robust way
        // as list-available-companies (BFS finds nested Edit Log Company.1800 too),
        // instead of the old flat-only Company.900 read that left names blank.
        const folders = scanCompanyFolders(tallyDataPath)
          .map(f => ({ folder: f.folder, name: f.name, path: path.join(tallyDataPath, f.folder) }));
        if (folders.length === 0) {
          auditLog('list-companies', args, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: 'No company folders found in the data directory.' }] };
        }
        const tsv = 'folder\tname\tpath\n' + folders.map(f => `${f.folder}\t${f.name}\t${f.path}`).join('\n');
        auditLog('list-companies', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: tsv }] };
      } catch (err) {
        auditLog('list-companies', args, 'error', Date.now() - start);
        throw err;
      }
    }
  );

  mcpServer.registerTool(
    'list-available-companies',
    {
      title: 'List Available Companies',
      description: `discovers companies on disk with enough metadata to drive a load-company call without trial and error. Returns one row per digit-named folder under the Tally data directory, with: folderId, folderPath, displayName (extracted from Company.900 / Company.1800), hasData (whether any company metadata file was found), dataFilePath, requiresCredentials (null if unknown, true/false if a credential-hint config exists), knownUsername, notes. Handles both layouts: stock Tally Prime (<data>/<id>/Company.900) and Tally Prime Edit Log (<data>/<id>/<id>/Company.1800 — one level deeper). Recursively walks each folder up to depth 3 so an LLM doesn't get fooled into thinking nested-layout folders are empty. CREDENTIAL HINTS: optional config file at <dataPath>/.tally-mcp-companies.json (or override via TALLY_COMPANIES_CONFIG env var) maps folder id → { requiresCredentials, knownUsername, notes }. The config never stores passwords; it only signals "the human will need to supply credentials before load-company succeeds for this folder." Use this tool BEFORE load-company instead of trying random folder ids and waiting for failures.`,
      inputSchema: {
        dataPath: z.string().optional().describe('override the data path to scan. By default, this is the value of TALLY_DATA_PATH env var; falls back to the documented Edit Log default. Pass an explicit path when scanning a backup folder or a secondary drive.'),
        configPath: z.string().optional().describe('override the credentials-hint config path. Default is <dataPath>/.tally-mcp-companies.json (or TALLY_COMPANIES_CONFIG env if set).')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const defaultRoot = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        // Confine caller-supplied dataPath/configPath to an allowlist so a
        // prompt-injected caller can't scan arbitrary directories or JSON-parse an
        // arbitrary file. Default allowed root is the configured Tally data path;
        // operators who need to scan a backup drive add roots via
        // TALLY_ALLOWED_DATA_ROOTS (comma/semicolon-separated).
        const allowedRoots = [
          defaultRoot,
          ...(process.env.TALLY_ALLOWED_DATA_ROOTS || '').split(/[;,]/).map(s => s.trim()).filter(Boolean)
        ];
        const tallyDataPath = args.dataPath || defaultRoot;
        if (args.dataPath && !isPathWithinRoots(tallyDataPath, allowedRoots).ok) {
          auditLog('list-available-companies', args, 'denied', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `dataPath "${tallyDataPath}" is outside the allowed Tally data root(s).`, remedy: 'Set TALLY_ALLOWED_DATA_ROOTS to permit additional locations.', retryable: false });
        }
        if (!fs.existsSync(tallyDataPath)) {
          auditLog('list-available-companies', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `Data directory not found: ${tallyDataPath}`, retryable: false });
        }
        const configPath = args.configPath
          || process.env.TALLY_COMPANIES_CONFIG
          || path.join(tallyDataPath, '.tally-mcp-companies.json');
        // Confine an explicit configPath the same way (default/env-derived paths are trusted).
        if (args.configPath && !isPathWithinRoots(configPath, allowedRoots).ok) {
          auditLog('list-available-companies', args, 'denied', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `configPath "${configPath}" is outside the allowed Tally data root(s).`, remedy: 'Set TALLY_ALLOWED_DATA_ROOTS to permit additional locations.', retryable: false });
        }
        const companies = scanAvailableCompanies(tallyDataPath, configPath);

        if (companies.length === 0) {
          auditLog('list-available-companies', args, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: `No company folders found in ${tallyDataPath}.` }] };
        }

        const summary = {
          dataPath: tallyDataPath,
          configPath: fs.existsSync(configPath) ? configPath : `${configPath} (not present — credential hints unavailable)`,
          companies
        };
        auditLog('list-available-companies', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        auditLog('list-available-companies', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'list-available-companies failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'open-company',
    {
      title: 'Open Company',
      description: `Verifies a company is active, or GUI-loads it, and sets it as the active company for subsequent queries. Tries strategies in order: (1) SVCURRENTCOMPANY probe — verifies the company is directly accessible (works in Tally server/multi-company mode; does NOT load), (2) loaded-list check — detects if the company is already loaded in the Tally UI (does NOT load), (3) GUI automation agent that controls the Tally UI via Alt+F3 → Select Company → type name → Enter (requires tally-gui-agent-v2.ps1 running in the interactive desktop session; this is the only strategy that actually loads). For a cold load prefer load-company / load-company-by-alias — open-company's non-gui strategies only verify. Once it succeeds, all other tools automatically target this company unless targetCompany is specified explicitly. Use list-companies first to find available company names.`,
      inputSchema: {
        companyName: z.string().describe('exact company name as shown in Tally (e.g. "My Company Pvt Ltd"). Use list-companies or list-master with collection=company to find names.'),
        strategy: z.enum(['auto', 'verify-svcurrentcompany', 'verify-in-loaded-list', 'gui-agent', 'tdl-load', 'tdl-connect']).optional().describe('which strategy to use. "auto" tries all in order (default). "verify-svcurrentcompany" reads SVCURRENTCOMPANY — succeeds only if the company is already resident (does NOT load). "verify-in-loaded-list" checks the loaded-company list (does NOT load). "gui-agent" performs the actual load via GUI automation (companion agent must be running). Deprecated aliases (still accepted this release): "tdl-load"→verify-svcurrentcompany, "tdl-connect"→verify-in-loaded-list.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const { strategy, deprecatedAlias } = normalizeOpenCompanyStrategy(args.strategy || 'auto');
      let companyName = args.companyName;
      const logs: string[] = [];
      if (deprecatedAlias) {
        logs.push(`[deprecation] strategy "${deprecatedAlias}" was renamed to "${strategy}"; the old name still works this release but will be removed. See issue #24.`);
      }

      // --- Resolve folder number to company name if needed ---
      // If input looks like a folder number, try to get the real company name from Tally's own company list
      if (/^\d+$/.test(companyName)) {
        logs.push(`[Pre-check] Input "${companyName}" looks like a folder number, trying to resolve company name...`);
        try {
          // Ask Tally for all company names (from its data directory)
          const listXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>MCPListCompaniesReport</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <REPORT NAME="MCPListCompaniesReport">
            <FORMS>MCPListCompaniesForm</FORMS>
          </REPORT>
          <FORM NAME="MCPListCompaniesForm">
            <PARTS>MCPListCompaniesPart</PARTS>
            <XMLTAG>DATA</XMLTAG>
          </FORM>
          <PART NAME="MCPListCompaniesPart">
            <LINES>MCPListCompaniesLine</LINES>
            <REPEAT>MCPListCompaniesLine : MCPAllCompaniesCol</REPEAT>
            <SCROLLED>Vertical</SCROLLED>
          </PART>
          <LINE NAME="MCPListCompaniesLine">
            <FIELDS>MCPCompanyNameFld, MCPCompanyNumFld</FIELDS>
            <XMLTAG>ROW</XMLTAG>
          </LINE>
          <FIELD NAME="MCPCompanyNameFld">
            <SET>$Name</SET>
            <XMLTAG>NAME</XMLTAG>
          </FIELD>
          <FIELD NAME="MCPCompanyNumFld">
            <SET>$$FolderName:$CompanyMailName</SET>
            <XMLTAG>NUMBER</XMLTAG>
          </FIELD>
          <COLLECTION NAME="MCPAllCompaniesCol">
            <TYPE>Company</TYPE>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
          const listResp = await postTallyXML(listXml);
          logs.push(`  Tally company list response received (${listResp.length} chars)`);
          // Extract company names from response
          const nameMatches = listResp.match(/<NAME>([^<]+)<\/NAME>/g);
          if (nameMatches && nameMatches.length > 0) {
            const names = nameMatches.map(m => m.replace(/<\/?NAME>/g, ''));
            logs.push(`  Found companies: ${names.join(', ')}`);
            // If there's only one company, use it; otherwise keep the folder number for later strategies
            if (names.length === 1) {
              companyName = names[0];
              logs.push(`  Resolved to: "${companyName}"`);
            } else if (names.length > 1) {
              // Use first company as best guess
              companyName = names[0];
              logs.push(`  Multiple companies found, using first: "${companyName}"`);
            }
          }
        } catch (err) {
          logs.push(`  Could not resolve company name from Tally: ${err}`);
        }
      }

      // --- Strategy 1: SVCURRENTCOMPANY probe — works in Tally server/multi-company mode ---
      const tryTdlLoad = async (): Promise<boolean> => {
        logs.push('[Strategy 1: SVCURRENTCOMPANY probe] Checking if company is directly accessible...');
        const accessible = await verifyCompanyLoaded(companyName);
        logs.push(`  ${accessible ? 'Company is accessible in Tally (server mode or already open).' : 'Company not accessible via SVCURRENTCOMPANY.'}`);
        return accessible;
      };

      // --- Strategy 2: open company list check — detects if company is already loaded in Tally UI ---
      const tryTdlConnect = async (): Promise<boolean> => {
        logs.push('[Strategy 2: open company list] Checking if company is in Tally open company list...');
        try {
          const openNames = await listLoadedCompanies();
          if (openNames.length === 0) {
            logs.push('  No companies returned from Tally.');
            return false;
          }
          logs.push(`  Open companies in Tally: ${openNames.join(', ')}`);
          const target = companyName.toLowerCase().trim();
          const found = openNames.some(n => n.toLowerCase().trim() === target);
          logs.push(`  ${found ? 'Company found in open list.' : 'Company not in open list.'}`);
          return found;
        } catch (err) {
          logs.push(`  Error: ${err}`);
          return false;
        }
      };

      // --- Strategy 3: GUI Agent - sends commands to the companion agent running in the interactive session ---
      const tryGuiAgent = async (): Promise<boolean> => {
        logs.push('[Strategy 3: GUI Agent] Attempting...');
        try {
          const guiTimeoutSeconds = getOpenCompanyGuiTimeoutSeconds();
          const guiMaxSteps = getOpenCompanyGuiMaxSteps();
          const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
          const commandFile = path.join(tallyDataPath, '_mcp_gui_command.json');
          const resultFile = path.join(tallyDataPath, '_mcp_gui_result.json');

          // Check if Tally is running at all
          let tallyRunning = true;
          try {
            await postTallyXML('<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>');
          } catch {
            tallyRunning = false;
          }

          const action = tallyRunning ? 'select-company' : 'load-on-startup';
          logs.push(`  Tally running: ${tallyRunning}, action: ${action}`);

          // If Tally isn't running, try to start it first
          if (!tallyRunning) {
            const tallyExe = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
            if (fs.existsSync(tallyExe)) {
              logs.push('  Starting Tally...');
              try { execSync(`start "" "${tallyExe}"`, { timeout: 5000, shell: 'cmd' }); } catch {}
              await new Promise(resolve => setTimeout(resolve, 10000));
            }
          }

          // --- First, ping the agent to check if it's alive ---
          const pingCommandId = createGuiAgentCommandId('ping');
          try { fs.unlinkSync(resultFile); } catch {}
          atomicWriteFile(commandFile, JSON.stringify({ action: 'ping', commandId: pingCommandId, timestamp: new Date().toISOString() }));
          let agentAlive = false;
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (fs.existsSync(resultFile)) {
              try {
                const pingResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8').replace(/^﻿/, ''));
                if (isMatchingGuiAgentCommand(pingResult, pingCommandId)) {
                  agentAlive = true;
                  try { fs.unlinkSync(resultFile); } catch {}
                  break;
                }
                logs.push(`  Ignoring stale ping response for commandId ${pingResult?.commandId || 'unknown'}.`);
                try { fs.unlinkSync(resultFile); } catch {}
              } catch {
                try { fs.unlinkSync(resultFile); } catch {}
              }
            }
          }

          if (!agentAlive) {
            logs.push('  GUI agent not running. Please start scripts/tally-gui-agent-v2.ps1 in the interactive desktop session.');
            return false;
          }
          logs.push('  GUI agent is alive.');

          // --- Send the actual command ---
          const commandId = createGuiAgentCommandId('open-company');
          try { fs.unlinkSync(resultFile); } catch {}
          const command = JSON.stringify({
            action: action,
            companyName: companyName,
            commandId: commandId,
            maxSteps: guiMaxSteps,
            timestamp: new Date().toISOString()
          });
          atomicWriteFile(commandFile, command);
          logs.push(`  Command sent (commandId=${commandId}, maxSteps=${guiMaxSteps}), waiting for GUI agent (up to ${guiTimeoutSeconds} seconds for LLM-guided actions)...`);

          // Poll for result — timeout is configurable because LLM-guided actions can take longer.
          let agentResponded = false;
          for (let i = 0; i < guiTimeoutSeconds; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (fs.existsSync(resultFile)) {
              try {
                const resultText = fs.readFileSync(resultFile, 'utf-8').replace(/^﻿/, '');
                const result = JSON.parse(resultText);
                if (!isMatchingGuiAgentCommand(result, commandId)) {
                  logs.push(`  Ignoring stale response for commandId ${result?.commandId || 'unknown'}.`);
                  try { fs.unlinkSync(resultFile); } catch {}
                  continue;
                }
                logs.push(`  Agent response: ${result.status} - ${result.message}`);
                agentResponded = true;
                try { fs.unlinkSync(resultFile); } catch {}
                if (result.status !== 'success') return false;
                break;
              } catch {}
            }
          }

          if (!agentResponded) {
            logs.push(`  Agent did not respond within ${guiTimeoutSeconds} seconds.`);
            return false;
          }

          // Wait for Tally to process the company load
          await new Promise(resolve => setTimeout(resolve, 5000));

          const loaded = await verifyCompanyLoaded(companyName);
          logs.push(`  Verification: ${loaded ? 'SUCCESS' : 'company not detected in active list'}`);
          return loaded;
        } catch (err) {
          logs.push(`  Error: ${err}`);
          return false;
        }
      };

      // --- Execute strategies ---
      try {
        let success = false;

        if (strategy === 'auto' || strategy === 'verify-svcurrentcompany') {
          success = await tryTdlLoad();
          if (success || strategy === 'verify-svcurrentcompany') {
            if (success) activeCompany = companyName;
            auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
            return {
              isError: !success,
              content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` : '') }]
            };
          }
        }

        if (strategy === 'auto' || strategy === 'verify-in-loaded-list') {
          success = await tryTdlConnect();
          if (success || strategy === 'verify-in-loaded-list') {
            if (success) activeCompany = companyName;
            auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
            return {
              isError: !success,
              content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` : '') }]
            };
          }
        }

        if (strategy === 'auto' || strategy === 'gui-agent') {
          success = await tryGuiAgent();
          if (success) {
            activeCompany = companyName;
            auditLog('open-company', args, 'success', Date.now() - start);
            return {
              content: [{ type: 'text', text: logs.join('\n') + `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` }]
            };
          }
          auditLog('open-company', args, 'error', Date.now() - start);
          return errorResult('AGENT_UNREACHABLE', { message: 'All strategies failed to open the company.', logs: logs.join('\n') });
        }

        auditLog('open-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'All open-company strategies exhausted.', logs: logs.join('\n') });
      } catch (err) {
        auditLog('open-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: `Failed to open company: ${err}`, logs: logs.join('\n') });
      }
    }
  );

  mcpServer.registerTool(
    'open-company-debug',
    {
      title: 'Open Company Debug',
      description: `checks open-company readiness (paths, agent files, env flags, process status) and optionally includes the latest GUI agent result payload for troubleshooting.`,
      inputSchema: {
        includeRecentResult: z.boolean().optional().describe('include parsed contents of latest _mcp_gui_result.json if available'),
        watchDir: z.string().optional().describe('optional explicit watch/data directory override')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const tallyDataPath = args.watchDir || process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const tallyExePath = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
        const commandFile = path.join(tallyDataPath, '_mcp_gui_command.json');
        const resultFile = path.join(tallyDataPath, '_mcp_gui_result.json');
        const guiScriptPath = path.join(process.cwd(), 'scripts', 'tally-gui-agent-v2.ps1');
        const guiDllPath = path.join(process.cwd(), 'scripts', 'TallyUI.dll');

        const report: Record<string, any> = {
          timestamp: new Date().toISOString(),
          tallyDataPath,
          tallyDataPathExists: fs.existsSync(tallyDataPath),
          tallyExePath,
          tallyExeExists: fs.existsSync(tallyExePath),
          guiScriptPath,
          guiScriptExists: fs.existsSync(guiScriptPath),
          guiDllPath,
          guiDllExists: fs.existsSync(guiDllPath),
          commandFile,
          commandFileExists: fs.existsSync(commandFile),
          resultFile,
          resultFileExists: fs.existsSync(resultFile),
          openAiKeySet: !!process.env.OPENAI_API_KEY,
          anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
          configuredTimeoutSeconds: getOpenCompanyGuiTimeoutSeconds(),
          configuredMaxSteps: getOpenCompanyGuiMaxSteps(),
          tallyEdition: getTallyEdition(),
          activeCompany: activeCompany || null
        };

        try {
          // Fast probe that does not require external commands.
          const pingEnvelope = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>';
          const pingResp = await postTallyXML(pingEnvelope);
          report.tallyXmlProbe = {
            reachable: true,
            sample: pingResp.substring(0, 160)
          };
        } catch (err) {
          report.tallyXmlProbe = {
            reachable: false,
            error: String(err)
          };
        }

        // Live probe of the GUI agent — separate from "is the script file present" since the agent could
        // be installed but not running (the most common Session 0 misconfiguration).
        const guiAgentLogs: string[] = [];
        const agentPing = await pingGuiAgent(tallyDataPath, 4, guiAgentLogs);
        report.guiAgentResponding = agentPing.alive;
        report.guiAgentVersion = agentPing.agentVersion;
        report.guiAgentVersionRequired = REQUIRED_AGENT_VERSION;
        report.guiAgentVersionOk = agentPing.versionOk;
        if (!agentPing.alive) {
          report.guiAgentHint = 'Agent did not respond to ping. Start tally-gui-agent-v2.ps1 in the user session (Task Scheduler at logon is recommended; setup-windows.ps1 registers the task as TallyMCPAgent).';
        } else if (!agentPing.versionOk) {
          report.guiAgentHint = `Agent is running but reports version ${agentPing.agentVersion ?? '(none)'}, older than the server's required minimum ${REQUIRED_AGENT_VERSION}. Restart the agent to pick up the on-disk update (the agent self-restarts on script change unless launched with -NoSelfRestart; otherwise: 'schtasks /End /TN TallyMCPAgent; schtasks /Run /TN TallyMCPAgent').`;
        }

        if (args.includeRecentResult && fs.existsSync(resultFile)) {
          try {
            report.recentResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8').replace(/^﻿/, ''));
          } catch (err) {
            report.recentResult = { parseError: String(err) };
          }
        }

        auditLog('open-company-debug', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
        };
      } catch (err) {
        auditLog('open-company-debug', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'open-company-debug failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'status',
    {
      title: 'Status',
      description: `Authoritative one-shot health/usability check for this Tally MCP server. Returns a stable five-field contract: { tallyReachable, agentAlive, activeCompany, edition, readonly }. Both liveness probes are retried briefly so a single transient blip doesn't flip the reported state. Call this to answer "is this usable right now, and in what mode?" instead of stitching list-loaded-companies + open-company-debug. Use open-company-debug for the verbose troubleshooting dump (paths, files, agent version, XML sample).`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const { tallyReachable, agentAlive } = await probeLiveness();
        const status = {
          tallyReachable,
          agentAlive,
          activeCompany: activeCompany || null,
          edition: getTallyEdition(),
          readonly: process.env.READONLY_MODE === 'true'
        };
        auditLog('status', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      } catch (err) {
        auditLog('status', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'status failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'get-context',
    {
      title: 'Get Context',
      description: `One-shot environment + requirements snapshot: { edition, readonly, activeCompany, agentAlive, tallyReachable, requirements }. Wraps status (live liveness, retried) and adds the static list of external requirements so a fresh agent can learn what must be running before it can load a company — without triggering a failure first.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const { tallyReachable, agentAlive } = await probeLiveness();
        const context = {
          edition: getTallyEdition(),
          readonly: process.env.READONLY_MODE === 'true',
          activeCompany: activeCompany || null,
          agentAlive,
          tallyReachable,
          requirements: getTallyRequirements()
        };
        auditLog('get-context', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
      } catch (err) {
        auditLog('get-context', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'get-context failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'get-period',
    {
      title: 'Get Period',
      description: `Returns the active company's period so you never have to infer valid dates: { company, fyFrom, fyTo, booksFrom, currentDate, lastEntryDate, fyToInferred }. fyFrom/fyTo are the financial year (ISO YYYY-MM-DD); booksFrom is the books-beginning date (the earliest valid voucher date — may be later than fyFrom if the company started mid-year); currentDate is Tally's working date; lastEntryDate is the most recent voucher's date. fyToInferred=true means Tally left the FY-end blank (ongoing year) and it was computed as fyFrom + 1 year − 1 day. Call this before posting a voucher (date it inside booksFrom..fyTo) or running a report, instead of guessing dates or reading them off a screenshot. Pass targetCompany to query a specific loaded company; defaults to the active company.`,
      inputSchema: {
        targetCompany: z.string().optional().describe('Exact loaded-company name to query. Defaults to the active company.')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        if (!(await pingTally(4000))) {
          auditLog('get-period', args, 'error', Date.now() - start);
          return errorResult('TALLY_DOWN', { logs: 'pingTally failed before get-period.' });
        }
        const company = (args.targetCompany && args.targetCompany.trim()) || activeCompany || null;
        const period = await fetchCompanyPeriod(company);
        if (!period.company && !period.fyFrom) {
          auditLog('get-period', args, 'error', Date.now() - start);
          return errorResult('COMPANY_NOT_FOUND', {
            message: company
              ? `No period returned for company "${company}" — is it loaded?`
              : 'No active company, and no targetCompany was given.',
            remedy: 'Load a company (load-company / load-company-by-alias) or pass targetCompany, then retry.'
          });
        }
        auditLog('get-period', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(period, null, 2) }], structuredContent: period };
      } catch (err) {
        auditLog('get-period', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'get-period failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'tally-raw-xml-probe',
    {
      title: 'Tally Raw XML Probe (debug only)',
      description: `Posts a raw XML envelope to the Tally XML server and returns the raw response — bypasses all wrapper logic. Used for protocol reverse-engineering and undocumented verb discovery. NOT for normal use; the wrapped tools (list-master, trial-balance, etc.) construct XML safely. Disabled unless TALLY_DEBUG_XML=1 is set in the server env. Read-only by default: any non-Export TALLYREQUEST verb (Import/Alter/Delete) is refused unless allowWrite=true is passed explicitly.`,
      inputSchema: {
        xml: z.string().describe('raw XML envelope to POST to the Tally XML server. Standard structure: <ENVELOPE><HEADER>...</HEADER><BODY>...</BODY></ENVELOPE>.'),
        label: z.string().optional().describe('optional label included in the audit log so probes can be correlated to experiment notes (e.g. "H1-import-variant").'),
        allowWrite: z.boolean().optional().describe('explicit opt-in required to POST a mutating envelope (TALLYREQUEST other than Export, i.e. Import/Alter/Delete). Defaults to false — without it, non-Export verbs are refused so a prompt-injected caller cannot silently mutate Tally data.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const verb = parseTallyRequestVerb(args.xml);
      // Log the full XML for this debug/write primitive so any mutation is auditable.
      const auditArgs = { xmlLength: args.xml.length, label: args.label, verb, xml: args.xml };
      if (process.env.TALLY_DEBUG_XML !== '1') {
        auditLog('tally-raw-xml-probe', auditArgs, 'denied', Date.now() - start);
        return errorResult('PRECONDITION_FAILED', { message: 'Raw XML probe is disabled.', remedy: 'Set TALLY_DEBUG_XML=1 in the server env to enable raw XML probes.', retryable: false });
      }
      // Read-only by default. Export is the only read verb; Import/Alter/Delete mutate
      // Tally data, so refuse them unless the caller explicitly opts in via allowWrite.
      if (verb && verb !== 'export' && args.allowWrite !== true) {
        auditLog('tally-raw-xml-probe', auditArgs, 'denied', Date.now() - start);
        return errorResult('PRECONDITION_FAILED', { message: `Refusing TALLYREQUEST verb "${verb}" — this probe is read-only by default and only "Export" is allowed.`, remedy: 'If you genuinely intend a write (Import/Alter/Delete), re-call with allowWrite: true.', retryable: false });
      }
      try {
        const resp = await postTallyXML(args.xml);
        auditLog('tally-raw-xml-probe', { ...auditArgs, respLength: resp.length }, 'success', Date.now() - start);
        const cap = 50000;
        const body = resp.length > cap ? `${resp.slice(0, cap)}\n\n[TRUNCATED — full length ${resp.length} chars]` : resp;
        return {
          content: [{ type: 'text', text: `[response: ${resp.length} chars in ${Date.now() - start}ms${args.label ? `, label="${args.label}"` : ''}]\n\n${body}` }]
        };
      } catch (err) {
        auditLog('tally-raw-xml-probe', auditArgs, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'tally-raw-xml-probe failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'list-loaded-companies',
    {
      title: 'List Loaded Companies',
      description: `lists companies currently loaded in Tally Prime (i.e. accessible right now without an open-company call). Use this before set-active-company to confirm the target is loaded. Different from list-companies, which enumerates company folders on disk regardless of whether they are loaded. NOTE: on Silver edition (TALLY_EDITION=silver), Tally allows only one company resident at any time — this list will have at most 1 entry. On Gold, multiple entries can coexist.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const names = await listLoadedCompanies();
        if (names.length === 0) {
          auditLog('list-loaded-companies', args, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: 'No companies are currently loaded in Tally. Use open-company to load one.' }] };
        }
        const tsv = 'name\tactive\n' + names.map(n => `${n}\t${activeCompany && n.toLowerCase() === activeCompany.toLowerCase() ? 'yes' : 'no'}`).join('\n');
        auditLog('list-loaded-companies', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: tsv }] };
      } catch (err) {
        auditLog('list-loaded-companies', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'list-loaded-companies failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'set-active-company',
    {
      title: 'Set Active Company',
      description: `sets the active company for subsequent tool calls without invoking the Tally UI. Cheap pointer flip — use this to switch between companies that are already loaded in Tally (e.g. for cross-referencing subsidiaries). Verifies the company is actually loaded via SVCURRENTCOMPANY probe; returns an error suggesting open-company if not. After this succeeds, every subsequent tool call automatically targets this company unless targetCompany is specified explicitly.`,
      inputSchema: {
        companyName: z.string().max(256).describe('exact company name as shown in Tally. Use list-loaded-companies to see what is currently loaded.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        // Tier 1: exact match against the authoritative loaded-companies list.
        // Case-insensitive + whitespace-normalized so hidden chars (NBSP, CR,
        // trailing whitespace) don't cause false negatives. This is what closes
        // the "user confirms the suggested name but still gets a fuzzy loop"
        // bug: when fuzzy Tier 3 suggests "ROSS COMPUTER PVT. LTD." and the
        // user re-calls with that exact string, this tier matches and accepts.
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const requestedNorm = normalize(args.companyName);
        const loaded = await listLoadedCompanies();
        const exactInLoaded = loaded.find(n => normalize(n) === requestedNorm);
        if (exactInLoaded) {
          activeCompany = exactInLoaded;
          auditLog('set-active-company', args, 'success', Date.now() - start);
          return {
            content: [{ type: 'text', text: `Active company set to "${exactInLoaded}". Subsequent tools will target this company unless targetCompany is specified explicitly.` }]
          };
        }

        // Tier 2: SVCURRENTCOMPANY probe — useful if listLoadedCompanies is
        // momentarily out of sync with Tally's actual current-company pointer.
        if (await verifyCompanyLoaded(args.companyName)) {
          activeCompany = args.companyName;
          auditLog('set-active-company', args, 'success', Date.now() - start);
          return {
            content: [{ type: 'text', text: `Active company set to "${args.companyName}". Subsequent tools will target this company unless targetCompany is specified explicitly.` }]
          };
        }

        // Tier 3: fuzzy match against the loaded list.
        // We DO NOT auto-resolve — risk of running tools against the wrong
        // company if the fuzzy match guesses wrong. Instead, surface the
        // closest candidate(s) so the caller (or the LLM) can confirm and
        // re-call set-active-company with the exact name (which Tier 1 will
        // then accept via normalized comparison).
        const closest = findMatchingLoadedCompany(args.companyName, loaded);
        auditLog('set-active-company', args, 'denied', Date.now() - start);

        if (closest) {
          // Fuzzy match found — surface the closest name as a suggested remedy.
          return errorResult('COMPANY_NOT_FOUND', {
            message: `Company "${args.companyName}" was not found as an exact match. Did you mean "${closest}"?`,
            remedy: `Re-call set-active-company with the EXACT name: set-active-company(companyName: "${closest}").`,
            logs: `Other companies currently loaded:\n${loaded.map(n => `  - "${n}"`).join('\n')}`,
          });
        }

        if (loaded.length === 0) {
          return errorResult('COMPANY_NOT_FOUND', { message: `Company "${args.companyName}" not found and no companies are currently loaded in Tally.`, remedy: 'Use open-company or load-company-by-alias to load one first.' });
        }

        // No fuzzy match either — surface the loaded list as context.
        return errorResult('COMPANY_NOT_FOUND', {
          message: `Company "${args.companyName}" not found in Tally — and no fuzzy match was close enough to suggest.`,
          remedy: 'Re-call set-active-company with one of the loaded names (exact), or use open-company to load a different one.',
          logs: `Companies currently loaded:\n${loaded.map(n => `  - "${n}"`).join('\n')}`,
        });
      } catch (err) {
        auditLog('set-active-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'set-active-company failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'load-company',
    {
      title: 'Load Company (via Tally Restart)',
      description: `loads a company into Tally Prime by editing tally.ini and restarting Tally. Use this when the target company is NOT in list-loaded-companies. Slow (~10-30s for restart) but reliable — Tally has no XML primitive for loading from disk, so a restart is the only option. Accepts either a folder ID (e.g. "100000") or a company name (e.g. "Ross Industries"); resolves names by reading Company.900 from each folder. If multiple folders share a name, returns an ambiguity error listing folder IDs so you can re-call with the specific ID. EDITION-AWARE: on Silver (set TALLY_EDITION=silver), this is always a SWAP — the new company replaces any current one (Silver allows only one company resident). On Gold (TALLY_EDITION=gold), additive by default; pass replace=true to force a swap. Requires the GUI agent (tally-gui-agent-v2.ps1) running in the user's interactive session — the tool pings it before doing anything destructive and refuses to kill Tally if the agent is unreachable. After the restart, the tool verifies the requested company actually appears in the loaded list. CREDENTIAL HANDLING: if Tally's auto-load fails because the company is password-protected (common with Edit Log boxes — Tally drops to Select Company because it can't bypass the credential prompt), pass userName + password and the tool will use the GUI agent to deterministically keystroke through the Select Company → credentials prompt → Gateway sequence. Credentials are filtered from audit logs.`,
      inputSchema: {
        company: z.string().describe('folder ID (digits only, e.g. "100000") OR company name as stored in Company.900 (e.g. "Ross Industries"). Use list-companies to see both.'),
        waitTimeoutSec: z.number().optional().describe('seconds to wait for the Tally XML server to come back up after restart. Default 60.'),
        replace: z.boolean().optional().describe('if true, only this company is loaded — all other Load= lines are removed from tally.ini. Default false (additive).'),
        dataPath: z.string().optional().describe('override the data path to scan for company folders. By default, this is read from tally.ini\'s Data= directive (the same path Tally itself uses). Pass this only when you know the data lives somewhere different — e.g. a backup folder or a secondary drive.'),
        userName: z.string().optional().describe('Tally username for the company (if user-based security is enabled). Used by the GUI agent to keystroke through the credential prompt when auto-load is blocked by Tally\'s login dialog. Filtered from audit logs.'),
        password: z.string().optional().describe('Tally password for the company. Filtered from audit logs. Lives in the IPC file briefly during the call (~5s) — acceptable on a single-user box, document carefully if multi-user.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const logs: string[] = [];
      const company = args.company;
      const timeoutMs = (args.waitTimeoutSec ?? 60) * 1000;
      const edition = getTallyEdition();
      // Silver allows only one company resident, so any "add" semantics are meaningless — force replace.
      const replace = edition === 'silver' ? true : !!args.replace;
      const tallyIniPath = process.env.TALLY_INI_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.ini';
      const tallyExePath = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
      try {
        if (!fs.existsSync(tallyIniPath)) {
          auditLog('load-company', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `tally.ini not found at ${tallyIniPath}.`, remedy: 'Set the TALLY_INI_PATH env var if it lives elsewhere.', retryable: false });
        }
        if (!fs.existsSync(tallyExePath)) {
          auditLog('load-company', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `tally.exe not found at ${tallyExePath}.`, remedy: 'Set the TALLY_EXE_PATH env var if it lives elsewhere.', retryable: false });
        }

        // Resolve data path: explicit override > tally.ini Data= > env var > built-in default.
        // Tally.ini is the canonical source — Tally itself reads from there.
        const ini = fs.readFileSync(tallyIniPath, 'utf-8');
        const iniDataPath = parseTallyIniDataPath(ini);
        const tallyDataPath = args.dataPath
          || iniDataPath
          || process.env.TALLY_DATA_PATH
          || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const dataPathSource = args.dataPath ? 'argument'
          : iniDataPath ? 'tally.ini'
          : process.env.TALLY_DATA_PATH ? 'TALLY_DATA_PATH env'
          : 'built-in default';

        // Resolve company input → folder id
        const folders = scanCompanyFolders(tallyDataPath);
        const resolved = resolveCompanyInput(company, folders);
        if (resolved.kind === 'not-found') {
          auditLog('load-company', args, 'error', Date.now() - start);
          const list = resolved.available.length === 0
            ? '(no folders found in data path)'
            : resolved.available.map(f => `  ${f.folder}\t${f.name || '(no name)'}`).join('\n');
          return errorResult('COMPANY_NOT_FOUND', {
            message: `Company "${company}" not found. Data path: ${tallyDataPath} (from ${dataPathSource}).`,
            remedy: 'Provide an exact folder id (digits) or a name matching Company.900 exactly; pass dataPath="<absolute path>" if the data lives elsewhere.',
            logs: `Available folders:\n${list}`,
          });
        }
        if (resolved.kind === 'ambiguous') {
          auditLog('load-company', args, 'error', Date.now() - start);
          const list = resolved.matches.map(f => `  ${f.folder}\t${f.name}`).join('\n');
          return errorResult('AMBIGUOUS', {
            message: `Multiple companies match the name "${company}".`,
            remedy: `Re-call load-company with the specific folder id (e.g. company: "${resolved.matches[0].folder}") to disambiguate.`,
            logs: list,
          });
        }
        const companyId = resolved.folderId;
        logs.push(`[load-company] input="${company}" matchedBy=${resolved.matchedBy} folderId=${companyId} companyName="${resolved.companyName}" edition=${edition} replace=${replace}${edition === 'silver' && args.replace === false ? ' (Silver: replace forced true)' : ''}`);
        logs.push(`  tallyIni=${tallyIniPath}`);
        logs.push(`  dataPath=${tallyDataPath} (source: ${dataPathSource})`);

        // Pre-flight: confirm the GUI agent is alive BEFORE we kill Tally. If we kill without an agent
        // to bring it back, the box is left in a worse state than it started.
        const agentWatchDir = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        logs.push('  Pinging GUI agent (must be alive before we kill Tally)...');
        const agentPing = await pingGuiAgent(agentWatchDir, 4, logs);
        if (!agentPing.alive) {
          auditLog('load-company', args, 'error', Date.now() - start);
          return errorResult('AGENT_UNREACHABLE', {
            message: `GUI agent did not respond at ${agentWatchDir}. Refusing to kill Tally without confirming we can restart it.`,
            logs: logs.join('\n'),
          });
        }
        // Version handshake: refuse to call select-and-unlock-company / start-tally on an agent that
        // predates the IPC fields they rely on. Better to fail fast here than silently mis-key
        // credentials into a stale agent. (issue #15 - option D)
        if (!agentPing.versionOk) {
          auditLog('load-company', args, 'error', Date.now() - start);
          const reportedVersion = agentPing.agentVersion ?? '(none reported)';
          return errorResult('AGENT_TOO_OLD', {
            message: `GUI agent is alive but reports version ${reportedVersion}, which is older than the required minimum ${REQUIRED_AGENT_VERSION}. The agent on disk has been updated by a deploy but the running process is stale.`,
            logs: logs.join('\n'),
          });
        }
        logs.push(`    GUI agent is alive (version ${agentPing.agentVersion ?? '(unknown)'}).`);

        const currentLoads = parseTallyIniLoads(ini);
        logs.push(`  Current Load= entries: ${currentLoads.length === 0 ? '(none)' : currentLoads.join(', ')}`);

        const newLoads = replace ? [companyId] : Array.from(new Set([...currentLoads, companyId]));
        const noChange = newLoads.length === currentLoads.length && newLoads.every((id, i) => id === currentLoads[i]);

        if (!noChange) {
          const updated = rewriteTallyIniLoads(ini, newLoads);
          atomicWriteFile(tallyIniPath, updated);
          logs.push(`  Updated tally.ini Load= to: ${newLoads.join(', ')}`);
        } else {
          logs.push('  tally.ini already has the requested Load= entries — skipping rewrite.');
        }

        // Stop Tally
        logs.push('  Stopping Tally (taskkill /F /IM tally.exe)...');
        try {
          execSync('taskkill /F /IM tally.exe', { timeout: 10000, windowsHide: true });
          logs.push('    Tally stopped.');
        } catch (err: any) {
          // taskkill returns non-zero when process not found — that's fine, means Tally wasn't running
          logs.push(`    taskkill: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]} (proceeding)`);
        }
        await sleep(2000);

        // Start Tally via the GUI agent IPC. The MCP service typically runs in Windows Session 0 (no desktop),
        // so it can't spawn GUI apps directly. The agent (tally-gui-agent-v2.ps1) runs in the interactive
        // user session and does the Start-Process on our behalf.
        // The agent's watch directory comes from TALLY_DATA_PATH env (same as the agent's startup logic) —
        // it must match what the agent is watching, NOT what tally.ini's Data= says (those can differ).
        logs.push(`  Starting Tally via GUI agent (${tallyExePath})...`);
        const agentResp = await callGuiAgent('start-tally', { exePath: tallyExePath, waitSec: 30 }, 35, agentWatchDir, logs);
        if (!agentResp) {
          logs.push('    GUI agent did not respond — is tally-gui-agent-v2.ps1 running in the user session?');
        } else if (agentResp.status !== 'success') {
          logs.push(`    GUI agent reported failure: ${agentResp.message}`);
        } else {
          logs.push(`    GUI agent reports Tally window detected.`);
        }

        // Poll XML server until ready (or timeout)
        logs.push(`  Polling Tally XML server (timeout ${args.waitTimeoutSec ?? 60}s)...`);
        const ready = await waitForTallyReady(timeoutMs, logs);
        if (!ready) {
          auditLog('load-company', args, 'error', Date.now() - start);
          return errorResult('TALLY_DOWN', {
            message: 'Tally did not become reachable after restart. The MCP service may be in Session 0 (no desktop) — Tally will not show a window in that case. Run the service in the user session, or have a companion process in the user session start tally.exe.',
            logs: logs.join('\n'),
          });
        }

        // Verify load: Tally silently skips auto-load when data is missing/empty or password-protected,
        // so XML reachability alone isn't proof of success. We need the requested company to appear in the loaded list.
        const expectedName = resolved.companyName.trim();
        let loaded = await listLoadedCompanies();
        if (expectedName && !loaded.some(n => n.toLowerCase() === expectedName.toLowerCase())) {
          await sleep(2000);
          loaded = await listLoadedCompanies();
        }
        logs.push(`  Loaded companies after restart: ${loaded.length === 0 ? '(none)' : loaded.join(', ')}`);

        let verified = expectedName
          ? loaded.some(n => n.toLowerCase() === expectedName.toLowerCase())
          : loaded.length > 0;

        // Credential fallback: if auto-load failed AND credentials were provided, ask the GUI agent
        // to keystroke through the Select Company dialog + credential prompt. This handles user-based
        // security where Tally drops to Select Company because the credential dialog blocked auto-load.
        if (!verified && (args.userName || args.password)) {
          logs.push('  Auto-load did not complete — likely blocked by credential prompt. Trying keystroke fallback via GUI agent...');
          const unlockResp = await callGuiAgent(
            'select-and-unlock-company',
            { companyId, userName: args.userName || '', password: args.password || '' },
            20,
            agentWatchDir,
            logs
          );
          if (!unlockResp || unlockResp.status !== 'success') {
            logs.push(`    GUI agent reported: ${unlockResp ? unlockResp.message : 'no response'}`);
          }
          // Re-verify after keystrokes settle
          await sleep(3000);
          loaded = await listLoadedCompanies();
          logs.push(`  Loaded companies after keystroke fallback: ${loaded.length === 0 ? '(none)' : loaded.join(', ')}`);
          verified = expectedName
            ? loaded.some(n => n.toLowerCase() === expectedName.toLowerCase())
            : loaded.length > 0;
        }

        if (!verified) {
          auditLog('load-company', args, 'error', Date.now() - start);
          const hint = (args.userName || args.password)
            ? 'Even with credentials, the company did not load. Verify the username/password are correct, and that the company is reachable via Alt+F3 → type id → Enter manually.'
            : 'If the company is password-protected, retry with userName and password arguments to use the keystroke fallback.';
          return errorResult('PASSWORD_REQUIRED', {
            message: `Tally restarted but the requested company is not in the loaded list. ${hint}`,
            logs: logs.join('\n'),
          });
        }

        // Pick activeCompany: prefer the verified name match; fall back to the only loaded company on Silver/single-load setups.
        if (expectedName && loaded.some(n => n.toLowerCase() === expectedName.toLowerCase())) {
          activeCompany = loaded.find(n => n.toLowerCase() === expectedName.toLowerCase()) || expectedName;
        } else if (loaded.length === 1) {
          activeCompany = loaded[0];
        }
        if (activeCompany) logs.push(`  Set activeCompany = "${activeCompany}".`);

        auditLog('load-company', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: logs.join('\n') + `\n\nTally is back up with ${loaded.length} loaded company/companies (edition: ${edition}). Active company: ${activeCompany || '(unset)'}.` }]
        };
      } catch (err) {
        auditLog('load-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: `load-company failed: ${err}`, logs: logs.join('\n') });
      }
    }
  );

  mcpServer.registerTool(
    'list-master',
    {
      title: 'List Masters',
      description: `fetches list of masters from Tally Prime collection e.g. group, ledger, vouchertype, unit, godown, stockgroup, stockitem, costcategory, costcentre, attendancetype, company, currency, gstin, gstclassification returns output in tab separated format`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        collection: z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification'])
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map<string, any>([['collection', args.collection]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('list-master', inputParams);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: rowCount(resp.data), rows: jsonToTSV(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'search-master',
    {
      title: 'Search Masters',
      description: `Like list-master but filtered by a plain case-insensitive substring (or prefix) match on the master NAME — a convenience so you don't have to pull the whole collection. This is a DUMB filter: no ranking, no fuzzy scoring, no reordering; matches are returned in Tally's source order. For fuzzy/best-match selection, pull list-master and match session-side. Returns { count, rows } (TSV) — the same row shape as list-master, filtered. Blank query returns everything.`,
      inputSchema: {
        collection: z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification']),
        query: z.string().describe('case-insensitive substring (or prefix) to match against the master name. Blank returns all rows (same as list-master).'),
        mode: z.enum(['substring', 'prefix']).optional().describe('match mode; defaults to substring'),
        targetCompany: z.string().optional().describe('optional company name; defaults to the active company')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const inputParams = new Map<string, any>([['collection', args.collection]]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      try {
        const resp = await pull('list-master', inputParams);
        if (resp.error) {
          auditLog('search-master', args, 'error', Date.now() - start);
          return errorResult('UNKNOWN', { message: resp.error });
        }
        const filtered = filterMasterRows(Array.isArray(resp.data) ? resp.data : [], args.query, args.mode ?? 'substring');
        auditLog('search-master', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: rowCount(filtered), rows: jsonToTSV(filtered) }) }]
        };
      } catch (err) {
        auditLog('search-master', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'search-master failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'chart-of-accounts',
    {
      title: 'Chart of Accounts',
      description: `fetches chart of accounts or group structure / GL hierarchywith fields group_name, group_parent, bs_pl, dr_cr, affects_gross_profit. the column bs_pl will have values BS = Balance Sheet / PL = Profit Loss. Column dr_cr as value D = Debit / C = Credit. columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values Y = Yes / N = No, it is used to determine if ledger under this group will affect gross profit or not. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map();
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('chart-of-accounts', inputParams);
      const tableId = await cacheTable('chart-of-accounts', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'trial-balance',
    {
      title: 'Trial Balance',
      description: `fetches trial balance with fields ledger_name, group_name, opening_balance, net_debit, net_credit, closing_balance. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('trial-balance', inputParams);
      const tableId = await cacheTable('trial-balance', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'profit-loss',
    {
      title: 'Profit and Loss',
      description: `fetches profit and loss statement with fields like ledger_name, group_name, amount, parent_group. amount negative is debit or expense and positive is credit or income. group_name is the immediate parent group of the ledger. parent_group is the grandparent / top-level primary group under which the group_name falls (e.g. Indirect Expenses, Direct Expenses, Sales Accounts, Purchase Accounts etc.). Use parent_group to aggregate sub-groups under their primary category. Always use financial year end date (31-Mar) as toDate for full year reports, not today's date. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('profit-loss', inputParams);
      const tableId = await cacheTable('profit-loss', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'balance-sheet',
    {
      title: 'Balance Sheet',
      description: `fetches balance sheet with fields like ledger_name, group_name, closing_balance. closing balance negative is debit or asset and positive is credit or liability. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('balance-sheet', inputParams);
      const tableId = await cacheTable('balance-sheet', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-summary',
    {
      title: 'Stock Summary',
      description: `fetches stock item summary with fields name, parent, opening_quantity, opening_value, inward_quantity, inward_value, outward_quantity, outward_value, closing_quantity, closing_value, returns output cached in DuckDB in-memory table (specified in tableID property). synonyms (name=stock item / parent=stock group) Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-summary', inputParams);
      const tableId = await cacheTable('stock-summary', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-balance',
    {
      title: 'Ledger Balance',
      description: `fetches ledger closing balance as on date, negative is debit and positive is credit`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        ledgerName: z.string().describe('exact ledger name, validate it using list-master tool with collection as ledger'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['ledgerName', args.ledgerName], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('ledger-balance', inputParams);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: rowCount(resp.data), rows: resp.data }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-item-balance',
    {
      title: 'Stock Item Balance',
      description: `fetches stock item remaining quantity balance as on date`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        itemName: z.string().describe('exact stock item name, validate it using list-master tool with collection as stockitem'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['itemName', args.itemName], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-item-balance', inputParams);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: rowCount(resp.data), rows: resp.data }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'bills-outstanding',
    {
      title: 'Bills Outstanding',
      description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        nature: z.enum(['receivable', 'payable']),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['nature', args.nature], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('bills-outstanding', inputParams);
      const tableId = await cacheTable('bills-outstanding', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-account',
    {
      title: 'Ledger Account',
      description: `fetches GL ledger account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, amount, narration, party_gstin, cgst_amount, sgst_amount, igst_amount. amount = debit is negative and credit is positive. party_name = ledger_name. GST tax amounts (cgst_amount, sgst_amount, igst_amount) are included per voucher entry where applicable. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        ledgerName: z.string().describe('exact ledger name, validate it using list-master tool with collection as ledger'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['ledgerName', args.ledgerName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      const resp = await pull('ledger-account', inputParams);
      const tableId = await cacheTable('ledger-account', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {

        //swap opening balance row to the top since it came at the end from Tally XML response
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          const lastItem = resp.data.pop();
          resp.data.unshift(lastItem);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'stock-item-account',
    {
      title: 'Stock Item Account',
      description: `fetches GL stock item account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, quantity, amount, narration, tracking_number, voucher_category. party_name = ledger_name. quantity = inward as positive and outward as negative. amount = debit is negative and credit is positive, narration = notes / remarks. for calculating closing balance of quantity, consider rows with tracking_number as empty as it is, but for rows with tracking_number having text value, then duplicate rows need to be removed by preparing intermediate output with aggregation of tracking_number and voucher_category with sum of quantity and then comparing quantity of Receipt Note with Purchase and Delivery Note with Sales to identify and remove the rows with Receipt Note and Delivery Note if they are found to be tracked fully / partially . returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        itemName: z.string().describe('exact stock item name, validate it using list-master tool with collection as stockitem'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      const resp = await pull('stock-item-account', inputParams);
      const tableId = await cacheTable('stock-item-account', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {

        //swap opening balance row to the top since it came at the end from Tally XML response
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          const lastItem = resp.data.pop();
          resp.data.unshift(lastItem);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'gst-voucher-details',
    {
      title: 'GST Voucher Details',
      description: `fetches GST tax breakup of vouchers (Sales, Purchase, Debit Note, Credit Note) for a date range with fields date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, cess_amount, invoice_value, reverse_charge, narration. amounts negative = debit, positive = credit. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gst-voucher-details', inputParams);
      const tableId = await cacheTable('gst-voucher-details', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-item-gst',
    {
      title: 'Stock Item GST Details',
      description: `fetches GST configuration of all stock items with fields item_name, parent_group, hsn_code, gst_applicability, type_of_supply (Goods/Services), tax_classification, igst_rate, cgst_rate, sgst_rate, cess_rate. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map();
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-item-gst', inputParams);
      const tableId = await cacheTable('stock-item-gst', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gst-hsn-summary',
    {
      title: 'GST HSN Summary',
      description: `fetches HSN-wise summary of GST transactions for a date range with fields hsn_code, description, uqc (unit quantity code), quantity, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, total_tax, invoice_value. useful for GST return filing (GSTR-1 HSN summary). returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gst-hsn-summary', inputParams);
      const tableId = await cacheTable('gst-hsn-summary', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gstr1-summary',
    {
      title: 'GSTR-1 Outward Supplies Summary',
      description: `fetches GSTR-1 style outward supplies summary for a date range. Covers Sales and Debit Note / Credit Note vouchers with GST details. Fields: date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, invoice_value, reverse_charge, supply_type (B2B/B2C). Use supply_type to segregate B2B vs B2C invoices. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gstr1-summary', inputParams);
      const tableId = await cacheTable('gstr1-summary', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gstr2-summary',
    {
      title: 'GSTR-2 Inward Supplies Summary',
      description: `fetches GSTR-2 style inward supplies summary for a date range. Covers Purchase and Debit Note / Credit Note vouchers with GST details. Fields: date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, invoice_value, reverse_charge, itc_eligibility. Useful for ITC (Input Tax Credit) reconciliation and GSTR-2B matching. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gstr2-summary', inputParams);
      const tableId = await cacheTable('gstr2-summary', resp.data);
      if (resp.error) {
        return errorResult('UNKNOWN', { message: resp.error });
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId, count: rowCount(resp.data) }) }]
        };
      }
    }
  );

  // ==================== PUSH TOOLS ====================

  mcpServer.registerTool(
    'create-voucher',
    {
      title: 'Create Voucher',
      description: `Posts one fully-resolved voucher to Tally. Preferred form: entries[] — an array of { ledger, drCr, amount } lines that MUST balance (sum of debits == sum of credits); the host rejects an unbalanced voucher with UNBALANCED. Supports optional inventory[], per-line billwise / costCentres, partyLedger, gst (placeOfSupply / reverse-charge), narration, voucherNumber, reference — so a plain journal, a GST invoice with stock, and a bill-wise receipt all post through this one tool. Ledger/stock names must already be exact (resolve them session-side; the host does no fuzzy matching). The legacy debitLedger/creditLedger/amount form still works as a 2-line shim. Returns { success, created, lastVchId }.`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name; defaults to the active company'),
        ...voucherInputShape,
        idempotencyKey: z.string().optional().describe('optional; replaying the same key returns the prior result without re-posting'),
        dryRun: z.boolean().optional().describe('if true, run all invariants and echo the exact posting (voucher + XML) WITHOUT writing to Tally'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-voucher', args, 'denied');
        return errorResult('READONLY');
      }
      const execOpts = await buildVoucherExecOpts(args);
      const result = await executeVoucher(args, { ...execOpts, dryRun: args.dryRun });
      auditLog('create-voucher', args, args.dryRun ? 'dryrun' : (result.isError ? 'error' : 'success'), Date.now() - start);
      return result;
    }
  );

  mcpServer.registerTool(
    'create-vouchers',
    {
      title: 'Create Vouchers (batch)',
      description: `Posts a batch of vouchers, each the same shape as create-voucher (entries[] + optional blocks). Returns per-row typed results aligned to the input. atomic=true validates EVERY row first (deterministic invariants) and posts NOTHING if any fails — but note Tally has no cross-voucher rollback, so a mid-batch Tally-side write failure can leave earlier rows posted (surfaced per-row). atomic=false (default) posts each independently; a failed row doesn't stop the rest. idempotencyKey makes a replayed batch return the prior result without re-posting. Session assembles the well-formed vouchers[]; the host executes deterministically.`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name; defaults to the active company'),
        vouchers: z.array(z.object(voucherInputShape)).min(1).describe('array of vouchers, each the create-voucher shape (entries[] + optional blocks)'),
        atomic: z.boolean().optional().describe('true = all-or-nothing validation (post nothing if any row fails deterministic checks). Default false = best-effort per row.'),
        idempotencyKey: z.string().optional().describe('optional; replaying the same key returns the prior batch result without re-posting'),
        dryRun: z.boolean().optional().describe('if true, validate all rows and echo per-row results WITHOUT writing to Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-vouchers', { count: args.vouchers.length }, 'denied');
        return errorResult('READONLY');
      }
      const store = getIdempotencyStore();
      const batchKey = args.idempotencyKey ? `batch:${args.idempotencyKey}` : '';
      if (batchKey) {
        const prior = store.get(batchKey);
        if (prior) {
          auditLog('create-vouchers', { count: args.vouchers.length, idempotentReplay: true }, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: JSON.stringify({ idempotentReplay: true, result: prior.result }) }] };
        }
      }
      const company = args.targetCompany || activeCompany || undefined;
      // One invariant context for the whole batch (fetch period + masters once).
      const anyInventory = args.vouchers.some(v => (v.inventory as unknown[] | undefined)?.length);
      const [period, knownLedgers, knownStockItems] = await Promise.all([
        fetchPeriodForWrite(company),
        fetchMasterNames('ledger', company),
        anyInventory ? fetchMasterNames('stockitem', company) : Promise.resolve<string[]>([]),
      ]);
      const rows = args.vouchers.map(v => ({ ...(v as VoucherArgs), targetCompany: company }));
      const batch = await executeVoucherBatch(rows, { atomic: args.atomic ?? false, dryRun: args.dryRun, period, knownLedgers, knownStockItems });
      if (batchKey && !args.dryRun && !batch.aborted) {
        try { store.put(batchKey, batch, new Date().toISOString()); } catch {}
      }
      const status = args.dryRun ? 'dryrun' : (batch.aborted || batch.posted < args.vouchers.length ? 'error' : 'success');
      auditLog('create-vouchers', { count: args.vouchers.length, atomic: args.atomic, dryRun: args.dryRun }, status, Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify(batch, null, 2) }], isError: batch.aborted };
    }
  );

  mcpServer.registerTool(
    'reverse-voucher',
    {
      title: 'Reverse / Cancel Voucher',
      description: `Cancels a posted voucher (mark-cancelled: ACTION="Cancel" + ISCANCELLED — Edit-Log-safe, keeps the row with a cancellation trail). Locate the target deterministically by voucherType + voucherNumber + its original date; no fuzzy matching (resolve the exact voucher session-side). mode defaults to 'cancel'. For a reversing contra entry instead, post a normal create-voucher with the dr/cr swapped. Refused when READONLY_MODE=true. Returns { success, altered }.`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name; defaults to the active company'),
        voucherType: z.enum(['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Journal', 'Debit Note', 'Credit Note']).describe('voucher type of the target voucher'),
        voucherNumber: z.string().describe('exact voucher number to cancel'),
        date: z.string().describe('the target voucher\'s original date (YYYY-MM-DD), used to locate it'),
        mode: z.enum(['cancel', 'reversing-entry']).optional().describe("defaults to 'cancel' (mark-cancelled). 'reversing-entry' is not posted here — use create-voucher with the dr/cr swapped.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('reverse-voucher', args, 'denied');
        return errorResult('READONLY');
      }
      if (args.mode === 'reversing-entry') {
        auditLog('reverse-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'reversing-entry mode is not posted here — create a contra voucher via create-voucher with the dr/cr swapped.', retryable: false });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        auditLog('reverse-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Date must be in YYYY-MM-DD format.', retryable: false });
      }
      if (!args.voucherNumber.trim()) {
        auditLog('reverse-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'voucherNumber is required to locate the voucher.', retryable: false });
      }
      const company = args.targetCompany || activeCompany || undefined;
      const xml = buildCancelVoucherXml({ voucherType: args.voucherType, voucherNumber: args.voucherNumber, date: args.date }, company);
      const resp = await pushXml(xml);
      if (!resp.success || (resp.altered === 0 && resp.created === 0)) {
        auditLog('reverse-voucher', args, 'error', Date.now() - start);
        return errorResult('PRECONDITION_FAILED', {
          message: resp.error || `Could not locate voucher ${args.voucherType} #${args.voucherNumber} dated ${args.date} to cancel.`,
          retryable: false
        });
      }
      auditLog('reverse-voucher', args, 'success', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, altered: resp.altered, cancelled: args.voucherNumber }) }] };
    }
  );

  mcpServer.registerTool(
    'create-ledger',
    {
      title: 'Create Ledger',
      description: `creates a new GL ledger master in Tally Prime. Parent group must exactly match an existing group in Tally — validate using list-master tool with collection as group before calling. Returns success status`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        name: z.string().describe('ledger name to create'),
        parentGroup: z.string().describe('exact parent group name — validate using list-master tool with collection as group'),
        openingBalance: z.number().optional().describe('optional opening balance. negative = debit, positive = credit'),
        mailingName: z.string().optional().describe('optional mailing name / display name'),
        gstRegistrationType: z.enum(['Regular', 'Composition', 'Unregistered', 'Consumer', 'Unknown']).optional().describe('optional GST registration type for party ledgers'),
        gstin: z.string().optional().describe('optional GSTIN number for party ledgers'),
        dryRun: z.boolean().optional().describe('if true, validate and echo the posting WITHOUT writing to Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-ledger', args, 'denied');
        return errorResult('READONLY');
      }
      if (!args.name || args.name.trim() === '') {
        auditLog('create-ledger', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Ledger name cannot be empty.', retryable: false });
      }

      let inputParams = new Map<string, any>([
        ['name', args.name],
        ['parentGroup', args.parentGroup]
      ]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.openingBalance !== undefined) inputParams.set('openingBalance', args.openingBalance);
      if (args.mailingName) inputParams.set('mailingName', args.mailingName);
      if (args.gstRegistrationType) inputParams.set('gstRegistrationType', args.gstRegistrationType);
      if (args.gstin) inputParams.set('gstin', args.gstin);

      if (args.dryRun) {
        auditLog('create-ledger', args, 'dryrun', Date.now() - start);
        return dryRunEcho('ledger', inputParams);
      }
      const resp = await push('ledger', inputParams);
      if (!resp.success) {
        auditLog('create-ledger', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: resp.error || 'Failed to create ledger.' });
      }
      auditLog('create-ledger', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created }) }]
      };
    }
  );

  mcpServer.registerTool(
    'create-stock-item',
    {
      title: 'Create Stock Item',
      description: `creates a new stock item master in Tally Prime. Parent group and unit must exactly match existing stock group and unit in Tally — validate using list-master tool with collection as stockgroup and unit respectively. Returns success status`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        name: z.string().describe('stock item name to create'),
        parentGroup: z.string().optional().describe('optional parent stock group — validate using list-master tool with collection as stockgroup'),
        unit: z.string().optional().describe('optional base unit — validate using list-master tool with collection as unit'),
        openingQuantity: z.number().optional().describe('optional opening quantity'),
        openingRate: z.number().optional().describe('optional opening rate per unit'),
        hsnCode: z.string().optional().describe('optional HSN/SAC code for GST'),
        gstRate: z.number().optional().describe('optional GST rate percentage'),
        dryRun: z.boolean().optional().describe('if true, validate and echo the posting WITHOUT writing to Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-stock-item', args, 'denied');
        return errorResult('READONLY');
      }
      if (!args.name || args.name.trim() === '') {
        auditLog('create-stock-item', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Stock item name cannot be empty.', retryable: false });
      }

      let inputParams = new Map<string, any>([
        ['name', args.name]
      ]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.parentGroup) inputParams.set('parentGroup', args.parentGroup);
      if (args.unit) inputParams.set('unit', args.unit);
      if (args.openingQuantity !== undefined) inputParams.set('openingQuantity', args.openingQuantity);
      if (args.openingRate !== undefined) inputParams.set('openingRate', args.openingRate);
      if (args.openingQuantity !== undefined && args.openingRate !== undefined) {
        inputParams.set('openingValue', args.openingQuantity * args.openingRate);
      }
      if (args.hsnCode) inputParams.set('hsnCode', args.hsnCode);
      if (args.gstRate !== undefined) inputParams.set('gstRate', args.gstRate);

      if (args.dryRun) {
        auditLog('create-stock-item', args, 'dryrun', Date.now() - start);
        return dryRunEcho('stock-item', inputParams);
      }
      const resp = await push('stock-item', inputParams);
      if (!resp.success) {
        auditLog('create-stock-item', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: resp.error || 'Failed to create stock item.' });
      }
      auditLog('create-stock-item', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created }) }]
      };
    }
  );

  mcpServer.registerTool(
    'create-gst-voucher',
    {
      title: 'Create GST Voucher',
      description: `creates a GST-compliant voucher (Sales, Purchase, Debit Note, Credit Note) in Tally Prime with automatic tax ledger allocation. Provide taxable value and GST rate — the tool will auto-calculate CGST+SGST (intra-state) or IGST (inter-state) based on place of supply. Tax ledger names are auto-resolved from Tally. Party ledger and sale/purchase ledger names must exactly match existing ledgers — validate using list-master tool with collection as ledger. For Debit Note / Credit Note, provide originalInvoiceNumber and optionally originalInvoiceDate to link back to the original invoice. Returns success status with created voucher ID`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        voucherType: z.enum(['Sales', 'Purchase', 'Debit Note', 'Credit Note']).describe('type of GST voucher to create'),
        date: z.string().describe('voucher date in YYYY-MM-DD format'),
        partyLedger: z.string().describe('exact party (customer/supplier) ledger name — validate using list-master tool with collection as ledger'),
        salePurchaseLedger: z.string().describe('exact sales or purchase ledger name — validate using list-master tool with collection as ledger'),
        taxableValue: z.number().describe('taxable amount before GST, must be greater than 0'),
        gstRate: z.number().describe('GST rate percentage (e.g. 18 for 18% GST). CGST and SGST will be half each for intra-state, or full IGST for inter-state'),
        isInterState: z.boolean().describe('true = inter-state supply (IGST), false = intra-state supply (CGST + SGST)'),
        placeOfSupply: z.string().optional().describe('optional place of supply state name for GST determination'),
        isReverseCharge: z.boolean().optional().describe('optional reverse charge flag, defaults to false'),
        narration: z.string().optional().describe('optional narration / remarks for the voucher'),
        voucherNumber: z.string().optional().describe('optional voucher number. leave blank for auto-numbering'),
        originalInvoiceNumber: z.string().optional().describe('original invoice number — required for Debit Note / Credit Note to link back to the original invoice'),
        originalInvoiceDate: z.string().optional().describe('original invoice date in YYYY-MM-DD format — optional for Debit Note / Credit Note'),
        dryRun: z.boolean().optional().describe('if true, run all invariants + tax computation and echo the posting (incl. taxBreakup) WITHOUT writing to Tally'),
        cgstLedger: z.string().optional().describe('optional exact CGST ledger name. if not provided, auto-resolved from Tally'),
        sgstLedger: z.string().optional().describe('optional exact SGST ledger name. if not provided, auto-resolved from Tally'),
        igstLedger: z.string().optional().describe('optional exact IGST ledger name. if not provided, auto-resolved from Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-gst-voucher', args, 'denied');
        return errorResult('READONLY');
      }
      // validate taxable value
      if (args.taxableValue <= 0) {
        auditLog('create-gst-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Taxable value must be greater than 0.', retryable: false });
      }
      // validate GST rate
      if (args.gstRate < 0 || args.gstRate > 100) {
        auditLog('create-gst-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'GST rate must be between 0 and 100.', retryable: false });
      }
      // validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        auditLog('create-gst-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Date must be in YYYY-MM-DD format.', retryable: false });
      }
      // date within the open period (#95 H-9 → OUT_OF_PERIOD). Tolerant: skipped if period unknown.
      {
        const period = await fetchPeriodForWrite(args.targetCompany || activeCompany || undefined);
        if (period && !isDateInOpenPeriod(args.date, period)) {
          auditLog('create-gst-voucher', args, 'denied');
          const lo = period.booksFrom || period.fyFrom;
          return errorResult('OUT_OF_PERIOD', { message: `Voucher date ${args.date} is outside the open period (${lo}..${period.fyTo}).` });
        }
      }
      // validate party != sale/purchase ledger
      if (args.partyLedger.trim().toLowerCase() === args.salePurchaseLedger.trim().toLowerCase()) {
        auditLog('create-gst-voucher', args, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'Party ledger and sale/purchase ledger must be different.', retryable: false });
      }

      // auto-resolve tax ledgers if not provided
      let cgstLedger = args.cgstLedger;
      let sgstLedger = args.sgstLedger;
      let igstLedger = args.igstLedger;

      if ((!args.isInterState && (!cgstLedger || !sgstLedger)) || (args.isInterState && !igstLedger)) {
        const resolveParams = new Map<string, any>();
        const _gtc = args.targetCompany || activeCompany;
        if (_gtc) resolveParams.set('targetCompany', _gtc);
        const gstLedgers = await resolveGSTLedgers(resolveParams);

        if (!args.isInterState) {
          if (!cgstLedger) cgstLedger = gstLedgers.cgst;
          if (!sgstLedger) sgstLedger = gstLedgers.sgst;
          if (!cgstLedger || !sgstLedger) {
            return errorResult('PRECONDITION_FAILED', { message: 'Could not auto-resolve CGST/SGST ledger names from Tally.', remedy: 'Provide cgstLedger and sgstLedger explicitly.', retryable: false });
          }
        } else {
          if (!igstLedger) igstLedger = gstLedgers.igst;
          if (!igstLedger) {
            return errorResult('PRECONDITION_FAILED', { message: 'Could not auto-resolve IGST ledger name from Tally.', remedy: 'Provide igstLedger explicitly.', retryable: false });
          }
        }
      }

      // calculate tax amounts
      const taxableValue = Math.round(args.taxableValue * 100) / 100;
      let cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

      if (args.isInterState) {
        igstAmount = Math.round(taxableValue * args.gstRate) / 100;
      } else {
        const halfRate = args.gstRate / 2;
        cgstAmount = Math.round(taxableValue * halfRate) / 100;
        sgstAmount = Math.round(taxableValue * halfRate) / 100;
      }

      const totalInvoiceValue = Math.round((taxableValue + cgstAmount + sgstAmount + igstAmount) * 100) / 100;

      const isSalesType = args.voucherType === 'Sales' || args.voucherType === 'Credit Note';
      const isPurchaseType = args.voucherType === 'Purchase' || args.voucherType === 'Debit Note';

      let inputParams = new Map<string, any>([
        ['voucherType', args.voucherType],
        ['date', args.date],
        ['partyLedger', args.partyLedger],
        ['salePurchaseLedger', args.salePurchaseLedger],
        ['taxableValue', taxableValue],
        ['totalInvoiceValue', totalInvoiceValue],
        ['isSalesType', isSalesType],
        ['isPurchaseType', isPurchaseType]
      ]);

      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.narration) inputParams.set('narration', args.narration);
      if (args.voucherNumber) inputParams.set('voucherNumber', args.voucherNumber);
      if (args.placeOfSupply) inputParams.set('placeOfSupply', args.placeOfSupply);
      if (args.isReverseCharge) inputParams.set('isReverseCharge', true);
      if (args.originalInvoiceNumber) inputParams.set('originalInvoiceNumber', args.originalInvoiceNumber);
      if (args.originalInvoiceDate) inputParams.set('originalInvoiceDate', args.originalInvoiceDate);

      if (!args.isInterState) {
        inputParams.set('cgstLedger', cgstLedger!);
        inputParams.set('cgstAmount', cgstAmount);
        inputParams.set('sgstLedger', sgstLedger!);
        inputParams.set('sgstAmount', sgstAmount);
      } else {
        inputParams.set('igstLedger', igstLedger!);
        inputParams.set('igstAmount', igstAmount);
      }

      if (args.dryRun) {
        auditLog('create-gst-voucher', args, 'dryrun', Date.now() - start);
        return dryRunEcho('gst-voucher', inputParams, { taxBreakup: { taxableValue, cgstAmount, sgstAmount, igstAmount, totalInvoiceValue } });
      }
      const resp = await push('gst-voucher', inputParams);
      if (!resp.success) {
        auditLog('create-gst-voucher', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: resp.error || 'Failed to create GST voucher.' });
      }
      auditLog('create-gst-voucher', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created, lastVchId: resp.lastVchId, taxBreakup: { taxableValue, cgstAmount, sgstAmount, igstAmount, totalInvoiceValue } }) }]
      };
    }
  );

  // --- Company registry tools (issue: alias-based fast loading) -----------------------------
  // Resolves the registry path from env, with the same fallback the installer uses.
  const resolveRegistryPath = (): string => {
    if (process.env.TALLY_COMPANIES_CONFIG) return process.env.TALLY_COMPANIES_CONFIG;
    const dataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
    return path.join(dataPath, '.tally-mcp-companies.json');
  };

  mcpServer.registerTool(
    'list-configured-companies',
    {
      title: 'List Configured Companies',
      description: `lists all companies the user has pre-configured in the Tally MCP registry via the tray dashboard's Manage Companies screen. Each entry is a friendly alias (e.g. "main", "branch") the user can refer to when asking to load a company. Use this BEFORE load-company-by-alias when the user says a short name without specifying an exact match — surface the list so they can clarify. Returns alias, displayName, and whether a stored password exists (never the password itself).`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const registry = loadCompanyRegistry(resolveRegistryPath());
        const out = registry.companies.map(c => ({
          alias: c.alias,
          extraAliases: c.extraAliases ?? [],
          folderId: c.folderId,
          displayName: c.displayName ?? '',
          hasPassword: !!c.passwordEnc,
          notes: c.notes ?? ''
        }));
        auditLog('list-configured-companies', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify({ count: out.length, companies: out }, null, 2) }] };
      } catch (err) {
        auditLog('list-configured-companies', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'list-configured-companies failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'resolve-company',
    {
      title: 'Resolve Company',
      description: `Resolves ONE human string — a folder id (digits), an exact company name, or a configured alias — to a single canonical record: { name, folderId, alias, isLoaded, isProtected, matchedBy }. Prefer this over guessing among the five list-* tools: it returns a typed ok / ambiguous / not-found so you know whether you can act. isLoaded tells you whether set-active-company will work right now; isProtected tells you whether a load will need credentials. On ambiguous/not-found it lists the candidates (with aliases) so you can disambiguate.`,
      inputSchema: {
        query: z.string().max(256).describe('folder id (digits), exact company name, or a configured alias to resolve to one company.')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const folders = scanCompanyFolders(tallyDataPath);
        const registry = loadCompanyRegistry(resolveRegistryPath());
        let loaded: string[] = [];
        try {
          loaded = await listLoadedCompanies();
        } catch {
          // Tally may be unreachable; isLoaded=false is the safe default.
        }
        const result = resolveCompanyEnriched(args.query, folders, registry, loaded);
        auditLog('resolve-company', args, result.kind === 'not-found' ? 'denied' : 'success', Date.now() - start);
        return {
          isError: result.kind === 'not-found',
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        auditLog('resolve-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'resolve-company failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'use-company',
    {
      title: 'Use Company',
      description: `One call to bring a known company to ACTIVE from an EXACT folder id / name / configured alias (no fuzzy matching — resolve fuzzily session-side first). Deterministically: resolves the query → if already loaded, just sets it active (fast path, no restart/keystrokes) → else routes to the right load path. Returns the final typed status: success, or a single typed error naming the one remaining blocker (AMBIGUOUS / COMPANY_NOT_FOUND / TALLY_DOWN / and, for a not-resident company, the exact load tool to call). Prefer this over hand-orchestrating resolve-company + set-active-company + load-*.`,
      inputSchema: {
        query: z.string().max(256).describe('EXACT folder id (digits), company name, or configured alias. Not fuzzy.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const folders = scanCompanyFolders(tallyDataPath);
        const registry = loadCompanyRegistry(resolveRegistryPath());
        let loaded: string[] = [];
        try { loaded = await listLoadedCompanies(); } catch { /* Tally maybe down; isLoaded=false */ }
        const resolved = resolveCompanyEnriched(args.query, folders, registry, loaded);
        const plan = planUseCompany(resolved);

        if (plan.action === 'error') {
          auditLog('use-company', args, 'denied', Date.now() - start);
          return errorResult(plan.code, { logs: JSON.stringify(resolved) });
        }

        // Fast path: already loaded → verify + set active (bounded transient retry on the verify).
        if (plan.action === 'set-active') {
          const { result: ok } = await retryForResult(
            () => verifyCompanyLoaded(plan.company.name).then(v => (v ? true : null)),
            (v) => v === true, 3
          );
          if (ok) {
            activeCompany = plan.company.name;
            auditLog('use-company', args, 'success', Date.now() - start);
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, activeCompany, folderId: plan.company.folderId, path: 'already-loaded' }) }] };
          }
          // isLoaded was stale — fall through to the appropriate load path below.
          plan.company.isLoaded = false;
        }

        // Not resident: name the single remaining action deterministically. The actual destructive
        // load (tally.ini restart) / DPAPI vault-unlock stay in their dedicated, Windows-validated
        // tools; use-company routes to exactly one of them so the caller isn't guessing.
        const c = plan.company;
        if (c.alias) {
          auditLog('use-company', args, 'denied', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', {
            message: `"${c.name}" (folder ${c.folderId}) is configured but not resident. Bring it active with load-company-by-alias.`,
            remedy: `Call load-company-by-alias with alias "${c.alias}" (uses the stored vault credentials).`,
            retryable: false
          });
        }
        auditLog('use-company', args, 'denied', Date.now() - start);
        return errorResult('PRECONDITION_FAILED', {
          message: `"${c.name}" (folder ${c.folderId}) is not resident and has no vault entry.`,
          remedy: `Call load-company (folderId "${c.folderId}"${c.isProtected ? ', with userName + password — it is protected' : ''}) — note it restarts Tally. Or configure it in the tray so it can vault-unlock.`,
          retryable: false
        });
      } catch (err) {
        auditLog('use-company', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'use-company failed.', logs: String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'open-tally',
    {
      title: 'Open Tally',
      description: `Launches Tally Prime if it is not already running, and waits until its XML server is reachable. Idempotent: if Tally is already up it returns immediately without relaunching. Because the MCP service runs in Windows Session 0 (no desktop), it can't spawn a GUI app itself — it dispatches the launch to the GUI agent running in the interactive session, so that agent must be alive (AGENT_UNREACHABLE otherwise). Call this before load-company / use-company / any read when Tally may be closed.`,
      inputSchema: {
        waitTimeoutSec: z.number().optional().describe('how long to wait for Tally to become reachable after launch (default 60)')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const logs: string[] = [];
      try {
        // Fast path: already reachable → nothing to do (no agent needed).
        if (await pingTally()) {
          auditLog('open-tally', args, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, alreadyRunning: true }) }] };
        }
        const tallyExePath = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
        if (!fs.existsSync(tallyExePath)) {
          auditLog('open-tally', args, 'error', Date.now() - start);
          return errorResult('PRECONDITION_FAILED', { message: `tally.exe not found at ${tallyExePath}.`, remedy: 'Set TALLY_EXE_PATH in .env (via Reconfigure) if Tally lives elsewhere.', retryable: false });
        }
        // The service is in Session 0, so the launch must go through the interactive-session agent.
        const agentWatchDir = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        logs.push('  Pinging GUI agent (needed to launch Tally in the interactive session)...');
        const agentPing = await pingGuiAgent(agentWatchDir, 4, logs);
        if (!agentPing.alive) {
          auditLog('open-tally', args, 'error', Date.now() - start);
          return errorResult('AGENT_UNREACHABLE', {
            message: `GUI agent did not respond at ${agentWatchDir}, so Tally can't be launched into the desktop session.`,
            logs: logs.join('\n'),
          });
        }
        if (!agentPing.versionOk) {
          auditLog('open-tally', args, 'error', Date.now() - start);
          return errorResult('AGENT_TOO_OLD', {
            message: `GUI agent is alive but reports version ${agentPing.agentVersion ?? '(none)'}, older than the required ${REQUIRED_AGENT_VERSION}.`,
            logs: logs.join('\n'),
          });
        }
        logs.push(`  Starting Tally via GUI agent (${tallyExePath})...`);
        const agentResp = await callGuiAgent('start-tally', { exePath: tallyExePath, waitSec: 30 }, 35, agentWatchDir, logs);
        if (!agentResp || agentResp.status !== 'success') {
          logs.push(`    GUI agent: ${agentResp ? agentResp.message : 'no response'}`);
        }
        const timeoutMs = (args.waitTimeoutSec ?? 60) * 1000;
        logs.push(`  Polling Tally XML server (timeout ${args.waitTimeoutSec ?? 60}s)...`);
        const ready = await waitForTallyReady(timeoutMs, logs);
        if (!ready) {
          auditLog('open-tally', args, 'error', Date.now() - start);
          return errorResult('TALLY_DOWN', {
            message: 'Tally was launched but did not become reachable in time. If the service runs in Session 0, Tally won\'t show a window there — the GUI agent must launch it in the user session.',
            logs: logs.join('\n'),
          });
        }
        auditLog('open-tally', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, alreadyRunning: false, launched: true, agentMessage: agentResp?.message ?? '' }) }] };
      } catch (err) {
        auditLog('open-tally', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'open-tally failed.', logs: logs.join('\n') + '\n' + String(err) });
      }
    }
  );

  mcpServer.registerTool(
    'load-company-by-alias',
    {
      title: 'Load Company by Alias',
      description: `fast deterministic load of a Tally company using a pre-configured alias from the registry. Looks up the alias, decrypts any stored password locally, and dispatches a keystroke flow to the GUI agent: types the folder ID, presses Enter, then types username/password if stored. Prefer this over open-company when the user refers to a company by a short name they've configured (use list-configured-companies first to see what's available). Returns success once Tally has accepted the keystrokes. If the alias is unknown, returns an error listing all valid aliases.`,
      inputSchema: {
        alias: z.string().describe('the friendly name the user configured (e.g. "main", "branch"). Case-insensitive, matched against alias and extraAliases.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const logs: string[] = [];
      try {
        const registry = loadCompanyRegistry(resolveRegistryPath());
        const entry = findCompanyByAlias(registry, args.alias);
        if (!entry) {
          const valid = listConfiguredAliases(registry);
          const hint = valid.length > 0
            ? `Valid aliases: ${valid.join(', ')}. Configure new aliases via the tray icon > Manage Companies.`
            : `No companies configured yet. Open the tray icon > Manage Companies to add one.`;
          auditLog('load-company-by-alias', args, 'denied', Date.now() - start);
          return errorResult('COMPANY_NOT_FOUND', { message: `Unknown alias "${args.alias}".`, remedy: hint });
        }

        // Decrypt the stored password just before dispatch. The plaintext lives in this
        // function's locals for ~milliseconds and is never logged (auditLog strips fields
        // named 'password'/'secret'/'token' from args before writing).
        let plaintextPassword = '';
        if (entry.passwordEnc) {
          try {
            plaintextPassword = await decryptPasswordViaDpapi(entry.passwordEnc);
          } catch (err) {
            auditLog('load-company-by-alias', args, 'error', Date.now() - start);
            return errorResult('UNKNOWN', {
              message: `Decryption failed for alias "${entry.alias}": ${err}.`,
              remedy: 'Fix via tray icon > Manage Companies > Edit > tick "Change password".',
              logs: String(err),
            });
          }
        }

        const dataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const timeoutSec = 30;
        // Self-healing unlock (#89 H-3): a keystroke miss is transient, so re-dispatch the whole
        // select-and-unlock up to N times (the agent re-keys + re-verifies each attempt) before
        // surrendering PASSWORD_REQUIRED — so a transient miss isn't reported like a wrong password.
        const maxRetries = Math.max(1, parseInt(process.env.UNLOCK_MAX_RETRIES || '3', 10) || 3);
        const { result: resp, attempts } = await retryForResult(
          () => callGuiAgent('select-and-unlock-company', { companyId: entry.folderId, userName: entry.username ?? '', password: plaintextPassword }, timeoutSec, dataPath, logs),
          (r) => !!r && r.status === 'success',
          maxRetries
        );
        logs.push(`  [unlock] select-and-unlock-company: ${attempts} attempt(s)`);

        if (!resp) {
          auditLog('load-company-by-alias', args, 'error', Date.now() - start);
          return errorResult('AGENT_UNREACHABLE', { logs: logs.join('\n') });
        }
        if (resp.status !== 'success') {
          auditLog('load-company-by-alias', args, 'error', Date.now() - start);
          return errorResult('PASSWORD_REQUIRED', {
            message: `Load failed for "${entry.alias}" after ${attempts} attempt(s): ${resp.message}.`,
            remedy: 'If the password is wrong, fix via tray icon > Manage Companies > Edit > tick "Change password".',
            logs: logs.join('\n'),
          });
        }

        activeCompany = entry.displayName || entry.folderId;
        auditLog('load-company-by-alias', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, alias: entry.alias, folderId: entry.folderId, displayName: entry.displayName ?? '', agentMessage: resp.message }) }]
        };
      } catch (err) {
        auditLog('load-company-by-alias', args, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'load-company-by-alias failed.', logs: String(err) });
      }
    }
  );

  // ==================== INTERACTIVE GUI CONTROL TOOLS ====================
  // Let an MCP client (Claude) drive the Tally window directly: gui-screenshot to SEE the current
  // screen, gui-send-keys to act on it. This is the adaptive, human-supervised alternative to the
  // blind select-and-unlock keystroke sequence - Claude reacts to whatever dialog is actually shown
  // (Select Company, credential prompt, "load anyway?", Gateway of Tally). Both are gated behind
  // ENABLE_GUI_CONTROL because they expose arbitrary keystroke injection and screenshots that can
  // include financial data or a credential field.
  mcpServer.registerTool(
    'gui-screenshot',
    {
      title: 'GUI Screenshot (Tally window)',
      description: `captures the current Tally Prime window as a PNG so you can SEE its on-screen state — Select Company list, credential prompt, "load anyway?" dialog, Gateway of Tally — and decide the next keystrokes. Pair with gui-send-keys to interactively drive Tally login / company selection instead of a blind fixed sequence. Requires ENABLE_GUI_CONTROL=true and the GUI agent running with Tally open. The image is returned to you and the on-disk copy is deleted immediately (it may show financial data or a credential field).`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const start = Date.now();
      if (process.env.ENABLE_GUI_CONTROL !== 'true') {
        auditLog('gui-screenshot', {}, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'GUI control is disabled.', remedy: 'Set ENABLE_GUI_CONTROL=true (and restart the service) to enable gui-screenshot / gui-send-keys.', retryable: false });
      }
      const dataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
      const logs: string[] = [];
      const resp = await callGuiAgent('screenshot', {}, 20, dataPath, logs);
      // The agent writes the PNG BEFORE writing its result, so a credential/financial frame can be on
      // disk even on the timeout path. Always clean it up, whatever the outcome - never leave it behind.
      const shot = path.join(dataPath, '_mcp_screenshot.png');
      const cleanupShot = () => { try { fs.unlinkSync(shot); } catch {} };
      if (!resp) {
        cleanupShot();
        auditLog('gui-screenshot', {}, 'error', Date.now() - start);
        return errorResult('AGENT_UNREACHABLE', { message: 'GUI agent did not respond. Is it running (tray > Restart GUI agent) and is Tally open?', logs: logs.join('\n') });
      }
      if (resp.status !== 'success') {
        cleanupShot();
        auditLog('gui-screenshot', {}, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: resp.message || 'Screenshot failed.' });
      }
      if (!fs.existsSync(shot)) {
        auditLog('gui-screenshot', {}, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: 'Agent reported success but the screenshot file was not found on disk.' });
      }
      const b64 = fs.readFileSync(shot).toString('base64');
      cleanupShot();  // don't leave a Tally-screen image (possibly a credential frame) on disk
      auditLog('gui-screenshot', {}, 'success', Date.now() - start);
      return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
    }
  );

  mcpServer.registerTool(
    'gui-send-keys',
    {
      title: 'GUI Send Keys (Tally window)',
      description: `sends an ordered sequence of keystrokes / typed text to the Tally Prime window to log in, select a company, or navigate menus. Pair with gui-screenshot to see the result and iterate step by step. Requires ENABLE_GUI_CONTROL=true and the GUI agent running with Tally open. Each step is {action, value}: "type" types the literal string (folder id, username, password); "key" presses ONE of these supported keys — enter, escape, tab, backspace, up, down, left, right, f1, f2, f3, f4, f5, f10, f12; "combo" presses a supported modifier chord — alt/ctrl/shift + one of f1, f2, f3, f4, f5, f10, a, c, v, x (e.g. "alt+f3", "ctrl+a"); "wait" pauses for value milliseconds (useful after an action that triggers a screen change). Keys/combos outside these sets are ignored (logged as unmapped). Focus is re-asserted before each step. Typed values are filtered from audit logs.`,
      inputSchema: {
        keys: z.array(z.object({
          action: z.enum(['type', 'key', 'combo', 'wait']).describe('type = literal text; key = single key; combo = modifier chord (e.g. alt+f3); wait = pause milliseconds'),
          value: z.string().describe('for type: the text to type; for key: the key name; for combo: e.g. "alt+f3"; for wait: milliseconds as a string')
        })).describe('ordered keystroke steps to run in the Tally window, e.g. [{action:"type",value:"100000"},{action:"key",value:"enter"}]')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async (args) => {
      const start = Date.now();
      // Redact literal typed text (may be a password) before it reaches the audit log.
      const redacted = { keys: (args.keys || []).map(k => k.action === 'type' ? { action: 'type', value: '***' } : k) };
      if (process.env.ENABLE_GUI_CONTROL !== 'true') {
        auditLog('gui-send-keys', redacted, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'GUI control is disabled.', remedy: 'Set ENABLE_GUI_CONTROL=true (and restart the service) to enable gui-screenshot / gui-send-keys.', retryable: false });
      }
      if (!args.keys || args.keys.length === 0) {
        auditLog('gui-send-keys', redacted, 'denied');
        return errorResult('PRECONDITION_FAILED', { message: 'No keys provided.', retryable: false });
      }
      const dataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
      const logs: string[] = [];
      const resp = await callGuiAgent('sendkeys', { keys: args.keys }, 30, dataPath, logs);
      if (!resp) {
        auditLog('gui-send-keys', redacted, 'error', Date.now() - start);
        return errorResult('AGENT_UNREACHABLE', { message: 'GUI agent did not respond. Is it running and is Tally open?', logs: logs.join('\n') });
      }
      if (resp.status !== 'success') {
        auditLog('gui-send-keys', redacted, 'error', Date.now() - start);
        return errorResult('UNKNOWN', { message: resp.message || 'sendkeys failed.' });
      }
      auditLog('gui-send-keys', redacted, 'success', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: resp.message }) }] };
    }
  );

  return mcpServer;
}
