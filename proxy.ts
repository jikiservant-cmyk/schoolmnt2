import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'

export async function proxy(request: NextRequest) {
  // Readiness must remain available when configuration is incomplete so the
  // orchestrator can remove the instance from service instead of seeing a
  // middleware 500.
  if (request.nextUrl.pathname === '/api/health') {
    return NextResponse.next();
  }
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
