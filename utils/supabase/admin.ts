import { createClient } from '@supabase/supabase-js';

/**
 * SECURITY: The service-role client bypasses RLS. It must only ever be built
 * with the real service-role key. Previously this fell back to the public anon
 * key (and then to a placeholder) when the key was missing — which silently
 * changed authorization semantics and, combined with try/catch blocks in the
 * login flow, made the admin-role gate fail OPEN. We now fail CLOSED.
 */
function getAdminCredentials() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Server misconfiguration: Supabase service credentials are not set.');
  }
  if (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    serviceRoleKey === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    throw new Error('Server misconfiguration: service-role key must not equal the public anon key.');
  }
  return { supabaseUrl, serviceRoleKey };
}

/**
 * Admin client configured with service role for the 'school' schema
 */
export function createAdminClient() {
  const { supabaseUrl, serviceRoleKey } = getAdminCredentials();
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

/**
 * Admin client configured with service role for the 'public' schema (wallets, tenants, etc.)
 */
export function createPublicAdminClient() {
  const { supabaseUrl, serviceRoleKey } = getAdminCredentials();
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
