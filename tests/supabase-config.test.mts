import assert from 'node:assert/strict';
import test from 'node:test';
import { getSupabasePublicConfig } from '../utils/supabase/public-config.ts';

test('Supabase config accepts explicitly configured HTTPS credentials', () => {
  assert.deepEqual(getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://example-project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key',
  }), {
    supabaseUrl: 'https://example-project.supabase.co',
    supabaseAnonKey: 'public-anon-key',
  });
});

test('Supabase config fails closed when values are missing or placeholders', () => {
  assert.throws(() => getSupabasePublicConfig({}), /must be configured/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder-project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'valid-looking-key',
  }), /placeholder/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://school.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'your-anon-key',
  }), /placeholder/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://school.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test_key',
  }), /placeholder/);
});

test('Supabase config rejects invalid and non-local HTTP URLs', () => {
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'not-a-url',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key',
  }), /invalid/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'http://supabase.internal',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key',
  }), /HTTPS/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'ftp://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key',
  }), /HTTPS/);
  assert.throws(() => getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://user:password@school.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key',
  }), /credentials/);
  assert.equal(getSupabasePublicConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'key',
  }).supabaseUrl, 'http://localhost:54321');
});
