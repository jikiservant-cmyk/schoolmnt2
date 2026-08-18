import { createClient } from '@/utils/supabase/server';
import PeopleDirectoryClient from './PeopleDirectoryClient';

interface SearchProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function PeoplePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const initialRoleFilter = params.role || 'all';

  const supabase = await createClient();

  // 1. Fetch school classes
  const { data: classesData } = await supabase
    .from('classes')
    .select('id, name')
    .order('name');

  const classes = classesData || [];

  // 2. Fetch people list
  const { data: peopleData } = await supabase
    .from('people')
    .select(`
      id,
      full_name,
      role,
      class_id,
      device_user_id,
      phone,
      is_active
    `)
    .order('full_name');

  const people = peopleData || [];

  return (
    <PeopleDirectoryClient 
      initialPeople={people} 
      classes={classes} 
      initialRoleFilter={initialRoleFilter} 
    />
  );
}
