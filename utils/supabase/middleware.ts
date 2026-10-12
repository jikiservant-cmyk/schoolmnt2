import { createServerClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { createPublicAdminClient } from '@/utils/supabase/admin'
import { hardenAuthCookieOptions } from './cookie-options'

export async function updateSession(request: NextRequest) {
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

  const { pathname } = request.nextUrl

  // Protected routes: /dashboard, /mark-attendance, and /manual-attendance
  if (!user && (pathname.startsWith('/dashboard') || pathname.startsWith('/mark-attendance') || pathname.startsWith('/manual-attendance'))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    const redirectResponse = NextResponse.redirect(url)
    supabaseResponse.headers.getSetCookie().forEach((cookieStr) => {
      redirectResponse.headers.append('Set-Cookie', cookieStr)
    })
    return redirectResponse
  }

  // Never treat a merely authenticated Supabase session as an app session.
  // This includes unverified addresses and profiles whose explicit school_id
  // conflicts with their staff membership. In addition to closing that gate at
  // the dashboard, clear invalid sessions at entry pages so they cannot cause
  // an endless /login -> /dashboard -> access_denied redirect loop.
  const isAuthEntryPath = pathname === '/login' || pathname === '/signup' || pathname === '/'
  if (user && isAuthEntryPath) {
    if (await isWorkingSchoolAdmin(user, supabase)) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      url.search = ''
      const redirectResponse = NextResponse.redirect(url)
      supabaseResponse.headers.getSetCookie().forEach((cookieStr) => {
        redirectResponse.headers.append('Set-Cookie', cookieStr)
      })
      return redirectResponse
    }

    try {
      await supabase.auth.signOut()
    } catch {
      /* Explicit expiry below is still mandatory. */
    }
    request.cookies.getAll()
      .filter((c) => c.name.startsWith('sb-'))
      .forEach((c) => supabaseResponse.cookies.set(c.name, '', {
        ...hardenAuthCookieOptions({}),
        maxAge: 0,
        expires: new Date(0),
      }))
    supabaseResponse.headers.set('Cache-Control', 'no-store')
    return supabaseResponse
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
 * Mirror lib/auth-guard's admin test before redirecting a session away from an
 * entry page. Any lookup failure is false so this middleware fails closed.
 */
async function isWorkingSchoolAdmin(
  user: User,
  supabase: ReturnType<typeof createServerClient>,
): Promise<boolean> {
  try {
    const emailIsVerified = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'false'
      || Boolean(user.email_confirmed_at || user.confirmed_at)
    if (!emailIsVerified) return false

    const { data: profile, error } = await createPublicAdminClient()
      .from('admin_profiles')
      .select('role, app_type, school_id')
      .eq('id', user.id)
      .maybeSingle()
    if (error || !profile || profile.role !== 'school_admin') return false
    if (profile.app_type && profile.app_type !== 'school') return false

    const { data: schoolId, error: rpcErr } = await supabase.rpc('auth_school_id')
    if (rpcErr || typeof schoolId !== 'string' || !UUID_RE.test(schoolId)) return false
    return !profile.school_id || profile.school_id.toLowerCase() === schoolId.toLowerCase()
  } catch {
    return false
  }
}
