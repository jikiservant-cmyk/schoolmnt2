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
