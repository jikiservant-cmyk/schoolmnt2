import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from('schools')
      .select('id')
      .limit(1);

    if (error) {
      return NextResponse.json(
        { status: 'unhealthy', dependencies: { database: 'unavailable' } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      { status: 'ok', dependencies: { database: 'ok' } },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    // Do not expose configuration or database details through a public probe.
    return NextResponse.json(
      { status: 'unhealthy', dependencies: { database: 'unavailable' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
