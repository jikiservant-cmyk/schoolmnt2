
/**
 * Lightweight fixed-window rate limiter used to throttle brute-force attempts
 * against authentication surfaces (login, signup, teacher PIN verification).
 *
 * NOTE: State is kept in-process. On a single Node instance (e.g. one Cloud Run
 * container) this is effective. When horizontally scaled, each instance keeps
 * its own counters, so the effective limit is multiplied by the instance
 * count. For multi-instance deployments back this with Redis/Upstash or a
 * Postgres table. Supabase GoTrue also applies its own server-side limits.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 50_000;

function sweep(now: number) {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still too big (e.g. distributed flood) — drop oldest entries.
  if (buckets.size >= MAX_KEYS) {
    const excess = buckets.size - MAX_KEYS + 1000;
    let i = 0;
    for (const key of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Consume one unit from `key`. Returns allowed=false once `limit` hits have
 * been recorded inside `windowMs`.
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const allowed = bucket.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** Peek without consuming. */
export function isRateLimited(key: string, limit: number): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) return false;
  return bucket.count >= limit;
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}
