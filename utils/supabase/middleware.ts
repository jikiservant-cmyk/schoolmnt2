import { createServerClient } from '@supabase/ssr'
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
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    const redirectResponse = NextResponse.redirect(url)
    supabaseResponse.headers.getSetCookie().forEach((cookieStr) => {
      redirectResponse.headers.append('Set-Cookie', cookieStr)
    })
    return redirectResponse
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
