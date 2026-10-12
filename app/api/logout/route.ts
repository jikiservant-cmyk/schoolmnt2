import { createClient } from '@/utils/supabase/server';
import { isSameOriginHeaders } from '@/lib/security/request';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Reject cross-site form posts (login/logout CSRF). Browsers always send
 * `Origin` on cross-origin POSTs; `Sec-Fetch-Site` is a second signal.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginHeaders(request.headers)) {
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
