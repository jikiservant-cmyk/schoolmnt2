import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  const supabaseUrl = 
    process.env.NEXT_PUBLIC_SUPABASE_URL || 
    process.env.SUPABASE_URL || 
    'https://placeholder-project.supabase.co';

  const supabaseAnonKey = 
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
    process.env.SUPABASE_ANON_KEY || 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder';

  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    db: {
      schema: 'school',
    },
  });
}
