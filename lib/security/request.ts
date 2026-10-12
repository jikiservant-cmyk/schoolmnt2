import { headers } from 'next/headers';

/**
 * Best-effort client IP for rate-limiting keys. Uses the left-most
 * X-Forwarded-For entry set by the platform load balancer (Cloud Run / Vercel).
 * Never use this value for authorization decisions — only for throttling.
 */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (h.get('x-real-ip') || 'unknown').slice(0, 64);
}

/**
 * Cross-site request check shared by Server Actions and route handlers.
 *
 * Next.js validates Server Action origins itself, but keeping this application
 * check makes the protection explicit and also covers actions when auth cookies
 * have deliberately been configured as SameSite=None for an embedded preview.
 * A missing Origin is accepted for older same-origin form navigations; browser
 * cross-site POSTs supply Origin and are rejected by the Fetch Metadata check.
 */
export function isSameOriginHeaders(requestHeaders: Pick<Headers, 'get'>): boolean {
  const fetchSite = requestHeaders.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = requestHeaders.get('origin');
  if (!origin) return true;

  // Proxies may append a list. The first host/protocol is the externally
  // visible one. Compare scheme too: `http://app.example` and
  // `https://app.example` are different browser origins.
  const forwardedHost = requestHeaders.get('x-forwarded-host');
  const host = (forwardedHost || requestHeaders.get('host') || '').split(',')[0]?.trim().toLowerCase();
  const forwardedProto = requestHeaders.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (!host) return false;

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host.toLowerCase() !== host) return false;
    if (forwardedProto && parsedOrigin.protocol.replace(/:$/, '').toLowerCase() !== forwardedProto) return false;
    return true;
  } catch {
    return false;
  }
}

/** Throw before a state-changing Server Action accepts a cross-site request. */
export async function requireSameOrigin(): Promise<void> {
  const requestHeaders = await headers();
  if (!isSameOriginHeaders(requestHeaders)) {
    throw new Error('Cross-site request rejected');
  }
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
