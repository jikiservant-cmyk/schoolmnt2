import { createClient } from '@supabase/supabase-js';

function requiredServerEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getSupabaseConfig() {
  const url = requiredServerEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requiredServerEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  // Never silently downgrade an admin client to an anon key.
  if (anonKey && serviceRoleKey === anonKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must not equal NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return { url, serviceRoleKey };
}

function createConfiguredAdminClient(schema: 'school' | 'public') {
  const { url, serviceRoleKey } = getSupabaseConfig();
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema,
    },
  });
}

/** Admin client configured with the service role for the school schema. */
export function createAdminClient() {
  return createConfiguredAdminClient('school');
}

/** Admin client configured with the service role for public tables. */
export function createPublicAdminClient() {
  return createConfiguredAdminClient('public');
}
