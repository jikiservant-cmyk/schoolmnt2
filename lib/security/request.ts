import { headers } from 'next/headers';

/**
 * Number of trusted reverse-proxy hops immediately in front of this server.
 *
 * - Explicit `TRUSTED_PROXY_HOPS` (integer >= 0) always wins (`0` disables trust).
 * - Managed serverless platforms (`K_SERVICE` on Google Cloud Run, `VERCEL` on
 *   Vercel) append the true client IP as the right-most external hop (`1`).
 * - Direct / unproxied servers return `0`: client-supplied `X-Forwarded-For` and
 *   `X-Real-IP` headers are untrusted and ignored so attackers cannot evade rate
 *   limits by rotating spoofed headers.
 */
export function resolveTrustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  if (process.env.K_SERVICE || process.env.VERCEL) {
    return 1;
  }
  return 0;
}

/**
 * Extracts the verified external client IP ONLY behind a trusted proxy, reading
 * the right-most external hop (`parts[parts.length - hops]`) rather than
 * `split(',')[0]` which clients can trivially spoof.
 */
export function extractClientIpFromHeaders(h: { get(name: string): string | null }): string {
  const hops = resolveTrustedProxyHops();
  if (hops <= 0) {
    return 'unknown';
  }

  if (process.env.VERCEL) {
    const vercelIp = h.get('x-vercel-forwarded-for');
    if (vercelIp) {
      const parts = vercelIp.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        return parts[Math.max(0, parts.length - hops)].slice(0, 64);
      }
    }
  }

  const xff = h.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - hops);
      return parts[idx].slice(0, 64);
    }
  }

  const realIp = h.get('x-real-ip')?.trim();
  if (realIp) {
    return realIp.slice(0, 64);
  }

  return 'unknown';
}

/**
 * Best-effort verified client IP for rate-limiting keys.
 * Never use this value for authorization decisions — only for throttling.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  return extractClientIpFromHeaders(h);
}

/** Safely read a string field from FormData (rejects File values / non-strings). */
export function getFormString(formData: FormData, key: string, maxLength = 1024): string | null {
  const value = formData.get(key);
  if (typeof value !== 'string') return null;
  if (value.length > maxLength) return null;
  return value;
}

// Pragmatic RFC 5322 subset — good enough to reject garbage before hitting GoTrue.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** Uniform artificial delay to blunt timing-based account enumeration. */
export async function constantDelay(startedAt: number, minMs = 400) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
  }
}
