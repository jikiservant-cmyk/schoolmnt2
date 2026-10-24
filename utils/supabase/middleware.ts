import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { createPublicAdminClient } from '@/utils/supabase/admin'
import { hardenAuthCookieOptions } from './cookie-options'
import {
  REGISTER_CAPABILITY_COOKIE,
  KIOSK_CAPABILITY_COOKIE,
  verifyRegisterCapabilityToken,
  verifyKioskCapabilityToken,
  buildCapabilityCookieOptions,
} from '@/lib/security/register-token'

/**
 * Emits a safe relative 307 redirect (`Location: /login` or `Location: /dashboard`)
 * preserving all `Set-Cookie` headers without leaking internal bind hosts
 * (e.g. `http://0.0.0.0:3000`) or honoring spoofed `Host` headers.
 */
function relativeRedirect(
  request: NextRequest,
  location: string,
  supabaseResponse: NextResponse
): NextResponse {
  const safeTarget = location.startsWith('/') && !location.startsWith('//') ? location : '/login'
  const configuredOrigin = (
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    ''
  ).trim()

  let redirectUrl: URL
  if (configuredOrigin) {
    redirectUrl = new URL(safeTarget, configuredOrigin)
  } else {
    redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = safeTarget
    redirectUrl.search = ''
    redirectUrl.hash = ''
  }

  const redirectResponse = NextResponse.redirect(redirectUrl, {
    status: 307,
    headers: {
      'Cache-Control': 'no-store',
      'x-internal-rel-location': safeTarget,
    },
  })
  supabaseResponse.headers.getSetCookie().forEach((cookieStr) => {
    redirectResponse.headers.append('Set-Cookie', cookieStr)
  })
  return redirectResponse
}

export async function updateSession(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl

  // Hardware push endpoints & webhooks never use browser sessions — skip GoTrue round-trips entirely.
  if (
    pathname === '/iclock' ||
    pathname.startsWith('/iclock/') ||
    pathname === '/api/devices' ||
    pathname.startsWith('/api/devices/') ||
    pathname === '/api/webhooks' ||
    pathname.startsWith('/api/webhooks/')
  ) {
    return NextResponse.next({ request })
  }

  // Evaluate Web-Crypto HMAC-SHA256 scoped capability tokens for classroom registers & gate kiosks.
  let validRegisterTokenToSet: { token: string; maxAge: number } | null = null
  let validKioskTokenToSet: { token: string; maxAge: number } | null = null
  let hasScopedCapabilityAccess = false

  const manualMatch = pathname.match(/^\/manual-attendance\/([^/]+)\/?$/)
  if (manualMatch) {
    const targetClassId = decodeURIComponent(manualMatch[1])
    const queryToken = searchParams.get('token')
    const cookieToken = request.cookies.get(REGISTER_CAPABILITY_COOKIE)?.value

    if (queryToken) {
      const verified = await verifyRegisterCapabilityToken(queryToken, targetClassId)
      if (verified) {
        const ttl = Math.max(1, verified.exp - Math.floor(Date.now() / 1000))
        request.cookies.set(REGISTER_CAPABILITY_COOKIE, queryToken)
        validRegisterTokenToSet = { token: queryToken, maxAge: ttl }
        hasScopedCapabilityAccess = true
      }
    }

    if (!hasScopedCapabilityAccess && cookieToken) {
      const verified = await verifyRegisterCapabilityToken(cookieToken, targetClassId)
      if (verified) {
        hasScopedCapabilityAccess = true
      }
    }
  } else if (pathname === '/mark-attendance' || pathname.startsWith('/mark-attendance/')) {
    const queryToken = searchParams.get('token')
    const cookieToken = request.cookies.get(KIOSK_CAPABILITY_COOKIE)?.value

    if (queryToken) {
      const verified = await verifyKioskCapabilityToken(queryToken)
      if (verified) {
        const ttl = Math.max(1, verified.exp - Math.floor(Date.now() / 1000))
        request.cookies.set(KIOSK_CAPABILITY_COOKIE, queryToken)
        validKioskTokenToSet = { token: queryToken, maxAge: ttl }
        hasScopedCapabilityAccess = true
      }
    }

    if (!hasScopedCapabilityAccess && cookieToken) {
      const verified = await verifyKioskCapabilityToken(cookieToken)
      if (verified) {
        hasScopedCapabilityAccess = true
      }
    }
  }

  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabaseUrl = 
    process.env.NEXT_PUBLIC_SUPABASE_URL || 
    process.env.SUPABASE_URL || 
    'https://placeholder-project.supabase.co'

  const supabaseAnonKey = 
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
    process.env.SUPABASE_ANON_KEY || 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder'

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      db: {
        schema: 'school',
      },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, hardenAuthCookieOptions(options))
          )
        },
      },
    }
  )

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (validRegisterTokenToSet) {
    supabaseResponse.cookies.set(
      REGISTER_CAPABILITY_COOKIE,
      validRegisterTokenToSet.token,
      buildCapabilityCookieOptions(validRegisterTokenToSet.maxAge)
    )
  }
  if (validKioskTokenToSet) {
    supabaseResponse.cookies.set(
      KIOSK_CAPABILITY_COOKIE,
      validKioskTokenToSet.token,
      buildCapabilityCookieOptions(validKioskTokenToSet.maxAge)
    )
  }

  // Protected routes: /dashboard strictly requires auth; /mark-attendance and
  // /manual-attendance accept either an authenticated session OR a verified capability token.
  const isProtectedWithoutCapability =
    pathname.startsWith('/dashboard') ||
    ((pathname.startsWith('/mark-attendance') || pathname.startsWith('/manual-attendance')) &&
      !hasScopedCapabilityAccess)

  if (!user && isProtectedWithoutCapability) {
    return relativeRedirect(request, '/login', supabaseResponse)
  }

  // A logged-in session that is NOT a school admin (staff login, account whose
  // school provisioning failed, revoked admin) is sent to
  // /login?error=access_denied by the dashboard. Server components can't clear
  // cookies, so the session survived and the block below sent the user straight
  // back to /dashboard: an endless redirect loop ("too many redirects") with no
  // way to reach the login form. Sign the session out HERE, then show the form.
  // Only for sessions that really fail the dashboard's admin check, so a
  // shared /login?error=access_denied link can't log a real admin out.
  if (user && pathname === '/login' && request.nextUrl.searchParams.get('error') === 'access_denied' && !(await isWorkingSchoolAdmin(user.id, supabase))) {
    try {
      await supabase.auth.signOut()
    } catch {
      /* cookies are expired below anyway */
    }
    request.cookies.getAll()
      .filter((c) => c.name.startsWith('sb-'))
      .forEach((c) => supabaseResponse.cookies.set(c.name, '', { maxAge: 0, path: '/' }))
    supabaseResponse.headers.set('Cache-Control', 'no-store')
    return supabaseResponse
  }

  // Redirect authenticated user away from login/signup
  if (user && (pathname === '/login' || pathname === '/signup' || pathname === '/')) {
    return relativeRedirect(request, '/dashboard', supabaseResponse)
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is. If you're
  // creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  return supabaseResponse
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Same test as lib/auth-guard checkSchoolAdmin (admin_profiles role/app_type
 * via service role + a school from auth_school_id). Any error -> false, i.e.
 * the session is signed out (fail closed, and no redirect loop).
 */
async function isWorkingSchoolAdmin(
  userId: string,
  supabase: ReturnType<typeof createServerClient>,
): Promise<boolean> {
  try {
    const { data: profile, error } = await createPublicAdminClient()
      .from('admin_profiles')
      .select('role, app_type')
      .eq('id', userId)
      .maybeSingle()
    if (error || !profile || profile.role !== 'school_admin') return false
    if (profile.app_type && profile.app_type !== 'school') return false
    const { data: schoolId, error: rpcErr } = await supabase.rpc('auth_school_id')
    return !rpcErr && typeof schoolId === 'string' && UUID_RE.test(schoolId)
  } catch {
    return false
  }
}
