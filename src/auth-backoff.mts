// Brute-force defences for the remote server that do not depend on knowing who the client is.

// ---- trust proxy ---------------------------------------------------------------------------------
//
// The per-IP rate limiter keys on req.ip. Express derives req.ip from X-Forwarded-For only for
// peers it has been told to trust; trusting a peer that is not really a proxy lets that peer pick
// its own "IP" on every request and walk straight past the limiter.
//
// TRUST_PROXY:
//   (unset)            'loopback' — trust X-Forwarded-For only from a proxy on this machine
//                      (cloudflared, nginx, caddy running alongside the server). A client that
//                      connects directly, e.g. over the LAN, is never trusted.
//   false | 0 | off    trust nobody; req.ip is always the socket address (direct / LAN serving).
//   <number>           trust that many proxy hops in front of the server.
//   <list>             comma-separated IPs, CIDR ranges, or the names loopback / linklocal /
//                      uniquelocal — for a reverse proxy on another host.
//   true               accepted for compatibility and treated as 1 hop (the previous behaviour).
export type TrustProxySetting = false | number | string;

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '') return 'loopback';
  const lower = value.toLowerCase();
  if (['false', '0', 'off', 'no', 'none'].includes(lower)) return false;
  if (['true', 'on', 'yes'].includes(lower)) return 1;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const parts = value.split(',').map(p => p.trim()).filter(Boolean);
  const valid = parts.every(p => /^(loopback|linklocal|uniquelocal)$/i.test(p) || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p));
  if (!valid || parts.length === 0) {
    console.error(`[security] Ignoring unrecognised TRUST_PROXY value; trusting loopback proxies only.`);
    return 'loopback';
  }
  return parts.join(',');
}

// ---- global failed-attempt backoff ---------------------------------------------------------------
//
// A per-IP limiter cannot stop a guesser who spreads attempts across addresses. This counts failed
// attempts for ONE secret across all clients. The first few failures are free (typos); after that
// every further failure opens a lockout window that doubles up to a cap, and while a window is open
// attempts are refused WITHOUT evaluating the secret — so the sustained guessing rate is bounded by
// the cap no matter how many addresses are used.
//
// The cost is deliberate and bounded: someone hammering the endpoint can delay a legitimate sign-in
// by at most `maxMs` at a time. A success, or a quiet period, clears the count.
export interface BackoffOptions {
  freeAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  resetAfterMs?: number;
  now?: () => number;
}

export class FailedAttemptBackoff {
  private failures = 0;
  private lockedUntil = 0;
  private lastFailureAt = 0;
  private readonly freeAttempts: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly resetAfterMs: number;
  private readonly now: () => number;

  constructor(options: BackoffOptions = {}) {
    this.freeAttempts = Math.max(0, options.freeAttempts ?? 5);
    this.baseMs = Math.max(1, options.baseMs ?? 1000);
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? 60_000);
    this.resetAfterMs = Math.max(this.maxMs, options.resetAfterMs ?? 15 * 60_000);
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until an attempt may be evaluated; 0 when attempts are currently allowed. */
  retryAfterMs(): number {
    const now = this.now();
    if (this.failures > 0 && now - this.lastFailureAt >= this.resetAfterMs) this.reset();
    return Math.max(0, this.lockedUntil - now);
  }

  recordFailure(): void {
    const now = this.now();
    this.failures += 1;
    this.lastFailureAt = now;
    const over = this.failures - this.freeAttempts;
    if (over > 0) {
      const delay = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(over - 1, 30));
      this.lockedUntil = now + delay;
    }
  }

  recordSuccess(): void {
    this.reset();
  }

  private reset(): void {
    this.failures = 0;
    this.lockedUntil = 0;
    this.lastFailureAt = 0;
  }
}
