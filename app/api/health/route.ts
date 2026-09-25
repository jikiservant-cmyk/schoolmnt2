import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { getSupabasePublicConfig } from '@/utils/supabase/public-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Minimal readiness probe. It never returns database errors or tenant data. */
export async function GET() {
  try {
    getSupabasePublicConfig();
    const supabase = createAdminClient();
    const { error } = await supabase.from('schools').select('id').limit(1);
    if (error) {
      console.error('[Health] School-schema readiness query failed:', error);
      return NextResponse.json(
        { status: 'unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return NextResponse.json(
      { status: 'ok' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[Health] Required runtime configuration is unavailable:', error);
    return NextResponse.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
