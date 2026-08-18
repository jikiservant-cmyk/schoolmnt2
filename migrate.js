const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await supabase.rpc('exec_sql', { sql: "ALTER TYPE school.user_role ADD VALUE IF NOT EXISTS 'support_staff';" });
  if (error) console.error(error);
  else console.log('success');
}
run();
