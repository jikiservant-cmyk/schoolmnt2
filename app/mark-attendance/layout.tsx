import { requireSchoolAdminPage } from '@/lib/auth-guard';

// Server-side gate: kiosk terminal requires a verified school_admin session.
export default async function MarkAttendanceLayout({ children }: { children: React.ReactNode }) {
  await requireSchoolAdminPage();
  return <>{children}</>;
}
