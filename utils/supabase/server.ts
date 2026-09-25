import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabasePublicConfig } from '@/utils/supabase/public-config';

export async function createClient() {
  const cookieStore = await cookies();

  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();

  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      db: {
        schema: 'school',
      },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, {
                ...options,
                path: '/',
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
              })
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing user sessions.
          }
        },
      },
    }
  );
}
