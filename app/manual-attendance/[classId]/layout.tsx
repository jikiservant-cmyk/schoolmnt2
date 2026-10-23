import { cookies } from 'next/headers';
import { requireSchoolAdminPage } from '@/lib/auth-guard';
import {
  REGISTER_CAPABILITY_COOKIE,
  verifyRegisterCapabilityToken,
} from '@/lib/security/register-token';

// Server-side gate: class attendance requires either a valid class-scoped
// HMAC capability cookie (`sk_reg_cap`) OR a verified `school_admin` session.
export default async function ManualAttendanceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;
  const cookieStore = await cookies();
  const capToken = cookieStore.get(REGISTER_CAPABILITY_COOKIE)?.value;
  if (capToken && (await verifyRegisterCapabilityToken(capToken, classId))) {
    return <>{children}</>;
  }

  await requireSchoolAdminPage();
  return <>{children}</>;
}
