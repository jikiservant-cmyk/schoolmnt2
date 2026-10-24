import { cookies } from 'next/headers';
import { requireSchoolAdminPage } from '@/lib/auth-guard';
import {
  KIOSK_CAPABILITY_COOKIE,
  verifyKioskCapabilityToken,
} from '@/lib/security/register-token';

// Server-side gate: kiosk terminal requires either a valid school-scoped
// HMAC capability cookie (`sk_kiosk_cap`) OR a verified `school_admin` session.
export default async function MarkAttendanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const capToken = cookieStore.get(KIOSK_CAPABILITY_COOKIE)?.value;
  if (capToken && (await verifyKioskCapabilityToken(capToken))) {
    return <>{children}</>;
  }

  await requireSchoolAdminPage();
  return <>{children}</>;
}
