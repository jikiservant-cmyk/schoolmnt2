import { createClient } from '@/utils/supabase/server';
import AddClassForm from './AddClassForm';
import { GraduationCap, ArrowLeft, BookOpen } from 'lucide-react';
import Link from 'next/link';
import CopyLinkButton from './CopyLinkButton';

export default async function ClassesPage() {
  const supabase = await createClient();

  // 1. Fetch raw classes
  const { data: classesRaw } = await supabase
    .from('classes')
    .select(`
      id,
      name,
      teacher_id,
      academic_years (
        name
      )
    `)
    .order('name');

  // 2. Fetch all teachers (to pass to the form and display list assignments)
  const { data: teachersRaw } = await supabase
    .from('people')
    .select('id, full_name')
    .eq('role', 'teacher')
    .eq('is_active', true)
    .order('full_name');

  // 3. Fetch student records to count them per class_id
  const { data: studentsRaw } = await supabase
    .from('people')
    .select('id, class_id')
    .eq('role', 'student')
    .eq('is_active', true);

  const teachers = teachersRaw || [];
  const students = studentsRaw || [];

  // 4. Map associations in-memory safely to avoid custom PostgREST schema naming errors
  const classes = (classesRaw || []).map((cls) => {
    const assignedTeacher = teachers.find(t => t.id === cls.teacher_id);
    const count = students.filter(s => s.class_id === cls.id).length;
    return {
      id: cls.id,
      name: cls.name,
      termName: (cls.academic_years as any)?.name || 'General Term',
      teacherName: assignedTeacher?.full_name || 'Unassigned',
      studentCount: count
    };
  });

  return (
    <div className="space-y-8 animate-fade-in">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-baseline gap-2 pb-2 border-b border-meridian-border">
        <div>
          <h1 className="font-serif text-3xl font-medium tracking-tight text-meridian-text-1 flex items-center gap-2">
            <GraduationCap className="w-8 h-8 text-meridian-gold" />
            School Classrooms
          </h1>
          <p className="text-xs font-mono uppercase tracking-widest text-meridian-text-3 mt-1">
            Classes Directory & Term Layout
          </p>
        </div>
        <Link 
          href="/dashboard" 
          className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-meridian-text-2 hover:text-meridian-gold transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Overview
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Classes List (8 columns) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-meridian-panel border border-meridian-border rounded-2xl p-6">
            <div className="pb-3 border-b border-meridian-border mb-4">
              <h3 className="font-serif text-lg font-medium text-meridian-text-1">
                Active Inscriptions
              </h3>
              <p className="text-[11px] text-meridian-text-3 font-mono mt-0.5">
                Overview of enrolled classrooms and academic leaders
              </p>
            </div>

            {classes.length === 0 ? (
              <div className="py-12 text-center border-2 border-dashed border-meridian-border/50 rounded-xl space-y-3">
                <BookOpen className="w-10 h-10 text-meridian-text-3 mx-auto opacity-60" />
                <div className="font-serif text-base text-meridian-text-2 font-medium">No classrooms registered yet</div>
                <p className="text-xs text-meridian-text-3 max-w-sm mx-auto">
                  Use the registration form on the right to instantiate your school&apos;s first classroom.
                </p>
              </div>
            ) : (
              <div>
                {/* Mobile Card View */}
                <div className="space-y-3 md:hidden">
                  {classes.map((cls) => (
                    <div key={cls.id} className="p-4 rounded-xl border border-meridian-border bg-meridian-panel-raised/40 space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-semibold text-meridian-text-1">{cls.name}</h4>
                          <span className="text-xs text-meridian-text-2">Teacher: {cls.teacherName}</span>
                        </div>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-meridian-deep border border-meridian-border rounded text-xs font-mono font-medium text-meridian-text-1">
                          {cls.studentCount} students
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs font-mono pt-2 border-t border-meridian-border/50 text-meridian-text-3">
                        <span>Term: {cls.termName}</span>
                        <CopyLinkButton classId={cls.id} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table View */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-meridian-border">
                        <th className="text-left font-mono text-[10px] uppercase tracking-wider text-meridian-text-3 pb-3">
                          Class Name
                        </th>
                        <th className="text-left font-mono text-[10px] uppercase tracking-wider text-meridian-text-3 pb-3">
                          Form Teacher
                        </th>
                        <th className="text-left font-mono text-[10px] uppercase tracking-wider text-meridian-text-3 pb-3">
                          Academic Term
                        </th>
                        <th className="text-right font-mono text-[10px] uppercase tracking-wider text-meridian-text-3 pb-3">
                          Size
                        </th>
                        <th className="text-right font-mono text-[10px] uppercase tracking-wider text-meridian-text-3 pb-3">
                          Link
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-meridian-border">
                      {classes.map((cls) => (
                        <tr key={cls.id} className="hover:bg-meridian-panel-raised/30 transition-colors">
                          <td className="py-3.5 text-sm font-semibold text-meridian-text-1">
                            {cls.name}
                          </td>
                          <td className="py-3.5 text-sm text-meridian-text-2">
                            {cls.teacherName}
                          </td>
                          <td className="py-3.5 text-xs font-mono uppercase tracking-wider text-meridian-text-3">
                            {cls.termName}
                          </td>
                          <td className="py-3.5 text-right font-mono text-sm text-meridian-text-1">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-meridian-deep rounded">
                              {cls.studentCount}
                            </span>
                          </td>
                          <td className="py-3.5 text-right pl-4">
                            <CopyLinkButton classId={cls.id} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Add Class Form (4 columns) */}
        <div className="lg:col-span-4">
          <AddClassForm teachers={teachers} />
        </div>

      </div>

    </div>
  );
}
