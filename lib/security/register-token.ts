/**
 * Web-Crypto HMAC-SHA256 Scoped Capability Tokens.
 *
 * Designed to run identically in Next.js Edge Middleware AND Node.js Server
 * Actions / Route Handlers using pure standard `globalThis.crypto.subtle`.
 *
 * Separates classroom teacher register links (`/manual-attendance/[classId]`)
 * and gate kiosk terminals (`/mark-attendance`) from full `school_admin`
 * dashboard sessions so teachers and gate operators never need a shared
 * `school_admin` cookie.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PREFIX = 'v1';

/** HttpOnly cookie storing a classroom register link capability token. */
export const REGISTER_CAPABILITY_COOKIE = 'sk_reg_cap';
/** HttpOnly cookie storing a short-lived verified Teacher PIN session token. */
export const REGISTER_PIN_COOKIE = 'sk_reg_pin';
/** HttpOnly cookie storing a gate kiosk terminal capability token. */
export const KIOSK_CAPABILITY_COOKIE = 'sk_kiosk_cap';

const DEFAULT_REGISTER_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_KIOSK_TTL_SECONDS = 30 * 24 * 60 * 60;    // 30 days
const DEFAULT_PIN_SESSION_TTL_SECONDS = 8 * 60 * 60;    // 8 hours (1 school day)

export interface RegisterCapabilityPayload {
  v: 1;
  scope: 'register';
  schoolId: string;
  classId: string;
  iat: number;
  exp: number;
}

export interface VerifiedTeacherPinPayload {
  v: 1;
  scope: 'register_pin';
  schoolId: string;
  classId: string;
  teacherId: string;
  staffUserId: string;
  /** Short digest binding this cookie to the teacher's current `pin_hash` so PIN resets immediately revoke active cookies. */
  pinTag?: string;
  iat: number;
  exp: number;
}

export interface KioskCapabilityPayload {
  v: 1;
  scope: 'kiosk';
  schoolId: string;
  iat: number;
  exp: number;
}

export type AnyCapabilityPayload =
  | RegisterCapabilityPayload
  | VerifiedTeacherPinPayload
  | KioskCapabilityPayload;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array | null {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

let cachedSecretSource: string | null = null;
let cachedCryptoKey: CryptoKey | null = null;

function resolveSigningSecretMaterial(): string {
  const dedicated = process.env.REGISTER_TOKEN_SECRET?.trim();
  if (dedicated) return `register-secret:${dedicated}`;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceKey) return `service-role-derived:${serviceKey}`;
  throw new Error('Missing capability token signing secret (REGISTER_TOKEN_SECRET or SUPABASE_SERVICE_ROLE_KEY).');
}

async function getHmacKey(): Promise<CryptoKey> {
  const source = resolveSigningSecretMaterial();
  if (cachedCryptoKey && cachedSecretSource === source) {
    return cachedCryptoKey;
  }
  const enc = new TextEncoder();
  const domainSeparated = enc.encode(`smartskoolz:capability-hmac-sha256:v1|${source}`);
  const derivedKeyBytes = await globalThis.crypto.subtle.digest('SHA-256', domainSeparated);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    derivedKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  cachedSecretSource = source;
  cachedCryptoKey = key;
  return key;
}

/** Short non-reversible binding tag derived from a bcrypt `pin_hash`. */
export async function computePinHashTag(pinHash: string): Promise<string> {
  const bytes = new TextEncoder().encode(`smartskoolz:pin-tag:v1|${pinHash}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return toBase64Url(digest.slice(0, 12));
}

export async function signCapabilityPayload(payload: AnyCapabilityPayload): Promise<string> {
  const key = await getHmacKey();
  const enc = new TextEncoder();
  const encodedPayload = toBase64Url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${TOKEN_PREFIX}.${encodedPayload}`;
  const sigBuffer = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(sigBuffer))}`;
}

export async function verifyCapabilityToken(rawToken: unknown): Promise<AnyCapabilityPayload | null> {
  if (typeof rawToken !== 'string') return null;
  const trimmed = rawToken.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;

  const [, payloadB64, sigB64] = parts;
  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || sigBytes.length !== 32 || !payloadBytes) return null;

  try {
    const key = await getHmacKey();
    const signingInput = new TextEncoder().encode(`${TOKEN_PREFIX}.${payloadB64}`);
    const valid = await globalThis.crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as BufferSource,
      signingInput
    );
    if (!valid) return null;

    const decoded = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<AnyCapabilityPayload>;
    if (!decoded || typeof decoded !== 'object' || decoded.v !== 1) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp) || decoded.exp <= nowSec) {
      return null;
    }
    if (typeof decoded.schoolId !== 'string' || !UUID_RE.test(decoded.schoolId)) {
      return null;
    }

    if (decoded.scope === 'register') {
      if (typeof decoded.classId !== 'string' || !UUID_RE.test(decoded.classId)) return null;
      return decoded as RegisterCapabilityPayload;
    }

    if (decoded.scope === 'register_pin') {
      if (
        typeof decoded.classId !== 'string' || !UUID_RE.test(decoded.classId) ||
        typeof decoded.teacherId !== 'string' || !UUID_RE.test(decoded.teacherId) ||
        typeof decoded.staffUserId !== 'string' || !UUID_RE.test(decoded.staffUserId)
      ) {
        return null;
      }
      return decoded as VerifiedTeacherPinPayload;
    }

    if (decoded.scope === 'kiosk') {
      return decoded as KioskCapabilityPayload;
    }

    return null;
  } catch {
    return null;
  }
}

function resolveTtlSeconds(envVarName: string, fallbackSeconds: number): number {
  const raw = process.env[envVarName];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, 365 * 24 * 3600);
    }
  }
  return fallbackSeconds;
}

export async function createRegisterCapabilityToken(params: {
  schoolId: string;
  classId: string;
  ttlSeconds?: number;
}): Promise<string> {
  if (!UUID_RE.test(params.schoolId) || !UUID_RE.test(params.classId)) {
    throw new Error('Invalid schoolId or classId for register capability token.');
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? resolveTtlSeconds('REGISTER_TOKEN_TTL_SECONDS', DEFAULT_REGISTER_TTL_SECONDS);
  return signCapabilityPayload({
    v: 1,
    scope: 'register',
    schoolId: params.schoolId,
    classId: params.classId,
    iat: now,
    exp: now + ttl,
  });
}

export async function createVerifiedTeacherPinToken(params: {
  schoolId: string;
  classId: string;
  teacherId: string;
  staffUserId: string;
  pinHash?: string | null;
  ttlSeconds?: number;
}): Promise<{ token: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = params.ttlSeconds ?? resolveTtlSeconds('REGISTER_PIN_TTL_SECONDS', DEFAULT_PIN_SESSION_TTL_SECONDS);
  const pinTag = params.pinHash ? await computePinHashTag(params.pinHash) : undefined;
  const token = await signCapabilityPayload({
    v: 1,
    scope: 'register_pin',
    schoolId: params.schoolId,
    classId: params.classId,
    teacherId: params.teacherId,
    staffUserId: params.staffUserId,
    ...(pinTag ? { pinTag } : {}),
    iat: now,
    exp: now + maxAge,
  });
  return { token, maxAge };
}

export async function createKioskCapabilityToken(params: {
  schoolId: string;
  ttlSeconds?: number;
}): Promise<string> {
  if (!UUID_RE.test(params.schoolId)) {
    throw new Error('Invalid schoolId for kiosk capability token.');
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? resolveTtlSeconds('KIOSK_TOKEN_TTL_SECONDS', DEFAULT_KIOSK_TTL_SECONDS);
  return signCapabilityPayload({
    v: 1,
    scope: 'kiosk',
    schoolId: params.schoolId,
    iat: now,
    exp: now + ttl,
  });
}

export async function verifyRegisterCapabilityToken(
  rawToken: unknown,
  expectedClassId?: string
): Promise<RegisterCapabilityPayload | null> {
  const parsed = await verifyCapabilityToken(rawToken);
  if (!parsed || parsed.scope !== 'register') return null;
  if (expectedClassId && parsed.classId.toLowerCase() !== expectedClassId.toLowerCase()) {
    return null;
  }
  return parsed;
}

export async function verifyTeacherPinSessionToken(
  rawToken: unknown,
  expectedSchoolId: string,
  expectedClassId: string
): Promise<VerifiedTeacherPinPayload | null> {
  const parsed = await verifyCapabilityToken(rawToken);
  if (!parsed || parsed.scope !== 'register_pin') return null;
  if (parsed.schoolId.toLowerCase() !== expectedSchoolId.toLowerCase()) return null;
  if (parsed.classId.toLowerCase() !== expectedClassId.toLowerCase()) return null;
  return parsed;
}

export async function verifyKioskCapabilityToken(rawToken: unknown): Promise<KioskCapabilityPayload | null> {
  const parsed = await verifyCapabilityToken(rawToken);
  if (!parsed || parsed.scope !== 'kiosk') return null;
  return parsed;
}

export function buildCapabilityCookieOptions(maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production' && process.env.ALLOW_HTTP_COOKIES !== 'true'
      ? false // Note: matches local HTTP production test runs unless HTTPS; see cookie-options.ts pattern
      : false,
    maxAge: maxAgeSeconds,
  };
}
