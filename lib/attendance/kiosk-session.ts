import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 15 * 60 * 1000;
const TOKEN_VERSION = 1;

export interface AttendanceSessionScope {
  userId: string;
  schoolId: string;
  classId: string;
  teacherId: string;
}

interface AttendanceSessionPayload extends AttendanceSessionScope {
  version: number;
  issuedAt: number;
  expiresAt: number;
}

function signingKey(): Buffer {
  const secret =
    process.env.ATTENDANCE_SESSION_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_KEY?.trim() ||
    '';
  if (secret.length < 32 || /^(your[-_]|placeholder|test[-_]?key|changeme)/i.test(secret)) {
    throw new Error('Attendance session signing secret is not configured.');
  }

  // Domain-separate kiosk tokens from any other HMAC use of the same server key.
  return createHmac('sha256', 'school-attendance-session:v1').update(secret).digest();
}

function isScope(value: unknown): value is AttendanceSessionScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return ['userId', 'schoolId', 'classId', 'teacherId'].every(key =>
    typeof scope[key] === 'string' && (scope[key] as string).trim().length > 0 && (scope[key] as string).length <= 200
  );
}

/** Issue a short-lived bearer token bound to one signed-in user, school, class, and teacher. */
export function createAttendanceSessionToken(
  scope: AttendanceSessionScope,
  now = Date.now(),
): string {
  if (!isScope(scope) || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('A valid attendance session scope and timestamp are required.');
  }

  const payload: AttendanceSessionPayload = {
    version: TOKEN_VERSION,
    userId: scope.userId,
    schoolId: scope.schoolId,
    classId: scope.classId,
    teacherId: scope.teacherId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

/** Validate signature, expiry, and the exact server-derived request scope. */
export function verifyAttendanceSessionToken(
  token: unknown,
  expectedScope: AttendanceSessionScope,
  now = Date.now(),
): AttendanceSessionScope | null {
  if (typeof token !== 'string' || token.length > 2048 || !isScope(expectedScope) || !Number.isSafeInteger(now)) {
    return null;
  }

  const [encodedPayload, suppliedSignature, extraPart] = token.split('.');
  if (
    !encodedPayload ||
    !suppliedSignature ||
    extraPart !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) {
    return null;
  }

  let expectedSignature: Buffer;
  try {
    expectedSignature = Buffer.from(
      createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url'),
      'base64url',
    );
  } catch {
    return null;
  }
  const actualSignature = Buffer.from(suppliedSignature, 'base64url');
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const candidate = payload as Partial<AttendanceSessionPayload>;
  if (!isScope(candidate)) return null;
  const sessionPayload = candidate as AttendanceSessionPayload;

  if (
    sessionPayload.version !== TOKEN_VERSION ||
    !Number.isSafeInteger(sessionPayload.issuedAt) ||
    !Number.isSafeInteger(sessionPayload.expiresAt) ||
    sessionPayload.issuedAt > now + 30_000 ||
    sessionPayload.expiresAt <= now ||
    sessionPayload.expiresAt <= sessionPayload.issuedAt ||
    sessionPayload.expiresAt - sessionPayload.issuedAt > SESSION_TTL_MS
  ) {
    return null;
  }

  if (
    sessionPayload.userId !== expectedScope.userId ||
    sessionPayload.schoolId !== expectedScope.schoolId ||
    sessionPayload.classId !== expectedScope.classId ||
    sessionPayload.teacherId !== expectedScope.teacherId
  ) {
    return null;
  }

  return {
    userId: sessionPayload.userId,
    schoolId: sessionPayload.schoolId,
    classId: sessionPayload.classId,
    teacherId: sessionPayload.teacherId,
  };
}
