/**
 * Hardened cookie attributes for Supabase auth cookies.
 *
 * Previously every auth cookie was forced to `SameSite=None`, which makes the
 * browser attach the session to *cross-site* requests (CSRF on form/route
 * handlers such as /api/logout, and session riding from any third-party page).
 *
 * Default is now `Lax`. If the app must run inside a third-party iframe
 * (e.g. an AI Studio preview), opt in explicitly with
 *   AUTH_COOKIE_SAMESITE=none
 * — never in production unless you understand the CSRF trade-off.
 *
 * `httpOnly` is enabled because the browser never reads the session directly
 * (all Supabase calls go through server actions / route handlers). This stops
 * an XSS payload from exfiltrating the access/refresh tokens.
 */
type SameSite = 'lax' | 'strict' | 'none';

function resolveSameSite(): SameSite {
  const raw = (process.env.AUTH_COOKIE_SAMESITE || '').toLowerCase();
  if (raw === 'none' || raw === 'strict' || raw === 'lax') return raw;
  return 'lax';
}

export function hardenAuthCookieOptions<T extends Record<string, unknown> | undefined>(options: T) {
  const sameSite = resolveSameSite();
  return {
    ...(options || {}),
    path: '/',
    sameSite,
    // SameSite=None requires Secure; otherwise secure everywhere except plain-http local dev.
    secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
    httpOnly: true,
  };
}
