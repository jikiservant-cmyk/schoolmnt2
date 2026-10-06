import { createClient } from '@/utils/supabase/server';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Reject cross-site form posts (login/logout CSRF). Browsers always send
 * `Origin` on cross-origin POSTs; `Sec-Fetch-Site` is a second signal.
 */
function isSameOrigin(request: NextRequest): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin navigations from old browsers may omit it; SameSite cookies cover these

  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Cross-site request rejected' }, { status: 403 });
  }

  const supabase = await createClient();
  // Revoke the refresh token server-side, then the cookie store clears sb-* cookies.
  await supabase.auth.signOut();

  // Relative Location: request.url carries the server's bind address
  // (e.g. http://0.0.0.0:3000) behind a proxy, which sent users to a dead page.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/login', 'Cache-Control': 'no-store' },
  });
}

// Explicitly refuse GET so a logout can't be triggered by <img src="/api/logout">.
export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
}
