import { createClient } from '@supabase/supabase-js';
import { getSupabasePublicConfig } from '@/utils/supabase/public-config';

function getAdminConfig() {
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_KEY?.trim() || '';

  if (!serviceRoleKey) {
    throw new Error('Server-side Supabase admin credentials are not configured.');
  }
  if (/^(your[-_]|placeholder|my_|test[-_]?key|changeme|change[-_]?me)/i.test(serviceRoleKey)) {
    throw new Error('The Supabase service-role key is still a placeholder.');
  }
  const anonKeys = new Set([
    supabaseAnonKey,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
    process.env.SUPABASE_ANON_KEY?.trim(),
  ].filter((key): key is string => Boolean(key)));
  if (anonKeys.has(serviceRoleKey)) {
    throw new Error('The Supabase service-role client must not use the anon key.');
  }

  return { supabaseUrl, serviceRoleKey };
}

/** Admin client configured with the service role for the school schema. */
export function createAdminClient() {
  const { supabaseUrl, serviceRoleKey } = getAdminConfig();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: 'school',
    },
  });
}

/** Admin client configured for the public schema (wallets, tenants, etc.). */
export function createPublicAdminClient() {
  const { supabaseUrl, serviceRoleKey } = getAdminConfig();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: 'public',
    },
  });
}
