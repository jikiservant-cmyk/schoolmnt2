import { createClient } from '@/utils/supabase/server';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  
  // Fetch current logged-in user and administrative session
  let adminName = 'Admin';
  let schoolName = '';
  let initials = 'AD';

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
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
    }
  } catch (err) {
    console.error('Error fetching admin context in layout:', err);
  }

  return (
    <div className="min-h-screen bg-[#f7f7f8] text-[#171719] font-sans flex flex-col">
      {/* Sidebar */}
      <Sidebar 
        schoolName={schoolName} 
        adminName={adminName} 
        initials={initials} 
      />

      {/* Main Content Area */}
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
