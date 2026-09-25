import { createBrowserClient } from '@supabase/ssr';
import { getSupabasePublicConfig } from '@/utils/supabase/public-config';

export function createClient() {
  // Only NEXT_PUBLIC values are available in a browser bundle. Do not silently
  // fall back to fake endpoints or server-only SUPABASE_URL aliases.
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    db: {
      schema: 'school',
    },
  });
}
