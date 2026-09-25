export interface SupabasePublicEnvironment {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  SUPABASE_ANON_KEY?: string;
}

export function getSupabasePublicConfig(
  environment: SupabasePublicEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  },
): { supabaseUrl: string; supabaseAnonKey: string } {
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.trim() || environment.SUPABASE_URL?.trim();
  const supabaseAnonKey = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || environment.SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and anon key must be configured before serving requests.');
  }
  if (/^(your[-_]|placeholder|my_|test[-_]?key$|changeme$|change[-_]?me$)/i.test(supabaseAnonKey)) {
    throw new Error('The Supabase anon key is still a placeholder.');
  }
  try {
    const parsedUrl = new URL(supabaseUrl);
    if (parsedUrl.hostname === 'placeholder-project.supabase.co') {
      throw new Error('The placeholder Supabase URL cannot be used at runtime.');
    }
    const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
    const isAllowedProtocol = parsedUrl.protocol === 'https:' || (isLocalhost && parsedUrl.protocol === 'http:');
    if (!isAllowedProtocol) {
      throw new Error('Supabase URL must use HTTPS outside HTTP localhost.');
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('Supabase URL must not include embedded credentials.');
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Supabase URL is invalid.');
    }
    throw error;
  }

  return { supabaseUrl, supabaseAnonKey };
}
