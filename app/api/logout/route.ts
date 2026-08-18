import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  
  const url = new URL('/login', request.url);
  return NextResponse.redirect(url, { status: 303 });
}
