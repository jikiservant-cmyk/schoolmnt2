import { redirect } from 'next/navigation';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

export const dynamic = 'force-dynamic';

async function getAdminContext() {
  try {
    return await requireSchoolAdmin();
  } catch (error) {
    console.error('Dashboard authorization failed:', error);
    redirect('/login');
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user } = await getAdminContext();

  // Fetch current logged-in user and administrative session
  let adminName = 'Admin';
  let schoolName = '';
  let initials = 'AD';

  try {
    const { data: staffData } = await supabase
      .from('staff_users')
      .select(`
        staff_role,
        people (
          full_name,
          schools (
            name
          )
        )
      `)
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (staffData && staffData.people) {
      const person = staffData.people as any;
      adminName = person.full_name || 'Admin';
      schoolName = person.schools?.name || '';

      initials = adminName
        .split(' ')
        .map(n => n[0])
        .join('')
        .substring(0, 2)
        .toUpperCase() || 'AD';
    } else {
      adminName = user.user_metadata?.full_name || 'Admin';
      initials = adminName.substring(0, 2).toUpperCase() || 'AD';
    }
  } catch (err) {
    console.error('Error fetching admin context in layout:', err);
  }

  return (
    <div className="min-h-screen bg-[#f7f7f8] text-[#171719] font-sans flex flex-col">
      <Sidebar
        schoolName={schoolName}
        adminName={adminName}
        initials={initials}
      />

      <div className="md:ml-[238px] min-h-screen flex flex-col pt-16 md:pt-0">
        <Topbar
          adminName={adminName}
          initials={initials}
          schoolName={schoolName}
        />

        <main className="flex-1 w-full max-w-[1320px] mx-auto px-4 sm:px-9 pb-10">
          {children}
        </main>
      </div>
    </div>
  );
}
