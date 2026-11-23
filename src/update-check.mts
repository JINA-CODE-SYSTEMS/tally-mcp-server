// "Is this Claudally up to date?", answerable from inside the AI assistant.
//
// The same check the tray makes, with the same boundaries (see scripts/tray/tally-mcp-tray.ps1):
// it TELLS, it never downloads or runs anything; the download link is a constant here, never a
// value taken from the response, so a spoofed answer cannot send anyone anywhere; and
// UPDATE_CHECK=false in .env turns the network call off, in which case only the installed version
// is reported.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const RELEASES_PAGE_URL = 'https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/latest';
export const RELEASES_API_URL = 'https://api.github.com/repos/JINA-CODE-SYSTEMS/tally-mcp-server/releases/latest';

/** -1 / 0 / 1 for dotted numeric versions. A prerelease suffix is dropped, as in the tray. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => {
    const core = v.trim().replace(/^v/i, '').split('-')[0];
    const nums = core.split('.').map(p => (/^\d+$/.test(p) ? Number(p) : 0));
    while (nums.length < 3) nums.push(0);
    return nums;
  };
  const x = norm(a), y = norm(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

export type UpdateCheckResult =
  | { status: 'disabled'; installed: string }
  | { status: 'unreachable'; installed: string; reason: string }
  | { status: 'up-to-date' | 'update-available'; installed: string; latest: string };

export async function checkForUpdates(
  installed: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<UpdateCheckResult> {
  const env = opts.env ?? process.env;
  if ((env.UPDATE_CHECK ?? '').trim().toLowerCase() === 'false') return { status: 'disabled', installed };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(RELEASES_API_URL, {
      headers: { 'User-Agent': 'Claudally-Server', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return { status: 'unreachable', installed, reason: `GitHub answered ${res.status}` };
    const body = await res.json() as { tag_name?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    // Only something shaped like a version is believed; anything else is treated as no answer.
    if (!/^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(tag)) return { status: 'unreachable', installed, reason: 'no version in the response' };
    const latest = tag.replace(/^v/i, '');
    return { status: compareVersions(latest, installed) > 0 ? 'update-available' : 'up-to-date', installed, latest };
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    return { status: 'unreachable', installed, reason };
  }
}

export function formatUpdateCheck(r: UpdateCheckResult): string {
  switch (r.status) {
    case 'disabled':
      return `Installed: Claudally ${r.installed}.\nUpdate checks are turned off on this PC (UPDATE_CHECK=false), so nothing was looked up. Latest releases: ${RELEASES_PAGE_URL}`;
    case 'unreachable':
      return `Installed: Claudally ${r.installed}.\nCould not check for a newer version (${r.reason}). Latest releases: ${RELEASES_PAGE_URL}`;
    case 'up-to-date':
      return `Installed: Claudally ${r.installed}. This is the latest release (${r.latest}); nothing to do.`;
    case 'update-available':
      return [
        `Installed: Claudally ${r.installed}. A newer release is available: ${r.latest}.`,
        `To update: download the installer from ${RELEASES_PAGE_URL} and run it on this PC; your settings and companies are kept.`,
        'Then quit the AI app completely and reopen it. If its Tally tools do not come back, run "Connect your AI assistant to Tally" from the Start Menu.',
        'Claudally never updates itself: the user downloads and runs the installer.',
      ].join('\n');
  }
}

export function registerUpdateCheck(
  server: McpServer,
  installedVersion: () => string,
  audit: (toolName: string, durationMs: number) => void
): void {
  server.registerTool(
    'check-for-updates',
    {
      title: 'Check for Claudally updates',
      description: 'Reports the installed Claudally version and whether a newer release exists, and how to update. Asks GitHub for the latest release version (nothing about this PC or its data is sent); skipped when UPDATE_CHECK=false. Downloads and installs nothing. Use when the user asks which version they have or whether they are up to date.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const start = Date.now();
      const text = formatUpdateCheck(await checkForUpdates(installedVersion()));
      audit('check-for-updates', Date.now() - start);
      return { content: [{ type: 'text', text }] };
    }
  );
}
