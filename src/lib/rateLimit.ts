/**
 * Sliding-window rate limiter (in-memory).
 *
 * For each key we keep an array of request timestamps that fall inside the
 * window. On every check we drop expired timestamps and either accept the
 * new request (push the timestamp) or reject it (return retry-after).
 *
 * NOTE: In-memory state is per Node.js instance. On a serverless platform
 * with multiple cold instances (Vercel, Lambda, etc.), each instance has
 * its own counter — so the *effective* limit can be N × the configured
 * limit where N is the number of warm instances. For a small/dev
 * deployment this is acceptable; for production-grade abuse protection,
 * back this with a shared store (Upstash Redis, Cloudflare KV, etc.).
 */

type Entry = number[]; // timestamps (ms) within the active window

const buckets = new Map<string, Entry>();

// Periodically prune buckets that are entirely outside the window so the
// Map doesn't grow unbounded. Runs at most once per minute.
let lastSweep = 0;
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const cutoff = now - windowMs;
  for (const [key, ts] of buckets) {
    const fresh = ts.filter((t) => t > cutoff);
    if (fresh.length === 0) buckets.delete(key);
    else if (fresh.length !== ts.length) buckets.set(key, fresh);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** How many requests remain in the current window. */
  remaining: number;
  /** Total limit for the window. */
  limit: number;
  /** Window length in seconds, for the Retry-After header. */
  windowSec: number;
  /** Seconds until the oldest in-window request falls out (only relevant when !ok). */
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);

  const cutoff = now - windowMs;
  const ts = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (ts.length >= limit) {
    buckets.set(key, ts);
    const oldest = ts[0];
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1000)
    );
    return {
      ok: false,
      remaining: 0,
      limit,
      windowSec: Math.ceil(windowMs / 1000),
      retryAfterSec,
    };
  }

  ts.push(now);
  buckets.set(key, ts);
  return {
    ok: true,
    remaining: limit - ts.length,
    limit,
    windowSec: Math.ceil(windowMs / 1000),
    retryAfterSec: 0,
  };
}

/** Build a stable rate-limit key from a Next.js request. */
export function keyForRequest(req: Request, userId: string | null): string {
  if (userId) return `u:${userId}`;
  return `ip:${ipFromRequest(req)}`;
}

/** Extract the client IP from common reverse-proxy headers. */
export function ipFromRequest(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
