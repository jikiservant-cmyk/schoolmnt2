import { requireSchoolAdminPage } from '@/lib/auth-guard';
import { createAdminClient } from '@/utils/supabase/admin';
import { getSchoolSettings } from '@/lib/school-settings';
import SettingsForm from './SettingsForm';

export default async function SchoolSettingsPage() {
  const { schoolId } = await requireSchoolAdminPage();
  const initialSettings = await getSchoolSettings(createAdminClient(), schoolId);

  return <SettingsForm initialSettings={initialSettings} />;
}
